#!/usr/bin/env node
//
// Fold every runtime asset into the HTML that uses it, so that after StatiCrypt
// encrypts the *.html the asset content lives INSIDE the ciphertext. Runs on the
// STAGED tree after obfuscate.js + strip-residue.js and before encryption.
//
// Transforms, per page:
//   <link rel="stylesheet" href="LOCAL">  -> <style>...</style>
//   <script src="LOCAL"> (classic)        -> <script>...</script>
//   <img src="LOCAL">                     -> src="data:MIME;base64,..."
//   any other src/href to a LOCAL image   -> data: URI
// External refs (http(s):, //, data:, #, mailto:, tel:, blob:) are left alone.
//
// Retired single-page-app shells: a page whose only script is
// <script type="module" src="LOCAL"> renders nothing without its (deleted)
// module graph. Such pages are rebuilt as a static index that links their
// sibling note pages, so the section still navigates after unlock.
//
// Finally: every non-HTML file that remains is swept. Anything runtime-required
// was copied into a page above; anything left is an orphan (deleted SPA modules,
// data JSON, the now-inlined originals) and must not ship in cleartext.
//
// Usage: node inline-assets.js <staging-dir>

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || ".");
if (!fs.existsSync(ROOT)) { console.error(`inline-assets: no such dir ${ROOT}`); process.exit(1); }

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bmp": "image/bmp", ".avif": "image/avif",
};
const isExternal = (v) => /^(https?:|\/\/|data:|#|mailto:|tel:|javascript:|blob:)/i.test(v);
const isHtml = (n) => n.toLowerCase().endsWith(".html");

// --- enumerate ---
const htmlFiles = [];
(function walk(abs, rel) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    const a = path.join(abs, e.name);
    if (e.isDirectory()) walk(a, r);
    else if (isHtml(e.name)) htmlFiles.push(r);
  }
})(ROOT, "");

// Resolve a page-relative href/src to an absolute staged path (or null).
function resolveLocal(pageRel, ref) {
  const q = ref.search(/[?#]/);
  const clean = q === -1 ? ref : ref.slice(0, q);
  if (!clean) return null;
  const pageDir = path.posix.dirname(pageRel);
  const rel = path.posix.normalize(
    clean.startsWith("/") ? clean.replace(/^\/+/, "")
      : path.posix.join(pageDir === "." ? "" : pageDir, clean)
  );
  if (rel.startsWith("..")) return null;
  return path.join(ROOT, rel);
}

const consumed = new Set();       // abs paths folded into some page
const moduleHosts = [];           // page rels that only load a (deleted) ES module
let styles = 0, scripts = 0, images = 0, unresolved = 0;

function readAsset(abs) {
  try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; } catch {}
  return null;
}

for (const f of htmlFiles) {
  let html = fs.readFileSync(path.join(ROOT, f), "utf8");
  let changed = false;
  let hasModule = false;   // this page loads a local ES module (retired SPA shell)

  // 1. Stylesheets: <link ... rel="stylesheet" ... href="LOCAL" ...> -> <style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) return tag;
    const m = tag.match(/href\s*=\s*"([^"]*)"/i);
    if (!m || isExternal(m[1])) return tag;
    const abs = resolveLocal(f, m[1]);
    if (!abs || !readAsset(abs)) { unresolved++; return tag; }
    const css = fs.readFileSync(abs, "utf8");
    consumed.add(abs); styles++; changed = true;
    return `<style>\n${css}\n</style>`;
  });

  // 2. Scripts: <script ... src="LOCAL" ...></script>
  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs) => {
    const m = attrs.match(/src\s*=\s*"([^"]*)"/i);
    if (!m) return tag;
    if (isExternal(m[1])) return tag;
    const isModule = /type\s*=\s*["']module["']/i.test(attrs);
    const abs = resolveLocal(f, m[1]);
    if (!abs || !readAsset(abs)) {
      if (isModule) hasModule = true;   // module whose target is gone -> shell
      else unresolved++;
      return tag;
    }
    if (isModule) {
      // A local ES module: its import graph can't be inlined as one <script> and
      // is being retired. Mark the page for rebuild; drop the dead tag.
      hasModule = true; consumed.add(abs); changed = true;
      return "";
    }
    const js = fs.readFileSync(abs, "utf8");
    consumed.add(abs); scripts++; changed = true;
    // Preserve non-src attributes (e.g. defer) except src/type=module.
    const keep = attrs.replace(/\s*src\s*=\s*"[^"]*"/i, "");
    return `<script${keep}>\n${js}\n</script>`;
  });

  // 3. Images and any other local-asset src/href -> data: URI.
  html = html.replace(/\b(src|href)\s*=\s*"([^"]*)"/gi, (m, attr, val) => {
    if (isExternal(val)) return m;
    const ext = path.extname(val.split(/[?#]/)[0]).toLowerCase();
    if (!MIME[ext]) return m;               // only embed known media types
    const abs = resolveLocal(f, val);
    if (!abs || !readAsset(abs)) { unresolved++; return m; }
    const b64 = fs.readFileSync(abs).toString("base64");
    consumed.add(abs); images++; changed = true;
    return `${attr}="data:${MIME[ext]};base64,${b64}"`;
  });

  // A page that loaded a local ES module is a retired single-page-app shell:
  // its body is rendered entirely by the (now-deleted) module graph, so it is
  // rebuilt below as a static index. (Verified: app.js is the only local module
  // in this codebase, so this never catches a real content page.)
  if (hasModule) moduleHosts.push(f);
  if (changed) fs.writeFileSync(path.join(ROOT, f), html);
}

