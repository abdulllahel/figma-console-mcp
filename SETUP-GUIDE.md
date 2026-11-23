# fiGapture + Figma Desktop Bridge — Setup Guide, Latest Changes & Known Incidents

**Version of this guide:** 2026-11-15
**Package folder:** `Downloads/Figma-Tools-2026-11-15/`
**Contents of the package:**

| File | What it is |
|---|---|
| `fiGapture-Chrome-Extension-v4.8.zip` | The Chrome extension that captures websites (screenshots, DOM, design tokens) |
| `Figma-Desktop-Bridge-Plugin.zip` | The Figma plugin (fiGapture paste, Transfer, Copy/Paste tabs) |
| `SETUP-GUIDE.md` | This file |

---

## 0. Instructions for Claude (read this first)

> You are helping the owner of these tools install them on a Mac (often a **new** Mac) or fix a problem.
>
> 1. **Guide one step at a time.** Give one step, wait for the user to say it's done (or send a screenshot), then give the next. Never dump all steps at once.
> 2. **Check before moving on.** Each step in Section 4 has a **"Check"** line. Ask the user to run it, or run it yourself if you have a terminal (Claude Code).
> 3. **Before the setup, ask:**
>    - Is this a new Mac or the existing one?
>    - Apple Silicon (M1/M2/M3/M4…) or Intel? (`uname -m` → `arm64` = Apple Silicon.)
>    - Which parts do they need? fiGapture only (Part A), or also Transfer / Copy/Paste (Parts B + C)?
>    - Do they have the **figma-console-mcp server folder**? It is **not** in this package (see Section 3).
> 4. **When something goes wrong, check Section 6 (Incidents) first.** Most problems have happened before, and the fix is written there.
> 5. **Never ask the user to paste their Figma access token into the chat.** They type it only into the config file on their own Mac.
> 6. **Changing macOS security settings** (Accessibility / "Device Control and Data Access") is something the user must do themselves. Tell them exactly what to click.
> 7. **Back up before editing any project file:** copy it to `_backups/<name>-<date>/`. After changing `src/core/websocket-server.ts`, always run the build and tests in Section 7.

---

## 1. What these tools are

```
┌────────────────────────────────────────┐
│  Chrome  ─ fiGapture extension (A)     │  captures a website
└──────────────────┬─────────────────────┘
                   │ HTTP to localhost ports 9223–9232
                   ▼
┌────────────────────────────────────────┐
│  figma-console MCP server (C)          │  Node.js program; Claude starts it
│  relay + on-disk backups               │  backups: ~/Documents/fiGapture-Transfer-Backups/
└──────────┬─────────────────┬───────────┘
           ▼                 ▼
┌──────────────────┐ ┌──────────────────┐
│ Figma file 1     │ │ Figma file 2     │   Figma Desktop Bridge plugin (B)
│ (source)         │ │ (destination)    │   runs inside each open file
└──────────────────┘ └──────────────────┘
```

- **A — fiGapture (Chrome extension, v4.8).** Captures web pages: full-page screenshots (via Chrome DevTools, no scrolling), editable layers, design tokens and assets. Shortcuts: **Alt+F** turns the tool on, **Alt+L** opens the Library, **Alt+P** does a full-page capture. Needs Chrome 116 or newer.
- **B — Figma Desktop Bridge (Figma plugin).** Tabs:
  - **fiGapture:** "Paste in Figma" builds screenshots, sections, variables, text styles and components from a capture. Uses no AI tokens.
  - **agents:** the standard figma-console AI connection.
  - **Transfer (Rebuild mode):** copies pages between two open Figma files by rebuilding every layer, with on-disk checkpoints and **Resume**.
  - **Copy/Paste (native mode):** uses Figma's own copy and paste, one page at a time. It is fastest and keeps library links exactly. It can press the buttons for you automatically (see 2.3).
- **C — figma-console MCP server.** Based on the official open-source *figma-console-mcp v1.46.0* (southleft). Only 3 files are customised: `figma-desktop-bridge/code.js`, `figma-desktop-bridge/ui.html`, `src/core/websocket-server.ts`. **Claude Desktop starts this server automatically** from its config file. You don't run it by hand.

**What needs what:**

| You want to… | Needs |
|---|---|
| Capture a website and paste it into Figma | A + B + C |
| Transfer or Copy/Paste pages between Figma files | B + C (and both files open in Figma desktop with the plugin running) |
| Use Claude's Figma tools | B + C |

---

## 2. Latest changes (most recent first)

