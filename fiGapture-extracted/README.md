# fiGapture

fiGapture is a dependency-free Chrome extension (Manifest V3) for capturing a
webpage or selected DOM elements and copying them to Figma as editable design
layers.

## Features

- Capture the visible viewport or a full page.
- Select one or multiple DOM elements with visual measurements.
- Preview responsive mobile and desktop widths.
- Inspect and copy page assets, including directly-hosted page videos
  (the Asset Grabber's Video tab — see note below).
- Export full-page screenshots as PNG or PDF.
- Re-copy recent captures from local history.

## Project structure

```text
fiGapture/
├── assets/
│   ├── icons/                 UI icons
│   └── system-asset/          Extension and brand icons
├── pages/
│   ├── offscreen/             Reliable editable-capture clipboard writer
│   ├── screenshot/            Full-page screenshot preview/export page
│   └── viewer/                SVG and image asset viewer
├── src/
│   ├── background/
│   │   └── service-worker.js  Extension lifecycle and Chrome APIs
│   ├── content/
│   │   └── toolbar.js         Injected Shadow DOM capture interface
│   ├── engine/
│   │   ├── capture.js         Minimal fiGapture adapter + active v2 engine
│   │   └── vendor/            Unmodified source engine from Figma extension
│   └── legacy/                Inactive launcher/bridge experiments
├── manifest.json              Chrome extension manifest
├── LICENSE
└── README.md
```

## Runtime flow

1. Chrome starts `src/background/service-worker.js`.
2. Activating fiGapture injects the capture engine into Chrome's isolated world.
3. The service worker injects `src/content/toolbar.js` into an isolated world.
4. The toolbar requests captures and sends the result to the clipboard.
5. Asset and screenshot previews open their respective pages under `pages/`.

## Install locally

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project directory (the folder containing `manifest.json`).

There is no build step and no package installation.

fiGapture requires Chrome 116 or newer for the v2 editable-capture engine.

## Video grabbing — what it does and doesn't do

The Asset Grabber's Video tab lists two kinds of entries:

1. **Direct files** — a `<video>` whose browser-resolved source
   (`currentSrc` / `<source src>`) is a plain, directly fetchable file URL.
   Downloading one just fetches that URL, the same as any other asset.
2. **HLS streams** — an `.m3u8` manifest the background service worker
   noticed on the network (`src/background/service-worker.js`, a passive
   `chrome.webRequest` observer — nothing is fetched at detection time).
   These show a "STREAM" badge. Downloading one opens
   `pages/stream/index.html`, which resolves the playlist to its
   highest-bitrate variant and concatenates the segments (TS, or an
   `#EXT-X-MAP` init segment + fMP4 fragments) into one file — no demuxing
   library involved, since ordered concatenation is valid for both of those
   segment types. Segment fetches go through the background service worker
   (`fetchResource`/`fetchImage`), which is exempt from the page's CORS —
   the same channel the plain-file path already used.

It deliberately never lists or downloads:

- video backed by a `blob:`/`mediasource:` URL that isn't also seen as an
  `.m3u8` on the network — the signature of content assembled client-side
  via MediaSource Extensions with no manifest fiGapture can resolve on its own.
- DASH manifests (`.mpd`) — listed nowhere yet. Reconstructing one generally
  needs real audio/video muxing (separate adaptation sets), not just
  concatenation, which is out of scope for now.
- HLS variants that declare a separate audio rendition. Producing a correct
  audio/video file also requires muxing, so fiGapture rejects these instead of
  silently downloading a video-only file.
- encrypted HLS segments (`#EXT-X-KEY` with a real `METHOD`), checked in
  `pages/stream/stream.js` before any segment is fetched.
- live streams (no `#EXT-X-ENDLIST`) and byte-range segments
  (`#EXT-X-BYTERANGE`) — not implemented.
- HLS streams larger than 256 MiB, individual segments larger than 16 MiB,
  and playlists that switch initialization segments. These are rejected to
  avoid excessive browser memory use or producing a corrupt file.
- any video with an active EME/DRM session (`video.mediaKeys`).
- anything on a known streaming/DRM platform, via a hostname denylist
  applied at three points: DOM scan (`scanVideoAssets()`), stream detection
  (`refreshStreamAssets()`), and again inside `pages/stream/stream.js`
  against the *resolved* manifest/segment hosts — all three copies of
  `VIDEO_BLOCKED_HOSTS` need to stay in sync by hand (YouTube, Netflix,
  Vimeo, Twitch, Hulu, Disney+, Prime Video, Max, Peacock, Facebook,
  Instagram, TikTok, Dailymotion, Crunchyroll, plus `googlevideo.com` /
  `gstatic.com` for YouTube's CDN).

In short: it can grab a plain self-hosted `<video src="…mp4">` or an
unencrypted, finished HLS stream, and nothing that a streaming platform is
actively protecting. It has no opinion on the copyright status of a video it
*can* grab — same as the existing image/SVG grabber. The `webRequest`
permission this needs (to see manifest URLs that never appear in the DOM)
means Chrome will ask you to re-approve the extension's permissions after
this update.

## Capturing pages inside "app shell" iframes (shared Claude artifacts)

Some pages show their real content inside one big iframe while the outer page
does not scroll. Shared Claude artifacts are the main example, in two layouts:

| Link | Frames |
|---|---|
| `claude.ai/public/artifacts/<id>` | claude.ai → `www.claudeusercontent.com` iframe (the page) |
| `claude.ai/artifact/<id>` | claude.ai → `<id>.frame.claudeusercontent.com` shell → `about:srcdoc` iframe (the page) |

**Full Page** detects this (a page that doesn't scroll and one iframe covering at
least half of it) and then, level by level, down to the frame that holds the page:

1. re-injects fiGapture into every frame (frames often load after the toolbar opens);
2. hides each shell's header/side panels and makes each iframe as tall as its
   content, so the whole page is laid out at once;
3. keeps viewport-sized sections (`100vh`, `min-h-screen` heroes) at their
   on-screen height, so nothing stretches;
4. captures the editable Figma layers **inside the deepest frame**, reads the
   design tokens there, and takes the screenshots by resizing the window to one
   slice and scrolling slice by slice (Chrome does not paint a cross-site iframe
   far outside the visible window, so `captureBeyondViewport` alone gave blank
   slices below the first screen);
5. puts everything back once the capture is saved.

If a frame can't be reached, Full Page stops with a message instead of capturing
the empty shell.

Code: `src/content/embed.js` (injected with the capture engine in every frame),
`fsFull` in `src/content/toolbar.js`, and `embedInject`, `embedFrameTarget`,
`notifyArchiveDone` and the embed branch of `cdpSlices` in
`src/background/service-worker.js`. The manifest asks for
`https://*.claudeusercontent.com/*` up front so artifacts work even if "all sites"
access was never granted. Other screenshot tools (PNG/PDF export) still capture
the outer page only.

## Development notes

- Reload the extension from `chrome://extensions/` after changing source files.
- Reload the target webpage after changing an injected script.
- Keep paths referenced by `manifest.json` and `service-worker.js` synchronized
  when moving extension resources.
- Files under `src/legacy/` are retained for reference but are not loaded by the
  current manifest or service worker.
