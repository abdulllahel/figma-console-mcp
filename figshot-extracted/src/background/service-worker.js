const _figshot_author="Abdullah Al Mamun",_figshot_auth_id="FigShot​‌‍‎‏",TOOLBAR_SCRIPT="src/content/toolbar.js",CAPTURE_SCRIPT="src/engine/capture.js",EMBED_SCRIPT="src/content/embed.js",OFFSCREEN_DOCUMENT_PATH="pages/offscreen/index.html",TOOLBAR_HOST_ID="__figma_capture_ext_toolbar__",MOBILE_UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",RULE_BASE_HEADERS=1e5,RULE_BASE_UA=2e5,headerRuleId=e=>1e5+e,uaRuleId=e=>2e5+e,frameChannelSecrets=new Map;function createChannelSecret(){const e=crypto.getRandomValues(new Uint8Array(32));let t="";for(const r of e)t+=String.fromCharCode(r);return btoa(t)}function configureFigshotFrame(e,t,r,o){window.__figshotBase__=e,window.__figshotPos__=t||null,window.__figshotAnimate__=r,window.__figshotChannelSecret__=o;const i=new TextEncoder,a=Uint8Array.from(atob(o),e=>e.charCodeAt(0)),n=crypto.subtle.importKey("raw",a,{name:"HMAC",hash:"SHA-256"},!1,["sign","verify"]),s=e=>JSON.stringify(Object.keys(e).filter(e=>"__figshotSig"!==e).sort().map(t=>[t,e[t]])),c=e=>{let t="";for(const r of new Uint8Array(e))t+=String.fromCharCode(r);return btoa(t)};window.__figshotSecurePost__=async(e,t)=>{if(!e||!t||"object"!=typeof t)return;const r={...t,__figshotTs:Date.now(),__figshotNonce:crypto.randomUUID?.()||Date.now()+"_"+Math.random().toString(36).slice(2)},o=await crypto.subtle.sign("HMAC",await n,i.encode(s(r)));e.postMessage({...r,__figshotSig:c(o)},"*")},window.__figshotVerifyEvent__=async e=>{const t=e?.data,r=t?.__figshotSig;if(!t||"object"!=typeof t||"string"!=typeof r||"number"!=typeof t.__figshotTs||Math.abs(Date.now()-t.__figshotTs)>6e4)return!1;try{return await crypto.subtle.verify("HMAC",await n,(o=r,Uint8Array.from(atob(o),e=>e.charCodeAt(0))),i.encode(s(t)))}catch{return!1}var o}}async function isToolbarMounted(e){try{const[t]=await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",func:e=>{const t=document.getElementById(e);if(!t)return!1;if("1"===t.getAttribute("data-fs-ready"))return!0;try{t.remove()}catch(e){}return!1},args:[TOOLBAR_HOST_ID]});return!!t?.result}catch(err){return!1}}async function injectIntoTab(e,t=!0){let r=null;try{({toolbarPosition:r=null}=await chrome.storage.local.get("toolbarPosition"))}catch(e){}const o=createChannelSecret();frameChannelSecrets.set(e,o);try{await chrome.scripting.executeScript({target:{tabId:e,allFrames:!0},world:"ISOLATED",func:configureFigshotFrame,args:[chrome.runtime.getURL(""),r,t,o]})}catch{await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",func:configureFigshotFrame,args:[chrome.runtime.getURL(""),r,t,o]})}try{await chrome.scripting.executeScript({target:{tabId:e,allFrames:!0},world:"ISOLATED",files:[CAPTURE_SCRIPT,EMBED_SCRIPT]}),await chrome.scripting.executeScript({target:{tabId:e,allFrames:!0},world:"ISOLATED",func:installCaptureRunner})}catch(t){const[{result:r}={}]=await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",func:()=>!!window.figma&&"function"==typeof window.figma.capturePage&&!!window.__figshotCaptureRunner}).catch(()=>[]);if(!r)try{await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",files:[CAPTURE_SCRIPT,EMBED_SCRIPT]}),await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",func:installCaptureRunner})}catch(e){throw new Error("Capture engine could not start: "+String(e?.message||t))}console.warn("fiGapture loaded in the main frame, but one or more child frames were unavailable:",t)}try{await chrome.scripting.executeScript({target:{tabId:e,allFrames:!0},world:"ISOLATED",files:[TOOLBAR_SCRIPT]})}catch{try{await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",files:[TOOLBAR_SCRIPT]})}catch(err){}}}function installCaptureRunner(){if(window.__figshotCaptureRunner)return;window.__figshotCaptureRunner=!0;let e=null;const t=new Set;window.addEventListener("message",async r=>{const o=r.data;if(!o||!await(window.__figshotVerifyEvent__?.(r)))return;if("string"!=typeof o.__figshotNonce||t.has(o.__figshotNonce))return;if(t.add(o.__figshotNonce),setTimeout(()=>t.delete(o.__figshotNonce),6e4),"capture-progress"===o.__figshot)return void(e&&e!==window&&window.__figshotSecurePost__?.(e,{__figshot:o.__figshot,pct:o.pct}));if("capture-cancel"===o.__figshot)return void(window.figma&&"function"==typeof window.figma.cancelCapture&&window.figma.cancelCapture());if("capture-request"!==o.__figshot)return;e=r.source;const i=(t,r,i)=>{e&&window.__figshotSecurePost__?.(e,{__figshot:"capture-result",reqId:o.reqId,ok:t,error:r||null,json:i}),e=null};try{if(!window.figma||"function"!=typeof window.figma.capturePage)return void i(!1,"engine-not-ready");const e=function(){const e=[document.documentElement,document.body].filter(Boolean),t=e.map(e=>({el:e,value:e.style.getPropertyValue("scroll-behavior"),priority:e.style.getPropertyPriority("scroll-behavior")}));return e.forEach(e=>e.style.setProperty("scroll-behavior","auto","important")),()=>t.forEach(({el:e,value:t,priority:r})=>{t?e.style.setProperty("scroll-behavior",t,r):e.style.removeProperty("scroll-behavior")})}();try{if(o.directClipboard&&"function"==typeof window.figma.capturePageToClipboard)await window.figma.capturePageToClipboard(o.selector||"body"),i(!0,null,null);else{i(!0,null,await window.figma.capturePage(o.selector||"body"))}}finally{e()}}catch(e){i(!1,String(e&&e.message||e))}})}let offscreenDocumentCreating=null;async function hasOffscreenDocument(){const e=chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);if(chrome.runtime.getContexts){return(await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[e]})).length>0}return(await clients.matchAll()).some(t=>t.url===e)}async function ensureOffscreenDocument(){await hasOffscreenDocument()||(offscreenDocumentCreating||(offscreenDocumentCreating=chrome.offscreen.createDocument({url:OFFSCREEN_DOCUMENT_PATH,reasons:["CLIPBOARD"],justification:"Copy editable fiGapture captures to the Figma clipboard"}).finally(()=>{offscreenDocumentCreating=null})),await offscreenDocumentCreating)}async function writeFigmaClipboard(e){await ensureOffscreenDocument();const t=await chrome.runtime.sendMessage({target:"figshot-offscreen",action:"writeFigmaClipboard",json:e});if(!t?.ok)throw new Error(t?.error||"Clipboard write failed")}async function hideToolbarInTab(e){try{await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",func:()=>{document.dispatchEvent(new CustomEvent("__figshot_toggle__",{detail:{action:"hide"}}))}})}catch(err){}}function notifyBadge(e){try{const t=e?{tabId:e}:{};chrome.action.setBadgeBackgroundColor({color:"#E5484D",...t}).catch(()=>{}),chrome.action.setBadgeText({text:"✕",...t}).catch(()=>{}),setTimeout(()=>{try{chrome.action.setBadgeText({text:"",...t}).catch(()=>{})}catch(e){}},2500)}catch(e){}}async function showToast(e,t){try{await chrome.scripting.executeScript({target:{tabId:e},world:"ISOLATED",func:e=>{if(document.getElementById("__figshot_toast__"))return;const t=document.createElement("div");if(t.id="__figshot_toast__",t.textContent=e,t.style.cssText=["position:fixed","bottom:32px","left:50%","transform:translateX(-50%) translateY(12px)","background:rgba(24,24,27,0.92)","color:#fafafa","font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif","padding:12px 24px","border-radius:12px","z-index:2147483647","pointer-events:none","opacity:0","transition:opacity 0.3s ease,transform 0.3s ease","box-shadow:0 8px 32px rgba(0,0,0,0.28)","backdrop-filter:blur(12px)","border:1px solid rgba(255,255,255,0.08)","text-align:center","max-width:360px"].join(";"),"popover"in t&&t.setAttribute("popover","manual"),(document.documentElement&&"html"===document.documentElement.tagName.toLowerCase()?document.documentElement:document.body||document.documentElement).appendChild(t),"popover"in t)try{t.showPopover()}catch(e){}requestAnimationFrame(()=>{t.style.opacity="1",t.style.transform="translateX(-50%) translateY(0)"}),setTimeout(()=>{t.style.opacity="0",t.style.transform="translateX(-50%) translateY(12px)",setTimeout(()=>t.remove(),320)},3e3)},args:[t]})}catch(t){notifyBadge(e)}}const activeOrigins=new Set;try{chrome.storage.local.get(["activeOrigins"]).then(e=>{if(Array.isArray(e.activeOrigins))for(const t of e.activeOrigins)activeOrigins.add(t)})}catch(e){}function originOf(e){try{return new URL(e).origin}catch(e){return null}}function persistActiveOrigins(){chrome.storage.local.set({activeOrigins:[...activeOrigins]}).catch(()=>{})}function setOriginActive(e,t){const r=originOf(e);r&&(t?activeOrigins.add(r):activeOrigins.delete(r),persistActiveOrigins())}function isOriginActive(e){const t=originOf(e);return!!t&&activeOrigins.has(t)}function updateActionForTab(e,t){const r=isRestrictedUrl(t);try{chrome.action.setTitle({tabId:e,title:r?"fiGapture — this page can't be captured":"fiGapture"}).catch(()=>{})}catch(e){}}chrome.tabs.onActivated.addListener(async({tabId:e})=>{let t=null;try{const r=await chrome.tabs.get(e);t=r.url,updateActionForTab(e,r.url),r.url&&isOriginActive(r.url)&&!isRestrictedUrl(r.url)&&!isDirectResourceUrl(r.url)&&(await isToolbarMounted(e)||await injectIntoTab(e,!1))}catch(r){if(t&&isOriginActive(t))notifyBadge(e)}}),chrome.tabs.onUpdated.addListener(async(e,t,r)=>{try{if((t.url||"loading"===t.status)&&updateActionForTab(e,r.url),"loading"===t.status&&chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[headerRuleId(e),uaRuleId(e)]}).catch(()=>{}),"complete"===t.status&&r.url&&isOriginActive(r.url)&&!isRestrictedUrl(r.url)&&!isDirectResourceUrl(r.url))try{await isToolbarMounted(e)||await injectIntoTab(e,!1)}catch(t){notifyBadge(e)}}catch(err){}}),chrome.tabs.onRemoved.addListener(async()=>{if(0!==activeOrigins.size)try{const e=await chrome.tabs.query({}),t=new Set;for(const r of e){const e=originOf(r.url);e&&t.add(e)}let r=!1;for(const e of[...activeOrigins])t.has(e)||(activeOrigins.delete(e),r=!0);r&&persistActiveOrigins()}catch(e){}});const detectedStreams=new Map,HLS_URL_RE=/\.m3u8(\?.*)?$/i,DASH_URL_RE=/\.mpd(\?.*)?$/i,DIRECT_VIDEO_URL_RE=/\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i,MAX_STREAMS_PER_TAB=40;function recordDetectedVideo(e,t,r){if(e<0)return;let o=detectedStreams.get(e);o||detectedStreams.set(e,o=new Map),o.size<40&&!o.has(t)&&o.set(t,r)}try{chrome.webRequest.onBeforeRequest.addListener(e=>{e.tabId<0||(HLS_URL_RE.test(e.url)?recordDetectedVideo(e.tabId,e.url,"hls"):DASH_URL_RE.test(e.url)?recordDetectedVideo(e.tabId,e.url,"dash"):"media"===e.type&&DIRECT_VIDEO_URL_RE.test(e.url)&&recordDetectedVideo(e.tabId,e.url,"direct"))},{urls:["<all_urls>"],types:["xmlhttprequest","media","other"]})}catch(e){}try{chrome.webRequest.onHeadersReceived.addListener(e=>{if(e.tabId<0)return;const t=((e.responseHeaders||[]).find(e=>"content-type"===e.name.toLowerCase())?.value||"").toLowerCase();t&&(t.includes("mpegurl")?recordDetectedVideo(e.tabId,e.url,"hls"):t.includes("dash+xml")?recordDetectedVideo(e.tabId,e.url,"dash"):"media"===e.type&&/^video\//.test(t)&&recordDetectedVideo(e.tabId,e.url,"direct"))},{urls:["<all_urls>"],types:["xmlhttprequest","media","other"]},["responseHeaders"])}catch(e){}chrome.tabs.onUpdated.addListener((e,t)=>{t.url&&detectedStreams.delete(e)}),chrome.tabs.onRemoved.addListener(e=>{detectedStreams.delete(e)});const streamJobs=new Map,streamFetchControllers=new Map;function registerStreamFetch(e){if(!e)return null;const t=new AbortController;let r=streamFetchControllers.get(e);return r||streamFetchControllers.set(e,r=new Set),r.add(t),t}function releaseStreamFetch(e,t){if(!e||!t)return;const r=streamFetchControllers.get(e);r&&(r.delete(t),r.size||streamFetchControllers.delete(e))}function cancelStreamFetches(e){const t=streamFetchControllers.get(e);if(t){streamFetchControllers.delete(e);for(const e of t)e.abort()}}const DIRECT_RESOURCE_RE=/\.(svg|png|jpe?g|gif|webp|ico|bmp|avif|pdf|xml|json|txt|csv|woff2?|ttf|otf|eot)(\?.*)?$/i;function isRestrictedUrl(e){if(!e)return!0;if(/^file:\/\//.test(e))return!1;if(!/^https?:\/\//.test(e))return!0;try{const t=new URL(e).hostname;return/(^|\.)chrome\.google\.com$/.test(t)||/(^|\.)chromewebstore\.google\.com$/.test(t)}catch(e){return!0}}function isDirectResourceUrl(e){if(!e)return!1;try{return DIRECT_RESOURCE_RE.test(new URL(e).pathname)}catch{return!1}}async function toggleToolbar(e){try{const e={permissions:["downloads","webRequest"],origins:["<all_urls>","file:///*"]};await chrome.permissions.contains(e)||await chrome.permissions.request(e)}catch(e){console.warn("Could not request permissions natively:",e)}if(e?.id)if(isRestrictedUrl(e.url))showToast(e.id,"fiGapture can’t run on this page");else{if(isDirectResourceUrl(e.url)){const t=chrome.runtime.getURL("pages/viewer/index.html")+"?url="+encodeURIComponent(e.url);return void chrome.tabs.create({url:t})}try{await isToolbarMounted(e.id)?(setOriginActive(e.url,!1),await hideToolbarInTab(e.id)):(setOriginActive(e.url,!0),await injectIntoTab(e.id))}catch(t){const r=String(t?.message||t||"Unknown startup error");setOriginActive(e.url,!1),showToast(e.id,"fiGapture couldn’t start — "+r.slice(0,180))}}}function isTrustedSender(e){return e?.id===chrome.runtime.id&&!!e?.tab?.id}async function enablePreviewRules(e,{ua:t}){const r=[{id:headerRuleId(e),priority:1,action:{type:"modifyHeaders",responseHeaders:[{header:"x-frame-options",operation:"remove"},{header:"frame-options",operation:"remove"},{header:"content-security-policy",operation:"remove"},{header:"cross-origin-opener-policy",operation:"remove"},{header:"cross-origin-embedder-policy",operation:"remove"},{header:"cross-origin-resource-policy",operation:"remove"}]},condition:{tabIds:[e],resourceTypes:["sub_frame"]}}];t&&r.push({id:uaRuleId(e),priority:1,action:{type:"modifyHeaders",requestHeaders:[{header:"User-Agent",operation:"set",value:t}]},condition:{tabIds:[e],resourceTypes:["sub_frame"]}}),await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[headerRuleId(e),uaRuleId(e)],addRules:r})}async function disablePreviewRules(e){await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[headerRuleId(e),uaRuleId(e)]})}chrome.action.onClicked.addListener(e=>{const t=e?.id?screenshotJobs.get(e.id):null;if(t)return t.cancelled=!0,chrome.action.setBadgeText({text:"×",tabId:e.id}).catch(()=>{}),void chrome.action.setTitle({tabId:e.id,title:"fiGapture — cancelling screenshot"}).catch(()=>{});toggleToolbar(e)}),chrome.commands.onCommand.addListener(async e=>{if("capture-full-page"===e)try{const[t]=await chrome.tabs.query({active:!0,currentWindow:!0});if(!t||!t.id||isRestrictedUrl(t.url))return;await isToolbarMounted(t.id)||(setOriginActive(t.url,!0),await injectIntoTab(t.id),await new Promise(e=>setTimeout(e,700))),await chrome.scripting.executeScript({target:{tabId:t.id},world:"ISOLATED",func:()=>document.dispatchEvent(new CustomEvent("__figshot_fullpage__"))})}catch(e){console.warn("[fiGapture] shortcut failed",e)}return void 0;if("open-library"===e)return void chrome.tabs.create({url:chrome.runtime.getURL("pages/library/index.html")});if("toggle-extension"===e)try{const[e]=await chrome.tabs.query({active:!0,currentWindow:!0});e&&e.id&&toggleToolbar(e)}catch(e){}});const screenshotStore=new Map,SCREENSHOT_DB="figshot-screenshots",SCREENSHOT_STORE="captures",SCREENSHOT_TTL_MS=18e5,SHOT_MAX_CANVAS_SIDE=32e3,SHOT_MAX_CANVAS_AREA=64e6,SHOT_CAPTURE_INTERVAL=350,SHOT_OVERLAP=200,SHOT_VIEWPORT_WAIT_MS=1500;function shotSetup(e){const t=window,r=document,o=r.documentElement,i=r.body,a=r.createElement("style");a.id="__figshot_shot_style__",a.textContent="::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}html{scrollbar-width:none!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}",(r.head||o).appendChild(a);const n=r.getElementById(e),s=n?n.style.display:null;n&&n.style.setProperty("display","none","important");const c=o.style.getPropertyValue("scroll-behavior"),l=o.style.getPropertyPriority("scroll-behavior");o.style.setProperty("scroll-behavior","auto","important");const u=t.innerWidth,d=t.innerHeight,h=[],g=[],f=[],m=[],p=r.querySelectorAll("body *");for(let e=0;e<p.length;e++){const r=p[e];if(r===n)continue;const o=t.getComputedStyle(r).position;if("sticky"===o)g.push({el:r,value:r.style.getPropertyValue("position"),priority:r.style.getPropertyPriority("position")}),r.style.setProperty("position","relative","important");else if("fixed"===o){const e=r.getBoundingClientRect();if(e.width>=.9*u&&e.height>=.9*d)continue;r.__figshotKeepFirstRow=e.top<100,h.push(r)}}for(const e of r.images||[])"lazy"===e.loading&&(f.push({img:e,value:e.getAttribute("loading")}),e.loading="eager");for(const e of r.querySelectorAll("video"))m.push({video:e,wasPaused:e.paused}),e.pause();let w=null;if(o.scrollHeight<=d+10&&(!i||i.scrollHeight<=d+10)){let e=0;for(let r=0;r<p.length;r++){const o=p[r];if(o===n||o.scrollHeight<=o.clientHeight+100)continue;const i=t.getComputedStyle(o);if("auto"!==i.overflowY&&"scroll"!==i.overflowY)continue;const a=o.getBoundingClientRect(),s=Math.max(0,Math.min(a.right,u)-Math.max(a.left,0))*Math.max(0,Math.min(a.bottom,d)-Math.max(a.top,0));s>e&&s>=.5*u*d&&(w=o,e=s)}}let y=null;if(w){w.setAttribute("data-figshot-scroll-root","1");const e=w.getBoundingClientRect(),t=Math.max(0,e.left),r=Math.max(0,e.top);y={x:t,y:r,width:Math.max(1,Math.min(u,e.right)-t),height:Math.max(1,Math.min(d,e.bottom)-r)}}t.__figshotShot={origX:w?w.scrollLeft:t.scrollX,origY:w?w.scrollTop:t.scrollY,host:n,hostDisplay:s,prevBehavior:c,prevBehaviorPrio:l,fixed:h,sticky:g,lazyImages:f,videos:m,clip:y};const b=t.getComputedStyle(o),S="hidden"===b.overflowY&&"hidden"===b.overflowX,_=e=>"number"==typeof e?e:0;return{totalWidth:w?u:Math.max(_(o.clientWidth),_(o.offsetWidth),S?0:_(o.scrollWidth),i?_(i.offsetWidth):0,i&&!S?_(i.scrollWidth):0,u),totalHeight:w?y.y+w.scrollHeight:Math.max(_(o.clientHeight),_(o.offsetHeight),S?0:_(o.scrollHeight),i?_(i.offsetHeight):0,i&&!S?_(i.scrollHeight):0,d),viewportWidth:u,viewportHeight:d,dpr:t.devicePixelRatio||1,clip:y}}async function shotScrollAndWait(e,t,r,o,i){const a=window,n=document,s=n.documentElement,c=n.body,l=a.__figshotShot,u=n.querySelector("[data-figshot-scroll-root]"),d=l&&l.clip||null,h=d?d.y:0;if(l&&l.fixed)for(const e of l.fixed)r&&e.__figshotKeepFirstRow?void 0!==e.__figshotPrevVis&&(e.style.visibility=e.__figshotPrevVis,delete e.__figshotPrevVis):void 0===e.__figshotPrevVis&&(e.__figshotPrevVis=e.style.visibility,e.style.setProperty("visibility","hidden","important"));const g=e=>new Promise(t=>setTimeout(t,e)),f=()=>new Promise(e=>requestAnimationFrame(()=>e())),m=()=>u?{totalWidth:a.innerWidth,totalHeight:h+u.scrollHeight}:{totalWidth:Math.max(s.scrollWidth,c?c.scrollWidth:0,s.clientWidth,a.innerWidth),totalHeight:Math.max(s.scrollHeight,c?c.scrollHeight:0,s.clientHeight,a.innerHeight)},p=()=>Array.from(n.images||[]).filter(e=>{const t=e.getBoundingClientRect();return t.bottom>=0&&t.right>=0&&t.top<=a.innerHeight&&t.left<=a.innerWidth});u?(u.scrollLeft=e,u.scrollTop=Math.max(0,t-h)):a.scrollTo(e,t),await f(),await f();const w=()=>u?u.scrollLeft:a.scrollX,y=()=>u?u.scrollTop:a.scrollY,b=Date.now()+o;let S=-1,_=-1,v=-1;for(;Date.now()<b;){const e=m(),t=w(),r=y(),o=p().some(e=>!e.complete);if(e.totalHeight===S&&t===_&&r===v&&!o)break;S=e.totalHeight,_=t,v=r,await g(60)}const T=p().filter(e=>e.complete&&e.naturalWidth>0&&"function"==typeof e.decode);let R,E;if(T.length&&await Promise.race([Promise.allSettled(T.map(e=>e.decode())),g(150)]),await f(),await f(),u){const e=u.scrollTop;E=r&&0===e?0:h+e,R=r&&0===e?0:d?d.x:0}else R=a.scrollX,E=a.scrollY;return{x:R,y:E,...m()}}function shotTeardown(){const e=window,t=document,r=t.documentElement,o=e.__figshotShot,i=t.getElementById("__figshot_shot_style__"),a=t.querySelector("[data-figshot-scroll-root]");if(i&&i.remove(),a&&a.removeAttribute("data-figshot-scroll-root"),o){if(o.fixed)for(const e of o.fixed)void 0!==e.__figshotPrevVis&&(e.style.visibility=e.__figshotPrevVis,delete e.__figshotPrevVis),delete e.__figshotKeepFirstRow;if(o.sticky)for(const{el:e,value:t,priority:r}of o.sticky)t?e.style.setProperty("position",t,r):e.style.removeProperty("position");if(o.lazyImages)for(const{img:e,value:t}of o.lazyImages)null===t?e.removeAttribute("loading"):e.setAttribute("loading",t);if(o.videos)for(const{video:e,wasPaused:t}of o.videos)t||e.play().catch(()=>{});o.host&&(o.hostDisplay?o.host.style.display=o.hostDisplay:o.host.style.removeProperty("display")),o.prevBehavior?r.style.setProperty("scroll-behavior",o.prevBehavior,o.prevBehaviorPrio):r.style.removeProperty("scroll-behavior"),a?(a.scrollLeft=o.origX,a.scrollTop=o.origY):e.scrollTo(o.origX,o.origY),delete e.__figshotShot}}async function captureTile(e){for(let t=0;t<6;t++)try{return await chrome.tabs.captureVisibleTab(e,{format:"png"})}catch(e){const t=String(e&&e.message||e);if(/MAX_CAPTURE|quota|rate/i.test(t)){await new Promise(e=>setTimeout(e,600));continue}throw e}throw new Error("captureVisibleTab rate-limited")}async function stitchChunks(e,t,r,o,i){const a=Math.max(1,Math.round(t*i)),n=Math.min(32e3,Math.floor(64e6/a)),s=Math.max(1,Math.floor(n/i)),c=[];for(let t=0;t<r;t+=s){const n=Math.min(t+s,r),l=new OffscreenCanvas(a,Math.round((n-t)*i)),u=l.getContext("2d");for(const r of e){const e=r.cropBottom||0,a=(r.clip?r.clip.height:o)-e;if(a<=0||r.y+a<=t||r.y>=n)continue;const s=r.storageId?await loadScreenshotTile(r.storageId):await(await fetch(r.dataUrl)).blob();if(!s)throw new Error("A screenshot source tile expired");const c=await createImageBitmap(s);r.clip?u.drawImage(c,Math.round(r.clip.x*i),Math.round(r.clip.y*i),Math.round(r.clip.width*i),Math.round(a*i),Math.round(r.x*i),Math.round((r.y-t)*i),Math.round(r.clip.width*i),Math.round(a*i)):e>0?u.drawImage(c,0,0,c.width,Math.min(c.height,Math.round(a*i)),Math.round(r.x*i),Math.round((r.y-t)*i),c.width,Math.min(c.height,Math.round(a*i))):u.drawImage(c,Math.round(r.x*i),Math.round((r.y-t)*i)),c.close&&c.close()}c.push(await blobToDataUrl(await l.convertToBlob({type:"image/png"})))}return c}async function blobToDataUrl(e){const t=new Uint8Array(await e.arrayBuffer());let r="";for(let e=0;e<t.length;e+=8192)r+=String.fromCharCode.apply(null,t.subarray(e,e+8192));return"data:image/png;base64,"+btoa(r)}const screenshotJobs=new Map;function openScreenshotDb(){return new Promise((e,t)=>{const r=indexedDB.open(SCREENSHOT_DB,1);r.onupgradeneeded=()=>{const e=r.result;e.objectStoreNames.contains("captures")||e.createObjectStore("captures",{keyPath:"id"})},r.onsuccess=()=>e(r.result),r.onerror=()=>t(r.error||new Error("Screenshot database failed"))})}async function saveScreenshot(e){screenshotStore.set(e.id,e);try{const t=await openScreenshotDb();await new Promise((r,o)=>{const i=t.transaction("captures","readwrite"),a=i.objectStore("captures"),n=a.openCursor();n.onsuccess=()=>{const e=n.result;e&&(e.value?.expiresAt<=Date.now()&&e.delete(),e.continue())},a.put(e),i.oncomplete=r,i.onerror=()=>o(i.error||new Error("Could not save screenshot"))}),t.close()}catch{}}async function saveScreenshotTile(e,t,r){const o=await(await fetch(t)).blob(),i=await openScreenshotDb();try{await new Promise((t,a)=>{const n=i.transaction("captures","readwrite");n.objectStore("captures").put({id:e,kind:"source-tile",blob:o,expiresAt:r}),n.oncomplete=t,n.onerror=()=>a(n.error||new Error("Could not store screenshot tile"))})}finally{i.close()}}async function loadScreenshotTile(e){const t=await openScreenshotDb();try{return await new Promise((r,o)=>{const i=t.transaction("captures","readonly").objectStore("captures").get(e);i.onsuccess=()=>r(i.result?.blob||null),i.onerror=()=>o(i.error||new Error("Could not load screenshot tile"))})}finally{t.close()}}async function deleteScreenshotTiles(e){if(!e.length)return;const t=await openScreenshotDb();try{await new Promise(r=>{const o=t.transaction("captures","readwrite"),i=o.objectStore("captures");for(const t of e)i.delete(t);o.oncomplete=r,o.onerror=r})}finally{t.close()}}async function loadScreenshot(e){let t=screenshotStore.get(e)||null;if(!t){const r=await openScreenshotDb();t=await new Promise((t,o)=>{const i=r.transaction("captures","readonly").objectStore("captures").get(e);i.onsuccess=()=>t(i.result||null),i.onerror=()=>o(i.error||new Error("Could not load screenshot"))}),r.close()}return t&&t.expiresAt>Date.now()?t:(t&&deleteScreenshot(e).catch(()=>{}),null)}async function deleteScreenshot(e){screenshotStore.delete(e);const t=await openScreenshotDb();await new Promise(r=>{const o=t.transaction("captures","readwrite");o.objectStore("captures").delete(e),o.oncomplete=r,o.onerror=r}),t.close()}async function assertCaptureTabActive(e,t){const[r]=await chrome.tabs.query({active:!0,windowId:t});if(!r||r.id!==e)throw new Error("TAB_NOT_ACTIVE")}function reportScreenshotStage(e,t){chrome.tabs.sendMessage(e,{action:"screenshotProgress",label:t}).catch(()=>{});const r=t.startsWith("Preparing")?"…":t.startsWith("Building")?"BLD":t.startsWith("Saving")?"SAV":null;r&&chrome.action.setBadgeText({text:r,tabId:e}).catch(()=>{}),chrome.action.setTitle({tabId:e,title:`fiGapture — ${t} (click to cancel)`}).catch(()=>{})}function clearScreenshotStage(e){chrome.action.setBadgeText({text:"",tabId:e}).catch(()=>{}),chrome.action.setTitle({tabId:e,title:"fiGapture"}).catch(()=>{})}async function sleepCheck(e,t){const r=Math.ceil(e/50);for(let e=0;e<r;e++){if(t.cancelled)throw new Error("USER_CANCELLED");await new Promise(e=>setTimeout(e,50))}}async function captureFullPage(e,t){const r=e.id,o=e.windowId;await assertCaptureTabActive(r,o),reportScreenshotStage(r,"Preparing page…");const[{result:i}]=await chrome.scripting.executeScript({target:{tabId:r},world:"ISOLATED",func:shotSetup,args:[TOOLBAR_HOST_ID]});if(!i)throw new Error("Could not measure page");let{totalWidth:a,totalHeight:n,viewportWidth:s,viewportHeight:c,dpr:l}=i;const u=[],d=new Set,h=[];let g=0,f=!1,m=!1;try{if(t.cancelled)throw new Error("USER_CANCELLED");a=Math.min(a,Math.floor(32e3/l));const e=i.clip||null,p=e?e.height:c,w=Math.max(1,p-(p>200?200:0));let y=0;for(let i=0;i<n&&y<300;i+=w,y++)for(let m=0;m<(e?1:a);m+=s){if(t.cancelled)throw new Error("USER_CANCELLED");await assertCaptureTabActive(r,o);const s=Math.min(99,Math.round(i/Math.max(1,n)*100));reportScreenshotStage(r,`Capturing… ${s}%`);try{chrome.action.setBadgeText({text:s+"%",tabId:r}).catch(()=>{})}catch(e){}const p=350-(Date.now()-g);p>0&&await sleepCheck(p,t);const[{result:w}]=await chrome.scripting.executeScript({target:{tabId:r},world:"ISOLATED",func:shotScrollAndWait,args:[m,i,0===i,1500,s]});if(!w)throw new Error("Could not settle page after scrolling");n=Math.max(n,w.totalHeight||0),a=Math.min(Math.max(a,w.totalWidth||0),Math.floor(32e3/l));const y=w.x??m,b=w.y??i,S=y+":"+b;if(d.has(S))continue;d.add(S);const _=!!(e&&i>0),v=_?e.height:c;b+v>=n-2&&(f=!0),await assertCaptureTabActive(r,o);const T=await captureTile(o),R=t.id+"_tile_"+u.length+"_"+Date.now().toString(36);await assertCaptureTabActive(r,o),await saveScreenshotTile(R,T,Date.now()+18e5),h.push(R),g=Date.now(),u.push({storageId:R,x:y,y:b,clip:_?e:null,cropBottom:0})}m=!0}finally{try{chrome.action.setBadgeText({text:"",tabId:r}).catch(()=>{}),chrome.action.setTitle({tabId:r,title:"fiGapture"}).catch(()=>{})}catch(e){}await chrome.scripting.executeScript({target:{tabId:r},world:"ISOLATED",func:shotTeardown}).catch(()=>{}),m||await deleteScreenshotTiles(h).catch(()=>{})}if(!u.length)throw new Error("No screenshot tiles were captured");const p=!f,w=p?Math.min(n,Math.max(...u.map(e=>e.y+(e.clip?e.clip.height:c)))):n;let y;reportScreenshotStage(r,"Building screenshot…");try{y=await stitchChunks(u,a,w,c,l)}finally{await deleteScreenshotTiles(h).catch(()=>{})}if(t.onStitched){await t.onStitched({chunks:y,width:Math.round(a),height:Math.round(w),dpr:l});return}const b="shot_"+Date.now()+"_"+Math.random().toString(36).slice(2,8);reportScreenshotStage(r,"Saving screenshot…"),await saveScreenshot({id:b,chunks:y,width:Math.round(a),height:Math.round(w),pixelWidth:Math.round(a*l),pixelHeight:Math.round(w*l),url:e.url||"",truncated:p,createdAt:Date.now(),expiresAt:Date.now()+18e5}),setTimeout(()=>deleteScreenshot(b).catch(()=>{}),18e5),await chrome.tabs.create({url:chrome.runtime.getURL("pages/screenshot/index.html")+"?id="+b})}const viewerStore=new Map;async function recoverCaptureAsset(e){if(!/^https?:\/\//i.test(e))return{url:e,blob:null,error:"blocked"};let t="recovery_failed";for(let r=0;r<3;r++)try{const t=await fetch(e,{signal:AbortSignal.timeout(1e4),cache:"force-cache",credentials:"omit",redirect:"follow",referrerPolicy:"no-referrer"}),r=(t.headers.get("content-type")||"").split(";")[0].trim().toLowerCase(),o=Number(t.headers.get("content-length")||0);if(!t.ok)throw new Error("HTTP_"+t.status);if(!r.startsWith("image/")&&!/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i.test(e))return{url:e,blob:null,error:"unsupported_type"};if(o>26214400)return{url:e,blob:null,error:"asset_too_large"};const i=new Uint8Array(await t.arrayBuffer());if(i.byteLength>26214400)return{url:e,blob:null,error:"asset_too_large"};let a="";for(let e=0;e<i.length;e+=8192)a+=String.fromCharCode.apply(null,i.subarray(e,e+8192));const n=(e.match(/\.([a-z0-9]+)(?:\?|$)/i)||[])[1]?.toLowerCase(),s={svg:"image/svg+xml",jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",avif:"image/avif",ico:"image/x-icon",bmp:"image/bmp"},c=r.startsWith("image/")?r:s[n]||"image/png";return{url:e,blob:{type:c,base64Blob:`data:${c};base64,${btoa(a)}`}}}catch(e){t=String(e?.message||e||"recovery_failed"),r<2&&await new Promise(e=>setTimeout(e,250*2**r))}return{url:e,blob:null,error:t}}async function recoverCaptureAssets(e,t=6){const r=new Array(e.length);let o=0;return await Promise.all(Array.from({length:Math.min(t,e.length)},async()=>{for(;;){const t=o++;if(t>=e.length)return;r[t]=await recoverCaptureAsset(e[t])}})),r}async function fetchResourceBuffer(e,t,r){const o=await fetch(e,{signal:r});if(!o.ok)throw new Error(`HTTP ${o.status}${o.statusText?" "+o.statusText:""}`);const i=Number.isFinite(t)?Math.max(0,Math.min(t,67108864)):0,a=Number(o.headers.get("content-length")||0);if(i&&a>i)throw new Error("Resource exceeds the allowed size limit.");if(!i||!o.body){const e=await o.arrayBuffer();if(i&&e.byteLength>i)throw new Error("Resource exceeds the allowed size limit.");return{buffer:e,contentType:o.headers.get("content-type")||""}}const n=o.body.getReader(),s=[];let c=0;try{for(;;){const{done:e,value:t}=await n.read();if(e)break;if(c+=t.byteLength,c>i)throw await n.cancel(),new Error("Resource exceeds the allowed size limit.");s.push(t)}}catch(e){try{await n.cancel()}catch{}throw e}const l=new Uint8Array(c);let u=0;for(const e of s)l.set(e,u),u+=e.byteLength;return{buffer:l.buffer,contentType:o.headers.get("content-type")||""}}chrome.runtime.onMessage.addListener((e,t,r)=>{if("figshot-offscreen"===e?.target)return!1;if(!isTrustedSender(t))return r({ok:!1,error:"untrusted_sender",code:"E_SENDER"}),!1;if("e2fGetHeroScreenshot"===e?.action){const winId=t?.tab?.windowId;const p=winId?chrome.tabs.captureVisibleTab(winId,{format:"png"}):chrome.tabs.captureVisibleTab(null,{format:"png"});return p.then(s=>r({ok:!0,screenshot:s})).catch(err=>r({ok:!1,error:String(err)})),!0}if("triggerToggle"===e?.action){const e=t?.tab?.id;return e&&toggleToolbar(t.tab).catch(()=>{}),!1}if("request_permissions"===e?.action)return chrome.windows.create({url:chrome.runtime.getURL("pages/permissions/index.html"),type:"popup",width:450,height:350}),r({ok:!0}),!1;if("figshotClosed"===e?.action){const e=t?.tab?.url;return e&&setOriginActive(e,!1),!1}if("getViewerData"===e?.action&&"string"==typeof e.id){const t=viewerStore.get(e.id);return t?(viewerStore.delete(e.id),r({ok:!0,...t})):r({ok:!1}),!1}if("fullPageScreenshot"===e?.action){const e=t?.tab;if(!e||!e.id)return r({ok:!1,error:"NO_TAB"}),!1;if(screenshotJobs.has(e.id))return r({ok:!1,error:"CAPTURE_IN_PROGRESS"}),!1;const o={id:"job_"+Date.now()+"_"+Math.random().toString(36).slice(2,8),tabId:e.id,cancelled:!1};return screenshotJobs.set(e.id,o),captureFullPage(e,o).then(()=>r({ok:!0})).catch(t=>{const o=String(t&&t.message||t),i="TAB_NOT_ACTIVE"===o?"Capture stopped — keep this tab active":"CAPTURE_IN_PROGRESS"===o?"A screenshot is already in progress":"Screenshot failed — "+o;"USER_CANCELLED"!==o&&showToast(e.id,i),r({ok:!1,error:o})}).finally(()=>{screenshotJobs.get(e.id)===o&&screenshotJobs.delete(e.id),clearScreenshotStage(e.id)}),!0}if("cancelFullPageScreenshot"===e?.action){const e=t?.tab?.id,r=e?screenshotJobs.get(e):null;return r&&(r.cancelled=!0),!1}if("getScreenshot"===e?.action&&"string"==typeof e.id)return loadScreenshot(e.id).then(e=>r(e?{ok:!0,...e}:{ok:!1})).catch(e=>r({ok:!1,error:String(e?.message||e)})),!0;if("fetchResource"===e?.action&&"string"==typeof e.url){const t=registerStreamFetch(e.streamJobId);return fetchResourceBuffer(e.url,e.maxBytes,t?.signal).then(({buffer:e,contentType:t})=>({ok:!0,text:(new TextDecoder).decode(e),byteLength:e.byteLength,contentType:t})).catch(e=>({ok:!1,error:String(e?.message||e)})).finally(()=>releaseStreamFetch(e.streamJobId,t)).then(r),!0}if("H2D_FETCH_ASSETS"===e?.cmd&&Array.isArray(e?.payload?.urls))return recoverCaptureAssets(e.payload.urls).then(e=>r({success:!0,value:e})).catch(e=>r({success:!1,error:{message:String(e?.message||e)}})),!0;if("fetchImage"===e?.action&&"string"==typeof e.url){const t=registerStreamFetch(e.streamJobId);return fetchResourceBuffer(e.url,e.maxBytes,t?.signal).then(({buffer:e,contentType:t})=>{const r=new Uint8Array(e);let o="";for(let e=0;e<r.length;e+=8192)o+=String.fromCharCode.apply(null,r.subarray(e,e+8192));return{ok:!0,base64:btoa(o),byteLength:e.byteLength,contentType:t}}).catch(e=>({ok:!1,error:String(e?.message||e)})).finally(()=>releaseStreamFetch(e.streamJobId,t)).then(r),!0}const o=t.tab.id;if("openLibrary"===e?.action)return chrome.tabs.create({url:chrome.runtime.getURL("pages/library/index.html")}),!1;if("archiveStartShots"===e?.action)return shotsEntry(t.tab),!1;if("archiveTakeShots"===e?.action)return shotsTake(t.tab),!1;if("archiveAbort"===e?.action)return shotsAbort(o),!1;if("writeFigmaClipboard"===e?.action&&"string"==typeof e.json){const m=e,n=t.tab;console.info("[fiGapture v3] got capture, archive flag =",!!m.archive);m.archive&&archiveFullPage(n,m.json).catch(e=>console.warn("[fiGapture] archive error",e));return writeFigmaClipboard(m.json).then(()=>r({ok:!0})).catch(e=>r({ok:!1,error:String(e?.message||e)})),!0}if("enablePreview"===e?.action)return enablePreviewRules(o,{ua:e.ua||null}).then(()=>r({ok:!0})).catch(e=>r({ok:!1,error:String(e?.message||e),code:"E_DNR_ADD"})),!0;if("embedInject"===e?.action)return embedInject(o).then(r).catch(e=>r({ok:!1,error:String(e?.message||e)})),!0;if("injectFrames"===e?.action)return(async()=>{try{const e=frameChannelSecrets.get(o)||createChannelSecret();frameChannelSecrets.set(o,e),await chrome.scripting.executeScript({target:{tabId:o,allFrames:!0},world:"ISOLATED",func:configureFigshotFrame,args:[chrome.runtime.getURL(""),null,!1,e]}),await chrome.scripting.executeScript({target:{tabId:o,allFrames:!0},world:"ISOLATED",files:[CAPTURE_SCRIPT,EMBED_SCRIPT]}),await chrome.scripting.executeScript({target:{tabId:o,allFrames:!0},world:"ISOLATED",func:installCaptureRunner}),await chrome.scripting.executeScript({target:{tabId:o,allFrames:!0},world:"ISOLATED",files:[TOOLBAR_SCRIPT]}),r({ok:!0})}catch(e){r({ok:!1,error:String(e)})}})(),!0;if("disablePreview"===e?.action)return disablePreviewRules(o).then(()=>r({ok:!0})).catch(e=>r({ok:!1,error:String(e?.message||e),code:"E_DNR_REMOVE"})),!0;if("openViewer"===e?.action){const t=chrome.runtime.getURL("pages/viewer/index.html");let o;if(e.url)o=t+"?url="+encodeURIComponent(e.url);else{if(!e.svgMarkup)return r({ok:!1}),!1;{const r=Math.random().toString(36).slice(2);viewerStore.set(r,{svgMarkup:e.svgMarkup,filename:e.filename||"inline.svg"}),setTimeout(()=>viewerStore.delete(r),3e5),o=t+"?id="+r}}return chrome.tabs.create({url:o}),r({ok:!0}),!1}if("getDetectedStreams"===e?.action){const e=detectedStreams.get(o);return r({ok:!0,items:e?[...e].map(([e,t])=>({url:e,kind:t})):[]}),!1}if("openStreamDownloader"===e?.action&&"string"==typeof e.manifestUrl){const t=Math.random().toString(36).slice(2);streamJobs.set(t,{manifestUrl:e.manifestUrl,filename:e.filename||"video"}),setTimeout(()=>streamJobs.delete(t),3e5);const o=chrome.runtime.getURL("pages/stream/index.html")+"?id="+t;return chrome.tabs.create({url:o}),r({ok:!0}),!1}if("getStreamJob"===e?.action&&"string"==typeof e.id){const t=streamJobs.get(e.id);return t?(streamJobs.delete(e.id),r({ok:!0,...t})):r({ok:!1}),!1}if("cancelStreamFetches"===e?.action&&"string"==typeof e.id)return cancelStreamFetches(e.id),r({ok:!0}),!1;if("downloadUrl"===e?.action&&"string"==typeof e.url)try{return chrome.downloads.download({url:e.url,filename:e.filename||void 0,saveAs:!1},e=>{chrome.runtime.lastError||null==e?r({ok:!1,error:chrome.runtime.lastError?.message||"Download failed"}):r({ok:!0,downloadId:e})}),!0}catch(e){return r({ok:!1,error:String(e?.message||e)}),!1}return!1}),chrome.tabs.onRemoved.addListener(e=>{frameChannelSecrets.delete(e),chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[headerRuleId(e),uaRuleId(e)]}).catch(()=>{})});

/* ===== fiGapture: save captures into the in-browser Library (IndexedDB) ===== */
const ARCHIVE_SLICE_HEIGHT = 1800; // CSS px per screenshot
const LIB_DB = "figshot-library";

function libDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(LIB_DB, 2);
    r.onupgradeneeded = () => {
      const st = r.result.objectStoreNames.contains("captures") ? r.transaction.objectStore("captures") : r.result.createObjectStore("captures", { keyPath: "id" });
      if (!st.indexNames.contains("key")) st.createIndex("key", "key");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("Library database failed"));
  });
}
async function libPut(rec) {
  const db = await libDb();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction("captures", "readwrite");
      tx.objectStore("captures").put(rec);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error || new Error("Could not save to Library"));
      tx.onabort = () => rej(tx.error || new Error("Library save aborted (storage full?)"));
    });
  } finally { db.close(); }
}
// Runs inside the page (serialised by chrome.scripting) — must be fully self-contained.
async function figshotDesignScrape(toolbarId) {
  const MAX_EL = 8000;
  const out = { url: location.href, title: document.title, cssVariables: {}, fonts: [] };
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const colorCache = new Map();
  const norm = (v) => {
    if (!v || v === "transparent" || v === "none") return null;
    if (colorCache.has(v)) return colorCache.get(v);
    let res = null;
    try {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = v;
      cx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
      if (a > 0) {
        const h = (n) => n.toString(16).padStart(2, "0");
        res = "#" + h(r) + h(g) + h(b) + (a < 255 ? h(a) : "");
      }
    } catch (e) {}
    colorCache.set(v, res);
    return res;
  };

  // --- CSS custom properties (grouped by the selector that defines them) + page CSS text
  let cssText = "";
  const walk = (rules) => {
    for (const r of rules) {
      if (r.style && r.selectorText) {
        let any = false;
        for (let i = 0; i < r.style.length; i++) {
          const p = r.style[i];
          if (p.startsWith("--")) {
            (out.cssVariables[r.selectorText] = out.cssVariables[r.selectorText] || {})[p] = r.style.getPropertyValue(p).trim();
            any = true;
          }
        }
        void any;
      }
      if (r.cssRules) walk(r.cssRules);
    }
  };
  const blocked = [];
  for (const sh of document.styleSheets) {
    try {
      const rules = sh.cssRules;
      walk(rules);
      if (cssText.length < 5e6) for (const r of rules) cssText += r.cssText + "\n";
    } catch (e) {
      if (sh.href) blocked.push(sh.href);
    }
  }
  for (const href of blocked.slice(0, 20)) {
    try {
      const t = await (await fetch(href, { credentials: "omit" })).text();
      cssText += "\n/* " + href + " */\n" + t;
      const ext = (out.cssVariables["(external) " + href] = {});
      for (const m of t.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) ext[m[1]] = m[2].trim();
    } catch (e) {}
  }
  const rootCs = getComputedStyle(document.documentElement);
  const resolved = {};
  for (const sel of Object.values(out.cssVariables)) for (const n of Object.keys(sel)) resolved[n] = rootCs.getPropertyValue(n).trim();
  out.cssVariablesResolved = resolved;

  // --- element pass
  const colors = new Map(), typo = new Map(), spacing = new Map(), radii = new Map(), shadows = new Map();
  const comps = new Map(), icons = new Map(), fonts = new Set();
  const inc = (m, k, init) => { const c = m.get(k); if (c) c.count++; else m.set(k, { ...(init || {}), count: 1 }); return m.get(k); };
  const px = (v) => parseFloat(v) || 0;
  const addColor = (raw, role) => {
    const hex = norm(raw);
    if (!hex) return;
    const c = inc(colors, hex, { value: hex, roles: [] });
    if (!c.roles.includes(role)) c.roles.push(role);
  };
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const STYLE_KEYS = ["backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textTransform",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopLeftRadius", "borderTopWidth", "borderTopStyle", "borderTopColor", "boxShadow", "textDecorationLine"];
  const pick = (cs) => { const o = {}; for (const k of STYLE_KEYS) o[k] = cs[k]; return o; };
  const sigOf = (cs, extra) => hash(STYLE_KEYS.map((k) => cs[k]).join("|") + (extra || ""));
  const addComp = (type, el, cs, rect, extra) => {
    const signature = sigOf(cs, extra);
    const k = type + "|" + signature;
    const c = comps.get(k);
    if (c) { c.count++; return; }
    comps.set(k, {
      type, signature, count: 1,
      sample: {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || "").trim().slice(0, 60),
        classes: (typeof el.className === "string" ? el.className : "").slice(0, 200),
        size: { width: Math.round(rect.width), height: Math.round(rect.height) },
        styles: pick(cs),
        html: el.outerHTML.slice(0, 900),
      },
    });
  };

  const els = document.querySelectorAll("body *");
  let seen = 0;
  for (const el of els) {
    if (seen++ > MAX_EL) break;
    if (el.id === toolbarId || el.closest("#" + toolbarId)) continue;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "link", "meta", "noscript", "head", "title", "br", "path", "g", "defs", "use", "circle", "rect", "line", "polyline", "polygon", "ellipse", "tspan"].includes(tag)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    const bg = norm(cs.backgroundColor);
    const borderW = px(cs.borderTopWidth);
    if (ownText) {
      addColor(cs.color, "text");
      const fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      fonts.add(fam);
      const key = [fam, cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.textTransform].join("|");
      inc(typo, key, { family: fam, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, color: norm(cs.color), tag, sample: (el.textContent || "").trim().slice(0, 40) });
    }
    if (bg) addColor(cs.backgroundColor, "background");
    if (borderW > 0 && cs.borderTopStyle !== "none") addColor(cs.borderTopColor, "border");
    for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft", "rowGap", "columnGap"]) {
      const v = px(cs[p]);
      if (v > 0 && v < 400) inc(spacing, Math.round(v * 100) / 100 + "px", { value: Math.round(v * 100) / 100 + "px" });
    }
    const r = cs.borderTopLeftRadius;
    if (px(r) > 0 || r.includes("%")) inc(radii, r, { value: r });
    if (cs.boxShadow && cs.boxShadow !== "none") inc(shadows, cs.boxShadow, { value: cs.boxShadow });

    // --- component heuristics
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const shortText = (el.innerText || "").trim().length <= 40;
    const radius = px(r);
    if (tag === "button" || role === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type))) addComp("button", el, cs, rect);
    else if (tag === "a" && shortText && (bg || borderW > 0) && radius > 0 && px(cs.paddingLeft) >= 6) addComp("button", el, cs, rect, "link");
    else if (tag === "input" && ["checkbox", "radio"].includes(type)) addComp("control-" + type, el, cs, rect);
    else if (role === "switch") addComp("control-switch", el, cs, rect);
    else if (tag === "input" || tag === "textarea" || tag === "select") addComp("input", el, cs, rect, tag);
    else if (/^h[1-6]$/.test(tag)) addComp("heading-" + tag, el, cs, rect);
    else if (tag === "a" && ownText) addComp("link", el, cs, rect);
    else if (tag === "nav" || tag === "header" || tag === "footer") addComp(tag, el, cs, rect);
    else if (tag === "img" && Math.abs(rect.width - rect.height) < 2 && radius >= rect.width / 2 - 1 && rect.width <= 128) addComp("avatar", el, cs, rect);
    else if (tag === "svg" && rect.width <= 40 && rect.height <= 40) {
      const h = hash(el.innerHTML.slice(0, 1500));
      if (!icons.has(h) && icons.size < 80) icons.set(h, { hash: h, size: Math.round(rect.width), html: el.outerHTML.slice(0, 2500) });
    } else if (shortText && bg && rect.height <= 36 && rect.height >= 14 && radius >= 4 && (el.innerText || "").trim() && el.children.length <= 2) addComp("badge", el, cs, rect);
    else if (["div", "section", "article", "li", "aside"].includes(tag) && rect.width >= 160 && rect.height >= 80 && el.children.length >= 2 && radius >= 4 && ((cs.boxShadow && cs.boxShadow !== "none") || borderW > 0 || (bg && bg !== norm(getComputedStyle(document.body).backgroundColor)))) addComp("card", el, cs, rect);
  }

  const top = (m, n) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, n);
  out.colors = top(colors, 200);
  out.typography = top(typo, 200);
  out.spacing = top(spacing, 80);
  out.radii = top(radii, 40);
  out.shadows = top(shadows, 40);
  out.components = top(comps, 400);
  out.icons = [...icons.values()];
  out.fonts = [...new Set([...fonts, ...[...document.fonts].map((f) => f.family.replace(/["']/g, ""))])];
  out.html = document.documentElement.outerHTML.slice(0, 4e6);
  out.css = cssText.slice(0, 5e6);
  out.meta = { viewport: { width: innerWidth, height: innerHeight }, scrapedAt: new Date().toISOString(), note: "Hover/focus/active states are not captured (computed styles only)." };
  return out;
}

function libKey(url) {
  try { const u = new URL(url); return u.origin.toLowerCase() + (u.pathname.replace(/\/+$/, "") || "") + u.search; } catch (e) { return String(url || ""); }
}
async function libDeleteOthers(key, keepId) {
  const db = await libDb();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction("captures", "readwrite");
      const st = tx.objectStore("captures");
      const q = st.index("key").getAllKeys(key);
      q.onsuccess = () => { (q.result || []).forEach((id) => { if (id !== keepId) st.delete(id); }); };
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function archiveSliceAndStore({ chunks, width, height, dpr }) {
  const sh = ARCHIVE_SLICE_HEIGHT;
  let total = Math.max(1, Math.ceil(height / sh - 1e-6));
  // A sliver of leftover (<10% of a slice) is merged into the previous slice.
  if (total > 1 && height - (total - 1) * sh < sh * 0.1) total--;
  const heights = [];
  for (const d of chunks) {
    const bm = await createImageBitmap(await (await fetch(d)).blob());
    heights.push(bm.height);
    bm.close && bm.close();
  }
  const totalPx = heights.reduce((a, b) => a + b, 0);
  const wPx = Math.max(1, Math.round(width * dpr));
  let cache = { idx: -1, bm: null };
  const getBitmap = async (i) => {
    if (cache.idx !== i) {
      cache.bm && cache.bm.close && cache.bm.close();
      cache = { idx: i, bm: await createImageBitmap(await (await fetch(chunks[i])).blob()) };
    }
    return cache.bm;
  };
  const out = [];
  for (let i = 0; i < total; i++) {
    const y0 = Math.round(i * sh * dpr);
    const y1 = i === total - 1 ? totalPx : Math.min(totalPx, Math.round((i + 1) * sh * dpr));
    const hPx = Math.max(1, y1 - y0);
    const canvas = new OffscreenCanvas(wPx, hPx);
    const ctx = canvas.getContext("2d");
    let off = 0;
    for (let c = 0; c < chunks.length; c++) {
      const cs = off, ce = off + heights[c];
      off = ce;
      if (ce <= y0 || cs >= y1) continue;
      const bm = await getBitmap(c);
      const sy = Math.max(y0, cs) - cs;
      const sH = Math.min(y1, ce) - Math.max(y0, cs);
      ctx.drawImage(bm, 0, sy, bm.width, sH, 0, Math.max(y0, cs) - y0, bm.width, sH);
    }
    out.push({ blob: await canvas.convertToBlob({ type: "image/png" }), width: wPx, height: hPx });
  }
  cache.bm && cache.bm.close && cache.bm.close();
  return out;
}

// ---- screenshots via the debugger protocol: no scrolling, no page changes, can run during the Figma capture ----
const pendingShots = new Map();
function shotsEntry(tab) {
  let e = pendingShots.get(tab.id);
  if (e) return e;
  e = { tabId: tab.id, attach: null, shots: null, detached: false, timer: null };
  e.attach = chrome.debugger.attach({ tabId: tab.id }, "1.3").then(() => true, (err) => { console.warn("[fiGapture] debugger attach failed", err); return false; });
  e.timer = setTimeout(() => shotsAbort(tab.id), 180000);
  pendingShots.set(tab.id, e);
  return e;
}
async function shotsDetach(e) {
  if (e.detached) return;
  e.detached = true;
  try { if (await e.attach) await chrome.debugger.detach({ tabId: e.tabId }); } catch (err) {}
}
function shotsAbort(tabId) {
  const e = pendingShots.get(tabId);
  if (!e) return;
  clearTimeout(e.timer);
  pendingShots.delete(tabId);
  shotsDetach(e);
}
function shotsTake(tab) {
  const e = shotsEntry(tab);
  if (!e.shots) {
    e.shots = (async () => {
      if (!(await e.attach)) throw new Error("debugger unavailable");
      try { return await cdpSlices(tab.id); } finally { await shotsDetach(e); }
    })();
    e.shots.catch(() => {});
  }
  return e.shots;
}
async function cdpSlices(tabId) {
  const target = { tabId };
  const send = (m, p) => chrome.debugger.sendCommand(target, m, p);
  const evalJs = (expression) => send("Runtime.evaluate", { expression, returnByValue: true });
  const ids = JSON.stringify([TOOLBAR_HOST_ID, "__figshot_toast__"]);
  await evalJs(`(()=>{for(const id of ${ids}){const n=document.getElementById(id);if(n){n.__fsv=n.style.visibility;n.style.setProperty("visibility","hidden","important")}}})()`);
  try {
    // Page size in CSS pixels, measured inside the page (layout metrics can report device pixels).
    const m = ((await evalJs("({w:Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0),h:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0),dpr:window.devicePixelRatio||1})")).result || {}).value || {};
    let cw = m.w, chh = m.h;
    if (!cw || !chh) { const lm = await send("Page.getLayoutMetrics"); const cs = lm.cssContentSize || lm.contentSize; cw = cs.width; chh = cs.height; }
    const dprGuess = m.dpr || 1;
    const width = Math.max(1, Math.min(Math.ceil(cw), Math.floor(16000 / dprGuess)));
    const height = Math.max(1, Math.ceil(chh));
    const sh = ARCHIVE_SLICE_HEIGHT;
    let total = Math.max(1, Math.ceil(height / sh - 1e-6));
    if (total > 1 && height - (total - 1) * sh < sh * 0.1) total--;
    const slices = [];
    // Page laid out by embed.js (claude.ai artifacts and other app-shell pages): the content is
    // in a cross-site iframe, which Chrome only paints near the visible window, so
    // captureBeyondViewport leaves everything below the first screen blank. Instead make the
    // window one slice tall and scroll to each slice, so every part is on screen when taken.
    const embedMode = ((await evalJs('document.documentElement.hasAttribute("data-figshot-embed")')).result || {}).value === true;
    let restoreScroll = null;
    if (embedMode) {
      const vw = ((await evalJs("({w:window.innerWidth,x:scrollX,y:scrollY})")).result || {}).value || {};
      restoreScroll = vw;
      await send("Emulation.setDeviceMetricsOverride", { width: vw.w || width, height: Math.min(sh, height), deviceScaleFactor: 0, mobile: false });
    }
    try {
    for (let i = 0; i < total; i++) {
      const y = i * sh;
      const h = i === total - 1 ? height - y : sh;
      if (embedMode) {
        await send("Runtime.evaluate", { expression: `new Promise(r=>{scrollTo(0,${y});requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,450)))})`, awaitPromise: true, returnByValue: true });
      }
      // scale 1: the browser already renders at the screen's pixel density, so this is full resolution without any visible zoom.
      const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: !embedMode, clip: { x: 0, y, width, height: h, scale: 1 } });
      const blob = await (await fetch("data:image/png;base64," + r.data)).blob();
      const bm = await createImageBitmap(blob);
      slices.push({ blob, width: bm.width, height: bm.height });
      bm.close && bm.close();
    }
    } finally {
      if (embedMode) {
        await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        await evalJs(`scrollTo(${(restoreScroll && restoreScroll.x) || 0},${(restoreScroll && restoreScroll.y) || 0})`).catch(() => {});
      }
    }
    // Effective pixels per CSS pixel, measured from the real output (so frames in Figma always match the image).
    const dpr = slices[0].width / width;
    return { slices, width, height, dpr };
  } finally {
    await evalJs(`(()=>{for(const id of ${ids}){const n=document.getElementById(id);if(n){n.style.visibility=n.__fsv||"";}}})()`).catch(() => {});
  }
}

// ---- send the saved capture to the Figma Desktop Bridge (through the local MCP server) ----
async function findBridgeServer() {
  let fallback = null;
  for (let port = 9223; port <= 9232; port++) {
    try {
      const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(700) });
      const j = await r.json();
      if (typeof j.figshotCaptures !== "number") continue; // an older server without the relay
      if (j.connectedClients > 0) return port; // a server the Figma plugin is connected to
      if (fallback === null) fallback = port;
    } catch (e) { /* port closed */ }
  }
  return fallback;
}
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}
async function pushToBridge(rec) {
  const port = await findBridgeServer();
  if (port === null) return false;
  const payload = {
    id: rec.id, key: rec.key, url: rec.url, title: rec.title, createdAt: rec.createdAt,
    figmaJson: rec.figmaJson, design: rec.design, pageWidth: rec.pageWidth, pageHeight: rec.pageHeight, dpr: rec.dpr,
    slices: await Promise.all(rec.slices.map(async (s) => ({ b64: await blobToBase64(s.blob), width: s.width, height: s.height }))),
  };
  const r = await fetch(`http://localhost:${port}/figshot/captures`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
  return r.ok;
}

// Make sure every frame in the tab has the capture engine + embed.js on the same
// signed channel. Pages such as claude.ai/artifact/<id> load the real page into a
// nested iframe that may not exist yet when the toolbar is first opened.
async function embedInject(tabId) {
  const secret = frameChannelSecrets.get(tabId);
  if (!secret) return { ok: false, error: "no channel" };
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "ISOLATED",
      func: (s) => window.__figshotChannelSecret__ === s && !!window.__figshotEmbedInstalled && !!window.__figshotCaptureRunner, args: [secret] });
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  const need = (frames || []).filter((f) => f && f.result !== true && typeof f.frameId === "number").map((f) => f.frameId);
  let injected = 0, failed = 0;
  for (const frameId of need) {
    const target = { tabId, frameIds: [frameId] };
    try {
      await chrome.scripting.executeScript({ target, world: "ISOLATED", func: configureFigshotFrame, args: [chrome.runtime.getURL(""), null, !1, secret] });
      await chrome.scripting.executeScript({ target, world: "ISOLATED", files: [CAPTURE_SCRIPT, EMBED_SCRIPT] });
      await chrome.scripting.executeScript({ target, world: "ISOLATED", func: installCaptureRunner });
      injected++;
    } catch (e) { failed++; }
  }
  return { ok: true, frames: (frames || []).length, injected, failed };
}

