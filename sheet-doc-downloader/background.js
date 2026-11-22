// Builds an export URL for the linked Google file and downloads it
// using the user's existing Google session (no extra dialogs).

const EXPORT_FORMATS = {
  document: ["md", "pdf", "docx", "txt", "html", "odt", "rtf", "epub"],
  spreadsheets: ["pdf", "xlsx", "csv", "ods", "tsv"],
  presentation: ["pdf", "pptx", "txt", "odp"],
};

function parseGoogleUrl(url) {
  let m = url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  if (m) return { kind: m[1], id: m[2] };
  m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (m) return { kind: "file", id: m[1] };
  m = url.match(/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]+)/);
  if (m) return { kind: "file", id: m[1] };
  return null;
}

function sanitize(name) {
  return (name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120);
}

async function handleDownload({ url, title }) {
  const parsed = parseGoogleUrl(url);
  if (!parsed) throw new Error("Not a Google Docs/Sheets/Slides/Drive link: " + url);

  const { format = "md", subfolder = "" } = await chrome.storage.sync.get(["format", "subfolder"]);
  let exportUrl, ext;

  if (parsed.kind === "file") {
    exportUrl = `https://drive.google.com/uc?export=download&id=${parsed.id}`;
    ext = "";
  } else {
    const allowed = EXPORT_FORMATS[parsed.kind];
    ext = allowed.includes(format) ? format : allowed[0] === "md" ? "md" : "pdf";
    exportUrl = `https://docs.google.com/${parsed.kind}/d/${parsed.id}/export?format=${ext}`;
  }

  const opts = { url: exportUrl, conflictAction: "uniquify", saveAs: false };
  // With a known title we name the file ourselves; otherwise Google's own
  // filename (the doc title) is used.
  if (title) {
    const folder = sanitize(subfolder);
    opts.filename = (folder ? folder + "/" : "") + sanitize(title) + (ext ? "." + ext : "");
  }
  const id = await chrome.downloads.download(opts);
  return { id, filename: opts.filename || parsed.id };
}

async function handleMany(urls) {
  const results = await Promise.allSettled(urls.map((url) => handleDownload({ url, title: "" })));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  return { ok, total: urls.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "downloadMany") {
    handleMany(msg.urls)
      .then((r) => sendResponse({ success: true, ...r }))
      .catch((e) => sendResponse({ success: false, error: String(e.message || e) }));
    return true;
  }
  if (msg && msg.type === "download") {
    handleDownload(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
});