// --- Rebuild retired module-host shells as a static sibling index. ---
function titleOf(html) {
  const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  for (const re of [/<h1[^>]*>([\s\S]*?)<\/h1>/i, /<h2[^>]*>([\s\S]*?)<\/h2>/i, /<title[^>]*>([\s\S]*?)<\/title>/i]) {
    const m = html.match(re); if (m && strip(m[1])) return strip(m[1]);
  }
  return null;
}
let rebuilt = 0;
for (const host of moduleHosts) {
  const hostDir = path.posix.dirname(host);
  const hostAbs = path.join(ROOT, host);
  // Sibling note pages under the same section, excluding other shells + self.
  const links = htmlFiles
    .filter((g) => g !== host && !moduleHosts.includes(g) &&
      (hostDir === "." ? !g.includes("/") : g.startsWith(hostDir + "/")))
    .map((g) => {
      const t = titleOf(fs.readFileSync(path.join(ROOT, g), "utf8")) ||
        path.posix.basename(g).replace(/\.html$/i, "");
      const rel = path.posix.relative(hostDir === "." ? "" : hostDir, g);
      return { rel, t };
    })
    .sort((a, b) => a.t.localeCompare(b.t));

  // Titles come from page HTML and already carry proper entities; only guard the
  // structural characters so we never double-encode an existing "&amp;".
  const esc = (s) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = links.map((l) =>
    `      <li><a href="./${l.rel.replace(/"/g, "%22")}">${esc(l.t)}</a></li>`).join("\n");

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notes</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.6;}
    h1{font-size:1.6rem;} ul{list-style:none;padding:0;} li{margin:.35rem 0;}
    a{color:#2563eb;text-decoration:none;} a:hover{text-decoration:underline;}
    .back{display:inline-block;margin-bottom:1rem;color:#666;}
  </style>
</head>
<body>
  <a class="back" href="../index.html">&larr; Notes</a>
  <h1>Section index</h1>
  <ul>
${items}
  </ul>
</body>
</html>
`;
  fs.writeFileSync(hostAbs, page);
  rebuilt++;
}

// --- Sweep: delete every remaining non-HTML file (orphans + inlined originals). ---
let swept = 0;
(function sweep(abs) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const a = path.join(abs, e.name);
    if (e.isDirectory()) { sweep(a); continue; }
    if (e.name === ".nojekyll") continue;   // Pages marker; kept as-is.
    if (!isHtml(e.name)) { fs.rmSync(a); swept++; }
  }
})(ROOT);
// Remove directories emptied by the sweep (deepest-first).
(function pruneEmpty(abs) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(path.join(abs, e.name));
  }
  if (abs !== ROOT) { try { if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs); } catch {} }
})(ROOT);

console.log(
  `inline-assets: ${styles} stylesheets, ${scripts} scripts, ${images} images inlined; ` +
  `${rebuilt} shells rebuilt; ${swept} non-HTML files swept; ${unresolved} refs left as-is`
);
