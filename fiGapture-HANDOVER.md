# fiGapture → Figma Bridge — Handover

Capture any website page in your browser, then paste it into Figma in one click: the page as editable Figma layers, full-resolution screenshots, and an automatically built design system (variables, styles, components) — **with no AI tokens used for the build**.

This package contains three parts that work together. Read **Part A** to install, **Part B** to use it, and **Part C** if you want to hand this to another Claude to continue the work.

```
FigShot-Handover/
├─ HANDOVER.md                       ← this file
├─ 1-fiGapture-extension/              ← browser extension (load unpacked)
├─ 2-figma-desktop-bridge-plugin/    ← Figma plugin (import from manifest)
└─ 3-mcp-server/                     ← modified figma-console-mcp server (relay)
```

---

# Part A — Install (about 10 minutes)

## What you need
- **Figma Desktop app** (plugins from a manifest only work in the desktop app).
- **Google Chrome or Microsoft Edge** (any Chromium browser).
- **Node.js 18 or newer** (`node -v` to check; get it from nodejs.org).
- **Claude Desktop** (or Claude Code) — it launches the server in step 2. Any MCP client that can run a local Node command works.

> The feature **only works with the server in folder `3-mcp-server`**. The published `figma-console-mcp` package from npm does **not** include the fiGapture relay, so don't use `npx figma-console-mcp@latest` for this.

