const fmt = document.getElementById("format");
const sub = document.getElementById("subfolder");
const ok = document.getElementById("ok");

chrome.storage.sync.get(["format", "subfolder"], (s) => {
  fmt.value = s.format || "md";
  sub.value = s.subfolder || "";
});

function save() {
  // "docx" maps to the native Office format per file type in background.js
  chrome.storage.sync.set({ format: fmt.value, subfolder: sub.value }, () => {
    ok.textContent = "Saved";
    setTimeout(() => (ok.textContent = ""), 1200);
  });
}
fmt.addEventListener("change", save);
sub.addEventListener("input", save);
