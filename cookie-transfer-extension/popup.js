"use strict";

const ALL = { origins: ["<all_urls>"] };
const $ = (id) => document.getElementById(id);

// Tags like the ones in the Claude import dialog. Purely informational.
const TAGS = [
  [/(^|\.)(google|zoho|proton|fastmail)\.(com|me)$/, "Email"],
  [/(^|\.)(microsoft|microsoftonline|live|apple|okta|auth0)\.com$/, "Sign-in provider"],
  [/(^|\.)(stripe|wise|paypal|ramp|brex|plaid)\.com$/, "Bank or payments"],
];
const tagFor = (domain) => (TAGS.find(([re]) => re.test(domain)) || [])[1];

let sites = []; // [{ domain, cookies, checked }]

function status(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("err", isError);
}

const bare = (d) => d.replace(/^\./, "");

async function dropAccess() {
  try { await chrome.permissions.remove(ALL); } catch { /* ignore */ }
}

// ---------- scan ----------
async function scan() {
  // Must be the first await in the click handler so the user gesture is still valid.
  const granted = await chrome.permissions.request(ALL);
  if (!granted) return status("Access was not granted, so no sites can be listed.", true);

  status("Scanning…");
  const stores = await chrome.cookies.getAllCookieStores();
  const byDomain = new Map();
  for (const store of stores) {
    const cookies = await chrome.cookies.getAll({ storeId: store.id });
    for (const c of cookies) {
      const d = bare(c.domain);
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(c);
    }
  }
  sites = [...byDomain]
    .map(([domain, cookies]) => ({ domain, cookies, checked: true }))
    .sort((a, b) => a.domain.localeCompare(b.domain));

  $("step-scan").hidden = true;
  $("step-pick").hidden = false;
  render();
  status(`Found cookies for ${sites.length} sites.`);
}

// ---------- list ----------
function visible() {
  const q = $("filter").value.trim().toLowerCase();
  return sites.filter((s) => !q || s.domain.includes(q));
}

function render() {
  const list = $("sites");
  list.textContent = "";
  for (const site of visible()) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = site.checked;
    box.addEventListener("change", () => { site.checked = box.checked; updateCount(); });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = site.domain;
    name.title = `${site.cookies.length} cookies`;
    label.append(box, name);
    li.append(label);
    const tag = tagFor(site.domain);
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      li.append(t);
    }
    list.append(li);
  }
  updateCount();
}

function updateCount() {
  const n = sites.filter((s) => s.checked).length;
  $("count").textContent = `${n} of ${sites.length} selected`;
  $("select-all").checked = n === sites.length;
  $("select-all").indeterminate = n > 0 && n < sites.length;
  $("export").disabled = $("send").disabled = n === 0;
}

function selectedCookies() {
  return sites.filter((s) => s.checked).flatMap((s) => s.cookies);
}

const payload = () => ({
  format: "cookie-transfer/1",
  exportedAt: new Date().toISOString(),
  cookies: selectedCookies(),
});

// ---------- export / send ----------
function exportFile() {
  const blob = new Blob([JSON.stringify(payload(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cookies-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  status("Saved. This file contains live session credentials: delete it after importing.");
}

function loopbackOnly(raw) {
  const u = new URL(raw);
  const ok = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!ok || u.protocol !== "http:") throw new Error("Receiver must be http://127.0.0.1, localhost or [::1].");
  return u.toString();
}

async function send() {
  try {
    const url = loopbackOnly($("url").value);
    const token = $("token").value.trim();
    if (!token) return status("Enter the token shown by the receiver.", true);
    status("Sending…");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload()),
    });
    if (!res.ok) throw new Error(`Receiver answered ${res.status}.`);
    status(`Sent ${selectedCookies().length} cookies.`);
  } catch (e) {
    status(e.message || String(e), true);
  }
}

// ---------- import ----------
function setDetails(c) {
  const host = bare(c.domain);
  const details = {
    url: `http${c.secure ? "s" : ""}://${host}${c.path || "/"}`,
    name: c.name,
    value: c.value,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || "unspecified",
  };
  if (!c.hostOnly) details.domain = c.domain; // host-only cookies must omit domain
  if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
  if (c.partitionKey) details.partitionKey = c.partitionKey;
  return details;
}

async function importFile() {
  const file = $("import-file").files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const cookies = Array.isArray(data) ? data : data.cookies;
    if (!Array.isArray(cookies)) throw new Error("Not a Cookie Transfer file.");

    // Needs a user gesture: this runs from the Import button's click.
    if (!(await chrome.permissions.request(ALL))) throw new Error("Access was not granted.");

    let ok = 0, failed = 0;
    for (const c of cookies) {
      try {
        if (await chrome.cookies.set(setDetails(c))) ok++; else failed++;
      } catch { failed++; }
    }
    status(`Imported ${ok} cookies${failed ? `, ${failed} skipped` : ""}.`, failed > 0 && ok === 0);
  } catch (e) {
    status(e.message || String(e), true);
  }
}

// ---------- wiring ----------
$("scan").addEventListener("click", scan);
$("filter").addEventListener("input", render);
$("select-all").addEventListener("change", (e) => {
  for (const s of visible()) s.checked = e.target.checked;
  render();
});
$("export").addEventListener("click", exportFile);
$("send").addEventListener("click", send);
$("import-file").addEventListener("change", (e) => { $("import").disabled = !e.target.files.length; });
$("import").addEventListener("click", importFile);

// Drop the broad access whenever the popup closes (best effort) and on next open.
window.addEventListener("pagehide", dropAccess);
dropAccess();
