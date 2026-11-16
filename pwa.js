#!/usr/bin/env node
//
// Offline home-screen app ("PWA") layer for the encrypted notes site.
//
//   node pwa.js stage <staged-plaintext-dir>   (before encryption)
//     - adds home-screen <head> tags + service-worker registration to every page
//     - adds the "Save offline" button to the home page (it ends up encrypted)
//
//   node pwa.js out <encrypted-output-dir>     (after encryption)
//     - writes sw.js (offline cache), manifest.webmanifest, icon-180.png, icon-512.png
//     - adds the same <head> tags to every page's public password-prompt shell
//
// Nothing here reads or stores the password. Pages stay ciphertext in the cache;
// they are decrypted in the browser exactly as online.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [mode, root] = process.argv.slice(2);
if (!["stage", "out"].includes(mode) || !root) {
  console.error("Usage: node pwa.js stage|out <dir>");
  process.exit(1);
}

function* htmlFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(p);
    else if (e.isFile() && e.name.endsWith(".html")) yield p;
  }
}

function rel(file) {
  const depth = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean).length;
  return depth ? "../".repeat(depth) : "./";
}

function headTags(r) {
  return (
    '<!--pwa--><link rel="manifest" href="' + r + 'manifest.webmanifest">' +
    '<meta name="apple-mobile-web-app-capable" content="yes">' +
    '<meta name="mobile-web-app-capable" content="yes">' +
    '<meta name="apple-mobile-web-app-title" content="Notes">' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
    '<meta name="theme-color" content="#1d2a44">' +
    '<link rel="apple-touch-icon" href="' + r + 'icon-180.png">' +
    "<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('" + r +
    "sw.js',{scope:'" + r + "'}).catch(function(){});}</script><!--/pwa-->"
  );
}

function addHead(file) {
  let s = fs.readFileSync(file, "utf8");
  if (s.includes("<!--pwa-->")) return false;
  const i = s.search(/<\/head>/i);
  if (i < 0) return false;
  s = s.slice(0, i) + headTags(rel(file)) + s.slice(i);
  fs.writeFileSync(file, s);
  return true;
}

// The "Save offline" button, injected into the (plaintext) home page before it
// is encrypted. It only talks to the service worker.
const UI = `<!--pwa-ui--><div id="pwa-offline" style="position:fixed;right:12px;bottom:12px;z-index:99999;display:none;font:13px/1.3 -apple-system,system-ui,sans-serif">
<button type="button" style="border:0;border-radius:999px;padding:9px 14px;background:#1d2a44;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer"></button></div>
<script>(function(){
// The download runs here, in the page, not in the service worker: iOS stops
// long-running service-worker work, so a 100 MB save started there can die
// silently. Keep this page open until it says "Saved".
if(!('serviceWorker' in navigator)||!('caches' in window))return;
var box=document.getElementById('pwa-offline'),btn=box.querySelector('button'),busy=false,CACHE='notes-offline',META='__offline_meta__';
function say(t){btn.textContent=t;box.style.display='block';}
function base(){return new URL('./',location.href).href;}
function list(){return fetch(base()+'sw.js',{cache:'no-cache'}).then(function(r){return r.text();}).then(function(t){return {v:JSON.parse(/const VERSION = (".*?");/.exec(t)[1]),files:JSON.parse(/const FILES = (\\[.*\\]);/.exec(t)[1])};});}
function meta(c){return c.match(base()+META).then(function(r){return r?r.json():{};});}
function status(){caches.open(CACHE).then(function(c){return meta(c).then(function(m){
  if(!navigator.onLine){say(m.complete?'✓ Saved offline':'Offline · not saved yet');return;}
  return list().then(function(L){
    if(m.complete&&m.version===L.v)say('✓ Saved offline · '+new Date(m.date).toLocaleDateString());
    else if(m.complete)say('⟳ Update offline copy');
    else if(m.version===L.v)say('⬇ Resume saving offline');
    else say('⬇ Save all notes offline');});});}).catch(function(){say('⬇ Save all notes offline');});}
function sync(){busy=true;say('Starting…');
  Promise.all([caches.open(CACHE),list()]).then(function(x){var c=x[0],L=x[1],B=base(),files=L.files,i=0,done=0,fail=0;
    return meta(c).then(function(m){var resume=m.version===L.v;
      return c.put(B+META,new Response(JSON.stringify({version:L.v,complete:false,date:Date.now()}))).then(function(){
        function next(){if(i>=files.length)return Promise.resolve();var u=new URL(files[i++],B).href;
          return (resume?c.match(u):Promise.resolve(null)).then(function(hit){if(hit)return;
            return fetch(u,{cache:'no-cache'}).then(function(r){if(r.ok)return c.put(u,r);fail++;});})
          .catch(function(){fail++;}).then(function(){done++;if(done%5===0||done===files.length)say('Saving offline… '+done+'/'+files.length+' · keep open');return next();});}
        return Promise.all([next(),next(),next(),next(),next(),next()]).then(function(){
          return fetch(B,{cache:'no-cache'}).then(function(r){if(r.ok)return c.put(B,r);}).catch(function(){});}).then(function(){
          var keep={};files.forEach(function(f){keep[new URL(f,B).href]=1;});keep[B]=1;keep[B+META]=1;
          return (fail?Promise.resolve():c.keys().then(function(ks){return Promise.all(ks.map(function(k){if(!keep[k.url.split('?')[0]])return c.delete(k);}));})).then(function(){
            return c.put(B+META,new Response(JSON.stringify({version:L.v,complete:!fail,date:Date.now()})));});}).then(function(){
          busy=false;say(fail?'Saved, '+fail+' failed · tap to retry':'✓ Saved offline · all '+files.length+' pages');});});});})
  .catch(function(){busy=false;say('Save failed · tap to retry');});}
btn.onclick=function(){if(busy)return;if(!navigator.onLine){say('Offline now · connect to save');return;}sync();};
navigator.serviceWorker.ready.then(status);
})();</script><!--/pwa-ui-->`;

