"use strict";
const $ = (s) => document.querySelector(s);
const status = (t) => { $("#status").textContent = t; };
let records = [];
const urls = [];

// ---------- storage ----------
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("fiGapture-library", 2);
    r.onupgradeneeded = () => {
      const st = r.result.objectStoreNames.contains("captures") ? r.transaction.objectStore("captures") : r.result.createObjectStore("captures", { keyPath: "id" });
      if (!st.indexNames.contains("key")) st.createIndex("key", "key");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadAll() {
  const db = await openDb();
  const rows = await new Promise((res, rej) => {
    const q = db.transaction("captures").objectStore("captures").getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  db.close();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
async function removeIds(ids) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction("captures", "readwrite");
    ids.forEach((id) => tx.objectStore("captures").delete(id));
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}

// ---------- list ----------
const esc = (t) => String(t).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "page"; } };
const pathOf = (u) => { try { const x = new URL(u); const p = x.pathname.replace(/\/+$/, "") || "/"; return p + x.search; } catch (e) { return "/"; } };

// Group records by website; pages sorted by path (home first).
function groupBySite(rows) {
  const m = new Map();
  rows.forEach((r) => { const h = hostOf(r.url); if (!m.has(h)) m.set(h, []); m.get(h).push(r); });
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([host, pages]) => ({
    host,
    pages: pages.sort((a, b) => pathOf(a.url).localeCompare(pathOf(b.url))),
  }));
}

// Wait for the one-time move of captures saved under the extension's previous name.
const libReady = chrome.runtime.sendMessage({ action: "libMigrate" }).catch(() => {});
async function render() {
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  await libReady;
  records = await loadAll();
  const list = $("#list");
  if (!records.length) { list.innerHTML = '<div class="card mut">Nothing saved yet. Open a website, open the fiGapture toolbar and click <b>Full Page</b>.</div>'; return; }
  list.innerHTML = "";
  for (const site of groupBySite(records)) {
    const box = document.createElement("div");
    box.className = "site";
    const withDesign = site.pages.filter((p) => p.design).length;
    box.innerHTML =
      `<div class="sitehead"><input type="checkbox" data-site="${esc(site.host)}" checked>` +
      `<div class="t"><div class="sitename">${esc(site.host)}</div><div class="mut">${site.pages.length} page(s) · one merged design system${withDesign ? "" : " (no design data yet)"}</div></div>` +
      `<button class="p" data-copysite="${esc(site.host)}">Copy site to Figma</button></div>`;
    for (const r of site.pages) {
      const card = document.createElement("div");
      card.className = "card";
      const thumbs = r.slices.map((s) => { const u = URL.createObjectURL(s.blob); urls.push(u); return `<img src="${u}" alt="">`; }).join("");
      card.innerHTML =
        `<div class="head"><input type="checkbox" data-id="${r.id}" data-host="${esc(site.host)}" checked>` +
        `<div class="t"><div class="title">${esc(pathOf(r.url))}</div><div class="mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title || r.url)}</div>` +
        `<div class="mut">${new Date(r.createdAt).toLocaleString()} · ${r.slices.length} screenshot(s)${r.pageHeight ? " · " + Math.round(r.pageHeight) + "px tall" : ""}</div></div>` +
        `<button data-copy="${r.id}">Copy page</button></div><div class="row">${thumbs}</div>`;
      box.appendChild(card);
    }
    list.appendChild(box);
  }
}

// ---------- DOM helpers for the blocks we hand to the capture engine ----------
function el(tag, style, text, kids) {
  const e = document.createElement(tag);
  if (style) Object.assign(e.style, style);
  if (text != null) e.textContent = text;
  if (kids) kids.forEach((k) => k && e.appendChild(k));
  return e;
}
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

function renderShots(r) {
  const w = Math.round(r.pageWidth || 1440);
  const dpr = r.dpr || 1;
  const wrap = el("div", { width: w + "px", background: "#fff", fontFamily: SANS });
  r.slices.forEach((s, i) => {
    const img = document.createElement("img");
    const u = URL.createObjectURL(s.blob); urls.push(u);
    img.src = u;
    Object.assign(img.style, { display: "block", width: w + "px", height: Math.round(s.height / dpr) + "px", margin: "0 0 24px 0" });
    wrap.appendChild(el("div", { font: "500 14px " + SANS, color: "#71717a", padding: "0 0 8px 0" }, `${hostOf(r.url)}${pathOf(r.url)} — screenshot ${i + 1} of ${r.slices.length}`));
    wrap.appendChild(img);
  });
  return wrap;
}