### 2.1 2026-11-15 — Accessibility permission: macOS checks "node", not Claude
- **Symptom:** Copy/Paste showed *"Clicking the canvas… macOS Accessibility permission is needed"*. It told you to turn on "claude" and "Claude", which did not help.
- **Root cause:** Claude Desktop starts the server through a helper (`Claude.app/Contents/Helpers/disclaimer`). The helper tells macOS that the server is **not** part of Claude. So macOS checks the program **`node`** itself, and `node` was switched off.
- **Fix:**
  - The plugin message now says to turn on **"node"** and shows the exact path of the `node` program to add if it is missing.
  - The server now asks macOS directly whether it is allowed. Before, the check hid the failure and said "OK" even when access was missing.
  - New relay test check added; tests now pass **36/36**.

### 2.2 2026-11-15 — Automatic Copy/Paste (added the same morning)
- The Copy/Paste tab can press **Cmd+C** and **Cmd+V** in Figma for you:
  - **Source file:** button **"Copy page N — <name>"**. The server clicks an empty spot of the canvas just left of the plugin panel (Figma only copies after a real canvas click), presses Cmd+C, then waits up to 30 s until Figma's layers are on the clipboard.
  - **Destination file:** button **"Paste <name> (N items)"**. Before pasting, it checks that the clipboard still holds layers from the right file.
  - Fallback buttons: **"I copied it myself"** / **"I pasted it myself"** / **"Keep what arrived and continue"**.
- **Requires** the macOS Accessibility permission for `node` (Section 4, step C6). It works on macOS only.
- New server routes: `/transfer/native/check`, `/focus`, `/copy`, `/paste`, `/open-settings`.
- Backup from before this feature: `_backups/before-auto-copypaste-20261115-061946/` (it contains a `RESTORE.md`).

### 2.3 2026-11-14 — Copy/Paste "Start copy" did nothing
- **Root cause:** after the Transfer dashboard rewrite, every new job started in state `exporting`. The Copy/Paste screen only shows jobs in state `native`. Each click saved an invisible job; 13 stuck jobs piled up.
- **Fix:** Copy/Paste jobs now start as `native`. The button disables itself after one click ("Starting…"). The stuck jobs were marked cancelled, not deleted.

### 2.4 2026-11-14 — Design-system pages are no longer locked
- Earlier, pages such as "Design system", "Components", "Foundations"… (and every page after a "Design system" page down to the next divider) were greyed out with 🔒.
- Now **every page can be ticked** in both Transfer and Copy/Paste. The "Design-system list" button is gone.
- Divider pages (names made only of dashes or dots, like `-----`) are still hidden from the list. They are empty separators.

### 2.5 2026-11-14 — Server crash "figma-console stopped running" fixed
- **Symptom:** Claude showed *"figma-console stopped running"*. The log ended with `ERR_HTTP_HEADERS_SENT`.
- **Root cause:** the server answered one request twice when a checkpoint file could not be read. Node then throws an error and the whole server quits.
- **Fix:** a crash-safe `sendJson()`; files are read before replying; each Transfer/fiGapture request is wrapped so that a bad request returns an error instead of killing the server.

### 2.6 Earlier fixes (2026-11-12 → 13)
- **Figma crash "Reason: crashed":** caused by sending 100 frames as one huge chunk, which ran Figma out of memory. Now each top-level frame is its own chunk (loose shapes are grouped 10 per chunk).
- **Transfer stuck on an image:** image reads now time out after 7 s, and every wait for an acknowledgement has a 10–15 s fallback.
- **"Timed out waiting for page" in the destination:** the fixed 30 s limit was replaced by a heartbeat. The destination now waits as long as the source keeps making progress, and gives up only after 3 minutes of silence.
- **Cancel not stopping:** cancel now uses the exact job ID, and the server refuses to let late chunks un-cancel a job.
- **Checkpoints and Resume:** every job is saved under `~/Documents/fiGapture-Transfer-Backups/<jobId>/`, and **"▶ Resume Transfer from Checkpoint"** skips work already done.
- **Live dashboard:** pages, items, files saved, and a progress bar.

---

## 3. What you need before you start

