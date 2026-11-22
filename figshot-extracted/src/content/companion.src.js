/* fiGapture "Companion" UI — injected into toolbar.js at the `data-fs-ready` hook by scripts/inject-companion.py.
 * Runs inside the toolbar closure, so it can read: b (shadow root), q (old bar), p (prefs), h (save prefs),
 * si (rebuild old bar), Ei (close), Ce/Ee/Me (state + labels), qe/$e/Pe (picker / font / responsive flags).
 * The old pill bar stays alive but hidden: this UI just clicks its buttons, so every feature is unchanged.
 */
(function () {
  try {
    var NS = 'http://www.w3.org/2000/svg';
    var css = `
.fgc{position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2a0a;-webkit-font-smoothing:antialiased}
.fgc *{box-sizing:border-box}
.fgc[data-hide="1"]{display:none}
.fgc-bubble,.fgc-card{pointer-events:auto;transform-origin:100% 0;transition:transform .5s cubic-bezier(.2,1.2,.3,1),opacity .28s ease}
.fgc-bubble{position:absolute;top:0;right:0;width:64px;height:64px;border-radius:50%;border:0;padding:0;cursor:pointer;background:linear-gradient(180deg,#fdfef8,#eef2d8);box-shadow:0 10px 30px rgba(32,48,8,.28),0 0 0 1px rgba(79,112,20,.14);display:grid;place-items:center;animation:fgc-bob 3.6s ease-in-out infinite}
.fgc-bubble:hover{transform:scale(1.08) rotate(-4deg)}.fgc-bubble:active{transform:scale(.94)}
.fgc[data-open="1"] .fgc-bubble{transform:scale(.3);opacity:0;pointer-events:none;animation:none}
.fgc[data-open="0"] .fgc-card{transform:scale(.2);opacity:0;pointer-events:none}
.fgc-card{position:absolute;top:0;right:0;width:300px;border-radius:28px;background:linear-gradient(180deg,#fdfef8 0%,#f1f4de 100%);box-shadow:0 24px 60px rgba(28,42,6,.32),0 0 0 1px rgba(79,112,20,.14);overflow:hidden}
.fgc-head{display:flex;gap:12px;align-items:center;padding:16px 16px 10px;}
.fgc-mascot{width:56px;height:56px;flex:none;border-radius:50%;background:linear-gradient(180deg,#fff,#eaf0cf);display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(79,112,20,.12)}
.fgc-mascot svg,.fgc-bubble svg{width:42px;height:42px;overflow:visible}
.fgc-ttl{flex:1;min-width:0}
.fgc-name{font-weight:700;font-size:15px;letter-spacing:-.01em}
.fgc-say{font-size:12.5px;line-height:1.35;color:#5b6b3a;margin-top:2px;min-height:34px}
.fgc-x{display:flex;gap:2px;align-self:flex-start}
.fgc-ib{width:28px;height:28px;border-radius:10px;border:0;background:transparent;color:#5b6b3a;cursor:pointer;display:grid;place-items:center}
.fgc-ib:hover{background:rgba(79,112,20,.12);color:#1d2a0a}
.fgc-ib svg{width:16px;height:16px}
.fgc-main{margin:4px 16px 0;width:calc(100% - 32px);height:52px;border:0;border-radius:18px;cursor:pointer;display:flex;align-items:center;gap:10px;padding:0 16px;font:inherit;font-weight:700;font-size:14.5px;color:#10190a;background:linear-gradient(135deg,#c9da8e,#9dba4c);box-shadow:0 10px 22px rgba(120,150,40,.38),inset 0 1px 0 rgba(255,255,255,.55);transition:transform .2s cubic-bezier(.3,1.5,.5,1),box-shadow .2s;position:relative;overflow:hidden}
.fgc-main:hover{transform:translateY(-2px);box-shadow:0 14px 26px rgba(120,150,40,.45),inset 0 1px 0 rgba(255,255,255,.55)}
.fgc-main:active{transform:scale(.97)}
.fgc-main svg{width:20px;height:20px}
.fgc-main .sp{flex:1;text-align:left}
.fgc-kbd{font-size:11px;font-weight:700;min-width:22px;height:22px;padding:0 6px;border-radius:7px;display:inline-grid;place-items:center;background:rgba(16,25,10,.12);color:inherit}
.fgc-sec{margin:14px 18px 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7d8a5c}
.fgc-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 16px 4px}
.fgc-tile{position:relative;height:64px;border-radius:18px;border:1px solid rgba(79,112,20,.16);background:#fff;cursor:pointer;font:inherit;color:#1d2a0a;text-align:left;padding:10px 12px;display:flex;flex-direction:column;justify-content:space-between;transition:transform .22s cubic-bezier(.3,1.5,.5,1),background .2s,box-shadow .2s,border-color .2s}
.fgc-tile:hover{transform:translateY(-2px);box-shadow:0 8px 18px rgba(60,90,15,.16);border-color:rgba(79,112,20,.35)}
.fgc-tile:active{transform:scale(.95)}
.fgc-tile svg{width:20px;height:20px;color:#4f7014}
.fgc-tile b{font-size:12.5px;font-weight:600}
.fgc-tile .fgc-kbd{position:absolute;top:9px;right:9px;background:rgba(79,112,20,.1);color:#4f7014}
.fgc-tile[data-on="1"]{background:linear-gradient(135deg,#4f7014,#6f9322);color:#f6f9e8;border-color:transparent;box-shadow:0 10px 22px rgba(79,112,20,.4)}
.fgc-tile[data-on="1"] svg{color:#dfeca9}.fgc-tile[data-on="1"] .fgc-kbd{background:rgba(255,255,255,.18);color:#f6f9e8}
.fgc-foot{display:flex;gap:8px;padding:12px 16px 16px}
.fgc-pill{flex:1;height:38px;border-radius:14px;border:0;background:rgba(79,112,20,.09);color:#2f4310;font:inherit;font-weight:600;font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;transition:background .2s,transform .2s}
.fgc-pill:hover{background:rgba(79,112,20,.17)}.fgc-pill:active{transform:scale(.96)}.fgc-pill svg{width:16px;height:16px}
.fgc-set{display:none;padding:0 16px 8px}
.fgc[data-set="1"] .fgc-set{display:block}
.fgc-row{display:flex;align-items:center;justify-content:space-between;padding:7px 4px;font-size:12.5px;font-weight:500;border-bottom:1px solid rgba(79,112,20,.1)}
.fgc-sw{width:34px;height:20px;border-radius:12px;background:#cfd6b4;position:relative;cursor:pointer;border:0;transition:background .2s}
.fgc-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .22s cubic-bezier(.3,1.5,.5,1)}
.fgc-sw[data-on="1"]{background:#6f9322}.fgc-sw[data-on="1"]::after{transform:translateX(14px)}
.fgc-bar{height:4px;margin:10px 16px 0;border-radius:3px;background:rgba(79,112,20,.14);overflow:hidden;display:none}
.fgc[data-busy="1"] .fgc-bar{display:block}
.fgc-bar i{display:block;height:100%;width:40%;border-radius:3px;background:linear-gradient(90deg,#9dba4c,#c9da8e);animation:fgc-slide 1.1s ease-in-out infinite}
.fgc-cancel{display:none}.fgc[data-busy="1"] .fgc-cancel{display:flex}
@keyframes fgc-slide{0%{margin-left:-40%}100%{margin-left:100%}}
@keyframes fgc-bob{0%,100%{translate:0 0}50%{translate:0 -3px}}
@keyframes fgc-wig{0%,100%{rotate:0deg}25%{rotate:-6deg}75%{rotate:6deg}}
.fgc[data-mood="capturing"] .fgc-mascot svg,.fgc[data-mood="capturing"] .fgc-bubble svg{animation:fgc-wig .5s ease-in-out infinite}
.fgc-eye{transition:transform .12s ease-out;transform-box:fill-box;transform-origin:center}
.fgc[data-mood="capturing"] .fgc-eye{transform:scaleY(.25)!important}
.fgc[data-mood="success"] .fgc-eye{transform:scaleY(.55) translateY(-4px)!important}
.fgc[data-mood="error"] .fgc-eye{transform:rotate(14deg)!important}
.fgc-toast{position:absolute;right:0;top:calc(100% + 10px)}
@media (prefers-reduced-motion:reduce){.fgc *{animation:none!important;transition:none!important}}
`;
    var st = document.createElement('style'); st.textContent = css; b.appendChild(st);

    function svg(vb, inner, cls) {
      var s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', vb); s.setAttribute('fill', 'none');
      s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
      if (cls) s.setAttribute('class', cls); s.innerHTML = inner; return s;
    }
    var ICON = {
      pick: '<path d="M4 3l5 14 2.2-5.8L17 9z"/>',
      font: '<path d="M4 16L9.5 4 15 16M6.4 12h6.2M16 8h3M17.5 8v8"/>',
      assets: '<rect x="3" y="4" width="14" height="12" rx="2.5"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="M3.5 14l4-3.6 3 2.6 2.5-2.2 3.5 3.2"/>',
      measure: '<path d="M3 13.5L13.5 3l3.5 3.5L6.5 17z"/><path d="M7.5 9.5l1.6 1.6M10 7l1.6 1.6M5 12l1.6 1.6"/>',
      shot: '<path d="M3 7.5h3l1.2-2h5.6l1.2 2h3V16H3z"/><circle cx="10" cy="11.6" r="2.7"/>',
      resp: '<rect x="6" y="2.5" width="8" height="15" rx="2"/><path d="M9 14.8h2"/>',
      full: '<path d="M10 3v9M6 8.6l4 4 4-4M3.5 16.5h13"/>',
      lib: '<rect x="3.5" y="3" width="4" height="14" rx="1"/><rect x="9" y="3" width="4" height="14" rx="1"/><path d="M15 5.2l2.3 11.6"/>',
      gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M5 5l1.4 1.4M13.6 13.6L15 15M15 5l-1.4 1.4M6.4 13.6L5 15"/>',
      x: '<path d="M5 5l10 10M15 5L5 15"/>',
      min: '<path d="M5 12l5-5 5 5"/>',
      stop: '<rect x="5" y="5" width="10" height="10" rx="2"/>'
    };
    function ic(name) { return svg('0 0 20 20', ICON[name]); }

    // ---- mascot (same avatar as the logo; eyes + mouth are animated by mood)
    function mascot() {
      var s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '36 36 184 184');
      s.innerHTML = '<defs><linearGradient id="fgm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9DA8E"/><stop offset=".52" stop-color="#9DBA4C"/><stop offset="1" stop-color="#4F7014"/></linearGradient></defs>' +
        '<path d="M128 38.8C176.6 38.8 216.3 75 216.3 114.8C216.3 154.5 198.6 203 167.7 214.5C152.3 219.8 140.4 213.6 130.2 206.6C119.2 212.7 97.1 214.5 86.1 205.7C77.2 196.9 72.8 186.3 71.5 175.7C53 172.1 39.7 158 39.7 136.8C39.7 83.9 79.4 38.8 128 38.8Z" fill="url(#fgm)"/>' +
        '<g class="fgc-eyes"><rect class="fgc-eye" x="130.2" y="79" width="16.8" height="34.4" rx="8.4" transform="rotate(7 139.9 96.2)" fill="#fff" fill-opacity=".94"/>' +
        '<rect class="fgc-eye" x="159.3" y="74.6" width="16.8" height="31.8" rx="8.4" transform="rotate(-12 169 90.5)" fill="#fff" fill-opacity=".94"/></g>' +
        '<path class="fgc-mouth" d="M99.8 122.3L109 113.4C116.5 130.2 133.3 140.4 152.3 135.9" stroke="#fff" stroke-opacity=".78" stroke-width="11.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
      return s;
    }
    var MOUTH = { idle: 'M99.8 122.3L109 113.4C116.5 130.2 133.3 140.4 152.3 135.9', success: 'M96 118C108 150 140 152 158 124', error: 'M100 140C115 124 140 124 154 140', capturing: 'M112 128C122 138 138 138 148 128', pick: 'M122 128a10 10 0 1 0 20 0a10 10 0 1 0 -20 0' };

    // ---- DOM
    var root = document.createElement('div'); root.className = 'fgc'; root.setAttribute('data-open', '1'); root.setAttribute('data-mood', 'idle');
    var bubble = document.createElement('button'); bubble.className = 'fgc-bubble'; bubble.type = 'button'; bubble.title = 'Open fiGapture'; bubble.appendChild(mascot());
    var card = document.createElement('div'); card.className = 'fgc-card';
    var head = document.createElement('div'); head.className = 'fgc-head';
    var mas = document.createElement('div'); mas.className = 'fgc-mascot'; mas.appendChild(mascot());
    var ttl = document.createElement('div'); ttl.className = 'fgc-ttl';
    var nm = document.createElement('div'); nm.className = 'fgc-name'; nm.textContent = 'fiGapture';
    var say = document.createElement('div'); say.className = 'fgc-say'; say.textContent = 'What shall we grab today?';
    ttl.append(nm, say);
    var xs = document.createElement('div'); xs.className = 'fgc-x';
    function ib(name, title, fn) { var e = document.createElement('button'); e.type = 'button'; e.className = 'fgc-ib'; e.title = title; e.appendChild(ic(name)); e.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); }); return e; }
    xs.append(ib('min', 'Minimise', function () { root.setAttribute('data-open', '0'); }), ib('x', 'Close (Esc)', function () { Ei(); }));
    head.append(mas, ttl, xs);

    function oldBtn(key) { return key ? b.querySelector('.bar [data-key="' + key + '"]') : null; }
    function respBtn() { var l = b.querySelectorAll('.bar .pill-tools > .btn'); for (var i = 0; i < l.length; i++) { if (!l[i].dataset.key) return l[i]; } return null; }
    function fire(key) { var e = key === 'r' ? respBtn() : oldBtn(key); if (e) e.click(); }

    var main = document.createElement('button'); main.type = 'button'; main.className = 'fgc-main';
    var mi = ic('full'), msp = document.createElement('span'); msp.className = 'sp'; msp.textContent = 'Capture full page';
    var mk = document.createElement('span'); mk.className = 'fgc-kbd'; mk.textContent = 'F';
    main.append(mi, msp, mk); main.addEventListener('click', function () { fire('f'); });
    var bar = document.createElement('div'); bar.className = 'fgc-bar'; bar.appendChild(document.createElement('i'));

    var sec = document.createElement('div'); sec.className = 'fgc-sec'; sec.textContent = 'Tools';
    var grid = document.createElement('div'); grid.className = 'fgc-grid';
    var TILES = [
      { id: 'select', key: 'c', label: 'Pick element', icon: 'pick', always: true },
      { id: 'font', key: 't', label: 'Fonts', icon: 'font' },
      { id: 'assets', key: 'a', label: 'Assets', icon: 'assets' },
      { id: 'measure', key: 'm', label: 'Measure', icon: 'measure' },
      { id: 'screenshot', key: 's', label: 'Screenshot', icon: 'shot' },
      { id: 'responsive', key: 'r', label: 'Responsive', icon: 'resp' }
    ];
    var tileEls = {};
    function enabled(t) { return t.always || (typeof p !== "undefined" && p && p.enabledTools ? p.enabledTools[t.id] !== false : true); }
    function drawTiles() {
      grid.textContent = '';
      TILES.forEach(function (t) {
        if (!enabled(t)) return;
        var e = document.createElement('button'); e.type = 'button'; e.className = 'fgc-tile'; e.appendChild(ic(t.icon));
        var l = document.createElement('b'); l.textContent = t.label; e.appendChild(l);
        if (t.key !== 'r') { var k = document.createElement('span'); k.className = 'fgc-kbd'; k.textContent = t.key.toUpperCase(); e.appendChild(k); }
        e.addEventListener('click', function () { fire(t.key); });
        tileEls[t.id] = e; grid.appendChild(e);
      });
    }
    drawTiles();

    var setBox = document.createElement('div'); setBox.className = 'fgc-set';
    TILES.filter(function (t) { return !t.always; }).forEach(function (t) {
      var r = document.createElement('div'); r.className = 'fgc-row'; var s = document.createElement('span'); s.textContent = t.label;
      var sw = document.createElement('button'); sw.type = 'button'; sw.className = 'fgc-sw'; sw.setAttribute('data-on', enabled(t) ? '1' : '0');
      sw.addEventListener('click', function () {
        if (typeof p !== "undefined" && p) { p.enabledTools = p.enabledTools || {}; var on = !(p.enabledTools[t.id] !== false); p.enabledTools[t.id] = on; sw.setAttribute('data-on', on ? '1' : '0'); if (typeof h === "function") { try { h(); } catch (e) {} } try { si(); } catch (e) {} drawTiles(); }
      });
      r.append(s, sw); setBox.appendChild(r);
    });

    var foot = document.createElement('div'); foot.className = 'fgc-foot';
    function pill(icon, label, fn, cls) { var e = document.createElement('button'); e.type = 'button'; e.className = 'fgc-pill' + (cls ? ' ' + cls : ''); e.appendChild(ic(icon)); e.appendChild(document.createTextNode(label)); e.addEventListener('click', fn); return e; }
    var libBtn = pill('lib', 'Library', function () { try { chrome.runtime.sendMessage({ action: 'openLibrary' }); } catch (e) {} });
    var setBtn = pill('gear', 'Customise', function () { root.setAttribute('data-set', root.getAttribute('data-set') === '1' ? '0' : '1'); });
    var canBtn = pill('stop', 'Cancel', function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }, 'fgc-cancel');
    foot.append(libBtn, setBtn, canBtn);

    card.append(head, main, bar, sec, grid, setBox, foot);
    root.append(bubble, card);
    bubble.addEventListener('click', function () { root.setAttribute('data-open', '1'); });
    b.appendChild(root);
    // keep the old bar after my root so the `~` selector can reveal it during responsive preview
    b.appendChild(q);

    // ---- mascot life: eyes follow the cursor
    var lastMove = 0;
    document.addEventListener('mousemove', function (e) {
      var n = Date.now(); if (n - lastMove < 40) return; lastMove = n;
      var r = (root.getAttribute('data-open') === '1' ? mas : bubble).getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.max(1, Math.hypot(dx, dy)), k = Math.min(1, d / 260) * 5;
      var tx = (dx / d) * k, ty = (dy / d) * k * .8;
      root.querySelectorAll('.fgc-eyes').forEach(function (g) { g.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px)'; });
    }, { passive: true });

    // ---- sync with the real tool state
    var SAY = { idle: 'What shall we grab today?', pick: 'Click anything on the page to copy it.', font: 'Hover any text to inspect its font.', assets: 'Hover an image or video to grab it.', measure: 'Hover elements to measure spacing.', screenshot: 'Taking the screenshot…', resp: 'Previewing responsive sizes.', capturing: 'Capturing the page… hold on.' };
    var lastKey = '';
    setInterval(function () {
      try {
        var mood = 'idle', text = SAY.idle, busy = false, active = {};
        ['c', 'f', 't', 'a', 'm', 's'].forEach(function () {});
        var map = { select: 'c', font: 't', assets: 'a', measure: 'm', screenshot: 's' };
        Object.keys(map).forEach(function (id) { var e = oldBtn(map[id]); if (e && e.classList.contains('active')) active[id] = 1; });
        if (qe) active.select = 1; if ($e) active.font = 1; if (document.body && document.body.classList.contains('measure-mode')) active.measure = 1;
        var rs = !!Pe; if (rs) active.responsive = 1;
        if (Ce === 'loading') { mood = 'capturing'; text = SAY.capturing; busy = true; }
        else if (Ce === 'success') { mood = 'success'; text = (typeof Ee === 'string' && Ee) || 'Done!'; }
        else if (Ce === 'error') { mood = 'error'; text = (typeof Me === 'string' && Me) || 'Something went wrong.'; }
        else if (active.select) { mood = 'pick'; text = SAY.pick; }
        else if (active.font) text = SAY.font; else if (active.assets) text = SAY.assets; else if (active.measure) text = SAY.measure; else if (rs) text = SAY.resp;
        var key = mood + '|' + text + '|' + Object.keys(active).join(',') + '|' + rs;
        if (key === lastKey) return; lastKey = key;
        say.textContent = text; root.setAttribute('data-mood', mood); root.setAttribute('data-busy', busy ? '1' : '0');
        root.setAttribute('data-old', rs ? '1' : '0'); root.setAttribute('data-hide', rs ? '1' : '0');
        Object.keys(tileEls).forEach(function (id) { tileEls[id].setAttribute('data-on', active[id] ? '1' : '0'); });
        var mp = MOUTH[mood] || MOUTH.idle; root.querySelectorAll('.fgc-mouth').forEach(function (m) { m.setAttribute('d', mp); });
        if (mood === 'success' || mood === 'error') root.setAttribute('data-open', '1');
      } catch (e) {}
    }, 120);

    // everything built: now hide the old pill bar (it stays alive, in layout, so its logic keeps working)
    var hideOld = document.createElement('style');
    hideOld.textContent = '.bar{visibility:hidden!important;pointer-events:none!important}.fgc[data-old="1"]~.bar{visibility:visible!important;pointer-events:auto!important}';
    b.appendChild(hideOld);
  } catch (err) { try { console.warn('[fiGapture] companion UI failed, falling back to classic bar', err); } catch (e) {} }
})();
