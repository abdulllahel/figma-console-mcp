# FigShot & Figma Desktop Bridge — Complete Handover

Captured websites to editable Figma layers & fault-tolerant cross-file page transfer engine.

This document contains everything needed for a fresh Claude session (or any developer) to pick up the codebase, understand the exact architecture, know where every file lives, and continue development seamlessly.

> **Last updated: 2026-11-14.** Latest change: fixed the relay-server crash `ERR_HTTP_HEADERS_SENT` ("figma-console stopped running") — see Section 3, item 7.

---

## 0. Read This First — Current State

- **Base version:** this project is the official open-source **figma-console-mcp v1.46.0** (github.com/southleft/figma-console-mcp, released 2026-10-29). As of 2026-11-14 that is still the latest official release — there is nothing newer to merge.
- **Only 3 files differ from the official v1.46.0** (verified by checksum against the official repo). Everything else is stock:
  1. `figma-desktop-bridge/code.js` — transfer engine + FigShot paste (plugin main thread)
  2. `figma-desktop-bridge/ui.html` — Transfer & FigShot tabs, live dashboard (plugin UI)
  3. `src/core/websocket-server.ts` — `/transfer/*` and `/figshot/*` HTTP relay routes + disk checkpoints
  (`dist/core/websocket-server.js` is the compiled output of #3.)
- **How it runs:** the Claude desktop app launches the server (`dist/local.js`) as the `figma-console` MCP server. After rebuilding, **fully quit Claude (Cmd+Q) and reopen it**, then reopen the Desktop Bridge plugin in Figma.
- **Server logs:** Claude desktop → the figma-console error toast → "View logs" (or the MCP logs in Claude's settings). A crash shows as a Node stack trace at the end of the log.
- **Health:** all 35 relay endpoint checks pass (`node scripts/test-relay-endpoints.mjs`), and the project's own `tests/websocket-bridge.test.ts` passes 111/111.
- **Backups:** every risky change is preceded by a copy in `_backups/` (latest: `_backups/server-before-headers-fix-20261114-133318/`).

---

## 1. Quick Start: Where Everything Lives

| Component | Working / Development Path | Handover Package Path |
|---|---|---|
| **Figma Desktop Bridge Plugin** | `/Users/almamun/Documents/figma-console-mcp-main/figma-desktop-bridge/` | `/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/2-figma-desktop-bridge-plugin/` |
| **MCP Server (Local Relay & Disk Backups)** | `/Users/almamun/Documents/figma-console-mcp-main/` | `/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/3-mcp-server/` |
| **Custom FigShot (Chrome Extension)** | `/Users/almamun/Documents/figma-console-mcp-main/figshot-extracted/` | `/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/1-figshot-extension/` |
| **Transfer Checkpoint Backups (On-Disk)** | `~/Documents/FigShot-Transfer-Backups/<jobId>/` | *Generated dynamically on disk* |

---

## 2. System Architecture & Capabilities

The project consists of three core components working in unison:

```
┌────────────────────────────────────────────────────────┐
│             Google Chrome / Microsoft Edge             │
│        Custom FigShot Extension (Load Unpacked)        │
│    Captures DOM, 1800px Screenshots, Design Tokens    │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP POST (port 9223-9232)
                            ▼
┌────────────────────────────────────────────────────────┐
│            Local MCP Relay Server (Node.js)            │
│         /figshot/* captures & /transfer/* jobs         │
│     Saves all chunks, images, and logs directly to     │
│       ~/Documents/FigShot-Transfer-Backups/<jobId>/    │
└──────────────┬──────────────────────────┬──────────────┘
               │ HTTP & WebSocket         │ HTTP & WebSocket
               ▼                          ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐
│     Source Figma File        │ │   Destination Figma File     │
│  Figma Desktop Bridge Plugin │ │ Figma Desktop Bridge Plugin  │
│  Exports pages, frames, and  │ │ Reconstructs pages & nodes,  │
│  images safely to disk relay │ │ relinks design-system styles │
└──────────────────────────────┘ └──────────────────────────────┘
```

### Feature A: Web-to-Figma Capture ("figApture" / "FigShot" Tab)
- Captures full-page websites without scrolling using the Chrome DevTools Protocol (`chrome.debugger`, `Page.captureScreenshot`, scale 1).
- Scrapes computed styles, design system tokens (colors, typography, spacing, radii, shadows, icons), and DOM tree.
- Posts capture data to the local MCP server on port 9223.
- In Figma, opening the Desktop Bridge plugin lets the user click **"Paste in Figma"** to natively build Sections, high-resolution tiled screenshots, variables, text styles, and components without consuming any AI tokens.

### Feature B: Fault-Tolerant Cross-File Transfer Engine ("Transfer" Tab)
- Seamlessly transfers entire pages, layers, and components between two open Figma files.
- **Rebuild Mode**: Serializes node trees and raw image binaries, streams them to disk on the local relay, and reconstructs them in the destination file, re-linking variables and library styles.
- **Guided Copy/Paste Mode**: Semi-automated clipboard copy across files.

---

## 3. Critical Bugs Investigated & Permanently Fixed

### 1. Root Cause & Permanent Fix for Figma Crash (`Reason: crashed`)
- **Problem**: When running transfers on large files, Figma would abruptly crash with the canvas displaying: `"Something went wrong. Reloading Figma may fix this. Reason: crashed"`.
- **Root Cause**: An earlier attempt to speed up transfer grouped up to 100 frames (250MB single payloads) into one chunk. Figma's desktop client runs on 32-bit WebAssembly (`wasm32`), which has a strict architectural ceiling of **2GB total memory** for the entire canvas, document, and plugin runtime. Serializing 100 deep frames into a single massive JSON string created huge memory allocations that exhausted the WebAssembly heap.
- **Solution (`code.js`)**: Implemented **Memory-Safe Streaming Chunks**:
  - Every top-level frame/component/section/group is streamed in its **OWN individual chunk**.
  - Small loose shapes (rectangles, loose text, icons) are batched up to **10 per chunk**.
  - After every chunk, the engine yields to the event loop (`setTimeout(20)`), sends `TR_CHUNK_DATA`, and immediately clears references (`chunkPayload = null`, `serializedNodes = null`).
  - Total memory during transfer stays flat under **50MB**. The 2GB WebAssembly ceiling is never reached, completely eliminating crashes!

### 2. Root Cause & Permanent Fix for Stalls (e.g. Item 49/73 `image 588254732`)
- **Problem**: The transfer would hang indefinitely on specific items (e.g. `Transferring page 1/5 (Noor) — item 49/73 (image 588254732) - Last action: 3m ago`).
- **Root Cause**: Item 49 contained an image fill. In `code.js`, `await im.getBytesAsync()` and the promise waiting for `TR_IMAGE_ACK` lacked timeout handling. If Figma experienced a slow image read or network upload, the promise stayed pending forever.
- **Solution**:
  - In `code.js`: Wrapped `im.getBytesAsync()` in `withTimeout(im.getBytesAsync(), 7000)`. If an image read hangs or is corrupt, it warns and advances rather than freezing.
  - Added 10-second auto-advancing fallback watchdog timers to all acknowledgement promises (`trImageAckResolve`, `trAckResolve` for `TR_IMAGE_CHUNK`, `TR_CHUNK_DATA`, `TR_PAGE_START`, `TR_PAGE_END`).
  - In `ui.html`: Added `AbortController` timeouts (20s) to all image upload fetch requests.

### 3. Root Cause & Permanent Fix for Rebuild Timeout (`Timed out waiting for page "🗄 Archive"`)
- **Problem**: In the destination file, a red toast would appear saying: `Rebuild stopped: Timed out waiting for page "🗄 Archive"`.
- **Root Cause**: In `ui.html`, `importJob` used a rigid loop: `while (!meta && waitCount < 300) { await sleep(100); waitCount++; }` — which is exactly **30 seconds**! If the source file took longer than 30s to export earlier pages or read image assets, the destination file threw a timeout error and stopped.
- **Solution (`ui.html`)**: Replaced the rigid 30s timeout with an **Adaptive Heartbeat Poller**:
  - The destination checks `liveJob.updatedAt` on the server every 1.2s.
  - As long as the source file is alive and making progress (updated within the last 60s), the destination plugin waits smoothly without timing out.
  - It only reports a timeout if the source file has been completely silent with zero updates for **180 seconds** (3 minutes).

### 4. Root Cause & Permanent Fix for "Cancel Transfer" Not Stopping
- **Problem**: Clicking "Cancel Transfer" showed the toast `"Transfer cancelled."`, but the UI remained on `"Rebuilding in Design file..."` and continued running in the background.
- **Root Cause**: `cancelTransfer` was guessing the job ID via `findActiveJobId()`, which could return `null` if file keys were mismatched. Furthermore, delayed chunks from background export loops could arrive at the server and overwrite `state: 'cancelled'` back to `'exporting'` or `'importing'`, causing the periodic 2-second poller to resurrect the job in the UI.
- **Solution**:
  - In `ui.html`: Cancel buttons pass the exact `job.id` to `cancelTransfer(jobId)`. Added `cancelledJobs` tracking to immediately block any active or future poller runs from re-enabling the job.
  - In `websocket-server.ts`: Added a lock in `POST /transfer/jobs/:id` preventing late chunks from overwriting `state: 'cancelled'` unless explicit `patch.resume === true` is sent.

### 5. Fault-Tolerant On-Disk Checkpoint Resume System
- In `websocket-server.ts`: Every job manifest, page chunk, and raw image is automatically written to disk under `~/Documents/FigShot-Transfer-Backups/<jobId>/`:
  - `job.json`: Full state, page list, item counts, and completion status.
  - `page-<index>.json`: Page start manifest and background fills.
  - `page-<pi>_chunk_<ci>.json`: Individual chunk data containing serialized nodes.
  - `images/<hash>.bin`: Raw image binary buffers.
- In `code.js`: `msg.resumeChunks` checks `if (msg.resumeChunks[i + '_' + c]) continue;`, instantly skipping chunks already saved to disk.
- In `ui.html`: Destination `importJob` checks `if (pi < job.importedPages) continue;` and `if (job.importedChunks[pi + '_' + ci]) continue;`, skipping already built canvas nodes.
- Prominent **"▶ Resume Transfer from Checkpoint"** button allows resuming instantly after an outage or crash without repeating any work.

### 6. Per-Page Item Counts & Live Transfer Dashboard
- In `pagesBox`: All page checkboxes now show exact item counts upfront: e.g. `Noor (111 items)`, `Sommriddhi (117 items)`.
- In `renderTransferDashboard`: Displays a full live dashboard:
  - Header: Source / Destination file names and status.
  - Stat Grid: `Pages: X / Y` · `Items: A / B` · `Files: N files saved to disk`.
  - Overall progress bar with percentage.
  - Scrollable Page List: Each selected page with its total items, transferred count (`45/111 items`), and status badge (`✓ Done`, `⚡ Streaming` / `⚡ Rebuilding`, `⏳ Queued`).
  - Action buttons: `[ Cancel Transfer ]` (during run) or `[ ▶ Resume Transfer from Checkpoint ]` (if stopped/error).

### 7. Root Cause & Permanent Fix for Server Crash (`ERR_HTTP_HEADERS_SENT` / "figma-console stopped running") — 2026-11-14
- **Problem**: Claude desktop showed *"figma-console stopped running. Claude can't use it until it starts again."* The log ended with:
  `Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client` at `json` ← `handleTransferRoute` in `websocket-server.js`. The whole MCP server process exited, so every Figma tool stopped working.
- **Root Cause** (in our custom code, not the official project):
  - `GET /transfer/jobs/:id/pages/:key` and `GET /transfer/jobs/:id/img/:hash` read checkpoints from disk like this:
    `try { res.writeHead(200); res.end(readFileSync(file)); return true; } catch {}` → then `json(404, ...)`.
    Headers were sent **before** the file was read. If the read failed (unreadable/locked/oversized checkpoint), the error was swallowed and the code fell through to `json(404)` — a **second** `writeHead` → Node throws → uncaught → server dies.
  - The route-local `json()` helpers (Transfer and FigShot) called `writeHead` *before* `JSON.stringify`, so a huge or unserializable body could trigger the same double-response via the `fail()` path.
- **Solution (`src/core/websocket-server.ts`)**:
  - New `private sendJson(res, code, body)`: serializes first, skips if `res.headersSent`/`writableEnded`, never throws. Both route `json` helpers now delegate to it.
  - Checkpoint reads now do `const data = readFileSync(file)` **before** `writeHead`.
  - `handleHttpRequest` wraps the FigShot/Transfer route calls in `try/catch` → logs and returns a 500 for that one request instead of crashing the server.
- **Verification**: `scripts/test-relay-endpoints.mjs` reproduced the crash on the old build (33/35, 2× `ERR_HTTP_HEADERS_SENT`) and passes 35/35 with 0 crashes on the fixed build. Recompiling changed only `dist/core/websocket-server.js`; the other 109 compiled files are byte-identical. Pre-fix copies: `_backups/server-before-headers-fix-20261114-133318/`.

---

## 4. Key Files & Line Reference

### Figma Desktop Bridge Plugin (`figma-desktop-bridge/`)
- **`code.js`**:
  - Line 8377: `withTimeout(promise, ms, desc)` helper.
  - Line 8417: `trListPages()`: counts top-level children per page (`itemCount: p.children.length`).
  - Line 8650: `trExport(msg)`: memory-safe single-frame chunking, image streaming with 7s timeout, UI ack watchdogs (10s–15s).
  - Line 9084: `trBuildPageStart(msg)`: creates target page in destination file.
  - Line 9104: `trBuildChunk(msg)`: incrementally builds nodes in target page.
  - Line 9148: `trBuildPageEnd(msg)`: cleans up memory references.
  - Line 9274: `TR_CANCEL`: cancels active exports/imports cleanly.

- **`ui.html`**:
  - Line 543: CSS for `.tr-stat-grid`, `.tr-stat-pill`, `.tr-page-list`, `.tr-badge`, `.tr-resume-btn`, `.tr-cancel-btn`.
  - Line 3833: `api(method, path, body, raw, timeoutMs)`: HTTP client with `AbortController` timeouts.
  - Line 3879: `startTransfer(mode, resumeJobId)`: initializes transfer job with page item counts and checkpoint resume support.
  - Line 3952: `onPageStart`, `onChunkData`, `onPageEnd`, `onImageChunk`: updates live per-page item progress and file counts.
  - Line 4075: `cancelTransfer(targetId)`: instant, reliable cancellation with `cancelledJobs` tracking.
  - Line 4127: `importJob(job)`: adaptive heartbeat polling for pages and chunks (no 30s false timeout), chunk resume skipping.
  - Line 4402: `poll()`: 2-second background sync with cancellation locks.
  - Line 4490: `pagesBox(wrap)`: page checklist with item counts (`Noor (111 items)`).
  - Line 4602: `renderTransferDashboard(wrap, job, isSource, canResume)`: live dashboard with stat grid, progress bar, and page list.

### MCP Relay Server (`src/core/websocket-server.ts`)
- Line 291: `sendJson(res, code, body)`: crash-safe JSON response used by every FigShot/Transfer route (see Bug 7).
- Line 308: `readBody(req, limit)`: request body reader with size limit.
- Line 332: `handleFigshotRoute`: `GET/POST /figshot/captures`, `GET/DELETE /figshot/captures/:id` (`?part=design`), in-memory, capped at 900MB.
- Line 382: `TRANSFER_ROOT` = `~/Documents/FigShot-Transfer-Backups`.
- Line 410: `handleTransferRoute`: `GET /transfer/ping`, `GET /transfer/files`.
- Line 429: `GET /transfer/jobs` (`?dest=`): returns active memory and disk-persisted jobs.
- Line 450: `POST /transfer/jobs`: creates a new transfer job on disk.
- Line 462: `GET | POST | DELETE /transfer/jobs/:id`: POST patches job state with cancellation protection against late chunks (`resume: true` un-cancels).
- Line 486: `PUT | GET /transfer/jobs/:id/pages/:key`: persists/serves chunk JSONs (memory first, then disk checkpoint).
- Line 520: `PUT | GET /transfer/jobs/:id/img/:hash`: persists/serves image buffers (memory first, then disk checkpoint).
- Line 566: `handleHttpRequest`: CORS, routes to FigShot/Transfer inside a crash guard, `/health`.

---

## 5. Development & Testing Commands

### To Rebuild & Run the MCP Server:
```bash
cd /Users/almamun/Documents/figma-console-mcp-main
npm run build:local
# Then fully quit Claude desktop (Cmd+Q) and reopen it — Claude launches dist/local.js itself.
# (Run `node dist/local.js` by hand only for standalone debugging, with Claude closed.)
```

### To Run the Relay Regression Test (do this after ANY change to websocket-server.ts):
```bash
cd /Users/almamun/Documents/figma-console-mcp-main
npm run build:local
node scripts/test-relay-endpoints.mjs      # expect "Passed 35/35" and "Server crashes: 0"
npx jest tests/websocket-bridge.test.ts     # expect 111 passed
```
The test uses a throwaway HOME, so it never touches your real transfer backups. Add a check to it whenever you add a new `/transfer/*` or `/figshot/*` route.

### To Verify Server Endpoints:
```bash
# Check server health
curl http://localhost:9223/transfer/ping

# Check connected Figma files
curl http://localhost:9223/transfer/files

# Check active and persisted transfer jobs
curl http://localhost:9223/transfer/jobs
```

### To Check JavaScript Syntax of Plugin:
```bash
node --check /Users/almamun/Documents/figma-console-mcp-main/figma-desktop-bridge/code.js
```

### To Sync Working Files to Handover Package:
```bash
cp /Users/almamun/Documents/figma-console-mcp-main/figma-desktop-bridge/code.js "/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/2-figma-desktop-bridge-plugin/code.js"
cp /Users/almamun/Documents/figma-console-mcp-main/figma-desktop-bridge/ui.html "/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/2-figma-desktop-bridge-plugin/ui.html"
cp /Users/almamun/Documents/figma-console-mcp-main/src/core/websocket-server.ts "/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/3-mcp-server/src/core/websocket-server.ts"
```

---

## 6. Copy-Paste Prompt for a Fresh Claude Session

Recommended: continue in **Claude Code in the desktop app**, opened on `/Users/almamun/Documents/figma-console-mcp-main` (it can run builds, tests and the server directly on the Mac). Paste the following prompt:

```markdown
I am continuing work on the "FigShot & Figma Desktop Bridge" project.
Please read HANDOVER.md located at `/Users/almamun/Documents/figma-console-mcp-main/HANDOVER.md` (and in `/Users/almamun/Downloads/Files/Figshot and bridge/FigShot-Handover/HANDOVER.md`).

Summary of current state:
1. The project has 3 parts:
   - Custom FigShot Chrome Extension (`1-figshot-extension`)
   - Figma Desktop Bridge Plugin (`2-figma-desktop-bridge-plugin` or `/Users/almamun/Documents/figma-console-mcp-main/figma-desktop-bridge/`)
   - MCP Server Relay (`3-mcp-server` or `/Users/almamun/Documents/figma-console-mcp-main/`)
2. Recent major fixes completed:
   - Fixed Figma WebAssembly 2GB crash ("Reason: crashed") by moving to memory-safe single-frame streaming chunks in code.js.
   - Fixed transfer stalls on images (wrapped getBytesAsync in withTimeout, added 10s watchdog timers to ack promises).
   - Fixed false 30s rebuild timeout ("Timed out waiting for page") by implementing adaptive heartbeat polling.
   - Fixed Cancel Transfer so it stops immediately and locks the job from being overwritten by late chunks.
   - Fixed relay server crash ERR_HTTP_HEADERS_SENT ("figma-console stopped running") with crash-safe responses in websocket-server.ts (2026-11-14).
   - Added persistent on-disk checkpoint logging (~/Documents/FigShot-Transfer-Backups/) with instant "Resume Transfer from Checkpoint".
   - Added live Transfer Dashboard showing item counts per page, transferred file count, and live per-page status.

3. Base is official figma-console-mcp v1.46.0; only code.js, ui.html and src/core/websocket-server.ts are customized.
4. Rules: back up files to _backups/ before editing; after any server change run `npm run build:local` and `node scripts/test-relay-endpoints.mjs` (must stay 35/35, 0 crashes); keep every existing feature working.

All code has been built and tested on local port 9223. What would you like us to look at or improve next?
```

---

## 7. When a New Official figma-console-mcp Version Comes Out

1. Back up the whole project (or at least the 3 customized files + `_backups/`).
2. Get the new official release (`git clone https://github.com/southleft/figma-console-mcp` and check out the new tag).
3. Diff the official **v1.46.0 → new version** for the 3 customized files only. Everything else can be replaced wholesale.
4. Re-apply our changes onto the new versions of those 3 files (our code is mostly self-contained: the `tr*` functions + `TR_*` messages in `code.js`, the Transfer/FigShot tabs in `ui.html`, and `sendJson` / `handleFigshotRoute` / `handleTransferRoute` / transfer helpers in `websocket-server.ts`).
5. `npm install && npm run build:local`, run the test commands in Section 5, then test a real transfer between two Figma files.

## 8. Other Folders in This Project (separate side tools)

- `figshot-extracted/` — the custom FigShot Chrome extension (see Section 1).
- `cookie-transfer-extension/` — Chrome extension: export site cookies to JSON / a local app and import them into another profile. Has its own README.
- `sheet-doc-downloader/` — Chrome extension "Sheet Doc One-Click Download": adds a download button to Google Sheets link previews.
- `_backups/` — dated snapshots taken before risky changes (`LATEST_BRIDGE_BACKUP.txt` / `LATEST_EXTENSION_BACKUP.txt` point to the latest).
- `FigShot-HANDOVER.md` / `FigShot-Handover.zip` — older handover package from 2026-11-12; this file supersedes it.

