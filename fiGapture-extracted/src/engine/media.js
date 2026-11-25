"use strict";
/* fiGapture: gets images and videos ready before a capture. Runs in the page's isolated world; the capture
 * engine calls window.__fiGaptureMedia.step() at every scroll stop and .finish() when it reaches the bottom.
 * Nothing on the page is clicked or played; changes are undone when the capture is saved. */
(() => {
  if (window.__fiGaptureMedia) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cap = (p, ms) => Promise.race([p, sleep(ms)]);
  const undo = [];
  const shown = (e, min) => { const r = e.getBoundingClientRect(); return r.width >= min && r.height >= min ? r : null; };
  const set = (e, prop, val) => { const old = e.style.getPropertyValue(prop), pr = e.style.getPropertyPriority(prop); undo.push(() => (old ? e.style.setProperty(prop, old, pr) : e.style.removeProperty(prop))); e.style.setProperty(prop, val, "important"); };

  // Images on screen now: give them up to `ms` to arrive before scrolling on.
  async function step(ms) {
    const wait = [];
    for (const im of document.images) {
      const r = im.getBoundingClientRect();
      if (r.bottom < -200 || r.top > innerHeight + 400 || r.width < 8) continue;
      if (im.loading === "lazy") im.loading = "eager";
      if (!im.complete) wait.push(new Promise((res) => { im.addEventListener("load", res, { once: true }); im.addEventListener("error", res, { once: true }); }));
    }
    if (wait.length) await cap(Promise.all(wait), ms || 1200);
  }
  const ask = (m, ms) => cap(new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } }), ms);
  function blank(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data, st = 4 * Math.max(1, Math.floor(w * h / 500));
    let a = 0; for (let i = 3; i < d.length; i += st) if (d[i] > 8) a++;
    return a === 0;
  }
  // A still picture of a <video>: from the element itself when the browser allows it, else the poster,
  // else decoded by the extension (cross-site videos cannot be read by the page).
  async function still(v) {
    try {
      if (v.readyState >= 2 && v.videoWidth) {
        const k = Math.min(1, 1600 / v.videoWidth), c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
        const g = c.getContext("2d"); g.drawImage(v, 0, 0, c.width, c.height);
        if (!blank(g, c.width, c.height)) return { data: c.toDataURL("image/jpeg", 0.88), how: "frame" };
      }
    } catch (e) { /* not readable from the page */ }
    const src = v.currentSrc || v.src || (v.querySelector("source[src]") || {}).src || "";
    if (/^https?:/.test(src)) {
      const r = await ask({ action: "videoFrame", url: src }, 20000);
      if (r && r.ok && r.data) return { data: r.data, how: "frame" };
    }
    if (v.poster) {
      const r = await ask({ action: "fetchImage", url: v.poster }, 8000);
      if (r && r.ok && /^image\//.test(r.contentType || "")) return { data: "data:" + r.contentType.split(";")[0] + ";base64," + r.base64, how: "poster" };
    }
    return null;
  }
  async function finish() {
    const t0 = Date.now();
    // 1) every image: no lazy loading, decoded before the screenshots
    const imgs = [...document.images].filter((i) => shown(i, 8));
    imgs.forEach((i) => { if (i.loading === "lazy") i.loading = "eager"; i.decoding = "sync"; });
    await cap(Promise.all(imgs.map((i) => (i.complete ? (i.naturalWidth ? cap(i.decode().catch(() => {}), 3000) : null) : new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); })))), 8000);
    // 2) every video gets its still as background, so a frame that does not paint is never an empty box
    const vids = [...document.querySelectorAll("video")].filter((v) => shown(v, 24)).slice(0, 40);
    let i = 0;
    await cap(Promise.all(Array.from({ length: 4 }, async () => {
      while (i < vids.length && Date.now() - t0 < 30000) {
        const v = vids[i++];
        const s = await still(v).catch(() => null);
        if (!s) continue;
        v.__fgStill = s;
        const cs = getComputedStyle(v);
        set(v, "background-image", `url("${s.data}")`);
        set(v, "background-size", cs.objectFit === "cover" || cs.objectFit === "contain" ? cs.objectFit : "100% 100%");
        set(v, "background-position", cs.objectPosition || "50% 50%");
        set(v, "background-repeat", "no-repeat");
        if (v.readyState < 2 && !v.poster) { v.setAttribute("poster", s.data); undo.push(() => v.removeAttribute("poster")); }
      }
    })), 32000);
    await sleep(120);
  }
  function restore() { while (undo.length) { try { undo.pop()(); } catch (e) {} } }
  document.addEventListener("__fiGapture_archive_done__", restore);
  window.__fiGaptureMedia = { step, finish, restore };
})();
