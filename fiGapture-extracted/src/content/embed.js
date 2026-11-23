// fiGapture — capture pages that live inside "app shell" iframes.
//
// Some pages show their real content inside one big iframe while the outer page
// itself does not scroll. Shared Claude artifacts are the main example, and they
// can be nested more than one level deep:
//   claude.ai/public/artifacts/<id>  → www.claudeusercontent.com iframe (the page)
//   claude.ai/artifact/<id>          → <id>.frame.claudeusercontent.com shell
//                                       → about:srcdoc iframe (the page)
// The capture engine only walks the DOM of the frame it runs in, and the
// screenshots measure the outer page, so Full Page used to capture an empty box
// and a single screen.
//
// This script runs in every frame (injected with the capture engine).
//  - prepare() (called in the top frame, and by each shell frame for the frame
//    inside it) finds such an iframe, hides the shell around it, and makes the
//    iframe as tall as its content, so the whole page is laid out at once.
//    Full Page then captures inside the deepest frame, and the screenshots cover
//    the whole page.
//  - "embed-cmd" messages: "measure" (lays out any nested shell first, then
//    reports the content height), "pin" (keeps 100vh-style sections at their
//    on-screen size after the frame becomes taller), "restore".
// Everything is restored after the capture is saved.
// Messages use the same signed channel as the rest of fiGapture
// (__fiGaptureSecurePost__ / __fiGaptureVerifyEvent__ from configureFiGaptureFrame).
(() => {
  if (window.__fiGaptureEmbedInstalled) return;
  window.__fiGaptureEmbedInstalled = true;

  const MAX_DEPTH = 4;
  const OWN_ID = /^__fi[gG]/; // __figma_capture_ext…, __figcap_…, __fiGapture_…
  // (fiGapture's own UI: toolbar host, toasts, overlays)
  const settle = (ms = 120) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms))));
  const docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const seen = new Set();
  const fresh = (d) => {
    if (typeof d.__fiGaptureNonce !== "string" || seen.has(d.__fiGaptureNonce)) return false;
    seen.add(d.__fiGaptureNonce);
    setTimeout(() => seen.delete(d.__fiGaptureNonce), 60000);
    return true;
  };
  const verified = async (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || typeof d.__fiGapture !== "string" || !d.__fiGapture.startsWith("embed-")) return null;
    if (!window.__fiGaptureVerifyEvent__ || !(await window.__fiGaptureVerifyEvent__(ev))) return null;
    return fresh(d) ? d : null;
  };
  const post = (win, msg) => window.__fiGaptureSecurePost__ && window.__fiGaptureSecurePost__(win, msg);
  const toWorker = (msg, timeoutMs = 10000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; clearTimeout(t); resolve(r || null); });
    } catch (e) { clearTimeout(t); resolve(null); }
  });

  // ---------------------------------------------------------------------------
  // Frame side: answer the frame above us
  // ---------------------------------------------------------------------------
  const frameState = { heights: null, exempt: null, saved: [], sub: null };
  const saveStyle = (el) => frameState.saved.push([el, el.getAttribute("style")]);
  const setImp = (el, prop, val) => el.style.setProperty(prop, val, "important");

  function findScroller() {
    // The page scrolls inside an element instead of the document (e.g. a full-height
    // container with overflow:auto). Pick the largest such element.
    const vw = innerWidth, vh = innerHeight;
    let best = null, bestArea = 0;
    for (const el of document.body ? document.body.querySelectorAll("*") : []) {
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return bestArea >= vw * vh * 0.4 ? best : null;
  }

  async function frameCmd(d) {
    const de = document.documentElement;
    const cmd = d.cmd;
    if (cmd === "measure") {
      // Called after the frame above set this frame's final width.
      frameState.saved = [];
      frameState.exempt = new Set();
      frameState.heights = null;
      frameState.sub = null;
      scrollTo(0, 0);
      let height = docH();
      const depth = (d.depth | 0) + 1;
      if (height <= innerHeight + 4 && depth < MAX_DEPTH) {
        // This frame may itself be a shell around another iframe (new-style
        // claude.ai/artifact links). Lay that one out first; this frame then
        // simply grows with it, so nothing here needs pinning.
        let sub = null;
        try { sub = await prepare(depth); } catch (e) { sub = null; }
        if (sub && !sub.blocked) {
          frameState.sub = sub;
          await settle();
          return { height: Math.ceil(docH()), viewport: innerHeight, width: innerWidth, path: sub.path };
        }
        if (sub && sub.blocked) return { error: "nested frame unreachable" };
      }
      // Record every element's height at the normal viewport height, so we can
      // keep viewport-sized sections the same after the frame is made taller.
      frameState.heights = new Map();
      for (const el of document.querySelectorAll("body *")) frameState.heights.set(el, el.getBoundingClientRect().height);
      if (height <= innerHeight + 4) {
        const sc = findScroller();
        if (sc) {
          // Let the inner scroller grow to its content; it and its ancestors are
          // meant to change height, so they are not pinned later.
          for (let n = sc; n && n !== de; n = n.parentElement) {
            frameState.exempt.add(n);
            saveStyle(n);
            setImp(n, "height", "auto");
            setImp(n, "max-height", "none");
            setImp(n, "overflow", "visible");
          }
          await settle();
          height = Math.max(docH(), sc.getBoundingClientRect().bottom + scrollY);
        }
      }
      de.setAttribute("data-figapture-embed-frame", "1");
      return { height: Math.ceil(height), viewport: innerHeight, width: innerWidth, path: [] };
    }
    if (cmd === "pin") {
      // The frame above made this frame taller. Anything whose height changed
      // because of that (100vh, min-h-screen, %-of-viewport) goes back to its
      // on-screen size, so the capture matches what a visitor sees.
      let pinned = 0;
      if (frameState.heights) {
        for (const [el, h] of frameState.heights) {
          if (!el.isConnected || frameState.exempt.has(el)) continue;
          const now = el.getBoundingClientRect().height;
          if (Math.abs(now - h) <= 1) continue;
          saveStyle(el);
          setImp(el, "height", h + "px");
          setImp(el, "min-height", h + "px");
          setImp(el, "max-height", h + "px");
          pinned++;
        }
      }
      await settle();
      return { pinned, height: docH() };
    }
    if (cmd === "restore") {
      if (frameState.sub) { try { frameState.sub.restore(); } catch (e) {} }
      for (let i = frameState.saved.length - 1; i >= 0; i--) {
        const [el, s] = frameState.saved[i];
        s == null ? el.removeAttribute("style") : el.setAttribute("style", s);
      }
      frameState.saved = [];
      frameState.heights = null;
      frameState.exempt = null;
      frameState.sub = null;
      de.removeAttribute("data-figapture-embed-frame");
      return { ok: true };
    }
    return { error: "unknown command" };
  }

  // One listener for both directions: each signed message may be accepted only
  // once (replay protection), so two listeners would reject each other's messages.
  const pending = new Map(); // replies we are waiting for
  window.addEventListener("message", async (ev) => {
    const d = await verified(ev);
    if (!d) return;
    if (d.__fiGapture === "embed-cmd") {
      let res;
      try { res = await frameCmd(d); } catch (e) { res = { error: String((e && e.message) || e) }; }
      post(ev.source, { __fiGapture: "embed-reply", reqId: d.reqId, ...res });
    } else if (d.__fiGapture === "embed-reply" && pending.has(d.reqId)) {
      const p = pending.get(d.reqId);
      if (ev.source !== p.win) return;
      pending.delete(d.reqId);
      p.resolve(d);
    }
  });

  // ---------------------------------------------------------------------------
  // Host side: find the embedded page and lay it out at full length
  // ---------------------------------------------------------------------------
  function ask(win, cmd, timeoutMs = 4000, extra = {}) {
    return new Promise((resolve) => {
      const reqId = "emb_" + Math.random().toString(36).slice(2);
      const t = setTimeout(() => { pending.delete(reqId); resolve(null); }, timeoutMs);
      pending.set(reqId, { win, resolve: (d) => { clearTimeout(t); resolve(d); } });
      Promise.resolve(post(win, { ...extra, __fiGapture: "embed-cmd", cmd, reqId })).catch(() => {});
    });
  }

  function findEmbed() {
    // Only "app shell" pages: the page itself does not scroll.
    if (docH() > innerHeight + 4) return null;
    const vw = innerWidth, vh = innerHeight;
    let best = null, bestArea = 0;
    for (const f of document.querySelectorAll("iframe")) {
      if (!f.contentWindow) continue;
      if ((f.name || "").startsWith("screen-ruler") || f.closest("[id^='__fig'], [id^='__fiG']")) continue; // fiGapture's own preview frames
      const cs = getComputedStyle(f);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
      const r = f.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (area > bestArea) { best = f; bestArea = area; }
    }
    return best && bestArea >= vw * vh * 0.5 ? best : null;
  }

  const frameIndex = (w) => { for (let i = 0; i < window.length; i++) if (window[i] === w) return i; return -1; };

  async function prepare(depth = 0) {
    const ifr = findEmbed();
    if (!ifr) return null;
    const win = ifr.contentWindow;
    if (depth === 0) {
      // Frames can appear or reload after the toolbar was opened (the artifact is
      // loaded into a fresh iframe). Make sure every frame has fiGapture in it.
      await toWorker({ action: "embedInject" });
    }
    const saved = [];
    const keep = (el) => saved.push([el, el.getAttribute("style")]);
    const restoreTop = () => {
      for (let i = saved.length - 1; i >= 0; i--) {
        const [el, s] = saved[i];
        s == null ? el.removeAttribute("style") : el.setAttribute("style", s);
      }
      saved.length = 0;
      document.documentElement.removeAttribute("data-figapture-embed");
    };
    try {
      // 1. Hide the shell (header bars, side panels) and let the iframe become a normal block.
      const path = [];
      for (let n = ifr.parentElement; n; n = n.parentElement) path.push(n);
      for (const anc of path) {
        for (const c of anc.children) {
          if (c === ifr || path.includes(c) || OWN_ID.test(c.id || "")) continue;
          if (c.tagName === "SCRIPT" || c.tagName === "STYLE" || c.tagName === "LINK" || c.tagName === "HEAD") continue;
          keep(c);
          c.style.setProperty("display", "none", "important");
        }
        keep(anc);
        for (const [p, v] of [["position", "static"], ["display", "block"], ["height", "auto"], ["min-height", "0"], ["max-height", "none"],
          ["overflow", "visible"], ["transform", "none"], ["padding", "0"], ["margin", "0"], ["width", "auto"], ["max-width", "none"]]) anc.style.setProperty(p, v, "important");
      }
      const width = document.documentElement.clientWidth;
      keep(ifr);
      for (const [p, v] of [["position", "static"], ["display", "block"], ["width", width + "px"], ["max-width", "none"], ["min-width", "0"],
        ["height", innerHeight + "px"], ["min-height", "0"], ["max-height", "none"], ["margin", "0"], ["border", "0"], ["transform", "none"]]) ifr.style.setProperty(p, v, "important");
      scrollTo(0, 0);
      await settle(200);

      // 2. Measure inside the frame at that width (it lays out any shell nested inside it first).
      let m = await ask(win, "measure", 20000, { depth });
      if (!m && depth === 0) {
        await toWorker({ action: "embedInject" });
        m = await ask(win, "measure", 20000, { depth });
      }
      if (!m || m.error || !(m.height > 0)) {
        restoreTop();
        const msg = "fiGapture can’t reach the page inside this frame. Open chrome://extensions → fiGapture → Details → Site access → “On all sites”, reload the page, then try again.";
        console.warn("[fiGapture] embedded page did not answer", m);
        // The page clearly lives in the frame; capturing the empty shell would be useless.
        return { blocked: true, msg };
      }
      document.documentElement.setAttribute("data-figapture-embed", "1");

      // 3. Make the iframe as tall as its content, then keep viewport-sized sections at their on-screen size.
      let h = m.height;
      if (h > m.viewport + 4) {
        ifr.style.setProperty("height", h + "px", "important");
        await settle(150);
        const p = await ask(win, "pin");
        if (p && p.height > 0 && Math.abs(p.height - h) > 2 && p.height < h * 3) {
          h = p.height;
          ifr.style.setProperty("height", h + "px", "important");
        }
        await settle(depth === 0 ? 400 : 150); // late images and fonts
      }
      // The window that holds the page: this iframe, or a frame nested inside it.
      const sub = Array.isArray(m.path) ? m.path : [];
      let target = win;
      for (const i of sub) target = target[i];
      if (depth === 0) console.info(`[fiGapture] embedded page laid out at ${width}×${h}px (${sub.length + 1} frame level${sub.length ? "s" : ""} deep)`);

      let restored = false, timer = null;
      const restore = () => {
        if (restored) return;
        restored = true;
        clearTimeout(timer);
        document.removeEventListener("__fiGapture_archive_done__", restore);
        ask(win, "restore", 3000);
        restoreTop();
      };
      return {
        win: target,
        path: [frameIndex(win), ...sub],
        width,
        height: h,
        restore,
        // The screenshots and design scrape finish after the Figma data is copied;
        // the service worker signals the end. Safety net: 3 minutes.
        restoreWhenArchived() {
          document.addEventListener("__fiGapture_archive_done__", restore);
          timer = setTimeout(restore, 180000);
        },
      };
    } catch (e) {
      ask(win, "restore", 3000);
      restoreTop();
      throw e;
    }
  }

  if (window === window.top) window.__fiGaptureEmbed = { prepare: () => prepare(0), find: findEmbed };
})();