if (mode === "stage") {
  let n = 0;
  for (const f of htmlFiles(root)) if (addHead(f)) n++;
  const home = path.join(root, "index.html");
  let s = fs.readFileSync(home, "utf8");
  if (!s.includes("<!--pwa-ui-->")) {
    const i = s.search(/<\/body>/i);
    s = i < 0 ? s + UI : s.slice(0, i) + UI + s.slice(i);
    fs.writeFileSync(home, s);
  }
  console.log("pwa: home-screen tags on " + n + " staged pages, offline button on the home page");
  process.exit(0);
}

// ---- out: service worker, manifest, icons, shell tags ----
let n = 0;
const files = [];
for (const f of htmlFiles(root)) {
  if (addHead(f)) n++;
  files.push(path.relative(root, f).split(path.sep).join("/"));
}
files.sort();
const h = crypto.createHash("sha256");
for (const f of files) h.update(f + "\0").update(fs.readFileSync(path.join(root, f)));
const version = h.digest("hex").slice(0, 16);

const SW = `// Offline cache for the encrypted notes. Generated by pwa.js; do not edit.
const VERSION = ${JSON.stringify(version)};
const FILES = ${JSON.stringify(files)};
const CACHE = "notes-offline";
const META = "__offline_meta__";
let busy = false, done = 0;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./index.html"])).catch(() => {}));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Serve from the cache at once; when online, refresh that page in the background.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok && !busy) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    return res || new Response("<p style='font:16px system-ui;padding:2em'>This page has not been saved offline yet. Connect once and tap “Save all notes offline” on the home page.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  })());
});

async function meta(c) { const r = await c.match(META); return r ? r.json() : {}; }

async function status() {
  const c = await caches.open(CACHE), m = await meta(c);
  return { type: "status", busy, done, total: FILES.length, complete: !!m.complete, current: m.version === VERSION, date: m.date };
}

async function sync(client) {
  if (busy) return;
  busy = true; done = 0;
  const c = await caches.open(CACHE), base = self.registration.scope, m = await meta(c);
  const resume = m.version === VERSION; // same build: keep what is already saved
  await c.put(META, new Response(JSON.stringify({ version: VERSION, complete: false, date: Date.now() })));
  let fail = 0, i = 0;
  const post = (msg) => client && client.postMessage(msg);
  async function worker() {
    while (i < FILES.length) {
      const url = new URL(FILES[i++], base).href;
      try {
        if (!(resume && (await c.match(url)))) {
          const res = await fetch(url, { cache: "no-cache" });
          if (res.ok) await c.put(url, res); else fail++;
        }
      } catch (_) { fail++; }
      done++;
      if (done % 10 === 0 || done === FILES.length) post({ type: "progress", done, total: FILES.length });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  try { const r = await fetch(base, { cache: "no-cache" }); if (r.ok) await c.put(base, r); } catch (_) {}
  if (!fail) {
    const keep = new Set(FILES.map((f) => new URL(f, base).href).concat([base, new URL(META, base).href]));
    for (const k of await c.keys()) if (!keep.has(k.url.split("?")[0])) await c.delete(k);
  }
  await c.put(META, new Response(JSON.stringify({ version: VERSION, complete: !fail, date: Date.now() })));
  busy = false;
  post({ type: "done", fail, total: FILES.length });
}

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "sync") e.waitUntil(sync(e.source));
  if (d.type === "status") e.waitUntil(status().then((s) => e.source && e.source.postMessage(s)));
});
`;
fs.writeFileSync(path.join(root, "sw.js"), SW);
fs.writeFileSync(path.join(root, "manifest.webmanifest"), JSON.stringify({
  name: "Notes", short_name: "Notes", start_url: "./index.html", scope: "./",
  display: "standalone", background_color: "#1d2a44", theme_color: "#1d2a44",
  icons: [{ src: "icon-180.png", sizes: "180x180", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
}, null, 2));
fs.writeFileSync(path.join(root, "icon-180.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAADd0lEQVR42u3cS2pTURzA4VPJtF1AoXPJLJOAE0ENDgMOpQtxDV2IdChkKFahk0ImmZWuIAuIG3DQEsvN40bTe8/r+400BtsmH+c+zr85uRhOgrStV14CwSE4BIfgEByCQ3AIDsEhOCQ4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcgkPqH8f9fOZV7qKf3791/SUGPfwYDR/D8dRbm6aGCDha1xJcEtEQH4elJU0KieKo00qCGjLAUaqV9DXkhyPfU5bsNGSPI+WlJXcNBeKIaKUwDeXj6M5K2RRqxHHMKUttGmrHsZ/LI5TKTQQbb4JDcAgOwSE4BIfgEByCQ4JDyeO4nt15M9b9up0HG2+tPj5P33BQO46tCK5ndyWJ2eXg3dsxHB2KSY1Ldg4KmefYdBB3gSnDQbHDPr0dkgp2UNck2C4xR/63pTpwn+PYA01VMtwEExyCQ3AIDsEhOASH4AjmOYJ5DvMc5jmCeQ77t+Y5ODDPYZ7Dlr15DjjMc7jPYZ7DyqGNzhdnjUeWoxUcTLT8U0Qlbp+nKOM/ngZHdTLi+nBYSfQMo/Gc88VZ/8cXK0dkGcvRauu7vvl4/+sHHJFl7H9+XB9wROvAw4SrFSehKZ6cGvZJcdlobOLEWjxSH/YJ5c77pDzmk8GwT+uikoWbRwSXp5P1I19//wi38/AvmzXL0Wp9QOntsnaQ727Zrk35KGj2LANPAhb5beANitxi7Wix2X8gKG/PdlDV1rx5DjhSnOc4/izB7XMFk2ByWAnuh3bYw9XfP7/+8sHKQcYuKDcPVzdwkLGPCBxk9OEDDsEhOGSeQ8E8RwgVfH4LHKHaeQ44zHM87eZfnsJhniO0D/XAYZ7jZXq+OfLiN8Jdymb8+RyNbbMudtHgyLKtFFLwAYfgEByCo6i2XpukcMECR4o+ErmUNUOa9Pph5ZBzDsEhOASHgnmOzhqOp8//ej+fedHhOMgKLnBYWuBgBQ5W4MjACi5wWFrgyNPK+4+fwo4PVIGjLisNClaOYq0cwqUqDeY5WrhUDiLYWwn9/p5Bpt8AHIKjjsXjZb/0ycVw4u0M+c+EdiESDjmsCA7BITgEh+AQHIJDcAgOCQ7BITgEh+AQHIJDcAgOwSHBITgEh+AQHIJDcAgOwSE4pPAH241wzMrOic4AAAAASUVORK5CYII=", "base64"));
fs.writeFileSync(path.join(root, "icon-512.png"), Buffer.from("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", "base64"));
console.log("pwa: sw.js (" + files.length + " pages, version " + version + "), manifest, icons; shell tags on " + n + " pages");
