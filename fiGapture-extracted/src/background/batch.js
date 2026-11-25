"use strict";
/* fiGapture batch capture.
 * A queue of pages, captured up to 3 at a time in background tabs of one separate window, with the
 * same Full Page capture the toolbar uses. While a page is captured its debugger session stays
 * attached with "focus emulation", so Chrome renders the hidden tab at full speed and nothing has to
 * be brought to the front. Results go to the Library and the Figma Bridge; the clipboard is not used.
 * The queue lives in chrome.storage.session, so it survives a service worker restart. */
const BATCH_PARALLEL = 3;
const BATCH_PRELOAD = 2;          // pages opened ahead so they load while others are captured
const BATCH_LOAD_MS = 40000;      // longest wait for a page to load
const BATCH_CAPTURE_MS = 210000;  // longest capture of one page
const BATCH_MAX = 200;
const SUB_MIN = 2, SUB_MAX = 6;   // sub-pages per site the user can choose
const batchCount = (n) => (n === true ? 5 : n ? Math.min(SUB_MAX, Math.max(SUB_MIN, Math.round(+n) || 0)) : 0);
var batchTabs = new Map();        // tabId -> the job being captured there (see batchEvent)
let batch = null;                 // { id, running, windowId, items: [...], startedAt, endedAt, stopReason }
let batchPumping = false;

const batchLoaded = chrome.storage.session.get("batch").then((x) => {
  batch = x.batch || null;
  batchResume();
}).catch(() => {});
function batchResume() { // the worker was restarted in the middle
  if (!batch || !batch.running) return;
  batch.items.forEach((it) => { if (BATCH_ACTIVE[it.status]) { it.status = "queued"; it.pct = 0; } });
  batchPump();
}
const BATCH_ACTIVE = { loading: 1, capturing: 1, saving: 1 };

let batchSaveTimer = null;
function batchSave(now) {
  const write = () => { batchSaveTimer = null; chrome.storage.session.set({ batch }).catch(() => {}); };
  if (now) { clearTimeout(batchSaveTimer); write(); } else if (!batchSaveTimer) batchSaveTimer = setTimeout(write, 400);
  batchBadge();
}
function batchBadge() {
  const it = batch ? batch.items : [];
  const done = it.filter((i) => !BATCH_ACTIVE[i.status] && i.status !== "queued").length;
  chrome.action.setBadgeBackgroundColor({ color: "#4F7014" }).catch(() => {});
  chrome.action.setBadgeText({ text: batch && batch.running ? `${done}/${it.length}` : "" }).catch(() => {});
}
// Called by the capture code (service-worker.js) for every tab; only batch tabs react.
function batchEvent(tabId, type, data) {
  const job = batchTabs.get(tabId);
  if (!job) return;
  if (type === "progress") { job.item.pct = Math.max(job.item.pct || 0, Math.min(90, Math.round(data))); if (data >= 68) job.item.status = "saving"; batchSave(); }
  else if (type === "saved") job.finish(null, data);
  else if (type === "failed") job.finish(new Error(data));
}

