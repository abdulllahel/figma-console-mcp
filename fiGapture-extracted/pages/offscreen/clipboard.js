"use strict";
// Decode the first picture of a video. The start of the file is tried first, the whole file only if needed.
async function fgVideoFrame(url) {
  for (const range of [4e6, 0]) {
    let obj = null;
    const v = document.createElement("video");
    try {
      const r = await fetch(url, { headers: range ? { Range: "bytes=0-" + range } : {}, credentials: "omit", signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (!range && +(r.headers.get("content-length") || 0) > 40e6) throw new Error("too large");
      const b = await r.blob();
      obj = URL.createObjectURL(new Blob([b], { type: /^video\//.test(b.type) ? b.type : "video/mp4" }));
      v.muted = true; v.preload = "auto"; v.src = obj;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("decode")); setTimeout(() => rej(new Error("timeout")), 6000); });
      const draw = () => { const k = Math.min(1, 1600 / v.videoWidth), c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k); const g = c.getContext("2d"); g.drawImage(v, 0, 0, c.width, c.height); return [c, g]; };
      let [c, g] = draw();
      // Many videos start on an empty frame: look a little further in when the first one is a single flat colour.
      const flat = () => { const d = g.getImageData(0, 0, c.width, c.height).data, s = 4 * Math.max(1, Math.floor(c.width * c.height / 400)); let lo = 255, hi = 0; for (let i = 0; i < d.length; i += s) { const l = d[i] + d[i + 1] + d[i + 2]; lo = Math.min(lo, l / 3); hi = Math.max(hi, l / 3); } return hi - lo < 6; };
      for (const t of [0.4, 1, 2]) { if (!flat() || !(v.duration > t)) break; v.currentTime = t; await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); }); [c, g] = draw(); }
      return c.toDataURL("image/jpeg", 0.88);
    } catch (e) { if (!range) throw e; } finally { v.removeAttribute("src"); v.load(); if (obj) URL.revokeObjectURL(obj); }
  }
}
chrome.runtime.onMessage.addListener((m, s, reply) => {
  if (m?.target !== "fiGapture-offscreen" || m.action !== "videoFrame") return false;
  fgVideoFrame(m.url).then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: String(e && e.message || e) }));
  return true;
});
(()=>{"use strict";function t(t){const e=(new TextEncoder).encode(t);let a="";for(let t=0;t<e.length;t+=8192)a+=String.fromCharCode.apply(null,e.subarray(t,t+8192));return btoa(a)}const P=new Map;chrome.runtime.onMessage.addListener((e,a,n)=>"fiGapture-offscreen"===e?.target&&"figmaJsonPart"===e.action?(P.has(e.pid)||P.clear(),P.set(e.pid,[...(P.get(e.pid)||[]),e.part]),n({ok:!0}),!1):"fiGapture-offscreen"===e?.target&&(e.pid&&(e.json=(P.get(e.pid)||[]).join(""),P.clear()),!0)&&"writeFigmaClipboard"===e.action&&"string"==typeof e.json&&(async function(t){const e=document.createElement("textarea"),a=e=>{e.clipboardData&&(e.clipboardData.setData("text/html",t),e.clipboardData.setData("text/plain",""),n=!0,e.preventDefault())};let n=!1;e.value=" ",e.setAttribute("aria-hidden","true"),e.style.cssText="position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0",document.body.appendChild(e),document.addEventListener("copy",a);try{if(e.select(),e.setSelectionRange(0,e.value.length),document.execCommand("copy")&&n)return}finally{document.removeEventListener("copy",a),e.remove()}if(!navigator.clipboard?.write||!globalThis.ClipboardItem)throw new Error("Extension clipboard API is unavailable");const o=new Blob([t],{type:"text/html"});await navigator.clipboard.write([new ClipboardItem({"text/html":o})])}(function(e){const a=(new Date).toISOString(),n={dataType:"h2d",source:"chrome-extension",capturedAtIso:a,h2d:{v:1,origin:{source:"chrome-extension",capturedAtIso:a}}};return'<span data-metadata="\x3c!--(figmeta)'+t(JSON.stringify(n))+'(/figmeta)--\x3e"></span><span data-h2d="\x3c!--(figh2d)'+t(e)+'(/figh2d)--\x3e"></span>'}(e.json)).then(()=>n({ok:!0})).catch(t=>n({ok:!1,error:String(t?.message||t)})),!0))})();