## Step 1 — Install the browser extension
1. Unzip this package somewhere permanent (don't move the folders afterward).
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and choose the folder **`1-fiGapture-extension`**.
5. The extension appears as **Custom fiGapture**. Accept the permission prompts (it needs the *debugger* permission to take full-page screenshots without scrolling).
6. If the original **fiGapture** from the Web Store is installed, **disable it** — both use the same extension ID.

> Why not a `.crx` file? Chrome and Edge block installing `.crx` files from outside their stores. "Load unpacked" is the supported way to run a modified extension.

## Step 2 — Set up the MCP server (the relay)
1. Open a terminal in the `3-mcp-server` folder and run:
   ```bash
   npm install
   ```
   (A prebuilt `dist/` folder is included. To rebuild after editing source: `npm run build:local`.)
2. Find your Node path and the absolute path to `dist/local.js`:
   ```bash
   which node
   cd 3-mcp-server && pwd
   ```
3. Add the server to **Claude Desktop**. Open the config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

   Add (or replace) the `figma-console` entry inside `"mcpServers"`:
   ```json
   {
     "mcpServers": {
       "figma-console": {
         "command": "/ABSOLUTE/PATH/TO/node",
         "args": ["/ABSOLUTE/PATH/TO/3-mcp-server/dist/local.js"],
         "env": {
           "FIGMA_ACCESS_TOKEN": "OPTIONAL-your-own-figma-personal-access-token",
           "ENABLE_MCP_APPS": "true"
         }
       }
     }
   }
   ```
   - Use **your own** Figma token (Figma → Settings → Security → Personal access tokens) or leave `FIGMA_ACCESS_TOKEN` out. It's only needed for Claude's own Figma tools, **not** for fiGapture.
   - If the file already has other servers, keep them; just add/replace `figma-console`.
4. **Quit and reopen Claude Desktop.**

   *Claude Code instead?* Run: `claude mcp add figma-console -- node /ABSOLUTE/PATH/TO/3-mcp-server/dist/local.js`

5. Check it's running (the server takes the first free port from 9223 to 9232):
   ```bash
   curl -s localhost:9223/health
   ```
   The reply must contain `"fiGaptureCaptures"`. If port 9223 doesn't answer, try 9224, 9225, …

## Step 3 — Install the Figma plugin
1. Open the **Figma desktop app** and open any design file.
2. Menu: **Plugins → Development → Import plugin from manifest…**
3. Choose **`2-figma-desktop-bridge-plugin/manifest.json`**.
4. Run it: **Plugins → Development → Figma Desktop Bridge**. A small window should say **Connected**.
5. Keep it open while you work. After any plugin update, close and re-run it.

## Step 4 — Quick test
1. Open any website, click the **Custom fiGapture** toolbar icon (or press **Alt+F**), then press **Full Page** (or **Alt+P**).
2. A toast should say *"Saved to Library … — sent to Figma Bridge"*.
3. In Figma, expand the Bridge window (the **+** / arrow button) and open the **fiGapture** tab. Your capture is listed under its domain.

---

# Part B — Using it

## Capturing
| Action | How |
|---|---|
| Open the toolbar | Click the extension icon, or **Alt+F** |
| Full-page capture | **Full Page** button, or **Alt+P** anywhere (Print Screen/F13 also works while the toolbar is open) |
| Open the in-browser Library | **Alt+L** (or right-click the extension icon → Options) |

One **Full Page** capture does everything at once: Figma layers (also copied to your clipboard), full-resolution screenshots (cut every 1800 px), and a design-system scrape (CSS variables, colors, type, spacing, radii, shadows, components, icons). Capturing the same URL again **replaces** the old capture. Shortcuts can be changed at `chrome://extensions/shortcuts` (or `edge://…`).

## Pasting into Figma (the Bridge's fiGapture tab)
- Captures are grouped in **accordions by website domain**. Click a domain to open it; tick the pages you want. Everything is ticked by default.
- **Select all / Select none**, **Delete selected**, **Delete all** (click once to arm, click again to confirm). Each page also has a small **×**.
- Inside an open accordion, the gray **Paste in Figma** pastes only that site's ticked pages. The blue **Paste in Figma (N)** at the bottom pastes everything ticked.
- What happens on **Paste in Figma**:
  1. **Page layers** are copied to your clipboard and an empty Section named *"Figma layers — paste here with Cmd+V"* is selected. **Press Cmd+V (Ctrl+V on Windows)** to drop them in. (A plugin cannot trigger Figma's paste handler, so this one keystroke can't be removed.)
  2. **One Section per page** with its screenshots stacked, named like `example.com/pricing`.
  3. **One design-system Section per website** (merged from all that site's pages): real Figma **variables**, **text styles**, **shadow styles**, a documentation frame, and native **components**.
- If the clipboard copy is refused, a **Copy layers** button appears — click it, then press Cmd+V.
- Nothing in this flow calls an AI model; the plugin builds everything locally with the Figma API.

## Library (in the browser)
**Alt+L** opens a page listing everything saved (grouped by site). It has its own **Copy to Figma** buttons that put pages + screenshots + a design-system doc on the clipboard for a plain Cmd+V — useful when you don't have the Bridge open.

---

# Part C — For the next Claude (continue the work)

Upload this whole package (or just this file plus the folders) to the new Claude conversation and say:
> "Read HANDOVER.md fully. This is a working project. Help me with: …"

## What was built (history of this project)
1. Started from the **fiGapture** Chrome extension (v4.8, by Rahul Ornob, MIT) downloaded as a CRX and unpacked.
2. **Removed Google sign-in** (`identity` permission, `oauth2` block, `signIn/signOut/getUserSession` handlers, toolbar session call). Renamed to **Custom fiGapture**.
3. **Full Page now saves to an in-browser Library** (IndexedDB `fiGapture-library`, store `captures`, index `key`) instead of only the clipboard.
4. **Screenshots** use the Chrome DevTools protocol (`chrome.debugger`, `Page.captureScreenshot`, `captureBeyondViewport`, **clip scale 1**) — no scrolling, runs in parallel with the Figma capture. Falls back to the old scroll-and-stitch method (`captureFullPage`) if the debugger can't attach.
5. **Design-system scrape** (`fiGaptureDesignScrape`, runs inside the page): CSS variables, colors, typography, spacing, radii, shadows, component heuristics (button, input, heading, link, card, badge, avatar, nav, …), SVG icons, plus page HTML/CSS.
6. **Library page** (`pages/library`) groups by domain/path, merges one design doc per site, and copies a combined Figma paste payload using fiGapture's own capture engine on synthetic DOM blocks.
7. **Shortcuts**: Alt+P (capture), Alt+L (library), Alt+F (toolbar); Print Screen/F13 listener while the toolbar is open.
8. **MCP server relay** (`3-mcp-server/src/core/websocket-server.ts`): HTTP endpoints on the same port as the WebSocket — `POST/GET/DELETE /fiGapture/captures`, `GET /fiGapture/captures/:id[?part=design]`, in-memory store (cap ≈ 900 MB), CORS enabled; `/health` reports `fiGaptureCaptures` (that's how the extension recognises a relay-capable server).
9. **Plugin** (`2-figma-desktop-bridge-plugin`): `ui.html` has the **fiGapture tab** (domain accordions, select/delete, paste buttons, tiles images to ≤ 4096 px); `code.js` has `fiGaptureBuild` + `fsBuildPage` + `fsBuildDesign` (Sections, images, variables, text/effect styles, components, icons; removes its own half-built nodes on failure).

10. **Four upgrades (2026-11-25)**: (a) *Gradients*: the plugin parses each element's computed `background-image` (linear/radial, angle, keywords, stops, alpha, bg-size/position) and sets real `GRADIENT_LINEAR/RADIAL` fills on the matching pasted layer (code.js `fgParseBgImage`/`fgPaint`/`fgBuildFills`; verified against Figma renders). Sources: the capture JSON plus the extension's new `fiGaptureExtrasScrape` (service-worker.js; adds `::before/::after` and `<canvas>` pictures, sent as `extras` with the capture; no relay change). (b) *Spacing*: capture boxes match the screenshot (measured 0 px on solid boxes); the drift came from Figma's auto-layout import, so after pasting, `fgFixPage` matches layers to page boxes by position/size and pins them (FIXED size, ABSOLUTE position in auto-layout parents). Option "Line layers up with the page" in the tab. (c) *Video first frame*: scrape draws the first frame from a detached copy (page untouched), else poster, else crop of the screenshot slices (ui.html `cropShot`); layer named "Video (first frame)". (d) *Paste choices*: Figma / Screenshot / DS checkboxes, universal and per website, saved in localStorage and figma.clientStorage (`FIGAPTURE_PREFS_*`); unticked parts are not built. Manual-paste path: button "Apply gradients & alignment (after Cmd+V)". Backups in `_backups/20261125-*`.

11. **Grouping (2026-11-25)**: each paste is one session. One website -> one Section named after the host holding its parts in a row (`Figma layers — host` | screenshots per page | design system). Several websites -> one Section per website inside a master Section `fiGapture session — <date> (<n> websites)`. code.js `fsDistribute` (pasted frames -> website, by name, then size), `fsArrange`, `fsRow`; ui.html sends `layerPages` and `sessionName`. Manual paste: layers are sorted when "Apply gradients & alignment" is clicked. Backup in `_backups/before-session-sections-*`.

12. **Auto layout everywhere (2026-11-25)**: last step of FIGAPTURE_LAYERS_FIX, code.js `alPage`. Every frame with children gets auto layout (except multi-path icons): children's boxes are cut into rows/columns (`alPlan`), gaps become spacing/padding, Row/Column/"… spacing" frames are added where needed; collapsed invisible wrappers are grown (`alGrow`). Overlapping, off-frame and some rotated layers become absolute-position children. Each frame is measured; >0.5 px drift -> retried, then absolute. `alFlex` sets hug/fill where nothing moves. Do NOT add setTimeout pauses in the loop: each one makes Figma redraw (70 s+ instead of 6 s). Tested on granola.ai and lattice.com copies: max shift 0.5 px, <0.02% pixels differ. Backup `_backups/before-auto-layout-*`.

13. **Batch capture + new interface (extension v5.2, 2026-11-25)**. `src/background/batch.js`: queue, 3 pages at a time in hidden tabs of a separate window (same size as the user's window, blank tab in front), kept rendering with the debugger's `Emulation.setFocusEmulationEnabled`; retry once, after the others; blocked / sign-in pages are reported, never bypassed; main tabs stay open, sub-page tabs close; queue in `chrome.storage.session`. Sub-pages: 5 same-site links, menu -> footer -> page (`batchCollectLinks`). Batch captures never touch the clipboard. `src/content/panel.js`: floating icon + panel, drawn by `Wo()` in toolbar.js, injected before toolbar.js. Full Page is started with `window.__fiGaptureFull()` (isolated world) instead of a DOM event, so web pages cannot trigger it. Engine: faster pre-scroll (200 ms per screen), image decode wait limited to 4 s (a stuck image used to hang the capture). Captures over 12 M characters are sent in parts (`figmaJsonPart`) because browser messages stop at 64 MB. Restore point: `_backups/RESTORE-POINT-before-batch-20261125-125835`.

14. **Quality fix (extension v5.3, 2026-11-25)**. *Extension*: batch tabs get `Emulation.setDeviceMetricsOverride` with the user's page size (hidden tabs could be 1 px wide -> text one letter per line, 108,000 px tall pages); `src/engine/media.js` waits for images at each scroll stop, decodes all images and gives every video a still (page element -> offscreen decode -> poster); missing pictures are recovered in groups of 8 and videos are excluded (one slow video used to lose all of them). *Plugin*: `fgFonts` replaces fonts Figma does not have with Inter and fits letter spacing to the browser's width (original font names in plugin data `fgFont`), restores dropped line breaks; layers are matched after removing Figma's drift (`fgPairTexts`/`fgDrift`); `fgPin` removes auto layout from affected frames before moving anything (moving one child used to push its neighbours); page frames clip and keep the page's exact size; off-page videos skipped. *ui.html before pasting*: `fixBg` removes gradient strips (text bars), `inlineUse` scales SVG symbols, `brokenSize` skips wrong-width captures; the paste waits for all pages. *Design system*: a documentation frame only, no variables / styles / components; fonts loaded once. Restore point: `_backups/RESTORE-POINT-before-quality-fix-20261125-153603`.

15. **Sub-page count + strict switch (v5.4, 2026-11-25)**. Panel: 2-6 sub-pages, shown only while the switch is on (`fiGaptureSubCount`, default 5). The switch (`fiGaptureSubs`) is read from storage at every capture and followed live in all tabs (each tab used to keep the value from when its panel loaded); batch.js refuses `batch:subs` while it is off. Pasting (ui.html): `slimAssets` re-encodes pictures over 300 KB for their shown size, `layerPortions` pastes in parts of about 28 MB; no manual steps (`autoPasteLayers` waits and retries). Backups: `_backups/before-subpage-count-*`, `before-fast-paste-*`, `before-no-manual-steps-*`.

**Where it stands (2026-11-25, extension v5.4) — start here on another device**
- *Not yet run for real in Figma*: the slimmed, portioned paste of a big session (18 pages: 451 MB -> 123 MB, 5 portions, simulated only) and the no-manual-steps flow. Sub-page count/switch was tested in Chrome and Edge on local pages only.
- *Known flaws*: overlapping job title on the Lattice customer-story page; some FAQ plus icons drawn as minus; "+" icons with no recorded colour stay black; a Superside heading's position not rechecked.
- *Rules*: no manual steps for the user; no styles/variables/components in the Figma file (documentation frame only); ask instead of assuming; back up before editing; test on 4 sites at most; push only when asked.
- *Not in git*: `_backups/` and captures in the browser Library stay on the original Mac. Figma hot-reloads the plugin when code.js/ui.html change, which stops a running paste.

## Data flow
```
Browser (Custom fiGapture) ──HTTP POST──▶ MCP server (localhost:9223–9232, in memory)
                                              ▲
Figma plugin UI (fiGapture tab) ──HTTP GET (poll every 3 s)
        │  copies page layers to clipboard (user presses Cmd+V)
        └─ postMessage FIGAPTURE_BUILD ─▶ plugin code.js ─▶ Sections / images / variables / styles / components
```

## Where to edit
| Want to change | File |
|---|---|
| Capture flow, screenshots, Library save, push to server | `1-fiGapture-extension/src/background/service-worker.js` (appended readable section at the end; the rest is minified) |
| Toolbar button, shortcuts, hooks | `1-fiGapture-extension/src/content/toolbar.js` (minified — edit by exact string replace) |
| Library page | `1-fiGapture-extension/pages/library/{index.html,library.js}` |
| Permissions, commands, name | `1-fiGapture-extension/manifest.json` |
| fiGapture tab UI | `2-figma-desktop-bridge-plugin/ui.html` (last `<script>` block + `.fs-*` CSS) |
| What gets built in Figma | `2-figma-desktop-bridge-plugin/code.js` (bottom: `fiGaptureBuild`) |
| Relay endpoints | `3-mcp-server/src/core/websocket-server.ts` (`handleFiGaptureRoute`) — then `npm run build:local` |

Tips: after editing a minified file, run `node --check <file>`. The extension must be **Reloaded** in `chrome://extensions` and the website tab **refreshed**; the Figma plugin must be **closed and re-run**; the server needs a Claude restart.

## Hard limits (don't promise these)
- **Print Screen cannot be a global shortcut** in a browser extension (a modifier key is required; Macs have no such key).
- **`.fig` files cannot be written directly** — Figma's format is closed. Build the content in Figma, then File → Save local copy.
- A plugin **cannot trigger Figma's paste**, so page layers need one **Cmd+V**.
- Figma rejects images over **4096 px** per side — handled by tiling.
- Hover/focus states are not captured (computed styles only). Web fonts missing on the Figma machine fall back to Inter.
- Captures held by the server are **in memory only**: restarting the server empties the Bridge list (the browser Library keeps them).
- The browser shows a **"started debugging this browser"** banner during capture (comes with the `debugger` permission).

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Toast doesn't say "sent to Figma Bridge" | Server not running or an old one is answering. Check `curl localhost:9223/health` (try 9224…) shows `fiGaptureCaptures`. Restart Claude Desktop. |
| fiGapture tab is empty | Plugin not connected, or capture was on a different server. Re-run the plugin; wait 3 s. |
| Empty Sections / "Image is too large" | Fixed in this version (tiling). Make sure the plugin was closed and re-run. |
| Screenshots cropped or zoomed | Fixed in this version (scale 1). Delete old captures and capture again. |
| Console errors "blocked by CORS policy" for image/SVG URLs | Harmless; fiGapture's image-recovery step was refused by those sites. Click the extension icon once and allow access to all sites to reduce them. |
| Library empty after Full Page | Reload the extension **and** refresh the page; open the service-worker console from the extension card to see `[Custom fiGapture]` logs. |
| Slow Claude while pasting | Pasting builds in Figma and briefly competes with other Figma edits; wait for "Done". |

## Licensing and safety notes
- The original fiGapture is © Rahul Ornob under an **MIT license**, but `src/engine/capture.js` is noted as Figma's proprietary code "used with permission", and `toolbar.js` carries a "proprietary" header. **Check you're allowed to share or modify the extension** before distributing it beyond people you trust.
- The extension requests broad permissions (`debugger`, all-sites access on demand). Install it only from this trusted package.
- Never commit or share your own Figma token or Claude config.

## Paste-ready summary for a fresh Claude chat
> I'm continuing a project called "fiGapture → Figma Bridge". It has 3 parts in a handover package: a modified Chrome/Edge extension (Custom fiGapture) that captures full web pages (Figma layers via fiGapture's engine, 1800 px full-resolution screenshots via the debugger protocol, and a design-system scrape) into an in-browser library and posts them to a local MCP server relay; a modified figma-console-mcp server exposing `/fiGapture/captures` HTTP endpoints; and the Figma Desktop Bridge plugin with a fiGapture tab that lists captures per domain and, on "Paste in Figma", builds Sections, tiled screenshots, variables, text/effect styles and components natively, and copies page layers to the clipboard for Cmd+V. Read HANDOVER.md for architecture, install steps, file map, limits and troubleshooting, then help me with: …