// Frame that holds an embedded page laid out by embed.js, else the top frame.
async function embedFrameTarget(tabId) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "ISOLATED", func: () => document.documentElement.hasAttribute("data-figshot-embed-frame") });
    const hit = (res || []).find((r) => r && r.result === true && r.frameId);
    if (hit) return { tabId, frameIds: [hit.frameId] };
  } catch (e) {}
  return { tabId };
}
function notifyArchiveDone(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => document.dispatchEvent(new CustomEvent("__figshot_archive_done__")) }).catch(() => {});
}

async function archiveFullPage(tab, figmaJson) {
  if (!tab || !tab.id) return;
  const tabId = tab.id;
  const rec = { id: "cap_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), createdAt: Date.now(), key: libKey(tab.url), url: tab.url || "", title: tab.title || "", figmaJson, slices: [], design: null, html: "", css: "" };
  let shotsP = null;
  try { shotsP = shotsTake(tab); } catch (e) {}
  try {
    console.info("[fiGapture] saving to Library", tab.url);
    // Everything below runs side by side: scraping the design system while the screenshots finish.
    // On "app shell" pages (shared Claude artifacts) the content is inside an iframe: scrape that frame.
    const designP = embedFrameTarget(tabId).then((target) => chrome.scripting.executeScript({ target, world: "ISOLATED", func: figshotDesignScrape, args: [TOOLBAR_HOST_ID] })).then((r) => (r && r[0] && r[0].result) || null).catch(() => null);
    const savedP = libPut(rec); // the Figma data is safe from this point on
    let shots = null;
    try { shots = await shotsP; } catch (e) { console.warn("[fiGapture] fast screenshots failed, using scroll method", e); }
    showToast(tabId, "Saving to fiGapture Library …"); // shown only after the screenshots, so it never appears in them
    const entry = pendingShots.get(tabId);
    if (entry) { clearTimeout(entry.timer); pendingShots.delete(tabId); shotsDetach(entry); }
    await savedP;
    if (shots) {
      rec.slices = shots.slices; rec.pageWidth = shots.width; rec.pageHeight = shots.height; rec.dpr = shots.dpr;
    } else if (!screenshotJobs.has(tabId)) {
      const job = { id: "archive_" + Date.now(), tabId, cancelled: false };
      screenshotJobs.set(tabId, job);
      try {
        job.onStitched = async (img) => { rec.slices = await archiveSliceAndStore(img); rec.pageWidth = img.width; rec.pageHeight = img.height; rec.dpr = img.dpr; };
        await captureFullPage(tab, job);
      } finally { if (screenshotJobs.get(tabId) === job) screenshotJobs.delete(tabId); try { clearScreenshotStage(tabId); } catch (e) {} }
    }
    const result = await designP;
    notifyArchiveDone(tabId); // screenshots + design scrape are done: the page can be put back (see embed.js)
    if (result) { const { html, css, ...design } = result; rec.design = design; rec.html = html || ""; rec.css = css || ""; }
    await libPut(rec);
    await libDeleteOthers(rec.key, rec.id); // re-capturing a URL replaces the old capture
    const sent = await pushToBridge(rec).catch((e) => { console.warn("[fiGapture] bridge push failed", e); return false; });
    showToast(tabId, `Saved to Library: Figma data + ${rec.slices.length} screenshot${rec.slices.length === 1 ? "" : "s"}${rec.design ? " + design system" : ""}${sent ? " — sent to Figma Bridge" : ""}. Library: Alt+L`);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg !== "USER_CANCELLED") showToast(tabId, "Save failed — " + msg);
    shotsAbort(tabId);
    notifyArchiveDone(tabId);
  }
}

console.info("[fiGapture v4] service worker started");
