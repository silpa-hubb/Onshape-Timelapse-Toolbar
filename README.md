# ⏱ Onshape Timelapse Toolbar

Make a timelapse video of how an Onshape model was built, straight from the document history.
No screen recording, no API key, nothing to install except (optionally) Tampermonkey.

Onshape records every change you make as a *microversion*. This script asks Onshape to render
your Part Studio or Assembly as it looked at each point in that history, then turns the images
into a video, GIF or a folder of frames.

## Features

- **Settings panel** inside Onshape, with a live preview
- **API-call estimate** before you render anything
- **Saved progress**: frames are stored in your browser. If you get rate-limited or close the tab, Render continues where it stopped, and re-making the video with different timing or overlays costs no API calls
- **Gentle pacing** between requests, plus a countdown if Onshape rate-limits you
- **Camera**: isometric / front / top / right / custom angle, orbit with easing, final 360° reveal spin, and zoom that follows the model as it grows
- **Overlays**: what changed ("Insert feature: Extrude 3"), who changed it, date and time, modelling-time counter, progress bar, version-name banners
- **Title card and end card** with stats (modelling time, number of edits, sessions)
- **Pauses at named versions**
- **Timing**: equal time per edit, or real time with breaks removed, plus a speed ramp
- **Look**: gradient, white, light, dark or custom background
- **Shapes**: 16:9 (YouTube), 1:1 and 4:5 (Instagram), 9:16 (Reels / TikTok / Shorts), in 720p or 1080p
- **Output**: MP4/WebM video, GIF, or a ZIP of PNG frames with timing (for CapCut, Premiere or ffmpeg)
- Works with **Part Studios and Assemblies**

## Install

**Option A: Tampermonkey (one click every time)**
1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `Onshape-Timelapse-Toolbar.user.js` and install it in Tampermonkey.
3. A **⏱ Timelapse** button appears in Onshape, at the bottom right.

**Option B: no install**
1. Open a Part Studio or Assembly tab in Onshape.
2. Press **F12** (Mac: **Cmd + Option + J**) and open the **Console** tab.
3. Paste the whole `Onshape-Timelapse-Toolbar.user.js` file and press Enter. (Chrome may ask you to type `allow pasting` first.)

## Use

1. **Preview**: renders the finished model so you can check the camera and overlays.
2. **Analyze**: reads the history and shows how many API calls the render will use.
3. **Render frames**: downloads the frames. You can stop at any time; progress is saved.
4. **Make video / GIF / ZIP**: builds the file and downloads it. Keep the tab visible while a video records.

Changing the camera, size, frame count or pacing needs new renders (frames you already rendered
with the same settings are reused). Changing timing lengths, overlays, title/end cards,
background or output format does **not** cost any API calls.

## API limits: please read

Every rendered frame is one Onshape API call. Onshape limits API calls per year
(for example **2,500 per user on Free and EDU Student plans**, see
[Onshape's API limits](https://onshape-public.github.io/docs/auth/limits/)). Onshape also
rate-limits bursts of requests. Recommended:

- Start with **Max build frames = 50** to try out settings, then do one bigger render.
- Keep **Reveal frames** around 36–48.
- Leave **Pause between API calls** at 1500 ms or more.

## Limitations

- The images are Onshape's flat (orthographic) shaded views. There's no perspective camera, and sketches aren't shown.
- If Onshape returns images with a solid background, the script removes it from the edges inwards, so holes enclosed by the model may keep the original background colour.
- The video is recorded in real time, so a 30-second video takes 30 seconds to make. Chrome and Edge make MP4; other browsers may make WebM.
- The script uses your logged-in Onshape session and only reads data. It never changes your documents.

## Credits

Made by Silpa Chaiburum.
Uses the Onshape REST API: `documenthistory`, `versions`, `boundingboxes` and `shadedviews`.
