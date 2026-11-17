// ==UserScript==
// @name         Onshape Timelapse
// @namespace    onshape-timelapse
// @version      2.0.1
// @description  Make a timelapse video of how an Onshape model was built, straight from its document history. No screen recording, no API key.
// @match        https://cad.onshape.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * HOW TO USE
 *  A) Tampermonkey (one-click): install this file as a userscript. A "⏱ Timelapse" button
 *     appears in Onshape (bottom-right). Open a Part Studio or Assembly tab and click it.
 *  B) No install: open a Part Studio / Assembly tab, press F12 → Console, paste this whole
 *     file, press Enter. The panel opens.
 *
 * Then: 1 Preview → 2 Analyze → 3 Render frames → 4 Make video.
 * Rendered frames are saved in your browser, so if Onshape rate-limits you, or you close the
 * tab, clicking "Render frames" again continues where it stopped without re-using API calls.
 *
 * Every rendered frame is one Onshape API call. Onshape limits API calls per year
 * (2,500 per user on Free / EDU Student plans), so check the estimate before rendering.
 */

(function () {
  "use strict";
  const VERSION = "2.0.1";
  const root = typeof window !== "undefined" ? window : globalThis;

  // =====================================================================================
  //  Pure helpers (no DOM) — also exported for testing
  // =====================================================================================

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = t => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);

  function hash(str) { // cyrb53, returned as 16 hex chars
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }

  function fmtDuration(ms) {
    if (!(ms > 0)) return "0m";
    const min = Math.round(ms / 60000);
    if (min < 1) return "<1m";
    if (min < 60) return min + "m";
    return Math.floor(min / 60) + "h " + String(min % 60).padStart(2, "0") + "m";
  }

  function cleanDesc(s) {
    s = String(s || "").replace(/\s*:\s*/g, ": ").replace(/\s+/g, " ").trim();
    return s.length > 64 ? s.slice(0, 63) + "…" : s;
  }

  // ---------- camera ----------
  const PRESETS = { iso: [-45, 35.26], front: [-90, 0], top: [-90, 90], right: [0, 0] };

  function cameraAngles(s) {
    return s.camera === "custom" ? [num(s.azimuth, -45), clamp(num(s.elevation, 35), -90, 90)]
                                 : PRESETS[s.camera] || PRESETS.iso;
  }

  // 3x4 row-major: camera x, y, z axes (world coords) + translation that puts `c` mid-frame.
  // az=-45, el=35.26 reproduces Onshape's isometric view.
  function viewMatrix(azDeg, elDeg, c) {
    const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
    const z = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
    const x = [-Math.sin(az), Math.cos(az), 0];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const rows = [];
    for (const a of [x, y, z]) rows.push(...a, -(a[0] * c[0] + a[1] * c[1] + a[2] * c[2]));
    return rows.map(v => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6)).join(",");
  }

  function outputSize(s) {
    const short = num(s.resolution, 1080);
    const r = { "16:9": [16, 9], "1:1": [1, 1], "9:16": [9, 16], "4:5": [4, 5] }[s.aspect] || [16, 9];
    if (r[0] >= r[1]) return [Math.round(short * r[0] / r[1] / 2) * 2, short];
    return [short, Math.round(short * r[1] / r[0] / 2) * 2];
  }

  function bboxInfo(bb) {
    if (!bb) return null;
    const lo = [bb.lowX, bb.lowY, bb.lowZ], hi = [bb.highX, bb.highY, bb.highZ];
    if (![...lo, ...hi].every(Number.isFinite)) return null;
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!(diag > 1e-6)) return null;
    return { center: lo.map((v, i) => (v + hi[i]) / 2), diag };
  }

  // ---------- history & planning ----------
  function prepareHistory(raw, breakMin) {
    const breakMs = Math.max(1, num(breakMin, 15)) * 60000;
    const hist = raw.map(h => ({ ...h, t: Date.parse(h.date) })).filter(h => !isNaN(h.t)).sort((a, b) => a.t - b.t);
    let active = 0, sessions = hist.length ? 1 : 0;
    hist.forEach((h, i) => {
      if (i) {
        const gap = h.t - hist[i - 1].t;
        if (gap > breakMs) sessions++; else active += Math.max(0, gap);
      }
      h.active = active;
    });
    return { hist, totalActive: active, sessions };
  }

  // view: { hist, totalActive, versions: [{mid, name}] }
  function makePlan(view, s) {
    const H = view.hist, n = H.length;
    if (!n) return { frames: [] };
    const pos = new Map(H.map((h, i) => [h.microversionId, i]));
    const versions = (view.versions || []).filter(v => pos.has(v.mid)).map(v => ({ hi: pos.get(v.mid), name: v.name }));
    const forced = (s.versionHold || s.showVersions) ? versions.map(v => v.hi) : [];
    const M = Math.max(2, Math.floor(num(s.maxFrames, 150)));
    let idx = [];
    if (n <= M) idx = H.map((_, i) => i);
    else if (s.pacing === "time" && view.totalActive > 0) {
      let j = 0;
      for (let k = 0; k < M; k++) {
        const target = view.totalActive * k / (M - 1);
        while (j + 1 < n && H[j + 1].active <= target) j++;
        idx.push(j);
      }
    } else for (let k = 0; k < M; k++) idx.push(Math.round(k * (n - 1) / (M - 1)));
    idx.push(n - 1, ...forced);
    idx = [...new Set(idx)].filter(i => i >= 0 && i < n).sort((a, b) => a - b);

    const frames = idx.map(hi => ({ hi, e: H[hi], versions: [] }));
    for (const v of versions) {
      let best = null;
      for (const f of frames) if (f.hi <= v.hi) best = f;
      if (best && !best.versions.includes(v.name)) best.versions.push(v.name);
    }

    const N = frames.length, ramp = Math.max(0, num(s.ramp, 0));
    let base = frames.map((f, k) => (s.pacing === "time" && k + 1 < N ? H[frames[k + 1].hi].active - f.e.active : 1));
    if (s.pacing === "time") {
      const others = base.slice(0, -1);
      const mean = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 1;
      base[N - 1] = mean || 1;
      if (!base.some(b => b > 0)) base = base.map(() => 1);
    }
    frames.forEach((f, k) => { f.w = base[k] * Math.pow(1 + ramp, 1 - 2 * (N > 1 ? k / (N - 1) : 0)); });
    const total = frames.slice(0, -1).reduce((a, f) => a + f.w, 0);
    let acc = 0;
    frames.forEach((f, k) => { f.p = total > 0 ? acc / total : (N > 1 ? k / (N - 1) : 1); acc += f.w; });
    frames[N - 1].p = 1;
    return { frames };
  }

  function zoomKeyIdx(plan, s) {
    const N = plan.frames.length, K = clamp(Math.floor(num(s.zoomKeyframes, 10)), 2, 40);
    const set = new Set();
    for (let i = 0; i < K; i++) set.add(Math.round(i * (N - 1) / (K - 1)));
    return [...set].sort((a, b) => a - b);
  }

  // bbox: mid -> {center, diag} | null
  function cameraForFrames(plan, s, bbox, W, H) {
    const [az0, el] = cameraAngles(s);
    const orbit = num(s.orbit, 0);
    const fit = Math.min(W * 0.94, H * 0.8);
    const margin = clamp(num(s.margin, 1.1), 0.3, 5);
    const fin = plan.frames.length ? bbox(plan.frames[plan.frames.length - 1].e.microversionId) : null;
    const auto = !!s.autofit || !fin;
    const ease = s.orbitEase ? easeInOut : (t => t);

    let kfs = null;
    if (!auto && s.zoomFollow) {
      kfs = [];
      let maxD = 0;
      for (const k of zoomKeyIdx(plan, s)) {
        const b = bbox(plan.frames[k].e.microversionId);
        if (!b) continue;
        maxD = Math.max(maxD, b.diag, fin.diag * 0.08);
        kfs.push({ k, c: b.center, d: maxD });
      }
      if (!kfs.length) kfs = null;
    }

    let lastC = auto ? [0, 0, 0] : fin.center, lastD = auto ? 0 : fin.diag;
    const cams = plan.frames.map((f, k) => {
      const az = az0 + orbit * ease(f.p);
      if (auto) return { vm: viewMatrix(az, el, [0, 0, 0]), ps: 0 };
      let c = fin.center, d = fin.diag;
      if (kfs) {
        let a = kfs[0], b = kfs[kfs.length - 1];
        if (k <= a.k) { c = a.c; d = a.d; }
        else if (k >= b.k) { c = b.c; d = b.d; }
        else {
          for (let i = 0; i + 1 < kfs.length; i++) if (k >= kfs[i].k && k <= kfs[i + 1].k) { a = kfs[i]; b = kfs[i + 1]; break; }
          const t = easeInOut((k - a.k) / Math.max(1, b.k - a.k));
          c = a.c.map((v, i) => lerp(v, b.c[i], t));
          d = lerp(a.d, b.d, t);
        }
      }
      lastC = c; lastD = d;
      return { vm: viewMatrix(az, el, c), ps: d * margin / fit };
    });

    const reveal = [];
    if (s.reveal && plan.frames.length) {
      const R = clamp(Math.floor(num(s.revealFrames, 48)), 4, 360);
      for (let j = 1; j <= R; j++) {
        const az = az0 + orbit + 360 * easeInOut(j / R);
        reveal.push(auto ? { vm: viewMatrix(az, el, [0, 0, 0]), ps: 0 }
                         : { vm: viewMatrix(az, el, lastC), ps: lastD * margin / fit });
      }
    }
    return { cams, reveal, auto };
  }

  // ---------- timeline ----------
  // kept: [{key, f, versions, w}], reveal: [key]
  function buildTimeline(kept, reveal, s) {
    const fps = clamp(Math.round(num(s.fps, 30)), 5, 60);
    const T = sec => Math.max(1, Math.round(num(sec, 0) * fps));
    const shots = [], banners = [];
    let g = 0;
    const add = sh => { sh.start = g; g += sh.ticks; shots.push(sh); };
    if (s.titleCard) add({ type: "title", ticks: T(s.titleSeconds) });

    let buildTicks = kept.length ? Math.max(1, Math.round(num(s.buildSeconds, 20) * fps)) : 0;
    const W = kept.reduce((a, k) => a + k.w, 0) || 1;
    let acc = 0, prev = 0;
    kept.forEach((k, i) => {
      acc += k.w;
      const last = i === kept.length - 1;
      let b = last ? buildTicks : Math.round(buildTicks * acc / W);
      if (last && b <= prev) { b = prev + 1; buildTicks = b; }
      const t = Math.max(0, b - prev), b0 = prev;
      prev = Math.max(prev, b);
      const hasV = k.versions.length > 0;
      if (hasV && s.showVersions) banners.push({ from: g, to: g + t + T(s.versionHoldSec), text: "Version: " + k.versions.join(" · ") });
      if (t > 0) add({ type: "frame", k, key: k.key, ticks: t, b0 });
      if (hasV && s.versionHold) add({ type: "frame", k, key: k.key, ticks: T(s.versionHoldSec), b0: b0 + t, hold: true });
    });

    if (reveal.length) {
      const RT = Math.max(reveal.length, Math.round(num(s.revealSeconds, 4) * fps));
      let p = 0;
      reveal.forEach((key, j) => {
        const b = Math.round(RT * (j + 1) / reveal.length);
        if (b - p > 0) add({ type: "reveal", key, ticks: b - p });
        p = b;
      });
    }
    if (s.endCard) add({ type: "end", ticks: T(s.endSeconds) });
    return { shots, banners, fps, buildTicks, total: g };
  }

  // ---------- background removal (only used if Onshape returns an opaque background) ----------
  function removeBackground(img, tol = 10) {
    const { data, width: w, height: h } = img;
    let changed = false;
    if (data[3] >= 250) {
      const r0 = data[0], g0 = data[1], b0 = data[2];
      const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
      let sp = 0;
      const push = p => {
        if (seen[p]) return;
        const o = p * 4;
        if (data[o + 3] >= 250 && Math.abs(data[o] - r0) <= tol && Math.abs(data[o + 1] - g0) <= tol && Math.abs(data[o + 2] - b0) <= tol) {
          seen[p] = 1; stack[sp++] = p;
        }
      };
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
      while (sp) {
        const p = stack[--sp];
        data[p * 4 + 3] = 0; changed = true;
        const x = p % w;
        if (x > 0) push(p - 1);
        if (x < w - 1) push(p + 1);
        if (p >= w) push(p - w);
        if (p < w * (h - 1)) push(p + w);
      }
    }
    let opaque = 0;
    for (let o = 3; o < data.length; o += 4) if (data[o] > 16 && ++opaque >= 30) break;
    return { changed, blank: opaque < 30 };
  }

  // ---------- GIF encoder (median-cut palette + LZW) ----------
  function buildPalette(pixelArrays) {
    const cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    for (const d of pixelArrays) {
      for (let o = 0; o < d.length; o += 4) {
        const r = d[o], g = d[o + 1], b = d[o + 2];
        const i = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        cnt[i]++; sr[i] += r; sg[i] += g; sb[i] += b;
      }
    }
    const bins = [];
    for (let i = 0; i < 32768; i++) if (cnt[i]) bins.push(i);
    const comp = (i, c) => (c === 0 ? i >> 10 : c === 1 ? (i >> 5) & 31 : i & 31);
    const boxes = [bins];
    while (boxes.length < 256) {
      let bi = -1, best = 0, bc = 0;
      for (let k = 0; k < boxes.length; k++) {
        const bx = boxes[k];
        if (bx.length < 2) continue;
        let pop = 0;
        const mn = [31, 31, 31], mx = [0, 0, 0];
        for (const i of bx) {
          pop += cnt[i];
          for (let c = 0; c < 3; c++) { const v = comp(i, c); if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
        }
        for (let c = 0; c < 3; c++) {
          const sc = (mx[c] - mn[c]) * Math.sqrt(pop);
          if (sc > best) { best = sc; bi = k; bc = c; }
        }
      }
      if (bi < 0) break;
      const bx = boxes[bi].sort((a, b) => comp(a, bc) - comp(b, bc));
      let half = 0;
      for (const i of bx) half += cnt[i];
      half /= 2;
      let acc = 0, cut = bx.length - 1;
      for (let j = 0; j < bx.length - 1; j++) { acc += cnt[bx[j]]; if (acc >= half) { cut = j + 1; break; } }
      boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
    }
    const pal = boxes.map(bx => {
      let n = 0, r = 0, g = 0, b = 0;
      for (const i of bx) { n += cnt[i]; r += sr[i]; g += sg[i]; b += sb[i]; }
      return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
    });
    while (pal.length < 256) pal.push([0, 0, 0]);
    const lut = new Int16Array(32768).fill(-1);
    const flat = new Uint8Array(768);
    pal.forEach((c, k) => flat.set(c, k * 3));
    function indexOf(r, g, b) {
      const i = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let v = lut[i];
      if (v < 0) {
        const rr = (r & 0xf8) + 4, gg = (g & 0xf8) + 4, bb = (b & 0xf8) + 4;
        let bd = Infinity;
        for (let k = 0; k < 256; k++) {
          const dr = rr - pal[k][0], dg = gg - pal[k][1], db = bb - pal[k][2];
          const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
          if (d < bd) { bd = d; v = k; }
        }
        lut[i] = v;
      }
      return v;
    }
    return { flat, indexOf };
  }

  class ByteBuf {
    constructor(n = 1 << 16) { this.a = new Uint8Array(n); this.n = 0; }
    push(b) { if (this.n === this.a.length) { const x = new Uint8Array(this.a.length * 2); x.set(this.a); this.a = x; } this.a[this.n++] = b; }
    pushAll(arr) { for (let i = 0; i < arr.length; i++) this.push(arr[i]); }
    bytes() { return this.a.slice(0, this.n); }
  }

  function lzw(indices, minCode = 8) {
    const out = new ByteBuf(indices.length >> 1 || 64);
    const clear = 1 << minCode, eoi = clear + 1;
    let size = minCode + 1, next = eoi + 1, cur = 0, nbits = 0;
    let dict = new Map();
    const write = code => {
      cur |= code << nbits; nbits += size;
      while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; }
    };
    write(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = (prefix << 8) | k;
      const hit = dict.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      write(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        if (next > (1 << size) && size < 12) size++;
      } else {
        write(clear);
        dict = new Map(); size = minCode + 1; next = eoi + 1;
      }
      prefix = k;
    }
    write(prefix);
    write(eoi);
    if (nbits > 0) out.push(cur & 255);
    return out.bytes();
  }

  function gifWriter(w, h, palFlat) {
    const parts = [];
    const u16 = v => [v & 255, (v >> 8) & 255];
    parts.push(Uint8Array.from([..."GIF89a"].map(c => c.charCodeAt(0)).concat(u16(w), u16(h), [0xf7, 0, 0])));
    parts.push(palFlat);
    parts.push(Uint8Array.from([0x21, 0xff, 0x0b, ..."NETSCAPE2.0"].map(c => (typeof c === "string" ? c.charCodeAt(0) : c)).concat([3, 1, 0, 0, 0])));
    return {
      addFrame(indices, delayCs) {
        const d = clamp(Math.round(delayCs), 2, 65535);
        parts.push(Uint8Array.from([0x21, 0xf9, 4, 0x04, ...u16(d), 0, 0, 0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0, 8]));
        const data = lzw(indices, 8);
        const blocks = new ByteBuf(data.length + Math.ceil(data.length / 255) + 2);
        for (let o = 0; o < data.length; o += 255) {
          const n = Math.min(255, data.length - o);
          blocks.push(n);
          for (let j = 0; j < n; j++) blocks.push(data[o + j]);
        }
        blocks.push(0);
        parts.push(blocks.bytes());
      },
      finish() { parts.push(Uint8Array.from([0x3b])); return parts; },
    };
  }

  // ---------- ZIP writer (store, no compression — PNGs are already compressed) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // files: [{name, data (Uint8Array or Blob), crc, size}] → array of parts for new Blob(parts)
  function zipParts(files, date = new Date()) {
    const enc = new TextEncoder();
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, day, true);
      lh.setUint32(14, f.crc, true); lh.setUint32(18, f.size, true); lh.setUint32(22, f.size, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, day, true);
      ch.setUint32(16, f.crc, true); ch.setUint32(20, f.size, true); ch.setUint32(24, f.size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + f.size;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return [...parts, ...central, new Uint8Array(end.buffer)];
  }

  root.__osTimelapseLib = {
    viewMatrix, outputSize, prepareHistory, makePlan, cameraForFrames, buildTimeline, removeBackground,
    buildPalette, lzw, gifWriter, crc32, zipParts, fmtDuration, hash, bboxInfo, cleanDesc, easeInOut,
  };

  if (typeof document === "undefined" || !document.body) return; // loaded in a test environment

  // =====================================================================================
  //  Browser part
  // =====================================================================================

  if (root.__osTimelapse) {
    if (root.__osTimelapse.version === VERSION) { root.__osTimelapse.open(); return; }
    try { root.__osTimelapse.destroy(); } catch (e) { /* ignore */ }
  }

  // ---------- settings ----------
  const DEFAULTS = {
    camera: "iso", azimuth: -45, elevation: 35, orbit: 360, orbitEase: true,
    reveal: true, revealFrames: 48, revealSeconds: 4,
    zoomFollow: false, zoomKeyframes: 10, margin: 1.1, autofit: false, edges: true,
    maxFrames: 150, pacing: "edits", breakMinutes: 15, skipUnchanged: true, buildSeconds: 20, ramp: 0,
    versionHold: true, versionHoldSec: 1.5, fps: 30,
    showDesc: true, showUser: false, showClock: true, showModelTime: true, showProgress: true, showVersions: true,
    titleCard: true, title: "", subtitle: "", titleSeconds: 2.5, endCard: true, endSeconds: 3.5,
    background: "gradient", bgColor1: "#f7f9fc", bgColor2: "#d5dee9", aspect: "16:9", resolution: 1080,
    format: "video", gifWidth: 640, delayMs: 1500,
  };
  const LS_KEY = "osTimelapseSettings";
  const S = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; } catch (e) { return { ...DEFAULTS }; }
  })();
  const saveSettings = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } };

  const state = { an: null, busy: false, stop: false, keys: new Set(), bbox: new Map(), calls: 0, lastStatus: 0 };
  class Stopped extends Error { constructor() { super("Stopped"); } }

  // ---------- IndexedDB cache ----------
  const db = {
    _p: null,
    open() {
      return this._p || (this._p = new Promise((res, rej) => {
        const r = indexedDB.open("onshape-timelapse", 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("frames", { keyPath: "key" });
          r.result.createObjectStore("meta", { keyPath: "key" });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    },
    async tx(store, mode, fn) {
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error("Storage error (browser storage may be full)"));
      });
    },
    get(store, key) { return this.tx(store, "readonly", st => st.get(key)); },
    put(store, val) { return this.tx(store, "readwrite", st => st.put(val)); },
    keys(store) { return this.tx(store, "readonly", st => st.getAllKeys()); },
    clear(store) { return this.tx(store, "readwrite", st => st.clear()); },
  };

  // ---------- Onshape API (uses your logged-in session) ----------
  let lastCall = 0;
  async function api(path, params, allowFail) {
    const url = "/api/v10" + path + (params ? "?" + new URLSearchParams(params) : "");
    for (let attempt = 0; attempt < 8; attempt++) {
      if (state.stop) throw new Stopped();
      const gap = num(S.delayMs, 1500) - (Date.now() - lastCall);
      if (gap > 0) await sleep(gap);
      lastCall = Date.now();
      state.calls++; ui.calls();
      let r;
      try {
        r = await fetch(url, { credentials: "include", headers: { Accept: "application/json;charset=UTF-8; qs=0.09" } });
      } catch (e) {
        if (attempt < 3) { await sleep(3000); continue; }
        throw new Error("Network error: " + e.message);
      }
      state.lastStatus = r.status;
      if (r.status === 429) {
        const ra = parseInt(r.headers.get("Retry-After"), 10);
        await waitWithCountdown(Math.max(5, Number.isFinite(ra) ? ra : 30 * (attempt + 1)));
        continue;
      }
      if (r.ok) return r.json();
      if (r.status === 401) throw new Error("Onshape says you're not signed in (401). Sign in and try again.");
      if (allowFail) return null;
      throw new Error(`Onshape API error ${r.status} on ${path.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
    }
    throw new Error("Onshape kept rate-limiting. Try again later — rendered frames are saved.");
  }

  async function waitWithCountdown(sec) {
    const until = Date.now() + sec * 1000;
    const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    while (Date.now() < until) {
      if (state.stop) throw new Stopped();
      const left = Math.ceil((until - Date.now()) / 1000);
      ui.status(`Onshape rate limit — resuming in ${Math.floor(left / 60)}m ${left % 60}s (around ${at}). ` +
        `Frames so far are saved: press Stop and make the video now, or come back later and click Render again.`, true);
      await sleep(1000);
    }
  }

  // ---------- analysis ----------
  function parseUrl() {
    const m = location.pathname.match(/\/documents\/([0-9a-f]+)\/w\/([0-9a-f]+)\/e\/([0-9a-f]+)/);
    return m ? { did: m[1], wid: m[2], eid: m[3] } : null;
  }

  async function loadHistory(u) {
    const ck = `hist|${u.did}|${u.wid}`;
    const rec = await db.get("meta", ck);
    const cached = (rec && rec.value) || [];
    const seen = new Map(cached.map(h => [h.microversionId, h]));
    const known = new Set(seen.keys());
    let batch = await api(`/documents/d/${u.did}/w/${u.wid}/documenthistory`);
    while (Array.isArray(batch) && batch.length) {
      const fresh = batch.filter(h => h.microversionId && !seen.has(h.microversionId));
      for (const h of fresh) {
        seen.set(h.microversionId, { microversionId: h.microversionId, date: h.date, description: h.description || "", username: h.username || "" });
      }
      ui.status(`Reading history … ${seen.size} edits`);
      if (!fresh.length || batch.some(h => known.has(h.microversionId))) break;
      const oldest = fresh.reduce((a, b) => (Date.parse(a.date) < Date.parse(b.date) ? a : b));
      batch = await api(`/documents/d/${u.did}/m/${oldest.microversionId}/documenthistory`);
    }
    const all = [...seen.values()];
    await db.put("meta", { key: ck, value: all });
    return all;
  }

  async function analyze() {
    const u = parseUrl();
    if (!u) throw new Error("Open a Part Studio or Assembly tab in a document's workspace first (the address should contain /w/…/e/…).");
    const c0 = state.calls;
    ui.status("Reading document info …");
    const els = await api(`/documents/d/${u.did}/w/${u.wid}/elements`, { elementId: u.eid }, true);
    const el = (Array.isArray(els) ? (els.find(e => e.id === u.eid) || els[0]) : null) || {};
    const t = String(el.elementType || "").toUpperCase();
    if (t && t !== "ASSEMBLY" && t !== "PARTSTUDIO") throw new Error("This tab isn't a Part Studio or Assembly. Open one and try again.");
    const type = t === "ASSEMBLY" ? "assemblies" : "partstudios";
    const doc = await api(`/documents/${u.did}`, null, true);
    const vers = (await api(`/documents/d/${u.did}/versions`, null, true)) || [];
    const raw = await loadHistory(u);
    if (!raw.length) throw new Error("No history found for this document.");
    state.an = {
      ...u, type, raw,
      elName: el.name || "", docName: (doc && doc.name) || "",
      versions: (Array.isArray(vers) ? vers : []).filter(v => v && v.name && v.name !== "Start" && v.microversion)
        .map(v => ({ mid: v.microversion, name: v.name })),
      setupCalls: 0,
    };
    state.an.startMid = await findTabStart(state.an);
    state.an.setupCalls = state.calls - c0;
  }

  // The history covers the whole document, including edits from before this tab existed.
  // Binary-search for the first history point where this tab can be rendered (~log2(n) tiny
  // renders, cached), so no frames are wasted on history from before the tab was created.
  async function findTabStart(a) {
    const hist = prepareHistory(a.raw, 15).hist;
    const ck = `start|${a.did}|${a.eid}`;
    const rec = await db.get("meta", ck);
    const known = rec && rec.value;
    const pos = new Map(hist.map((h, i) => [h.microversionId, i]));
    if (known && pos.has(known)) return known;
    const exists = async i => {
      const ek = `exists|${a.did}|${a.eid}|${hist[i].microversionId}`;
      const c = await db.get("meta", ek);
      if (c) return c.value;
      const d = await api(`/${a.type}/d/${a.did}/m/${hist[i].microversionId}/e/${a.eid}/shadedviews`,
        { viewMatrix: viewMatrix(-45, 35.26, [0, 0, 0]), outputWidth: 32, outputHeight: 32, pixelSize: 0 }, true);
      const v = !!d || !(state.lastStatus === 400 || state.lastStatus === 404);
      await db.put("meta", { key: ek, value: v });
      return v;
    };
    let lo = 0, hi = hist.length - 1, step = 0;
    if (await exists(0)) lo = hi = 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      ui.status(`Finding where this tab starts in the history … (check ${++step})`);
      if (await exists(mid)) hi = mid; else lo = mid + 1;
    }
    const mid = hist[lo].microversionId;
    await db.put("meta", { key: ck, value: mid });
    return mid;
  }

  async function ensureAnalysis() {
    const u = parseUrl();
    const a = state.an;
    if (!a || !u || u.did !== a.did || u.wid !== a.wid || u.eid !== a.eid) await analyze();
  }

  function getView() {
    const a = state.an;
    let raw = a.raw;
    if (a.startMid) {
      const sorted = prepareHistory(a.raw, 15).hist;
      const i = sorted.findIndex(h => h.microversionId === a.startMid);
      if (i > 0) raw = sorted.slice(i);
      a.skippedEdits = Math.max(0, i);
    }
    return { ...a, ...prepareHistory(raw, S.breakMinutes) };
  }

  // ---------- bounding boxes (cached) ----------
  async function getBbox(view, mid, fetchMissing) {
    const k = `bbox|${view.did}|${view.eid}|${mid}`;
    if (state.bbox.has(k)) return state.bbox.get(k);
    const rec = await db.get("meta", k);
    if (rec) { state.bbox.set(k, rec.value); return rec.value; }
    if (!fetchMissing) return undefined;
    const bb = await api(`/${view.type}/d/${view.did}/m/${mid}/e/${view.eid}/boundingboxes`, null, true);
    const info = bboxInfo(bb);
    if (bb || state.lastStatus === 400 || state.lastStatus === 404) {
      state.bbox.set(k, info);
      await db.put("meta", { key: k, value: info });
    }
    return info;
  }

  async function gatherBboxes(view, plan, fetchMissing) {
    const mids = new Set();
    if (!S.autofit && plan.frames.length) {
      mids.add(plan.frames[plan.frames.length - 1].e.microversionId);
      if (S.zoomFollow) for (const k of zoomKeyIdx(plan, S)) mids.add(plan.frames[k].e.microversionId);
    }
    const m = new Map();
    let missing = 0;
    for (const mid of mids) {
      const v = await getBbox(view, mid, fetchMissing);
      if (v === undefined) missing++;
      m.set(mid, v || null);
    }
    return { get: mid => m.get(mid) || null, missing };
  }

  const frameKey = (view, mid, W, H, cam) =>
    hash([view.did, view.eid, mid, W, H, cam.vm, cam.ps.toPrecision(8), S.edges ? 1 : 0].join("|"));

  async function jobsFor(fetchMissing) {
    const view = getView();
    const plan = makePlan(view, S);
    const [W, H] = outputSize(S);
    const bb = await gatherBboxes(view, plan, fetchMissing);
    const cam = cameraForFrames(plan, S, bb.get, W, H);
    const lastMid = plan.frames.length ? plan.frames[plan.frames.length - 1].e.microversionId : null;
    const jobs = plan.frames.map((f, k) => ({ kind: "frame", f, k, mid: f.e.microversionId, cam: cam.cams[k] }));
    cam.reveal.forEach((c, j) => jobs.push({ kind: "reveal", j, mid: lastMid, cam: c }));
    for (const j of jobs) j.key = frameKey(view, j.mid, W, H, j.cam);
    return { view, plan, jobs, W, H, bbMissing: bb.missing, auto: cam.auto };
  }

  // ---------- estimate ----------
  async function updateEstimate() {
    if (!state.an) {
      ui.estimate("Click <b>Analyze</b> to read this tab's history and see how many API calls the timelapse needs.");
      return;
    }
    const r = await jobsFor(false);
    const v = r.view;
    const cached = r.bbMissing ? 0 : r.jobs.filter(j => state.keys.has(j.key)).length;
    const toRender = r.jobs.length - cached;
    const calls = toRender + r.bbMissing;
    const per = Math.max(0.5, num(S.delayMs, 1500) / 1000 + 0.4);
    const mins = Math.ceil(calls * per / 60);
    const nBuild = r.jobs.filter(j => j.kind === "frame").length, nRev = r.jobs.length - nBuild;
    const nVers = r.plan.frames.filter(f => f.versions.length).length;
    const secs = (S.titleCard ? num(S.titleSeconds, 0) : 0) + num(S.buildSeconds, 20) +
      (S.versionHold ? nVers * num(S.versionHoldSec, 0) : 0) + (nRev ? num(S.revealSeconds, 0) : 0) + (S.endCard ? num(S.endSeconds, 0) : 0);
    const big = calls > 300 ? `<div class="warn">That's a lot of calls. Free and EDU Student accounts get 2,500 a year. Lower "Max frames" or "Reveal frames" to use fewer.</div>` : "";
    ui.estimate(
      `<b>${v.elName || "This tab"}</b>: ${v.hist.length} edits · ${v.sessions} session${v.sessions === 1 ? "" : "s"} · ${fmtDuration(v.totalActive)} of modelling<br>` +
      (v.skippedEdits ? `<span style="color:#8a919a">(skipped ${v.skippedEdits} earlier edits from before this tab existed)</span><br>` : "") +
      `Plan: ${nBuild} build frames${nRev ? ` + ${nRev} reveal frames` : ""}${nVers ? ` · ${nVers} version stop${nVers === 1 ? "" : "s"}` : ""}<br>` +
      `Already saved: ${cached} · <b>New API calls: ~${calls}</b>${calls ? ` (≈${mins} min)` : " — ready to make the video"}<br>` +
      `Video: ~${Math.round(secs)} s at ${r.W}×${r.H}${S.format === "gif" ? " (GIF is smaller)" : ""}` + big
    );
  }

  // ---------- rendering ----------
  let workCanvas = null;
  async function processPng(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob0 = new Blob([bytes], { type: "image/png" });
    const bmp = await createImageBitmap(blob0);
    workCanvas = workCanvas || document.createElement("canvas");
    const c = workCanvas;
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const res = removeBackground(img);
    let blob = blob0;
    if (res.changed) {
      ctx.putImageData(img, 0, 0);
      blob = await new Promise(r => c.toBlob(r, "image/png"));
    }
    return { blob, blank: res.blank, sig: hash(b64) };
  }

  async function renderShaded(view, mid, cam, W, H) {
    return api(`/${view.type}/d/${view.did}/m/${mid}/e/${view.eid}/shadedviews`, {
      viewMatrix: cam.vm, outputWidth: W, outputHeight: H, pixelSize: cam.ps, edges: S.edges ? "show" : "hide",
    }, true);
  }

  async function renderFrames() {
    await ensureAnalysis();
    ui.status("Measuring the model …");
    const r = await jobsFor(true);
    const meta = makeMeta(r.view);
    const total = r.jobs.length;
    let done = 0, fails = 0, made = 0;
    for (const j of r.jobs) {
      if (state.stop) throw new Stopped();
      done++;
      if (state.keys.has(j.key)) continue;
      ui.status(`Rendering ${done}/${total} — ${j.kind === "reveal" ? "reveal spin" : cleanDesc(j.f.e.description) || "edit"}`);
      const data = await renderShaded(r.view, j.mid, j.cam, r.W, r.H);
      const b64 = data && data.images && data.images[0];
      if (!b64) {
        if (data || state.lastStatus === 400 || state.lastStatus === 404) {
          await db.put("frames", { key: j.key, missing: true });
          state.keys.add(j.key);
          fails = 0;
        } else if (++fails >= 5) {
          throw new Error(`Onshape keeps refusing to render (status ${state.lastStatus}). Can you open this document normally?`);
        }
        continue;
      }
      fails = 0;
      const p = await processPng(b64);
      await db.put("frames", { key: j.key, blob: p.blob, blank: p.blank, sig: p.sig });
      state.keys.add(j.key);
      made++;
      ui.progress(done / total);
      if (!p.blank) {
        const bmp = await createImageBitmap(p.blob);
        const info = j.kind === "reveal" ? { ...meta.revealInfo, progress: 1 } : { ...frameInfo(j.f.e), progress: j.f.p };
        ui.drawPreview((ctx, w, h) => drawFrame(ctx, w, h, bmp, info));
        bmp.close();
      }
    }
    ui.progress(1);
    ui.status(`All ${total} frames ready (${made} new). Click “Make ${S.format === "gif" ? "GIF" : S.format === "zip" ? "ZIP" : "video"}”.`);
  }

  async function previewTask() {
    await ensureAnalysis();
    ui.status("Rendering preview of the finished model …");
    const r = await jobsFor(true);
    const j = r.jobs.filter(x => x.kind === "frame").pop();
    let rec = state.keys.has(j.key) ? await db.get("frames", j.key) : null;
    if (!rec) {
      const data = await renderShaded(r.view, j.mid, j.cam, r.W, r.H);
      const b64 = data && data.images && data.images[0];
      if (!b64) throw new Error("Onshape returned no image for this tab.");
      const p = await processPng(b64);
      rec = { key: j.key, blob: p.blob, blank: p.blank, sig: p.sig };
      await db.put("frames", rec);
      state.keys.add(j.key);
    }
    const bmp = await createImageBitmap(rec.blob);
    ui.drawPreview((ctx, w, h) => drawFrame(ctx, w, h, bmp, { ...frameInfo(j.f.e), progress: 1, banner: null }));
    bmp.close();
    ui.status(r.auto && !S.autofit
      ? "Preview ready. (Couldn't measure the model, so Onshape auto-fits each frame.)"
      : "Preview of the last frame. Off-centre or cut off? Tick “Let Onshape auto-fit every frame”. Then Render frames.");
  }

  // ---------- drawing ----------
  const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

  function hexLum(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  }

  function theme() {
    const b = S.background;
    const c1 = b === "white" ? "#ffffff" : b === "light" ? "#eef1f5" : b === "dark" ? "#1d2025" : (S.bgColor1 || "#ffffff");
    const c2 = b === "gradient" ? (S.bgColor2 || c1) : c1;
    const dark = (hexLum(c1) + hexLum(c2)) / 2 < 0.45;
    return {
      c1, c2, dark,
      text: dark ? "#f3f4f6" : "#20242b",
      sub: dark ? "rgba(243,244,246,.72)" : "rgba(32,36,43,.62)",
      accent: "#2f80ed",
      track: dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.08)",
    };
  }

  function drawBg(ctx, w, h, T) {
    if (T.c1 === T.c2) ctx.fillStyle = T.c1;
    else { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, T.c1); g.addColorStop(1, T.c2); ctx.fillStyle = g; }
    ctx.fillRect(0, 0, w, h);
  }

  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }

  function pill(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  function frameInfo(e) {
    return { desc: cleanDesc(e.description), user: e.username || "", date: new Date(e.t), modelMs: e.active };
  }

  const fmtDate = d => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const fmtTime = d => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  function drawFrame(ctx, w, h, bmp, info) {
    const T = theme();
    drawBg(ctx, w, h, T);
    if (bmp) ctx.drawImage(bmp, 0, 0, w, h);
    const u = Math.min(w, h) / 1080, pad = Math.round(44 * u);
    ctx.save();
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    let y = pad;
    if (S.showDesc && info.desc) {
      ctx.font = `600 ${Math.round(38 * u)}px ${FONT}`; ctx.fillStyle = T.text;
      ctx.fillText(fitText(ctx, info.desc, w * 0.56), pad, y); y += Math.round(52 * u);
    }
    if (S.showUser && info.user) {
      ctx.font = `400 ${Math.round(26 * u)}px ${FONT}`; ctx.fillStyle = T.sub;
      ctx.fillText(fitText(ctx, info.user, w * 0.56), pad, y);
    }
    ctx.textAlign = "right";
    let y2 = pad;
    if (S.showClock && info.date && !isNaN(info.date)) {
      ctx.font = `600 ${Math.round(30 * u)}px ${FONT}`; ctx.fillStyle = T.text;
      ctx.fillText(fmtDate(info.date), w - pad, y2); y2 += Math.round(40 * u);
      ctx.font = `400 ${Math.round(26 * u)}px ${FONT}`; ctx.fillStyle = T.sub;
      ctx.fillText(fmtTime(info.date), w - pad, y2); y2 += Math.round(44 * u);
    }
    if (S.showModelTime && info.modelMs != null) {
      ctx.font = `600 ${Math.round(30 * u)}px ${FONT}`; ctx.fillStyle = T.text;
      ctx.fillText(fmtDuration(info.modelMs), w - pad, y2); y2 += Math.round(40 * u);
      ctx.font = `400 ${Math.round(22 * u)}px ${FONT}`; ctx.fillStyle = T.sub;
      ctx.fillText("modelling time", w - pad, y2);
    }
    ctx.textAlign = "left";
    const barH = Math.max(4, Math.round(8 * u));
    if (info.banner) {
      ctx.font = `600 ${Math.round(28 * u)}px ${FONT}`;
      const text = fitText(ctx, info.banner, w - 2 * pad - 40 * u);
      const tw = ctx.measureText(text).width, bh = Math.round(52 * u);
      const by = h - pad - bh - (S.showProgress ? barH : 0);
      ctx.fillStyle = T.accent;
      pill(ctx, pad, by, tw + 40 * u, bh, bh / 2);
      ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
      ctx.fillText(text, pad + 20 * u, by + bh / 2);
    }
    if (S.showProgress && info.progress != null) {
      ctx.fillStyle = T.track; ctx.fillRect(0, h - barH, w, barH);
      ctx.fillStyle = T.accent; ctx.fillRect(0, h - barH, w * clamp(info.progress, 0, 1), barH);
    }
    ctx.restore();
  }

  function centerText(ctx, text, y, size, weight, color, maxW, w) {
    let s = size;
    ctx.font = `${weight} ${Math.round(s)}px ${FONT}`;
    while (ctx.measureText(text).width > maxW && s > 12) { s *= 0.92; ctx.font = `${weight} ${Math.round(s)}px ${FONT}`; }
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, y);
  }

  function drawTitle(ctx, w, h, fin, meta, alpha) {
    const T = theme(), u = Math.min(w, h) / 1080;
    drawBg(ctx, w, h, T);
    ctx.save();
    if (fin) { ctx.globalAlpha = alpha * 0.13; ctx.drawImage(fin, 0, 0, w, h); }
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const cy = h * 0.46;
    ctx.fillStyle = T.accent;
    pill(ctx, w / 2 - 60 * u, cy - 110 * u, 120 * u, 8 * u, 4 * u);
    centerText(ctx, meta.title, cy - 30 * u, 92 * u, 700, T.text, w * 0.86, w);
    if (meta.subtitle) centerText(ctx, meta.subtitle, cy + 52 * u, 42 * u, 400, T.text, w * 0.86, w);
    centerText(ctx, meta.dates, cy + (meta.subtitle ? 118 : 60) * u, 28 * u, 400, T.sub, w * 0.86, w);
    ctx.restore();
  }

  function drawEnd(ctx, w, h, fin, meta, alpha) {
    const T = theme(), u = Math.min(w, h) / 1080;
    drawBg(ctx, w, h, T);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (fin) {
      const sc = 0.66, dw = w * sc, dh = h * sc;
      ctx.drawImage(fin, (w - dw) / 2, h * 0.04, dw, dh);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const y = h * 0.04 + h * 0.66 + 40 * u;
    centerText(ctx, meta.title, y + 10 * u, 60 * u, 700, T.text, w * 0.86, w);
    centerText(ctx, meta.stats, y + 76 * u, 30 * u, 500, T.text, w * 0.9, w);
    centerText(ctx, meta.dates, y + 122 * u, 26 * u, 400, T.sub, w * 0.9, w);
    if (meta.subtitle) centerText(ctx, meta.subtitle, y + 164 * u, 26 * u, 400, T.sub, w * 0.9, w);
    ctx.font = `400 ${Math.round(20 * u)}px ${FONT}`; ctx.fillStyle = T.sub; ctx.textBaseline = "bottom";
    ctx.fillText("Made with Onshape Timelapse", w / 2, h - 18 * u);
    ctx.restore();
  }

  function makeMeta(view) {
    const H = view.hist, first = H[0], last = H[H.length - 1];
    const d0 = new Date(first.t), d1 = new Date(last.t);
    const dates = fmtDate(d0) === fmtDate(d1) ? fmtDate(d0) : `${fmtDate(d0)} – ${fmtDate(d1)}`;
    return {
      title: (S.title || "").trim() || view.elName || view.docName || "My model",
      subtitle: (S.subtitle || "").trim(),
      dates,
      stats: `${fmtDuration(view.totalActive)} of modelling · ${H.length} edits · ${view.sessions} session${view.sessions === 1 ? "" : "s"}`,
      revealInfo: { desc: "Finished", user: "", date: d1, modelMs: view.totalActive },
    };
  }

  function drawShot(ctx, w, h, sh, tt, g, bmp, fin, tl, meta, animate) {
    const fade = Math.max(1, Math.round(0.35 * tl.fps));
    if (sh.type === "title") {
      return drawTitle(ctx, w, h, fin, meta, animate ? Math.min(1, (tt + 1) / fade, (sh.ticks - tt) / fade) : 1);
    }
    if (sh.type === "end") return drawEnd(ctx, w, h, fin, meta, animate ? Math.min(1, (tt + 1) / fade) : 1);
    const info = sh.type === "reveal" ? { ...meta.revealInfo, progress: 1 } : frameInfo(sh.k.f.e);
    if (sh.type === "frame") info.progress = clamp((sh.b0 + (sh.hold ? 0 : tt)) / Math.max(1, tl.buildTicks), 0, 1);
    const b = tl.banners.find(x => g >= x.from && g < x.to);
    info.banner = b ? b.text : null;
    drawFrame(ctx, w, h, bmp, info);
  }

  class BitmapCache {
    constructor(max) { this.max = max; this.m = new Map(); }
    get(key) {
      let p = this.m.get(key);
      if (p) { this.m.delete(key); this.m.set(key, p); return p; }
      p = db.get("frames", key).then(rec => (rec && rec.blob ? createImageBitmap(rec.blob) : null));
      this.m.set(key, p);
      while (this.m.size > this.max) {
        const [k, old] = this.m.entries().next().value;
        this.m.delete(k);
        old.then(b => b && b.close && b.close()).catch(() => {});
      }
      return p;
    }
  }

  // ---------- output ----------
  async function collectTimeline() {
    await ensureAnalysis();
    const r = await jobsFor(false);
    if (r.bbMissing) throw new Error("Nothing rendered with these settings yet — click “Render frames” first.");
    const kept = [];
    let lastSig = null, notReady = 0;
    const canSkip = S.skipUnchanged && !num(S.orbit, 0) && !S.zoomFollow;
    for (const j of r.jobs.filter(x => x.kind === "frame")) {
      if (!state.keys.has(j.key)) notReady++;
      const rec = state.keys.has(j.key) ? await db.get("frames", j.key) : null;
      const usable = rec && rec.blob && !rec.blank;
      if (!usable || (canSkip && rec.sig === lastSig && kept.length)) {
        if (kept.length) for (const v of j.f.versions) if (!kept[kept.length - 1].versions.includes(v)) kept[kept.length - 1].versions.push(v);
        continue;
      }
      lastSig = rec.sig;
      kept.push({ key: j.key, f: j.f, versions: [...j.f.versions], w: j.f.w });
    }
    const reveal = [];
    for (const j of r.jobs.filter(x => x.kind === "reveal")) {
      if (!state.keys.has(j.key)) { notReady++; continue; }
      const rec = await db.get("frames", j.key);
      if (rec && rec.blob && !rec.blank) reveal.push(j.key);
    }
    if (!kept.length) throw new Error("No rendered frames match the current settings. Click “Render frames” first. (Camera, size, frame count and pacing changes need new renders.)");
    const tl = buildTimeline(kept, reveal, S);
    return { r, tl, meta: makeMeta(r.view), finKey: kept[kept.length - 1].key, notReady };
  }

  async function makeOutput() {
    const c = await collectTimeline();
    const note = c.notReady ? ` (${c.notReady} frames weren't rendered yet, so they're left out)` : "";
    const base = safeName(c.meta.title) + "_timelapse";
    if (S.format === "gif") await makeGif(c, base);
    else if (S.format === "zip") await makeZip(c, base);
    else await makeVideo(c, base);
    ui.status(ui.lastStatus + note);
  }

  const safeName = s => (String(s || "onshape").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "onshape");

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }

  async function makeVideo(c, base) {
    const { tl, meta } = c, [W, H] = [c.r.W, c.r.H];
    const types = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = root.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error("This browser can't record video. Use Chrome or Edge, or choose GIF / ZIP output.");
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const manual = track && typeof track.requestFrame === "function";
    const rec = new MediaRecorder(manual ? stream : canvas.captureStream(tl.fps),
      { mimeType: mime, videoBitsPerSecond: Math.round(W * H * tl.fps * 0.16) });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });

    const cache = new BitmapCache(16);
    const fin = await db.get("frames", c.finKey).then(x => createImageBitmap(x.blob));
    const shots = tl.shots;
    drawShot(ctx, W, H, shots[0], 0, 0, shots[0].key ? await cache.get(shots[0].key) : null, fin, tl, meta, true);
    rec.start(1000);
    const dt = 1000 / tl.fps, t0 = performance.now();
    let g = 0;
    if (document.hidden) ui.status("Keep this tab visible while recording, or the video will stutter.", true);
    try {
      for (let si = 0; si < shots.length; si++) {
        const sh = shots[si];
        for (let a = 1; a <= 6 && si + a < shots.length; a++) if (shots[si + a].key) cache.get(shots[si + a].key);
        const bmp = sh.key ? await cache.get(sh.key) : null;
        for (let tt = 0; tt < sh.ticks; tt++, g++) {
          if (state.stop) throw new Stopped();
          drawShot(ctx, W, H, sh, tt, g, bmp, fin, tl, meta, true);
          if (manual) track.requestFrame();
          if (g % 3 === 0) ui.drawPreview((pctx, pw, ph) => pctx.drawImage(canvas, 0, 0, pw, ph));
          if (g % tl.fps === 0) { ui.status(`Recording video … ${Math.round(g / tl.fps)} / ${Math.round(tl.total / tl.fps)} s — keep this tab visible`); ui.progress(g / tl.total); }
          const wait = t0 + (g + 1) * dt - performance.now();
          if (wait > 0) await sleep(wait);
        }
      }
    } finally {
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      fin.close && fin.close();
    }
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    download(new Blob(chunks, { type: mime.split(";")[0] }), `${base}.${ext}`);
    ui.progress(1);
    ui.status(`Done! Downloaded ${base}.${ext} (${Math.round(tl.total / tl.fps)} s).${ext === "webm" ? " WebM plays in browsers and VLC." : ""}`);
  }

  // one still image per shot, with how long it is shown
  function stills(tl) {
    return tl.shots.filter(sh => sh.ticks > 0).map(sh => ({ sh, sec: sh.ticks / tl.fps }));
  }

  async function makeGif(c, base) {
    const { tl, meta } = c;
    const gw = Math.round(clamp(num(S.gifWidth, 640), 160, 1280) / 2) * 2;
    const gh = Math.round(gw * c.r.H / c.r.W / 2) * 2;
    const canvas = document.createElement("canvas");
    canvas.width = gw; canvas.height = gh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const items = stills(tl);
    const cache = new BitmapCache(8);
    const fin = await db.get("frames", c.finKey).then(x => createImageBitmap(x.blob));
    const compose = async it => {
      const bmp = it.sh.key ? await cache.get(it.sh.key) : null;
      drawShot(ctx, gw, gh, it.sh, 0, it.sh.start, bmp, fin, tl, meta, false);
      return ctx.getImageData(0, 0, gw, gh).data;
    };
    ui.status("Building GIF colour palette …");
    const samples = [];
    const step = Math.max(1, Math.floor(items.length / 14));
    for (let i = 0; i < items.length; i += step) samples.push(new Uint8ClampedArray(await compose(items[i])));
    samples.push(new Uint8ClampedArray(await compose(items[items.length - 1])));
    const pal = buildPalette(samples);
    const gif = gifWriter(gw, gh, pal.flat);
    const idx = new Uint8Array(gw * gh);
    let carry = 0;
    for (let i = 0; i < items.length; i++) {
      if (state.stop) throw new Stopped();
      const d = await compose(items[i]);
      for (let p = 0, o = 0; p < idx.length; p++, o += 4) idx[p] = pal.indexOf(d[o], d[o + 1], d[o + 2]);
      const exact = items[i].sec * 100 + carry;
      const cs = Math.max(2, Math.round(exact));
      carry = exact - cs;
      gif.addFrame(idx, cs);
      ui.drawPreview((pctx, pw, ph) => pctx.drawImage(canvas, 0, 0, pw, ph));
      ui.progress((i + 1) / items.length);
      ui.status(`Encoding GIF … frame ${i + 1}/${items.length}`);
      if (i % 4 === 0) await sleep(0);
    }
    fin.close && fin.close();
    download(new Blob(gif.finish(), { type: "image/gif" }), `${base}.gif`);
    ui.status(`Done! Downloaded ${base}.gif (${gw}×${gh}, ${items.length} frames).`);
  }

  async function makeZip(c, base) {
    const { tl, meta } = c, [W, H] = [c.r.W, c.r.H];
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const items = stills(tl);
    const cache = new BitmapCache(8);
    const fin = await db.get("frames", c.finKey).then(x => createImageBitmap(x.blob));
    const files = [];
    const csv = ["file,seconds,type,description"];
    const concat = ["ffconcat version 1.0"];
    for (let i = 0; i < items.length; i++) {
      if (state.stop) throw new Stopped();
      const it = items[i];
      const bmp = it.sh.key ? await cache.get(it.sh.key) : null;
      drawShot(ctx, W, H, it.sh, 0, it.sh.start, bmp, fin, tl, meta, false);
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = `${String(i + 1).padStart(4, "0")}.png`;
      files.push({ name: `frames/${name}`, data: blob, crc: crc32(bytes), size: bytes.length });
      const desc = it.sh.type === "frame" ? cleanDesc(it.sh.k.f.e.description).replace(/"/g, "'") : it.sh.type;
      csv.push(`${name},${it.sec.toFixed(3)},${it.sh.type}${it.sh.hold ? "-hold" : ""},"${desc}"`);
      concat.push(`file ${name}`, `duration ${it.sec.toFixed(3)}`);
      ui.progress((i + 1) / items.length);
      ui.status(`Saving frames … ${i + 1}/${items.length}`);
      if (i % 4 === 0) await sleep(0);
    }
    concat.push(`file ${String(items.length).padStart(4, "0")}.png`);
    const enc = new TextEncoder();
    const addText = (name, text) => { const b = enc.encode(text); files.push({ name, data: b, crc: crc32(b), size: b.length }); };
    addText("frames/timing.csv", csv.join("\n") + "\n");
    addText("frames/frames.ffconcat", concat.join("\n") + "\n");
    addText("README.txt",
      "Frames from Onshape Timelapse.\n\n" +
      "timing.csv lists how long each frame is shown, so you can rebuild the timing in any video editor.\n\n" +
      "To make an MP4 with ffmpeg, run this inside the frames folder:\n" +
      "  ffmpeg -f concat -i frames.ffconcat -vf \"fps=" + tl.fps + ",format=yuv420p\" -c:v libx264 timelapse.mp4\n");
    fin.close && fin.close();
    download(new Blob(zipParts(files), { type: "application/zip" }), `${base}_frames.zip`);
    ui.status(`Done! Downloaded ${base}_frames.zip (${items.length} PNG frames + timing).`);
  }

  // ---------- UI ----------
  const FIELDS = [
    ["Camera", true, [
      { k: "camera", t: "select", label: "View", opts: [["iso", "Isometric"], ["front", "Front"], ["top", "Top"], ["right", "Right"], ["custom", "Custom angle"]] },
      { k: "azimuth", t: "number", label: "Azimuth (°)", step: 5, show: s => s.camera === "custom" },
      { k: "elevation", t: "number", label: "Elevation (°)", step: 5, min: -90, max: 90, show: s => s.camera === "custom" },
      { k: "orbit", t: "number", label: "Orbit during build (°)", step: 45, help: "0 = still camera · 360 = one full turn · negative = other way" },
      { k: "orbitEase", t: "check", label: "Ease the orbit in and out", show: s => +s.orbit !== 0 },
      { k: "reveal", t: "check", label: "360° reveal spin at the end" },
      { k: "revealFrames", t: "number", label: "Reveal frames (1 API call each)", min: 4, max: 360, step: 4, show: s => s.reveal },
      { k: "revealSeconds", t: "number", label: "Reveal length (s)", min: 1, max: 30, step: 0.5, show: s => s.reveal },
      { k: "zoomFollow", t: "check", label: "Zoom follows the model as it grows", show: s => !s.autofit },
      { k: "zoomKeyframes", t: "number", label: "Zoom checkpoints (1 API call each)", min: 2, max: 40, show: s => s.zoomFollow && !s.autofit },
      { k: "margin", t: "number", label: "Framing margin", min: 0.5, max: 3, step: 0.05, show: s => !s.autofit, help: "Bigger = more space around the model" },
      { k: "autofit", t: "check", label: "Let Onshape auto-fit every frame (use if framing is off)" },
      { k: "edges", t: "check", label: "Show edges" },
    ]],
    ["Frames & timing", false, [
      { k: "maxFrames", t: "number", label: "Max build frames (1 API call each)", min: 2, max: 2000, step: 10 },
      { k: "pacing", t: "select", label: "Pacing", opts: [["edits", "Each edit gets equal time"], ["time", "Real time (breaks removed)"]] },
      { k: "breakMinutes", t: "number", label: "A gap longer than this is a break (min)", min: 1, max: 600, step: 5 },
      { k: "skipUnchanged", t: "check", label: "Skip edits with no visible change", show: s => !+s.orbit && !s.zoomFollow, help: "e.g. sketch-only edits" },
      { k: "buildSeconds", t: "number", label: "Build length (s)", min: 2, max: 600, step: 1 },
      { k: "ramp", t: "range", label: "Speed ramp (start slow → end fast)", min: 0, max: 3, step: 0.25 },
      { k: "versionHold", t: "check", label: "Pause at named versions" },
      { k: "versionHoldSec", t: "number", label: "Pause length (s)", min: 0.2, max: 10, step: 0.1, show: s => s.versionHold || s.showVersions },
      { k: "fps", t: "number", label: "Frames per second", min: 5, max: 60, step: 1 },
    ]],
    ["Overlays", false, [
      { k: "showDesc", t: "check", label: "What changed (e.g. “Insert feature: Extrude 3”)" },
      { k: "showUser", t: "check", label: "Who made the change" },
      { k: "showClock", t: "check", label: "Date and time" },
      { k: "showModelTime", t: "check", label: "Modelling time counter" },
      { k: "showProgress", t: "check", label: "Progress bar" },
      { k: "showVersions", t: "check", label: "Version name banner" },
      { k: "titleCard", t: "check", label: "Title card" },
      { k: "title", t: "text", label: "Title", placeholder: "Defaults to the tab name", show: s => s.titleCard || s.endCard },
      { k: "subtitle", t: "text", label: "Subtitle", placeholder: "e.g. your name / club", show: s => s.titleCard || s.endCard },
      { k: "titleSeconds", t: "number", label: "Title length (s)", min: 0.5, max: 15, step: 0.5, show: s => s.titleCard },
      { k: "endCard", t: "check", label: "End card with stats" },
      { k: "endSeconds", t: "number", label: "End card length (s)", min: 0.5, max: 15, step: 0.5, show: s => s.endCard },
    ]],
    ["Look & size", false, [
      { k: "background", t: "select", label: "Background", opts: [["gradient", "Gradient"], ["white", "White"], ["light", "Light grey"], ["dark", "Dark"], ["custom", "Custom colour"]] },
      { k: "bgColor1", t: "color", label: "Colour", show: s => s.background === "custom" || s.background === "gradient" },
      { k: "bgColor2", t: "color", label: "Bottom colour", show: s => s.background === "gradient" },
      { k: "aspect", t: "select", label: "Shape", opts: [["16:9", "16:9 — YouTube"], ["1:1", "1:1 — Instagram post"], ["4:5", "4:5 — Instagram portrait"], ["9:16", "9:16 — Reels / TikTok / Shorts"]] },
      { k: "resolution", t: "select", label: "Quality", opts: [["720", "720p"], ["1080", "1080p"]] },
    ]],
    ["Output", false, [
      { k: "format", t: "select", label: "Make", opts: [["video", "Video (MP4 / WebM)"], ["gif", "GIF"], ["zip", "ZIP of PNG frames"]] },
      { k: "gifWidth", t: "number", label: "GIF width (px)", min: 160, max: 1280, step: 40, show: s => s.format === "gif" },
    ]],
    ["Advanced", false, [
      { k: "delayMs", t: "number", label: "Pause between API calls (ms)", min: 0, max: 20000, step: 250, help: "Longer = less likely to be rate-limited" },
    ]],
  ];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ${FONT}; }
    .launch { position: fixed; right: 18px; bottom: 64px; z-index: 2; border: 0; border-radius: 20px; padding: 8px 14px;
      background: #2f80ed; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    .panel { position: fixed; right: 16px; top: 56px; width: 390px; max-height: calc(100vh - 130px); overflow: auto; z-index: 3;
      background: #fff; color: #1f2329; border-radius: 12px; box-shadow: 0 6px 30px rgba(0,0,0,.28); font-size: 13px; }
    .panel[hidden], .launch[hidden] { display: none; }
    header { position: sticky; top: 0; background: #fff; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #e6e8eb; z-index: 1; }
    header b { font-size: 14px; } header .ver { color: #8a919a; font-size: 11px; } header .x { margin-left: auto; }
    .body { padding: 10px 12px 14px; }
    canvas.pv { width: 100%; max-height: 300px; object-fit: contain; background: #eef1f4; border-radius: 8px; display: block; }
    .bar { height: 4px; background: #e9ecef; border-radius: 2px; margin: 8px 0 6px; overflow: hidden; }
    .bar > div { height: 100%; width: 0; background: #2f80ed; transition: width .2s; }
    .status { min-height: 34px; line-height: 1.35; color: #3a4048; }
    .status.warn { color: #b25e00; }
    .calls { color: #8a919a; font-size: 11px; margin-top: 2px; }
    .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 10px 0; }
    button { font: inherit; border: 1px solid #cfd4da; background: #f7f8fa; color: #1f2329; border-radius: 7px; padding: 7px 8px; cursor: pointer; }
    button:hover:not(:disabled) { background: #eef1f4; }
    button:disabled { opacity: .45; cursor: default; }
    button.primary { background: #2f80ed; border-color: #2f80ed; color: #fff; font-weight: 600; }
    button.primary:hover:not(:disabled) { background: #2a72d4; }
    button.stop { grid-column: span 2; border-color: #e0a3a3; color: #b42318; background: #fff; }
    .est { background: #f5f7fa; border-radius: 8px; padding: 8px 10px; line-height: 1.5; margin-bottom: 8px; }
    .est .warn { color: #b25e00; margin-top: 4px; }
    details { border-top: 1px solid #eceef1; padding: 6px 0; }
    summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; }
    .row.check { justify-content: flex-start; }
    .row input[type=number], .row input[type=text], .row select { width: 150px; font: inherit; padding: 4px 6px;
      border: 1px solid #cfd4da; border-radius: 6px; background: #fff; color: #1f2329; }
    .row input[type=range] { width: 150px; }
    .row input[type=color] { width: 60px; height: 26px; border: 1px solid #cfd4da; border-radius: 6px; padding: 1px; }
    .help { color: #8a919a; font-size: 11px; margin: -2px 0 4px; }
    .row[hidden], .help[hidden] { display: none; }
    .foot { display: flex; gap: 6px; margin-top: 8px; }
    .foot button { flex: 1; font-size: 12px; }
  `;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fieldHtml(f) {
    const v = S[f.k];
    let input;
    if (f.t === "select") input = `<select>${f.opts.map(([val, lab]) => `<option value="${val}"${String(v) === val ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`;
    else if (f.t === "check") input = `<input type="checkbox"${v ? " checked" : ""}>`;
    else if (f.t === "text") input = `<input type="text" value="${esc(v || "")}" placeholder="${esc(f.placeholder || "")}">`;
    else if (f.t === "color") input = `<input type="color" value="${esc(v)}">`;
    else input = `<input type="${f.t === "range" ? "range" : "number"}" value="${esc(v)}"${f.min != null ? ` min="${f.min}"` : ""}${f.max != null ? ` max="${f.max}"` : ""}${f.step != null ? ` step="${f.step}"` : ""}>`;
    const row = f.t === "check"
      ? `<label class="row check" data-k="${f.k}">${input}<span>${esc(f.label)}</span></label>`
      : `<label class="row" data-k="${f.k}"><span>${esc(f.label)}${f.t === "range" ? ` <b class="rv">${v}</b>` : ""}</span>${input}</label>`;
    return row + (f.help ? `<div class="help" data-h="${f.k}">${esc(f.help)}</div>` : "");
  }

  function createUi() {
    const host = document.createElement("div");
    host.id = "os-timelapse-host";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${CSS}</style>
      <button class="launch" title="Onshape Timelapse">⏱ Timelapse</button>
      <div class="panel" hidden>
        <header><b>⏱ Onshape Timelapse</b><span class="ver">v${VERSION}</span><button class="x" data-act="close" title="Close">✕</button></header>
        <div class="body">
          <canvas class="pv" width="640" height="360"></canvas>
          <div class="bar"><div></div></div>
          <div class="status">Open a Part Studio or Assembly tab, then click Preview.</div>
          <div class="calls"></div>
          <div class="acts">
            <button data-act="preview">1 · Preview</button>
            <button data-act="analyze">2 · Analyze</button>
            <button data-act="render">3 · Render frames</button>
            <button data-act="make" class="primary">4 · Make video</button>
            <button data-act="stop" class="stop" disabled>Stop</button>
          </div>
          <div class="est"></div>
          ${FIELDS.map(([title, open, fs]) => `<details${open ? " open" : ""}><summary>${esc(title)}</summary>${fs.map(fieldHtml).join("")}</details>`).join("")}
          <div class="foot">
            <button data-act="reset">Reset settings</button>
            <button data-act="clear">Delete saved frames</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host);
    const $ = s => sh.querySelector(s);
    const panel = $(".panel"), launch = $(".launch"), pv = $("canvas.pv");
    for (const ev of ["keydown", "keyup", "keypress", "wheel", "mousedown", "pointerdown", "contextmenu"]) {
      panel.addEventListener(ev, e => e.stopPropagation());
    }
    const api_ = {
      lastStatus: "",
      status(msg, warn) { api_.lastStatus = msg; const el = $(".status"); el.textContent = msg; el.classList.toggle("warn", !!warn); },
      progress(f) { $(".bar > div").style.width = `${Math.round(clamp(f, 0, 1) * 100)}%`; },
      calls() { $(".calls").textContent = `API calls this session: ${state.calls}`; },
      estimate(html) { $(".est").innerHTML = html; },
      drawPreview(fn) {
        const [W, H] = outputSize(S);
        const pw = 640, ph = Math.round(640 * H / W);
        if (pv.width !== pw || pv.height !== ph) { pv.width = pw; pv.height = ph; }
        fn(pv.getContext("2d"), pw, ph);
      },
      busy(b) {
        sh.querySelectorAll("button[data-act]").forEach(btn => {
          const a = btn.dataset.act;
          if (a === "stop") btn.disabled = !b; else if (a !== "close") btn.disabled = b;
        });
      },
      refresh() {
        for (const [, , fs] of FIELDS) for (const f of fs) {
          const vis = !f.show || f.show(S);
          const row = sh.querySelector(`[data-k="${f.k}"]`), help = sh.querySelector(`[data-h="${f.k}"]`);
          if (row) row.hidden = !vis;
          if (help) help.hidden = !vis;
        }
        $('[data-act="make"]').textContent = `4 · Make ${S.format === "gif" ? "GIF" : S.format === "zip" ? "ZIP" : "video"}`;
      },
      open() { panel.hidden = false; launch.hidden = true; },
      close() { panel.hidden = true; launch.hidden = false; },
      destroy() { host.remove(); },
    };

    for (const [, , fs] of FIELDS) for (const f of fs) {
      const row = sh.querySelector(`[data-k="${f.k}"]`);
      const input = row.querySelector("input, select");
      const handler = () => {
        let v;
        if (f.t === "check") v = input.checked;
        else if (f.t === "number" || f.t === "range") { v = parseFloat(input.value); if (!Number.isFinite(v)) return; }
        else if (f.t === "select" && f.k === "resolution") v = parseInt(input.value, 10);
        else v = input.value;
        S[f.k] = v;
        if (f.t === "range") row.querySelector(".rv").textContent = v;
        saveSettings();
        api_.refresh();
        scheduleEstimate();
      };
      input.addEventListener(f.t === "text" || f.t === "number" ? "input" : "change", handler);
      if (f.t === "range") input.addEventListener("input", handler);
    }

    launch.addEventListener("click", () => api_.open());
    sh.addEventListener("click", e => {
      const btn = e.target.closest && e.target.closest("button[data-act]");
      if (!btn) return;
      const a = btn.dataset.act;
      if (a === "close") api_.close();
      else if (a === "stop") { state.stop = true; api_.status("Stopping …"); }
      else if (a === "preview") runTask(previewTask);
      else if (a === "analyze") runTask(async () => { await analyze(); await updateEstimate(); api_.status("Analyzed. Check the estimate, then click Render frames."); });
      else if (a === "render") runTask(async () => { await renderFrames(); await updateEstimate(); });
      else if (a === "make") runTask(makeOutput);
      else if (a === "reset") {
        if (!confirm("Reset all timelapse settings to defaults?")) return;
        Object.assign(S, DEFAULTS); saveSettings();
        const wasOpen = !panel.hidden; host.remove();
        const fresh = buildFreshUi(); if (wasOpen) fresh.open();
      } else if (a === "clear") {
        if (!confirm("Delete all saved timelapse frames from this browser? You'd need API calls to render them again.")) return;
        runTask(async () => { await db.clear("frames"); state.keys.clear(); await updateEstimate(); api_.status("Saved frames deleted."); });
      }
    });
    api_.refresh();
    api_.calls();
    return api_;
  }

  let ui = null;
  function buildFreshUi() { ui = createUi(); scheduleEstimate(); return ui; }

  let estTimer = null;
  function scheduleEstimate() {
    clearTimeout(estTimer);
    estTimer = setTimeout(() => { if (!state.busy) updateEstimate().catch(e => console.warn("[timelapse]", e)); }, 300);
  }

  async function runTask(fn) {
    if (state.busy) return;
    state.busy = true; state.stop = false; ui.busy(true);
    try { await fn(); }
    catch (e) {
      if (e instanceof Stopped) ui.status("Stopped. Rendered frames are saved — “Make video” uses whatever is ready, and Render continues later.");
      else { console.error("[timelapse]", e); ui.status("⚠ " + e.message, true); }
    } finally {
      state.busy = false; state.stop = false; ui.busy(false);
    }
  }

  // ---------- start ----------
  buildFreshUi();
  db.keys("frames").then(k => { k.forEach(x => state.keys.add(x)); scheduleEstimate(); })
    .catch(e => ui.status("Browser storage unavailable — frames won't be saved between runs. (" + e.message + ")", true));

  root.__osTimelapse = {
    version: VERSION,
    open: () => ui.open(),
    destroy: () => { state.stop = true; ui.destroy(); },
  };

  const fromUserscript = typeof GM_info !== "undefined";
  if (!fromUserscript) ui.open();
})();