- **Mac with macOS** (tested on macOS 27, Apple Silicon).
- **Figma desktop app** (not the browser version; the plugin needs the desktop app).
- **Google Chrome 116+** (for fiGapture).
- **Claude Desktop app** (it starts the server).
- **Node.js 18 or newer** (tested with Node 26.13, npm 11.20).
- **A Figma personal access token.** Create one in Figma ▸ your avatar ▸ **Settings ▸ Security ▸ Personal access tokens**. It starts with `figd_`. Keep it private.
- **The server folder `figma-console-mcp-main`.** ⚠️ **This is not in the two zips.** Get it one of these ways:
  1. Copy `~/Documents/figma-console-mcp-main/` from the old Mac (AirDrop, USB or cloud drive). **Leave out `node_modules`** (about 500 MB); you rebuild it with `npm install`.
  2. Or use the handover package folder `FigShot-Handover/3-mcp-server/`. It has been synced, but check it with the tests in Section 7.

---

## 4. Step-by-step setup

### Part C — the server (do this first)

**C1. Install Homebrew and Node.js**
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
```bash
brew install node
```
**Check:** `node -v` shows v18 or higher, and `which node` shows the path to it.
- Apple Silicon: `/opt/homebrew/bin/node`
- Intel Mac: `/usr/local/bin/node` ← **use this path in step C4 instead**

**C2. Put the server folder in place**
Put it at `~/Documents/figma-console-mcp-main/`.
**Check:** `ls ~/Documents/figma-console-mcp-main/package.json` shows the file.

**C3. Install and build**
```bash
cd ~/Documents/figma-console-mcp-main
```
```bash
npm install
```
```bash
npm run build:local
```
**Check:** the build finishes without errors, and `ls dist/local.js` shows the file.

**C4. Tell Claude Desktop to start the server**
Open the file `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if it doesn't exist). Add `figma-console` inside `mcpServers`. Replace `YOUR_MAC_USERNAME` and the token:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOUR_MAC_USERNAME/Documents/figma-console-mcp-main/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```
- Intel Mac: change `command` to `/usr/local/bin/node`.
- If the file already has other servers, add `"figma-console": {...}` next to them. Don't replace the whole file.

**Check:** `python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json` prints the file without errors.

**C5. Restart Claude completely**
Press **Cmd+Q** in Claude (closing the window is not enough), then open it again.
**Check:**
```bash
curl http://localhost:9223/transfer/ping
```
It should answer `{"ok":true,...,"native":1}`. If port 9223 is used by another app, try 9224, 9225 … up to 9232.

**C6. macOS permission for automatic Copy/Paste** (only needed for the automatic Copy/Paste buttons)
1. Open **System Settings ▸ Privacy & Security ▸ Accessibility**. On macOS 27 this page is called **"Device Control and Data Access"**.
2. Turn on **`node`**. Turning on Claude is **not** enough (see Incident 8).
3. If `node` isn't in the list: click **+**, press **Cmd+Shift+G**, and paste the real path of node. Find it with:
   ```bash
   realpath "$(which node)"
   ```
   It looks like `/opt/homebrew/Cellar/node/<version>/bin/node`.
4. Quit and reopen Claude (Cmd+Q).

**Check:** `curl http://localhost:9223/transfer/native/check` (use the port from C5) → `"ok":true`. If it says `"needsAccess":true`, it also shows `accessApp`: that is the exact program to switch on.

### Part B — the Figma plugin

**B1. Choose where to import from.** Recommended: the server folder, `~/Documents/figma-console-mcp-main/figma-desktop-bridge/manifest.json`. Then rebuilding or updating the project updates the plugin too. (Or unzip `Figma-Desktop-Bridge-Plugin.zip` and use its `manifest.json`.)

**B2. Import it into Figma.** In Figma desktop, open any design file ▸ **Plugins ▸ Development ▸ Import plugin from manifest…** ▸ choose the `manifest.json`.

**B3. Run it.** **Plugins ▸ Development ▸ Figma Desktop Bridge**.
**Check:** the plugin shows a green **"Connected"**, and the Transfer tab can see the server.

**B4. For Transfer / Copy/Paste:** open the plugin in **both** files (source and destination), paste the destination file's link into the source file's plugin, and wait for *"✓ Found … — plugin is running there."*

### Part A — the fiGapture Chrome extension

**A1.** Unzip `fiGapture-Chrome-Extension-v4.8.zip` into a folder you'll **keep** (for example `~/Documents/fiGapture/`). Chrome loads it from that folder every time; if you delete or move the folder, the extension stops working.

**A2.** In Chrome, go to `chrome://extensions`, turn on **Developer mode** (top right) ▸ **Load unpacked** ▸ choose the unzipped folder (the one that contains `manifest.json`).

**A3.** Pin it (puzzle-piece icon ▸ pin fiGapture). Open a website ▸ **Alt+F**.