// ---------- links ----------
function batchNormalise(raw) {
  let t = String(raw || "").trim().replace(/^[<("'\[]+|[>)"'\],;]+$/g, "");
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = "https://" + t;
  try {
    const u = new URL(t);
    if (!/^https?:$/.test(u.protocol) || (!u.hostname.includes(".") && u.hostname !== "localhost")) return null;
    u.hash = "";
    return u.href;
  } catch (e) { return null; }
}
function batchKey(url) { try { const u = new URL(url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search; } catch (e) { return url; } }
function batchParse(text) {
  const urls = [], bad = [], seen = new Set(); let dup = 0;
  String(text || "").split(/[\s,]+/).filter(Boolean).forEach((raw) => {
    const u = batchNormalise(raw);
    if (!u || isRestrictedUrl(u)) { bad.push(raw.slice(0, 80)); return; }
    const k = batchKey(u);
    if (seen.has(k)) { dup++; return; }
    seen.add(k); urls.push(u);
  });
  return { urls, bad, dup };
}

// Runs inside the page: same-site links, main menu first, then footer, then the rest of the page.
function batchCollectLinks(max) {
  const host = location.hostname.replace(/^www\./, "");
  const key = (u) => u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search;
  const skip = /(^|[\/_-])(log-?in|sign-?in|sign-?up|sso|register|get-started|onboarding|create|free-trial|logout|log-?out|sign-?out|auth|account|checkout|cart|download|downloads|legal|privacy|terms|cookies?|gdpr|imprint|tos|eula)([\/_.-]|$)/i;
  const file = /\.(pdf|zip|dmg|exe|pkg|msi|png|jpe?g|gif|svg|webp|mp4|mov|mp3|csv|xlsx?|docx?|pptx?|xml|rss|json|txt|ics)$/i;
  const seen = new Set([key(location)]), out = [];
  const take = (list) => {
    for (const a of list) {
      if (out.length >= max) return;
      let u; try { u = new URL(a.getAttribute("href"), document.baseURI); } catch (e) { continue; }
      if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
      if (a.hasAttribute("download") || skip.test(u.pathname) || file.test(u.pathname)) continue;
      if (/^(log ?in|sign ?in|sign ?up|get started)$/i.test((a.textContent || "").trim())) continue;
      u.hash = "";
      const k = key(u);
      if (seen.has(k)) continue;
      seen.add(k); out.push(u.href);
    }
  };
  const all = (s) => Array.from(document.querySelectorAll(s));
  take(all("header a[href], nav a[href], [role=navigation] a[href], [role=banner] a[href]").filter((a) => !a.closest("footer, [role=contentinfo]")));
  take(all("footer a[href], [role=contentinfo] a[href]"));
  take(all("a[href]"));
  return out;
}
// Runs inside the page: is this a wall (bot check, sign-in, error) instead of the real page?
function batchCheckPage() {
  const text = (document.body ? document.body.innerText : "").trim(), t = document.title || "";
  const short = text.length < 1500;
  if (/^(just a moment|attention required|access denied|security check|verify(ing)? you are human|are you a robot|403 forbidden)/i.test(t.trim())) return { blocked: "The site shows a bot check or access wall" };
  if (short && /(verify(ing)? you are (a )?human|checking your browser|enable javascript and cookies to continue|unusual traffic|press (&|and) hold)/i.test(text)) return { blocked: "The site shows a bot check" };
  if (short && document.querySelector("input[type=password]")) return { blocked: "The page asks you to sign in" };
  if (text.length < 5 && !document.querySelector("img,svg,canvas,video,iframe")) return { empty: true };
  return { ok: true, ready: document.readyState };
}

// ---------- one page ----------
const batchSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function batchWindow(url) {
  if (batch.windowId) {
    try { await chrome.windows.get(batch.windowId); return (await chrome.tabs.create({ windowId: batch.windowId, url, active: false })).id; } catch (e) { batch.windowId = null; }
  }
  if (!batch.windowPromise) {
    // Same size as the window the batch was started from, so pages get the same layout as a manual capture.
    const src = batch.sourceWindow ? await chrome.windows.get(batch.sourceWindow).catch(() => null) : null;
    if (batch.windowId || batch.windowPromise) return batchWindow(url);
    const size = src && src.width > 500 ? { width: src.width, height: src.height, left: src.left, top: src.top } : { width: 1440, height: 900 };
    // A blank tab stays in front: the front tab of a minimised window stops rendering, the hidden ones do not.
    const p = chrome.windows.create({ url: "about:blank", focused: false, ...size }).then(async (w) => {
      if (src) await chrome.windows.update(src.id, { focused: true }).catch(() => {}); // stay in the user's window
      return w;
    });
    Object.defineProperty(batch, "windowPromise", { value: p, configurable: true, enumerable: false });
    const w = await p.finally(() => { delete batch.windowPromise; });
    batch.windowId = w.id;
    batch.blankTab = w.tabs[0].id;
    return (await chrome.tabs.create({ windowId: w.id, url, active: false })).id;
  }
  await batch.windowPromise.catch(() => {});
  return batchWindow(url);
}
async function batchOpen(it) {
  if (it.tabId) { try { await chrome.tabs.get(it.tabId); return it.tabId; } catch (e) { it.tabId = null; } }
  it.tabId = await batchWindow(it.url);
  it.openedAt = Date.now();
  batchSave();
  return it.tabId;
}
async function batchRun(it) {
  it.status = "loading"; it.pct = 0; it.error = ""; it.startedAt = Date.now();
  batchSave(true);
  const tabId = await batchOpen(it);
  let entry = null, job = null, timer = null;
  try {
    // Debugger first: a hidden tab renders and runs timers normally only with focus emulation.
    if (!pendingShots.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {}); // left over from before a worker restart
    entry = shotsEntry({ id: tabId });
    entry.hold = true; clearTimeout(entry.timer);
    if (!(await entry.attach)) throw new Error("The browser did not allow the debugger on this page");
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await batchViewport(tabId);
    const result = await new Promise((resolve, reject) => {
      job = { item: it, over: false, finish: (err, data) => { job.over = true; if (err) reject(err); else resolve(data); } };
      const alive = () => { if (job.over) throw new Error("Stopped"); }; // the steps below must not go on after the page ended
      batchTabs.set(tabId, job);
      (async () => {
        const t0 = Date.now();
        let interactiveAt = 0;
        for (;;) {
          alive();
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === "complete" && !tab.pendingUrl) break;
          if (!interactiveAt) {
            const r = await Promise.race([chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => document.readyState + "|" + location.protocol }).catch(() => null), batchSleep(1500)]);
            const st = r && r[0] && r[0].result || "";
            if (/^(interactive|complete)\|http/.test(st)) interactiveAt = Date.now();
          } else if (Date.now() - interactiveAt > 7000) break; // a slow tracker or image must not hold the capture
          if (Date.now() - t0 > BATCH_LOAD_MS) { if (interactiveAt) break; throw new Error("The page did not load in time"); }
          await batchSleep(200);
        }
        const tab = await chrome.tabs.get(tabId);
        if (/^(chrome|edge)-error:/.test(tab.url || "")) throw new Error("The page could not be opened");
        if (isRestrictedUrl(tab.url)) throw Object.assign(new Error("The browser does not allow capturing this page"), { blocked: true });
        it.finalUrl = tab.url; it.title = tab.title || "";
        await batchSleep(900);
        alive();
        let chk = null;
        for (let i = 0; i < 4; i++) {
          const r = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: batchCheckPage }).catch((e) => { throw new Error(/error page/i.test(String(e)) ? "The page could not be opened" : String(e && e.message || e)); });
          chk = r && r[0] && r[0].result;
          if (chk && !chk.empty && !chk.blocked) break;
          await batchSleep(1500); // the page may still be filling in, or a check may pass by itself
        }
        alive();
        if (chk && chk.blocked) throw Object.assign(new Error(chk.blocked), { blocked: true });
        const vp = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => innerWidth });
        if (!(vp[0].result >= 800)) { await batchViewport(tabId); await batchSleep(600); const v2 = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => innerWidth }); if (!(v2[0].result >= 800)) throw new Error("The page window had the wrong size"); }
        it.status = "capturing"; batchSave();
        if (!(await isToolbarMounted(tabId))) { await injectIntoTab(tabId, false); await batchSleep(500); alive(); }
        await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => { window.__fiGaptureFull && window.__fiGaptureFull(); } });
        timer = setTimeout(() => job.finish(new Error("The capture took too long")), BATCH_CAPTURE_MS);
      })().catch((e) => { job.over = true; reject(e); });
    });
    it.slices = result.slices; it.sent = result.sent;
    // A tall page with almost no layer data was captured before its content was there: try again.
    if (result.slices >= 3 && result.layers < 50000) throw new Error("The page was saved almost empty");
    if (!result.slices) { it.error = "Saved without screenshots"; }
    if (it.kind === "main" && it.subs) await batchAddSubs(it, tabId, it.subs);
    it.status = "done"; it.pct = 100;
  } finally {
    clearTimeout(timer);
    batchTabs.delete(tabId);
    if (entry) { entry.hold = false; if (pendingShots.get(tabId) === entry) pendingShots.delete(tabId); await shotsDetach(entry); }
    it.endedAt = Date.now();
    // Remove the floating icon again, unless it was already switched on for this site.
    try { const t = await chrome.tabs.get(tabId); if (!isOriginActive(t.url)) await hideToolbarInTab(tabId); } catch (e) {}
  }
}
async function batchAddSubs(parent, tabId, count) {
  const r = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: batchCollectLinks, args: [count * 4] }).catch(() => null);
  const links = (r && r[0] && r[0].result) || [];
  const have = new Set(batch.items.map((i) => batchKey(i.url)));
  const at = batch.items.indexOf(parent) + 1, add = [];
  for (const url of links) {
    if (add.length >= count) break;
    const k = batchKey(url);
    if (have.has(k)) continue;
    have.add(k);
    add.push(batchItem(url, "sub", parent.id));
  }
  batch.items.splice(at, 0, ...add);
  parent.subCount = add.length;
  return add.length;
}
// A hidden tab can be laid out one pixel wide. Give it the size of the user's own page area, always.
async function batchViewport(tabId) {
  if (!batchTabs.has(tabId) && !(pendingShots.get(tabId) || {}).hold) return;
  const width = Math.max(1024, (batch && batch.vw) || 1440), height = Math.max(600, (batch && batch.vh) || 900);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false }).catch(() => {});
}
let batchSeq = 0;
function batchItem(url, kind, parent) { return { id: "b" + Date.now().toString(36) + (batchSeq++).toString(36), url, kind, parent: parent || null, status: "queued", pct: 0, error: "", tries: 0 }; }

