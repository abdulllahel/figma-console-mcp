"use strict";
/* fiGapture floating icon + panel. toolbar.js calls window.__fiGapturePanel(container, api) whenever it
 * draws its idle state; every tool still runs from toolbar.js, this file only draws the controls.
 * api: { root, capture(), tiles: [{ id, label, key, node }], more: node, close(), isOpen(), setOpen(bool) } */
(() => {
  if (window.__fiGapturePanel) return;
  const CSS = `
  .fgp { display:flex; flex-direction:column; align-items:flex-end; gap:8px; pointer-events:none; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--text-primary); }
  .fgp * { box-sizing:border-box; white-space:normal; } .fgp .u, .fgp-badge { white-space:nowrap; } .fgp textarea { white-space:pre-wrap; }
  .fgp button, .fgp textarea { font:inherit; color:inherit; }
  .fgp-dock { pointer-events:auto; display:flex; flex-direction:column; align-items:center; gap:4px; width:48px; padding:6px; border-radius:24px; background:var(--bg-color); border:1px solid var(--border-color); box-shadow:0 10px 30px rgba(0,0,0,.4); }
  .fgp-main { position:relative; width:36px; height:36px; border:0; border-radius:18px; padding:0; display:flex; align-items:center; justify-content:center; background:var(--accent-color); color:var(--accent-text) !important; cursor:pointer; }
  .fgp-main:hover { filter:brightness(1.1); } .fgp-main svg { width:20px; height:20px; display:block; }
  .fgp-arrow { width:36px; height:22px; border:0; border-radius:11px; padding:0; display:flex; align-items:center; justify-content:center; background:transparent; color:var(--text-muted) !important; cursor:pointer; }
  .fgp-arrow:hover { background:rgba(255,255,255,.1); color:var(--text-primary) !important; } .fgp-arrow svg { width:14px; height:14px; transition:transform .2s ease; } .fgp-arrow.open svg { transform:rotate(180deg); }
  .fgp-badge { position:absolute; right:-9px; top:-9px; min-width:20px; padding:0 5px; height:18px; border-radius:9px; background:#F4F7E6; color:#121A06; font-size:10px; font-weight:700; line-height:18px; text-align:center; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .fgp-panel { pointer-events:auto; display:none; flex-direction:column; gap:14px; width:328px; max-width:calc(100vw - 40px); max-height:min(640px, calc(100vh - 220px)); overflow-y:auto; overscroll-behavior:contain; padding:14px; border-radius:16px; background:#171d0f; border:1px solid var(--border-color); box-shadow:0 16px 48px rgba(0,0,0,.5); scrollbar-width:thin; scrollbar-color:#4b5a30 transparent; cursor:default; }
  .fgp-panel.open { display:flex; } .fgp-panel > * { flex:none; }
  .fgp-btn { width:100%; min-height:40px; padding:8px 12px; border:1px solid transparent; border-radius:10px; font-weight:600 !important; background:var(--accent-color); color:var(--accent-text) !important; cursor:pointer; }
  .fgp-btn:hover { filter:brightness(1.08); } .fgp-btn:disabled { opacity:.45; cursor:default; filter:none; }
  .fgp-btn.ghost { background:transparent; border-color:#4b5a30; color:var(--text-primary) !important; } .fgp-btn.ghost:hover { background:rgba(255,255,255,.06); filter:none; }
  .fgp-row { display:flex; gap:8px; align-items:center; } .fgp-row .fgp-btn { min-height:34px; padding:5px 8px; font-size:12px; }
  .fgp-label { font-weight:600; } .fgp-sub { font-size:12px; color:var(--text-muted); } .fgp-err { font-size:12px; color:#ffb4a6; }
  .fgp-col { display:flex; flex-direction:column; gap:7px; }
  .fgp textarea { display:block; width:100%; height:92px; resize:vertical; padding:9px 10px; border-radius:10px; border:1px solid #4b5a30; background:#0e1208; color:var(--text-primary); font:12px/1.5 ui-monospace,Menlo,Consolas,monospace; outline:none; cursor:text; user-select:text; -webkit-user-select:text; }
  .fgp textarea::placeholder { color:rgba(244,247,230,.4); }
  .fgp-switch { display:flex; align-items:center; gap:10px; width:100%; padding:0; border:0; background:none; text-align:left; cursor:pointer; }
  .fgp-switch > span:first-child { flex:1; min-width:0; } .fgp-knob { flex:none; position:relative; width:34px; height:20px; border-radius:10px; background:#4a4f41; transition:background .15s; } .fgp-knob::after { content:""; position:absolute; left:2px; top:2px; width:16px; height:16px; border-radius:8px; background:#fff; transition:transform .15s; }
  .fgp-switch[aria-checked=true] .fgp-knob { background:var(--accent-color); } .fgp-switch[aria-checked=true] .fgp-knob::after { transform:translateX(14px); }
  .fgp-counts { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:6px; } .fgp-n { height:34px; border:1px solid #4b5a30; border-radius:9px; background:transparent; font-weight:600 !important; cursor:pointer; font-variant-numeric:tabular-nums; } .fgp-n:hover { background:rgba(255,255,255,.08); } .fgp-n[aria-checked=true] { background:var(--accent-color); border-color:var(--accent-color); color:var(--accent-text) !important; }
  .fgp-queue { padding:11px; border-radius:12px; background:#0e1208; } .fgp-count { display:flex; justify-content:space-between; gap:8px; font-weight:600; font-variant-numeric:tabular-nums; }
  .fgp-bar { height:6px; border-radius:3px; background:#333c22; overflow:hidden; } .fgp-fill { height:100%; width:0; background:var(--accent-color); transition:width .4s ease; }
  .fgp-list { display:flex; flex-direction:column; max-height:190px; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:#4b5a30 transparent; }
  .fgp-item { display:flex; align-items:flex-start; gap:8px; padding:5px 0; font-size:12px; border-top:1px solid #262d18; } .fgp-item:first-child { border-top:0; } .fgp-item.sub { padding-left:16px; }
  .fgp-item .t { flex:1; min-width:0; } .fgp-item .u { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .fgp-item .e { color:#ffb4a6; font-size:11px; }
  .fgp-item .s { flex:none; color:var(--text-muted); font-variant-numeric:tabular-nums; } .fgp-item.done .s { color:#c4dd78; } .fgp-item.failed .s, .fgp-item.blocked .s { color:#ffb4a6; }
  .fgp-dot { flex:none; width:12px; height:12px; margin-top:3px; border-radius:6px; border:2px solid #56633c; } .fgp-item.done .fgp-dot { background:#9DBA4C; border-color:#9DBA4C; } .fgp-item.failed .fgp-dot, .fgp-item.blocked .fgp-dot { background:#ff8c78; border-color:#ff8c78; } .fgp-item.busy .fgp-dot { border-color:#9DBA4C; border-right-color:transparent; animation:fgp-spin .8s linear infinite; }
  @keyframes fgp-spin { to { transform:rotate(360deg); } }
  .fgp-tiles { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .fgp-tile { display:flex; flex-direction:column; align-items:center; justify-content:flex-start; gap:4px; min-height:72px; padding:10px 4px 8px; border-radius:12px; background:rgba(255,255,255,.05); cursor:pointer; text-align:center; }
  .fgp-tile:hover { background:rgba(255,255,255,.11); } .fgp-tile .btn { width:28px !important; height:28px !important; padding:0 !important; background:transparent !important; transform:none !important; pointer-events:none; } .fgp-tile .btn-tooltip { display:none !important; } .fgp-tile .preset-anchor, .fgp-tile .more-options-container { display:flex; }
  .fgp-tile .n { font-size:11px; line-height:1.25; } .fgp-tile .k { color:var(--text-muted); }
  .fgp :is(button,textarea,.fgp-tile):focus-visible { outline:2px solid #c9da8e; outline-offset:2px; }
  @media (prefers-reduced-motion:reduce) { .fgp * { animation:none !important; transition:none !important; } }
  `;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (tag === "button") e.type = "button"; return e; };
  const svg = (box, inner) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", box); s.setAttribute("fill", "none"); const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`, "image/svg+xml"); [...doc.documentElement.childNodes].forEach((n) => s.appendChild(document.importNode(n, true))); return s; };
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { if (chrome.runtime.lastError) res({ ok: false, error: "Reload this page: fiGapture was updated." }); else res(r || { ok: false }); }); } catch (e) { res({ ok: false, error: "Reload this page: fiGapture was updated." }); } });
  const short = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname.replace(/\/+$/, "")) + x.search; } catch (e) { return u; } };
  const STATUS = { queued: "Waiting", loading: "Opening", capturing: "Capturing", saving: "Saving", done: "Captured", failed: "Failed", blocked: "Blocked", cancelled: "Stopped" };
  // Kept outside the DOM, because the panel is redrawn whenever a tool starts or ends.
  const COUNTS = [2, 3, 4, 5, 6];
  const mem = { text: "", subs: false, count: 5, state: null, note: "", err: "", parsed: null };
  // The switch is one setting for all tabs: read again before every capture, and followed live.
  const readSubs = async () => {
    try { const x = await chrome.storage.local.get(["fiGaptureSubs", "fiGaptureSubCount"]); mem.subs = !!x.fiGaptureSubs; if (COUNTS.includes(x.fiGaptureSubCount)) mem.count = x.fiGaptureSubCount; } catch (e) { mem.subs = false; }
    paint();
    return mem.subs ? mem.count : 0;
  };
  readSubs();
  try { chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && (c.fiGaptureSubs || c.fiGaptureSubCount)) readSubs(); }); } catch (e) {}
  let ui = null, timer = null, parseTimer = null;

  function paint() {
    if (!ui || !ui.wrap.isConnected) return;
    const s = mem.state, u = ui;
    u.sw.setAttribute("aria-checked", String(mem.subs));
    u.swTitle.textContent = mem.subs ? `Also capture ${mem.count} sub-pages` : "Also capture sub-pages";
    u.counts.style.display = mem.subs ? "" : "none";
    u.countBtns.forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.n === mem.count)));
    u.err.textContent = mem.err; u.err.style.display = mem.err ? "" : "none";
    u.note.textContent = mem.note; u.note.style.display = mem.note ? "" : "none";
    const n = mem.parsed ? mem.parsed.count : 0;
    u.start.disabled = !n;
    u.start.textContent = n ? `${s && s.running ? "Add" : "Capture"} ${n} link${n === 1 ? "" : "s"}${mem.subs ? ` + ${mem.count} sub-pages each` : ""}` : "Capture links";
    const p = mem.parsed;
    const info = p ? [p.dup ? `${p.dup} duplicate${p.dup === 1 ? "" : "s"} skipped` : "", p.bad.length ? `Not a link: ${p.bad.slice(0, 3).join(", ")}${p.bad.length > 3 ? " …" : ""}` : ""].filter(Boolean).join(". ") : "";
    u.info.textContent = info; u.info.style.display = info ? "" : "none";
    u.badge.style.display = s && s.running ? "" : "none";
    u.queue.style.display = s && s.total ? "" : "none";
    if (!s || !s.total) return;
    const ended = s.done + s.failed + s.blocked + s.cancelled, left = s.total - ended;
    u.badge.textContent = `${ended}/${s.total}`;
    u.countL.textContent = `${s.done} of ${s.total} captured`;
    u.countR.textContent = s.running ? `${left} left` : "Finished";
    const part = s.items.reduce((a, i) => a + (/^(loading|capturing|saving)$/.test(i.status) ? (i.pct || 0) / 100 : 0), 0);
    u.fill.style.width = Math.min(100, 100 * (ended + part) / s.total) + "%";
    const secs = Math.max(0, Math.round(((s.endedAt || s.now) - s.startedAt) / 1000)), mm = (x) => (x >= 60 ? Math.floor(x / 60) + " min " : "") + (x % 60) + " s";
    const bits = [`${mm(secs)} so far`];
    if (s.running && ended >= 2 && left) bits.push(`about ${mm(Math.round(secs / ended * left))} left`);
    if (!s.running) bits[0] = `Took ${mm(secs)}`;
    if (s.failed) bits.push(`${s.failed} failed`);
    if (s.blocked) bits.push(`${s.blocked} blocked`);
    if (s.cancelled) bits.push(`${s.cancelled} stopped`);
    const unsent = s.items.filter((i) => i.status === "done" && i.sent === false).length;
    if (unsent) bits.push(`${unsent} saved to the Library only (Figma Bridge not reachable)`);
    u.meta.textContent = bits.join(" · ") + (s.stopReason ? ". " + s.stopReason : "");
    u.stop.style.display = s.running ? "" : "none";
    u.retry.style.display = !s.running && s.failed + s.blocked + s.cancelled ? "" : "none";
    u.clear.style.display = s.running ? "none" : "";
    const sig = s.items.map((i) => i.id).join();
    if (u.list.dataset.sig !== sig) {
      u.list.dataset.sig = sig; u.list.replaceChildren(); u.rows = {};
      s.items.forEach((i) => {
        const r = el("div"), t = el("div", "t"), a = el("div", "u", short(i.url)), e = el("div", "e"), st = el("div", "s");
        a.title = i.url; t.append(a, e); r.append(el("div", "fgp-dot"), t, st); u.list.append(r); u.rows[i.id] = { r, e, st };
      });
    }
    s.items.forEach((i) => {
      const w = u.rows[i.id]; if (!w) return;
      const busy = /^(loading|capturing|saving)$/.test(i.status);
      w.r.className = "fgp-item" + (i.kind === "sub" ? " sub" : "") + " " + (busy ? "busy" : i.status);
      w.st.textContent = STATUS[i.status] + (i.status === "capturing" && i.pct ? ` ${i.pct}%` : "");
      w.e.textContent = i.error; w.e.style.display = i.error ? "" : "none";
    });
  }
  async function poll(once) {
    clearTimeout(timer);
    if (!ui || !ui.wrap.isConnected) return;
    if (!document.hidden) { const r = await send({ action: "batch:state" }); if (r.ok) mem.state = r.state; paint(); }
    const live = mem.state && mem.state.running;
    if (!once || live) timer = setTimeout(poll, live ? 800 : 4000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  async function parse() {
    if (!mem.text.trim()) { mem.parsed = null; paint(); return; }
    const t = mem.text, r = await send({ action: "batch:parse", text: t });
    if (t === mem.text) { mem.parsed = r.ok ? r : null; if (!r.ok && r.error) mem.err = r.error; paint(); }
  }
  async function act(m) { mem.err = ""; mem.note = ""; const r = await send(m); if (r.state !== undefined) mem.state = r.state; if (!r.ok && r.error) mem.err = r.error; paint(); poll(); return r; }

  window.__fiGapturePanel = (container, api) => {
    if (!api.root.querySelector("style[data-fgp]")) { const st = el("style"); st.dataset.fgp = "1"; st.textContent = CSS; api.root.appendChild(st); }
    const wrap = el("div", "fgp"), dock = el("div", "fgp-dock"), panel = el("div", "fgp-panel");
    const main = el("button", "fgp-main"); main.title = "Capture this page (F)"; main.setAttribute("aria-label", "Capture this page"); main.setAttribute("data-key", "f");
    main.append(svg("0 0 200 200", '<g stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"><rect x="70" y="24" width="60" height="152" rx="30"/><rect x="24" y="70" width="152" height="60" rx="30"/></g><circle cx="156" cy="50" r="10" fill="currentColor"/><circle cx="44" cy="150" r="10" fill="currentColor"/>'));
    const badge = el("span", "fgp-badge"); badge.style.display = "none"; main.append(badge);
    const arrow = el("button", "fgp-arrow"); arrow.setAttribute("aria-label", "More options"); arrow.append(svg("0 0 16 16", '<path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'));
    const setOpen = (v) => { api.setOpen(v); panel.classList.toggle("open", v); arrow.classList.toggle("open", v); arrow.setAttribute("aria-expanded", String(v)); arrow.title = v ? "Close panel" : "More options"; if (v) poll(); };
    // A drag on the panel must not move the dock, and text in it must stay selectable.
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    ["wheel", "click"].forEach((t) => panel.addEventListener(t, (e) => e.stopPropagation()));

    const captureHere = async () => {
      setOpen(false);
      api.capture();
      const extra = await readSubs(); // 0 when the switch is off: this page and nothing else
      if (extra) act({ action: "batch:subs", count: extra });
    };
    main.addEventListener("click", (e) => { e.stopPropagation(); captureHere(); });
    arrow.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!panel.classList.contains("open")); });

    const here = el("button", "fgp-btn", "Capture this page"); here.addEventListener("click", captureHere);
    const links = el("div", "fgp-col"), ta = el("textarea"), info = el("div", "fgp-sub"), err = el("div", "fgp-err"), note = el("div", "fgp-sub"), start = el("button", "fgp-btn", "Capture links");
    links.append(el("div", "fgp-label", "Capture a list of links"), ta);
    ta.placeholder = "Paste links, one per line\nhttps://example.com"; ta.spellcheck = false; ta.value = mem.text; ta.setAttribute("aria-label", "Links to capture");
    ["keydown", "keyup", "keypress", "paste", "input"].forEach((t) => ta.addEventListener(t, (e) => e.stopPropagation()));
    ta.addEventListener("input", () => { mem.text = ta.value; mem.err = ""; clearTimeout(parseTimer); parseTimer = setTimeout(parse, 200); });
    const sw = el("button", "fgp-switch"); sw.setAttribute("role", "switch");
    const swt = el("span"); const swTitle = el("div", "fgp-label", "Also capture sub-pages"); swt.append(swTitle, el("div", "fgp-sub", "From the main menu, then footer and page links")); sw.append(swt, el("span", "fgp-knob"));
    sw.addEventListener("click", () => { mem.subs = !mem.subs; try { chrome.storage.local.set({ fiGaptureSubs: mem.subs }); } catch (e) {} paint(); });
    const counts = el("div", "fgp-counts"); counts.setAttribute("role", "radiogroup"); counts.setAttribute("aria-label", "Number of sub-pages");
    const countBtns = COUNTS.map((n) => { const b = el("button", "fgp-n", String(n)); b.dataset.n = n; b.setAttribute("role", "radio"); b.title = `${n} sub-pages`; b.addEventListener("click", () => { mem.count = n; try { chrome.storage.local.set({ fiGaptureSubCount: n }); } catch (e) {} paint(); }); counts.append(b); return b; });
    start.addEventListener("click", async () => {
      start.disabled = true;
      const r = await act({ action: "batch:start", text: mem.text, subs: await readSubs() });
      if (r.ok) { mem.text = ""; mem.parsed = null; ta.value = ""; mem.note = "Capturing in a separate window. You can keep working here."; paint(); }
    });
    links.append(info, err, sw, counts, start, note);

    const queue = el("div", "fgp-queue fgp-col"), count = el("div", "fgp-count"), countL = el("span"), countR = el("span"), bar = el("div", "fgp-bar"), fill = el("div", "fgp-fill"), meta = el("div", "fgp-sub"), list = el("div", "fgp-list"), row = el("div", "fgp-row");
    bar.append(fill); count.append(countL, countR); countL.setAttribute("aria-live", "polite");
    const stop = el("button", "fgp-btn ghost", "Stop"), retry = el("button", "fgp-btn ghost", "Retry the rest"), clear = el("button", "fgp-btn ghost", "Clear list");
    stop.addEventListener("click", () => act({ action: "batch:stop" })); retry.addEventListener("click", () => act({ action: "batch:retry" })); clear.addEventListener("click", () => act({ action: "batch:clear" }));
    list.addEventListener("click", (e) => { const id = ui && Object.keys(ui.rows).find((k) => ui.rows[k].r.contains(e.target)); if (id) send({ action: "batch:show", id }); });
    row.append(stop, retry, clear); queue.append(count, bar, meta, list, row); queue.style.display = "none";

    const tiles = el("div", "fgp-tiles");
    const tile = (label, key, node, run) => {
      const t = el("div", "fgp-tile"); t.setAttribute("role", "button"); t.tabIndex = 0; t.title = key ? `${label} (${key})` : label;
      if (node) { node.querySelectorAll("button").forEach((b) => { b.tabIndex = -1; }); t.append(node); }
      const n = el("span", "n", label); t.append(n); if (key) t.append(el("span", "n k", key));
      const go = () => run();
      t.addEventListener("click", (e) => { if (e.target.closest(".more-drawer")) return; if (e.detail === -1) return; go(); });
      t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); go(); } });
      tiles.append(t);
    };
    const press = (node) => { const b = node.matches("button") ? node : node.querySelector("button"); if (b) { b.dispatchEvent(new MouseEvent("click", { bubbles: false })); } };
    api.tiles.forEach((x) => tile(x.label, x.key, x.node, () => { setOpen(false); press(x.node); }));
    const icon = (inner) => { const d = el("div", "btn"); const i = el("div", "icon"); const s = svg("0 0 20 20", inner); s.setAttribute("width", "20"); s.setAttribute("height", "20"); i.append(s); d.append(i); d.style.cssText = "display:flex;align-items:center;justify-content:center"; return d; };
    tile("Library", "Alt+L", icon('<path d="M4 3v14M8 3v14M12 4l4 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'), () => send({ action: "openLibrary" }));
    tile("Tools shown", "", api.more, () => press(api.more));
    tile("Close", "Esc", icon('<path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'), () => api.close());

    panel.append(here, links, queue, el("div", "fgp-label", "Tools"), tiles);
    dock.append(main, arrow); wrap.append(dock, panel); container.append(wrap);
    ui = { wrap, badge, sw, swTitle, counts, countBtns, info, err, note, start, queue, countL, countR, fill, meta, list, stop, retry, clear, rows: {} };
    setOpen(api.isOpen());
    requestAnimationFrame(() => { paint(); poll(); });
  };
})();