**A4.** Allow the permissions it asks for (site access, and optionally `webRequest`/`downloads` for video and asset grabbing).

**Check:** on a web page, Alt+F shows the fiGapture toolbar. A capture appears in the plugin's **fiGapture** tab, ready for "Paste in Figma".

---

## 5. Daily use — quick reference

- **Copy/Paste (fastest, keeps library links):**
  1. In the source file, tick the pages ▸ **Start copy**.
  2. Click **Copy page N**.
  3. In the destination file, click **Paste**.
  4. Back in the source file, click **Next page**.
  - Doing it by hand: copy with **Edit ▸ Copy** (Cmd+C does nothing while the plugin window has focus), then click **"I copied it myself"**.
- **Transfer (Rebuild):** slower, but runs on its own and can resume after a crash. Leave both files open.
- **After any change to the server code:** run `npm run build:local` ▸ **Cmd+Q Claude, reopen it** ▸ close and reopen the plugin in every Figma file.

---

## 6. Incidents that happened, and that can happen again on a new Mac

Each one: **what you see → why → how to fix.**

**1. "figma-console stopped running" (Claude toast)**
- **Why:** the server crashed. This was fixed on 2026-11-14 (`ERR_HTTP_HEADERS_SENT`). On a new Mac it can also mean a wrong `node` path or `dist/local.js` path in the config, or that the build was never run.
- **Fix:** check the log (Claude ▸ the error toast ▸ **View logs**). Check the paths in step C4, run `npm run build:local`, then Cmd+Q Claude and reopen it.

**2. Figma shows "Something went wrong… Reason: crashed" during a Transfer**
- **Why:** Figma ran out of memory. This was fixed by sending one frame per chunk. It can still happen with a **single enormous frame**, or a file that is already near Figma's memory limit.
- **Fix:** split giant frames, close other big files, or use **Copy/Paste** for that page. Then use **Resume Transfer from Checkpoint**.

**3. Transfer stuck on "item X/Y (image …)"**
- **Why:** a slow or broken image. Since the fix it skips the image after 7–15 s and continues.
- **Fix:** wait 15 s. If it is still stuck, click Cancel, then Resume.

**4. "Timed out waiting for page …" in the destination**
- **Why:** the destination gives up after **3 minutes with no progress** from the source. This usually means the source plugin was closed or Figma froze.
- **Fix:** keep both files open with the plugin running, then click Resume.

**5. Cancel doesn't stop the Transfer**
- **Fixed.** If it happens again, close and reopen the plugin in both files. The job stays cancelled on the server.

**6. Page item counts look wrong (e.g. "Home (0 items)", or the progress bar stuck at a low %)**
- **Why (known, not fixed yet):** Figma only fully loads pages you have opened, so counts for unopened pages can be 0 or too low. The percentage is built from those counts.
- **Fix:** it is cosmetic; the transfer itself is fine. Click each page once before starting for better counts, and watch the "item N/M" message instead of the %.

**7. Copy/Paste "Start copy" does nothing**
- **Fixed on 2026-11-14.** If it happens on a new Mac, the plugin there is an old copy. Re-import the latest plugin (step B2) and close and reopen it.