function cleanSvg(html) {
  try {
    const doc = new DOMParser().parseFromString(html, "image/svg+xml");
    if (doc.querySelector("parsererror")) return null;
    doc.querySelectorAll("script,foreignObject").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((n) => [...n.attributes].forEach((a) => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); }));
    const svg = document.importNode(doc.documentElement, true);
    svg.setAttribute("width", "32"); svg.setAttribute("height", "32");
    return svg;
  } catch (e) { return null; }
}

function section(title, sub) {
  return el("div", { margin: "40px 0 0 0" }, null, [
    el("div", { font: "700 22px " + SANS, color: "#111", padding: "0 0 4px 0" }, title),
    sub ? el("div", { font: "400 13px " + SANS, color: "#71717a", padding: "0 0 16px 0" }, sub) : null,
  ]);
}

function mergeDesigns(pages) {
  const byCount = (a, b) => b.count - a.count;
  const sum = (key, arrays, idf) => { const m = new Map(); arrays.forEach((arr) => (arr || []).forEach((x) => { const k = idf(x); const c = m.get(k); if (c) { c.count += x.count; if (x.roles) x.roles.forEach((r) => { if (c.roles && !c.roles.includes(r)) c.roles.push(r); }); } else m.set(k, { ...x, roles: x.roles ? [...x.roles] : undefined }); })); return [...m.values()].sort(byCount); };
  const ds = pages.map((p) => p.design).filter(Boolean);
  const vars = {};
  ds.forEach((d) => Object.assign(vars, d.cssVariablesResolved || {}));
  const icons = new Map();
  ds.forEach((d) => (d.icons || []).forEach((i) => { if (!icons.has(i.hash)) icons.set(i.hash, i); }));
  return {
    colors: sum("c", ds.map((d) => d.colors), (x) => x.value),
    typography: sum("t", ds.map((d) => d.typography), (x) => [x.family, x.size, x.weight, x.lineHeight, x.letterSpacing, x.textTransform].join("|")),
    spacing: sum("s", ds.map((d) => d.spacing), (x) => x.value),
    radii: sum("r", ds.map((d) => d.radii), (x) => x.value),
    shadows: sum("h", ds.map((d) => d.shadows), (x) => x.value),
    components: sum("k", ds.map((d) => d.components), (x) => x.type + "|" + x.signature),
    cssVariablesResolved: vars,
    icons: [...icons.values()],
  };
}

