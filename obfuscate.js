#!/usr/bin/env node
//
// Rename every directory and note file in a staged site tree to opaque tokens,
// and rewrite all internal links to match — so the published repo leaks no topic
// names in its paths. Runs on the STAGED copy (never your real notes), before
// staticrypt encrypts it.
//
// Tokens are derived through a memory-hard KDF so that even if a plaintext path
// and its token were ever seen together, the password can't be brute-forced at
// raw-hash speed:
//
//   key   = scrypt(STATICRYPT_PASSWORD, salt from .staticrypt.json, 32 bytes)
//   token = HMAC-SHA256(key, "path:" + sourceRelPath) truncated to 16 hex chars
//
// The scrypt salt is the same fixed salt StatiCrypt encrypts with, so tokens stay
// deterministic per password (a given password always yields the same tree) while
// each new password reshuffles every token. The password is never used directly
// as an HMAC key.
//
// Rules:
//   - "index.html" keeps its name (directory-default serving + the home link).
//   - other *.html  -> <token>.html
//   - directories   -> <token>
//   - assets (css/js/img/...) keep their names (generic), only their parent dir
//     segments get renamed; links to them are recomputed so they still resolve.
//
// Usage: STATICRYPT_PASSWORD=... node obfuscate.js <staging-dir>

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(process.argv[2] || ".");
const PASSWORD = process.env.STATICRYPT_PASSWORD;
if (!PASSWORD) { console.error("obfuscate: STATICRYPT_PASSWORD not set"); process.exit(1); }

// Read the fixed StatiCrypt salt (hex) and derive a memory-hard key from it.
// .staticrypt.json lives next to this script (repo root), not in the staged tree.
const saltHex = JSON.parse(
  fs.readFileSync(path.join(__dirname, ".staticrypt.json"), "utf8")
).salt;
if (!saltHex) { console.error("obfuscate: no salt in .staticrypt.json"); process.exit(1); }
const KEY = crypto.scryptSync(PASSWORD, Buffer.from(saltHex, "hex"), 32);

const TOKEN_LEN = 16; // hex chars = 64 bits, collision-safe for our file count
const token = (relPath) =>
  crypto.createHmac("sha256", KEY).update("path:" + relPath).digest("hex").slice(0, TOKEN_LEN);

// --- 1. Enumerate the tree (posix-style relative paths from ROOT). ---
const dirs = [];   // relative dir paths, excluding "."
const files = [];  // relative file paths
(function walk(abs, rel) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    const a = path.join(abs, e.name);
    if (e.isDirectory()) { dirs.push(r); walk(a, r); }
    else files.push(r);
  }
})(ROOT, "");

// --- 2. Build source->obfuscated maps (dirs shallow-first). ---
const dirMap = new Map(); // srcDirRel -> obfDirRel
dirs.sort((a, b) => a.split("/").length - b.split("/").length);
for (const d of dirs) {
  const parent = path.posix.dirname(d);
  const obfParent = parent === "." ? "" : dirMap.get(parent);
  const obfName = token(d);
  dirMap.set(d, obfParent ? obfParent + "/" + obfName : obfName);
}
const fileMap = new Map(); // srcFileRel -> obfFileRel
const isHtml = (n) => n.toLowerCase().endsWith(".html");
for (const f of files) {
  const dir = path.posix.dirname(f);
  const base = path.posix.basename(f);
  const obfDir = dir === "." ? "" : dirMap.get(dir);
  let obfBase;
  if (base === "index.html") obfBase = "index.html";
  else if (isHtml(base)) obfBase = token(f) + ".html";
  else obfBase = base; // asset: keep name
  fileMap.set(f, obfDir ? obfDir + "/" + obfBase : obfBase);
}

// Resolve a target source path (file or dir) to its obfuscated path.
function obfTarget(srcRel, wasDir) {
  if (wasDir) {
    if (srcRel === "." || srcRel === "") return "";
    return dirMap.get(srcRel);
  }
  return fileMap.get(srcRel);
}

// --- 3. Rewrite links inside every HTML file. ---
const ATTR = /((?:href|src)\s*=\s*")([^"]*)(")/gi;
let rewrites = 0, unresolved = 0;
for (const f of files) {
  if (!isHtml(f)) continue;
  const abs = path.join(ROOT, f);
  const srcDir = path.posix.dirname(f);
  let changed = false;
  let html = fs.readFileSync(abs, "utf8").replace(ATTR, (m, pre, val, post) => {
    // Skip externals, anchors, schemes.
    if (/^(https?:|\/\/|#|mailto:|data:|javascript:|tel:)/i.test(val)) return m;
    // Split off ?query / #fragment.
    const hashIdx = val.search(/[?#]/);
    const suffix = hashIdx === -1 ? "" : val.slice(hashIdx);
    let target = hashIdx === -1 ? val : val.slice(0, hashIdx);
    if (target === "") return m; // pure fragment/query

    const endsSlash = target.endsWith("/");
    // Resolve to a ROOT-relative posix path.
    let resolved;
    if (target.startsWith("/")) resolved = path.posix.normalize(target).replace(/^\/+/, "");
    else resolved = path.posix.normalize(path.posix.join(srcDir === "." ? "" : srcDir, target));
    resolved = resolved.replace(/\/$/, "");
    if (resolved === "" || resolved === ".") return m;

    const wasDir = endsSlash || dirMap.has(resolved);
    const obf = obfTarget(resolved, wasDir);
    if (obf === undefined) { unresolved++; return m; } // unknown target, leave as-is

    // Recompute a relative link from THIS file's new dir to the target's new path.
    const myNewDir = path.posix.dirname(fileMap.get(f));
    let rel = path.posix.relative(myNewDir === "." ? "" : myNewDir, obf);
    if (wasDir) rel += "/";
    if (rel === "") rel = wasDir ? "./" : "./" + path.posix.basename(obf);
    if (!rel.startsWith(".") && !rel.startsWith("/")) rel = "./" + rel;
    changed = true; rewrites++;
    return pre + rel + suffix + post;
  });
  if (changed) fs.writeFileSync(abs, html);
}

// --- 4. Physically move files/dirs to obfuscated paths (deepest-first). ---
// Write all files to their new locations, then remove now-empty old dirs.
const moves = files
  .map((f) => [f, fileMap.get(f)])
  .filter(([a, b]) => a !== b);
for (const [src, dst] of moves) {
  const dstAbs = path.join(ROOT, dst);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.renameSync(path.join(ROOT, src), dstAbs);
}
// Remove leftover empty source directories (deepest first).
for (const d of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
  const abs = path.join(ROOT, d);
  try { if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs); } catch {}
}

console.log(`obfuscate: ${files.length} files, ${dirs.length} dirs renamed; ${rewrites} links rewritten; ${unresolved} left as-is`);