**8. "macOS Accessibility permission is needed" even though Claude is switched on** ⚠️ *Will happen on every new Mac*
- **Why:** macOS checks **`node`**, not Claude (Claude's `disclaimer` helper makes the server count as its own app).
- **Fix:** step C6. Turn on **node**, then Cmd+Q Claude and reopen it.
- **Note:** this lets any Node script on that Mac control other apps. If you don't want that, skip it and use "I copied it myself" / "I pasted it myself".

**9. Accessibility worked before, but stopped after a Homebrew update** ⚠️
- **Why:** `brew upgrade` installs Node at a new path (`…/Cellar/node/<new version>/…`), and macOS treats it as a new app.
- **Fix:** repeat step C6. Remove the old `node` entry (−) and add the new one (+).

**10. Copy fails: "Figma did not copy (the canvas did not get focus)" / "copied text instead of layers"**
- **Why:** the automatic click landed outside the canvas.
- **Fix:** keep the plugin panel over the canvas (not over the left or right side panels), click inside the correct file first, then try again. Or copy by hand with **Edit ▸ Copy**.

**11. "Click inside <file> first so it is the active file"**
- **Why:** another Figma tab or app is in front. In split view, the file name in the window title decides which file is active.
- **Fix:** click once on that file's canvas, then press the button again.

**12. Several servers running at once ("Connected to 3 AI apps")** ⚠️
- **Why:** every app that has figma-console configured starts its own server (Claude Desktop, Claude Code, Antigravity, Cursor…). Each takes a port from 9223 to 9232. On 2026-11-15, port 9223 belonged to **Antigravity**, running an **old build** without automatic Copy/Paste.
- **Fix:** the plugin automatically prefers a server that supports automatic Copy/Paste. If features are missing, rebuild (`npm run build:local`) and restart **all** those apps, or remove figma-console from the apps you don't use. To see who owns a port:
  ```bash
  lsof -nP -iTCP:9223 -sTCP:LISTEN
  ```

**13. Changes don't show up after a rebuild**
- **Why:** Claude keeps running the old server until it is fully quit, and the Figma plugin keeps its old UI until it is reopened.
- **Fix:** Cmd+Q Claude, reopen it, and close and reopen the plugin in every file.

**14. The plugin loads an old version**
- **Why:** Figma loads the plugin from the folder you imported it from. The server also copies the plugin to `~/.figma-console-mcp/plugin/` every time it starts, so there can be two copies. On the old Mac, Figma uses `~/Documents/figma-console-mcp-main/figma-desktop-bridge/manifest.json`.
- **Fix:** import from the project folder (step B1) and keep only that one. To check which one Figma uses:
  ```bash
  grep -rhoa '[^"]*manifest\.json' ~/Library/Application\ Support/Figma/ | sort -u
  ```

**15. fiGapture: Chrome asks to approve permissions again, or the extension disappears**
- **Why:** the video-grabbing update added the `webRequest` permission, so Chrome asks again. "Load unpacked" extensions also disappear if their folder is moved or deleted.
- **Fix:** approve the permissions, keep the unzipped folder in a permanent place, and click ↻ (reload) on `chrome://extensions` after replacing files.

**16. fiGapture full-page capture shows a "… started debugging this browser" bar**
- **Why:** normal. Full-page screenshots use Chrome's DevTools (`debugger` permission).
- **Fix:** none needed. Don't click "Cancel" during a capture.

**17. The handover package is out of date**
- **Why:** the `FigShot-Handover` folder in Downloads is a copy, and on 2026-11-14 its server file still had the crash bug.
- **Fix:** always take files from `~/Documents/figma-console-mcp-main/` (the master copy). Use the sync commands in `HANDOVER.md` Section 5, and also copy `dist/core/websocket-server.js` and `HANDOVER.md`.

**18. Intel Mac: "node: No such file" in the Claude log**
- **Fix:** use `/usr/local/bin/node` in the config (step C4).

**19. The Figma token is missing or expired (Figma tools fail with 403)**
- **Fix:** create a new token (Section 3) and put it in the config (step C4). Never paste it into a chat.

---

## 7. Checks and tests (for Claude Code or a developer)

Run these from the project folder:
```bash
cd ~/Documents/figma-console-mcp-main
```
```bash
npm run build:local
```
```bash
node scripts/test-relay-endpoints.mjs
```
Expect **"Passed 36/36"** and **"Server crashes: 0"**. The test uses a throwaway home folder, so it never touches real backups.
```bash
npx jest tests/websocket-bridge.test.ts
```
Expect **111 passed**.
```bash
node --check figma-desktop-bridge/code.js
```
Prints nothing if `code.js` has no syntax errors.

**Health checks while Claude is running** (use your port):
```bash
curl http://localhost:9223/transfer/ping
```
```bash
curl http://localhost:9223/transfer/files
```
```bash
curl http://localhost:9223/transfer/native/check
```

**Backups and restore:** every risky change has a dated copy in `_backups/` (for example `before-accessibility-fix-20261115-083320/`, `before-auto-copypaste-20261115-061946/`, `bridge-before-copypaste-fix-20261114-210106/`). Copy the files back, rebuild, Cmd+Q Claude, and reopen the plugin.

**Full project history and file and line references:** see `HANDOVER.md` in the project folder.

---

## 8. Copy-paste prompt for a new Claude chat

```
I'm setting up (or fixing) fiGapture and the Figma Desktop Bridge on my Mac.
I've attached SETUP-GUIDE.md. Please read it fully, then:
1. Ask me the questions in Section 0 (new Mac? Apple Silicon or Intel? which parts? do I have the server folder?).
2. Walk me through Section 4 ONE step at a time, waiting for me after each step and using each "Check".
3. If anything fails, look it up in Section 6 first and tell me the fix.
Don't ask me for my Figma token in the chat.
```