function renderDesign(host, pages) {
  const d = mergeDesigns(pages);
  const r = { url: "https://" + host, createdAt: Math.max(...pages.map((p) => p.createdAt)) };
  const root = el("div", { width: "1200px", background: "#fff", color: "#111", fontFamily: SANS, padding: "48px", boxSizing: "border-box" });
  root.appendChild(el("div", { font: "700 34px " + SANS }, `Design system — ${hostOf(r.url)}`));
  root.appendChild(el("div", { font: "400 14px " + SANS, color: "#71717a", padding: "6px 0 0 0" }, `${r.url} · captured ${new Date(r.createdAt).toLocaleString()}`));
  root.appendChild(el("div", { font: "400 12px " + SANS, color: "#a1a1aa", padding: "4px 0 0 0" }, "Extracted from computed styles; hover/focus states are not captured."));

  {
    const sec = section("Pages captured", `${pages.length} page(s) merged into this document`);
    pages.forEach((p) => sec.appendChild(el("div", { font: "400 13px " + SANS, color: "#3f3f46", padding: "2px 0" }, `${pathOf(p.url)} — ${p.title || ""}`.slice(0, 140))));
    root.appendChild(sec);
  }

  // Colors
  if ((d.colors || []).length) {
    const s = section("Colors", `${d.colors.length} unique colors, most used first`);
    const grid = el("div", { display: "flex", flexWrap: "wrap", gap: "16px" });
    d.colors.slice(0, 48).forEach((c) => {
      grid.appendChild(el("div", { width: "130px" }, null, [
        el("div", { width: "130px", height: "64px", borderRadius: "8px", background: c.value, border: "1px solid #e4e4e7" }),
        el("div", { font: "600 13px " + SANS, padding: "6px 0 0 0" }, c.value.toUpperCase()),
        el("div", { font: "400 11px " + SANS, color: "#71717a" }, `${(c.roles || []).join(", ")} · ×${c.count}`),
      ]));
    });
    s.appendChild(grid); root.appendChild(s);
  }

  // CSS variables
  const vars = Object.entries(d.cssVariablesResolved || {}).filter(([, v]) => v).slice(0, 120);
  if (vars.length) {
    const s = section("CSS variables", `${vars.length} custom properties (resolved on :root)`);
    vars.forEach(([k, v]) => {
      const row = el("div", { display: "flex", gap: "16px", padding: "4px 0", borderBottom: "1px solid #f4f4f5", font: "400 12px " + SANS, alignItems: "center" });
      const isColor = /^(#|rgb|hsl|oklch|color\()/i.test(v);
      if (isColor) row.appendChild(el("div", { width: "14px", height: "14px", borderRadius: "3px", background: v, border: "1px solid #e4e4e7", flex: "none" }));
      row.appendChild(el("div", { width: "320px", fontWeight: "600", flex: "none" }, k));
      row.appendChild(el("div", { color: "#52525b" }, v.slice(0, 120)));
      s.appendChild(row);
    });
    root.appendChild(s);
  }

  // Typography
  if ((d.typography || []).length) {
    const s = section("Typography", `${d.typography.length} text styles`);
    d.typography.slice(0, 24).forEach((t) => {
      const spec = `${t.family} · ${t.size} / ${t.lineHeight} · weight ${t.weight}${t.letterSpacing && t.letterSpacing !== "normal" ? " · tracking " + t.letterSpacing : ""} · ×${t.count}`;
      s.appendChild(el("div", { padding: "12px 0", borderBottom: "1px solid #f4f4f5" }, null, [
        el("div", { fontFamily: t.family + "," + SANS, fontSize: t.size, fontWeight: t.weight, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, textTransform: t.textTransform, color: "#111", whiteSpace: "nowrap", overflow: "hidden" }, "The quick brown fox jumps over the lazy dog"),
        el("div", { font: "400 12px " + SANS, color: "#71717a", padding: "4px 0 0 0" }, spec),
      ]));
    });
    root.appendChild(s);
  }

  // Spacing
  if ((d.spacing || []).length) {
    const s = section("Spacing", "Most used padding / margin / gap values");
    [...d.spacing].sort((a, b) => b.count - a.count).slice(0, 16).sort((a, b) => parseFloat(a.value) - parseFloat(b.value)).forEach((sp) => {
      s.appendChild(el("div", { display: "flex", alignItems: "center", gap: "12px", padding: "3px 0", font: "400 12px " + SANS }, null, [
        el("div", { width: "70px", fontWeight: "600" }, sp.value),
        el("div", { width: Math.min(400, Math.max(2, parseFloat(sp.value))) + "px", height: "12px", background: "#6f8f2a", borderRadius: "2px" }),
        el("div", { color: "#71717a" }, "×" + sp.count),
      ]));
    });
    root.appendChild(s);
  }

  // Radii + shadows
  const boxes = (title, arr, fn) => {
    if (!arr || !arr.length) return;
    const s = section(title);
    const grid = el("div", { display: "flex", flexWrap: "wrap", gap: "20px" });
    arr.slice(0, 12).forEach((x) => grid.appendChild(el("div", { width: "120px" }, null, [
      el("div", fn(x)),
      el("div", { font: "400 11px " + SANS, color: "#71717a", padding: "8px 0 0 0", wordBreak: "break-word" }, `${x.value.slice(0, 60)} · ×${x.count}`),
    ])));
    s.appendChild(grid); root.appendChild(s);
  };
  boxes("Border radius", d.radii, (x) => ({ width: "72px", height: "72px", background: "#f4f4f5", border: "1px solid #d4d4d8", borderRadius: x.value }));
  boxes("Shadows", d.shadows, (x) => ({ width: "96px", height: "72px", background: "#fff", borderRadius: "8px", boxShadow: x.value }));

  // Components
  const comps = d.components || [];
  if (comps.length) {
    const s = section("Components", "Distinct style variants found on the page");
    const byType = new Map();
    comps.forEach((c) => { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); });
    let budget = 70;
    for (const [type, items] of byType) {
      if (budget <= 0) break;
      s.appendChild(el("div", { font: "600 16px " + SANS, margin: "24px 0 8px 0" }, `${type} — ${items.length} variant(s), ${items.reduce((a, b) => a + b.count, 0)} uses`));
      const grid = el("div", { display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" });
      items.slice(0, 8).forEach((c) => {
        if (budget-- <= 0) return;
        const st = c.sample.styles || {};
        const demo = el("div", { display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", maxWidth: "260px", overflow: "hidden", whiteSpace: "nowrap" }, c.sample.text || type);
        ["backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textTransform", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopLeftRadius", "boxShadow"].forEach((k) => { if (st[k]) demo.style[k] = st[k]; });
        if (parseFloat(st.borderTopWidth) > 0 && st.borderTopStyle !== "none") demo.style.border = `${st.borderTopWidth} ${st.borderTopStyle} ${st.borderTopColor}`;
        if (/^h[1-6]$|^heading/.test(type)) demo.style.whiteSpace = "normal";
        const spec = `${c.sample.size.width}×${c.sample.size.height} · pad ${st.paddingTop} ${st.paddingRight} · radius ${st.borderTopLeftRadius} · ${st.fontSize}/${st.fontWeight} · ×${c.count}`;
        grid.appendChild(el("div", { width: "270px", padding: "12px", border: "1px solid #e4e4e7", borderRadius: "10px", background: "#fafafa" }, null, [
          demo,
          el("div", { font: "400 11px " + SANS, color: "#71717a", padding: "8px 0 0 0", wordBreak: "break-word" }, spec),
        ]));
      });
      s.appendChild(grid);
    }
    root.appendChild(s);
  }

  // Icons
  if ((d.icons || []).length) {
    const s = section("Icons", `${d.icons.length} unique inline SVG icons`);
    const grid = el("div", { display: "flex", flexWrap: "wrap", gap: "16px" });
    d.icons.slice(0, 48).forEach((i) => { const svg = cleanSvg(i.html); if (svg) grid.appendChild(el("div", { width: "48px", height: "48px", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #e4e4e7", borderRadius: "8px", color: "#111" }, null, [svg])); });
    s.appendChild(grid); root.appendChild(s);
  }
  return root;
}

// ---------- capture a block with fiGapture's own engine ----------
async function captureBlock(node, title) {
  const stage = $("#stage");
  node.id = "fs-capture";
  stage.replaceChildren(node);
  await Promise.all([...node.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const json = JSON.parse(await window.figma.capturePage("#fs-capture"));
  json.documentTitle = title;
  stage.replaceChildren();
  return json;
}

async function buildPayload(caps, opts) {
  const all = [];
  const msg = (t) => { $("#overlayMsg").textContent = t; };
  for (const site of groupBySite(caps)) {
    for (const c of site.pages) {
      const label = site.host + pathOf(c.url);
      if (opts.page && c.figmaJson) {
        const j = JSON.parse(c.figmaJson);
        (Array.isArray(j) ? j : [j]).forEach((x, n) => { x.documentTitle = `${label} — Figma page${n ? " " + (n + 1) : ""}`; all.push(x); });
      }
      if (opts.shots && c.slices.length) { msg(`Preparing screenshots — ${label}…`); all.push(await captureBlock(renderShots(c), `${label} — Screenshots`)); }
    }
    if (opts.design) {
      // One design-system document per website, built from ALL its saved pages.
      const every = records.filter((r) => hostOf(r.url) === site.host);
      if (every.some((p) => p.design)) { msg(`Preparing design system — ${site.host}…`); all.push(await captureBlock(renderDesign(site.host, every), `${site.host} — Design system`)); }
    }
  }
  if (!all.length) throw new Error("Nothing to copy — pick at least one option.");
  return window.figma.wrapForClipboard(JSON.stringify(all));
}

async function copyIds(ids) {
  const caps = records.filter((r) => ids.includes(r.id));
  if (!caps.length) { status("Select at least one page."); return; }
  const opts = { page: $("#oPage").checked, shots: $("#oShots").checked, design: $("#oDesign").checked };
  $("#overlay").style.display = "flex";
  try {
    // A promise lets the clipboard write start inside the click, while we build the payload.
    await navigator.clipboard.write([new ClipboardItem({ "text/html": buildPayload(caps, opts) })]);
    const sites = new Set(caps.map((c) => hostOf(c.url))).size;
    status(`Copied ${caps.length} page(s) from ${sites} site(s). Now paste into Figma (Cmd+V).`);
  } catch (e) {
    status("Copy failed — " + (e && e.message || e));
  } finally {
    $("#overlay").style.display = "none";
    $("#stage").replaceChildren();
  }
}

// ---------- events ----------
const checked = () => [...document.querySelectorAll("input[data-id]:checked")].map((i) => i.dataset.id);
const idsOfSite = (host) => records.filter((r) => hostOf(r.url) === host).map((r) => r.id);
document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.copy) return copyIds([t.dataset.copy]);
  if (t.dataset && t.dataset.copysite) return copyIds(idsOfSite(t.dataset.copysite));
  if (t.id === "copySel") return copyIds(checked());
  if (t.dataset && t.dataset.site && t.tagName === "INPUT") document.querySelectorAll(`input[data-host="${CSS.escape(t.dataset.site)}"]`).forEach((b) => (b.checked = t.checked));
  if (t.id === "selAll") { const boxes = document.querySelectorAll("input[data-id],input[data-site]"); const all = [...boxes].every((b) => b.checked); boxes.forEach((b) => (b.checked = !all)); }
  if (t.id === "delSel") {
    const ids = checked();
    if (ids.length && confirm(`Delete ${ids.length} saved page(s)? This can't be undone.`)) { await removeIds(ids); await render(); status("Deleted."); }
  }
});
render().catch((e) => status("Could not open the Library — " + (e && e.message || e)));
