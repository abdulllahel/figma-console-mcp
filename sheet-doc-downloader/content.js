// Watches for Google Sheets' smart-chip / link preview card (the one showing the
// doc title, owner, "Summarize this file") and injects a download button into it.

const BTN_ATTR = "data-sdd-btn";
const DOC_RE = /https:\/\/(?:docs|drive)\.google\.com\/(?:document|spreadsheets|presentation|file)\/d\/[\w-]+[^\s"'<>]*|https:\/\/drive\.google\.com\/(?:open|uc)\?[^\s"'<>]*id=[\w-]+/;

let lastCellUrl = null; // fallback: last URL seen in the formula bar

function findCard() {
  // Anchor on text that is unique to the preview card.
  const xp = "//*[text()[contains(., 'is the owner') or contains(., 'Summarize this file') or contains(., 'never viewed') or contains(., 'You viewed') or contains(., 'You opened')]]";
  const res = document.evaluate(xp, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  const anchor = res.singleNodeValue;
  if (!anchor) return null;
  // Climb to the floating container (fixed/absolute, reasonably tall).
  let el = anchor;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if ((cs.position === "fixed" || cs.position === "absolute") && r.height > 150 && r.width > 200) return el;
    el = el.parentElement;
  }
  return null;
}

function urlFromCard(card) {
  for (const a of card.querySelectorAll("a[href]")) {
    const m = a.href.match(DOC_RE);
    if (m) return m[0];
  }
  const m = card.innerHTML.match(DOC_RE);
  if (m) return m[0].replace(/&amp;/g, "&");
  return null;
}

function urlFromFormulaBar() {
  const fb = document.querySelector("#t-formula-bar-input, .cell-input");
  const t = fb && fb.textContent;
  const m = t && t.match(DOC_RE);
  return m ? m[0] : null;
}

function titleFromCard(card) {
  // First short text line in the card is the document title.
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const s = n.nodeValue.trim();
    if (s && s.length < 200 && !/is the owner|never viewed|Summarize|Copy/i.test(s)) return s;
  }
  return "";
}

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "sdd-toast" + (bad ? " sdd-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function inject(card) {
  if (card.querySelector(`[${BTN_ATTR}]`)) return;
  const btn = document.createElement("button");
  btn.setAttribute(BTN_ATTR, "1");
  btn.className = "sdd-btn";
  btn.title = "Download as Markdown (.md)";
  btn.textContent = "MD";
  if (getComputedStyle(card).position === "static") card.style.position = "relative";

  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const url = urlFromCard(card) || urlFromFormulaBar() || lastCellUrl;
    if (!url) return toast("Couldn't find the file link", true);
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: "download", url, title: titleFromCard(card) }, (r) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !r || !r.ok) {
        toast("Download failed: " + ((r && r.error) || chrome.runtime.lastError?.message), true);
      } else {
        toast("Downloading: " + r.filename);
      }
    });
  });
  card.appendChild(btn);
}

// ---- Multi-select: "Download N files" button for a selected range ----
const MULTI_ID = "sdd-multi";
const MAX_CELLS = 60;

function currentRange() {
  const nb = document.querySelector("#t-name-box input") || document.querySelector("#t-name-box");
  const v = nb && (nb.value || nb.textContent || "").trim();
  return v && /^[A-Z]+\d+:[A-Z]+\d+$/.test(v) ? v : null;
}

function colNum(s) { return [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }
function cellCount(range) {
  const [a, b] = range.split(":").map((x) => x.match(/([A-Z]+)(\d+)/));
  return (Math.abs(colNum(a[1]) - colNum(b[1])) + 1) * (Math.abs(+a[2] - +b[2]) + 1);
}

async function urlsFromRange(range) {
  const id = (location.pathname.match(/spreadsheets\/d\/([\w-]+)/) || [])[1];
  const gid = (location.hash.match(/gid=(\d+)/) || [])[1] || "0";
  const base = `https://docs.google.com/spreadsheets/d/${id}`;
  // Fast endpoint first, classic export as fallback. Both have hard timeouts so
  // the button can never hang.
  const endpoints = [
    [`${base}/gviz/tq?tqx=out:csv&headers=0&gid=${gid}&range=${range}`, 8000],
    [`${base}/export?format=csv&gid=${gid}&range=${range}`, 15000],
  ];
  const re = new RegExp(DOC_RE.source, "g");
  let lastErr = "no response";
  for (const [url, ms] of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { credentials: "include", signal: ctrl.signal });
      if (!res.ok) { lastErr = "HTTP " + res.status; continue; }
      const text = await res.text();
      const urls = [...new Set((text.match(re) || []).map((u) => u.replace(/&amp;/g, "&")))];
      if (urls.length) return urls;
      lastErr = "no links found in cell text";
    } catch (e) {
      lastErr = e.name === "AbortError" ? "timed out" : String(e.message || e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Couldn't read the selected cells (" + lastErr + ")");
}

function updateMultiButton() {
  const range = currentRange();
  let b = document.getElementById(MULTI_ID);
  if (!range || cellCount(range) < 2 || cellCount(range) > MAX_CELLS) {
    if (b) b.remove();
    return;
  }
  if (!b) {
    b = document.createElement("button");
    b.id = MULTI_ID;
    b.className = "sdd-multi";
    b.addEventListener("click", async () => {
      const r = currentRange();
      if (!r) return;
      b.disabled = true;
      toast("Reading selected cells…");
      try {
        const urls = await urlsFromRange(r);
        if (!urls.length) return toast("No Google file links in the selected cells", true);
        chrome.runtime.sendMessage({ type: "downloadMany", urls }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.success) {
            toast("Download failed: " + ((resp && resp.error) || chrome.runtime.lastError?.message), true);
          } else {
            toast(`Downloading ${resp.ok}/${resp.total} files`, resp.ok < resp.total);
          }
        });
      } catch (e) {
        toast(String(e.message || e), true);
      } finally {
        b.disabled = false;
      }
    });
    document.body.appendChild(b);
  }
  b.textContent = `MD ⬇ selected cells (${range})`;
}
setInterval(updateMultiButton, 500);

let pending = false;
function scan() {
  pending = false;
  const u = urlFromFormulaBar();
  if (u) lastCellUrl = u;
  const card = findCard();
  if (card) inject(card);
}

new MutationObserver(() => {
  if (!pending) {
    pending = true;
    setTimeout(scan, 150);
  }
}).observe(document.body, { childList: true, subtree: true });