// ---------- queue ----------
async function batchPump() {
  if (batchPumping || !batch || !batch.running) return;
  batchPumping = true;
  chrome.alarms.create("fiGapture-batch", { periodInMinutes: 0.5 });
  try {
    const run = batch, active = new Map();
    // First tries first; pages that failed once wait until the others are done.
    const next = () => { const q = run.items.filter((i) => i.status === "queued" && !active.has(i.id)); return q.find((i) => !i.tries) || q[0]; };
    while (run === batch && run.running) {
      while (active.size < BATCH_PARALLEL && next()) {
        const it = next();
        active.set(it.id, batchStep(run, it).finally(() => active.delete(it.id)));
      }
      if (!active.size) break;
      run.items.filter((i) => i.status === "queued" && !i.tabId && !active.has(i.id)).slice(0, BATCH_PRELOAD).forEach((i) => batchOpen(i).catch(() => {}));
      await Promise.race([...active.values(), batchSleep(1000)]);
    }
    if (run === batch && run.running) { run.running = false; run.endedAt = Date.now(); }
    if (run.blankTab) { chrome.tabs.remove(run.blankTab).catch(() => {}); run.blankTab = null; run.windowId = null; }
  } finally {
    batchPumping = false;
    chrome.alarms.clear("fiGapture-batch");
    batchSave(true);
    if (batch && batch.running) setTimeout(batchPump, 0); // a new batch started meanwhile
  }
}
async function batchStep(run, it) {
  try { it.tries++; await batchRun(it); }
  catch (e) {
    if (!run.running || it.status === "cancelled") { it.status = "cancelled"; }
    else if (e && e.blocked) { it.status = "blocked"; it.error = e.message; }
    else if (it.tries < 2 && !/tab was closed|debugger/i.test(String(e && e.message))) {
      it.status = "queued"; it.pct = 0;
      if (it.tabId) await chrome.tabs.reload(it.tabId).catch(() => { it.tabId = null; });
    } else { it.status = "failed"; it.error = String((e && e.message) || e); }
  }
  // Sub-pages close after capture; main pages stay open.
  if (it.kind === "sub" && it.tabId && it.status !== "queued") { await chrome.tabs.remove(it.tabId).catch(() => {}); it.tabId = null; }
  batchSave(true);
}
async function batchStop(reason) {
  if (!batch || !batch.running) return;
  batch.running = false; batch.endedAt = Date.now(); batch.stopReason = reason || "";
  for (const it of batch.items) {
    if (it.status === "queued") {
      it.status = "cancelled";
      if (it.tabId && it.kind === "sub") { chrome.tabs.remove(it.tabId).catch(() => {}); it.tabId = null; }
    }
  }
  for (const [tabId, job] of batchTabs) {
    chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) }).catch(() => {});
    job.item.status = "cancelled"; job.finish(new Error("Stopped"));
  }
  batchSave(true);
}
function batchView() {
  if (!batch) return null;
  const n = (s) => batch.items.filter((i) => i.status === s).length;
  const active = batch.items.filter((i) => BATCH_ACTIVE[i.status]).length;
  return {
    running: batch.running, startedAt: batch.startedAt, endedAt: batch.endedAt || null, stopReason: batch.stopReason || "", now: Date.now(),
    total: batch.items.length, done: n("done"), failed: n("failed"), blocked: n("blocked"), cancelled: n("cancelled"), active, queued: n("queued"),
    items: batch.items.map((i) => ({ id: i.id, url: i.url, kind: i.kind, status: i.status, pct: i.pct || 0, error: i.error || "", title: i.title || "", sent: i.sent })),
  };
}
async function batchAllowed() {
  if (await chrome.permissions.contains({ origins: ["<all_urls>"] })) return true;
  chrome.windows.create({ url: chrome.runtime.getURL("pages/permissions/index.html"), type: "popup", width: 450, height: 350 });
  return false;
}
async function batchMessage(m, tab) {
  await batchLoaded;
  switch (m.action) {
    case "batch:state": return { ok: true, state: batchView() };
    case "batch:parse": { const p = batchParse(m.text); return { ok: true, count: p.urls.length, bad: p.bad, dup: p.dup }; }
    case "batch:start": case "batch:subs": {
      let items;
      if (m.action === "batch:start") {
        const p = batchParse(m.text);
        if (!p.urls.length) return { ok: false, error: "No usable links found." };
        if (p.urls.length > BATCH_MAX) return { ok: false, error: `Up to ${BATCH_MAX} links at a time.` };
        items = p.urls.map((u) => Object.assign(batchItem(u, "main"), { subs: batchCount(m.subs) }));
      }
      // Sub-pages of the current page only while the switch is on, whatever the page sent.
      if (m.action === "batch:subs" && !(batchCount(m.count) && (await chrome.storage.local.get("fiGaptureSubs")).fiGaptureSubs)) return { ok: true, state: batchView() };
      if (!(await batchAllowed())) return { ok: false, error: "Allow access to all sites in the small window, then start again." };
      if (!batch || !batch.running) batch = { id: "batch_" + Date.now(), running: true, windowId: null, sourceWindow: tab.windowId, vw: tab.width || 0, vh: tab.height || 0, items: [], startedAt: Date.now() };
      if (items) {
        const have = new Set(batch.items.filter((i) => i.status === "queued" || BATCH_ACTIVE[i.status]).map((i) => batchKey(i.url)));
        batch.items.push(...items.filter((i) => !have.has(batchKey(i.url))));
      } else if (!(await batchAddSubs({ id: "page", url: tab.url }, tab.id, batchCount(m.count)))) { if (!batch.items.length) batch = null; batchSave(true); return { ok: false, error: "No sub-pages found on this page." }; }
      batchSave(true);
      batchPump();
      return { ok: true, state: batchView() };
    }
    case "batch:stop": await batchStop(); return { ok: true, state: batchView() };
    case "batch:clear": if (batch && !batch.running) { batch = null; batchSave(true); } return { ok: true, state: batchView() };
    case "batch:retry":
      if (!batch || !(await batchAllowed())) return { ok: false, state: batchView() };
      batch.items.forEach((i) => { if (/^(failed|blocked|cancelled)$/.test(i.status)) { i.status = "queued"; i.tries = 0; i.error = ""; i.pct = 0; } });
      if (!batch.running) { batch.running = true; batch.startedAt = Date.now(); batch.endedAt = null; batch.stopReason = ""; }
      batchSave(true); batchPump();
      return { ok: true, state: batchView() };
    case "batch:show": {
      const it = batch && batch.items.find((i) => i.id === m.id);
      if (it && it.tabId) { const t = await chrome.tabs.update(it.tabId, { active: true }).catch(() => null); if (t) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); return { ok: !!t }; }
      return { ok: false };
    }
  }
  return { ok: false, error: "unknown action" };
}
chrome.tabs.onRemoved.addListener((tabId) => {
  const job = batchTabs.get(tabId);
  if (job) job.finish(new Error("The tab was closed"));
  if (batch) batch.items.forEach((i) => { if (i.tabId === tabId) i.tabId = null; });
});
// "Cancel" on the browser's debugging banner ends every session: stop instead of failing page by page.
chrome.debugger.onDetach.addListener((src, reason) => {
  if (reason === "canceled_by_user" && batchTabs.has(src.tabId)) batchStop("The browser's debugging banner was cancelled, so the batch stopped.");
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "fiGapture-batch") batchLoaded.then(() => batchPump()); });
