#!/usr/bin/env node
//
// Delete build/meta residue from a STAGED site tree, after obfuscate.js and
// before encryption. These files have no runtime purpose and several of them
// (topic maps, merge reports, source-filename tables) would leak the plaintext
// note structure if published — the very thing the encryption is meant to hide.
//
// Name-agnostic: matches by extension / basename only, so it keeps working after
// paths have been obfuscated to opaque tokens (and after a password rotation
// changes every token). It never inspects a real note name.
//
// Deleted:
//   - Markdown:            *.md            (README/MERGE_REPORT/RETIRE_LEARN/...)
//   - Dev scripts:         *.mjs           (link checkers, generators, serve)
//   - Python + bytecode:   *.py *.pyc, and every __pycache__/ directory
//   - Package/meta:        package.json, package-lock.json, requirements.txt
//   - Templates/samples:   *.example
//   - License notes:       *.txt           (third-party license text)
//
// Runtime assets (css/js/json/images) are intentionally NOT touched here;
// inline-assets.js folds the needed ones into the encrypted HTML and sweeps the
// rest.
//
// Usage: node strip-residue.js <staging-dir>

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || ".");
if (!fs.existsSync(ROOT)) { console.error(`strip-residue: no such dir ${ROOT}`); process.exit(1); }

const DROP_EXT = new Set([".md", ".mjs", ".py", ".pyc", ".example", ".txt"]);
const DROP_BASE = new Set(["package.json", "package-lock.json", "requirements.txt"]);

let removedFiles = 0, removedDirs = 0;

// Remove whole __pycache__ trees first (they only hold .pyc anyway).
(function pruneCache(abs) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const a = path.join(abs, e.name);
    if (e.name === "__pycache__") { fs.rmSync(a, { recursive: true, force: true }); removedDirs++; }
    else pruneCache(a);
  }
})(ROOT);

// Then drop residue files by extension / basename.
(function dropFiles(abs) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const a = path.join(abs, e.name);
    if (e.isDirectory()) { dropFiles(a); continue; }
    const ext = path.extname(e.name).toLowerCase();
    if (DROP_EXT.has(ext) || DROP_BASE.has(e.name)) { fs.rmSync(a); removedFiles++; }
  }
})(ROOT);

// Finally remove any directories left empty by the deletions (deepest-first).
(function pruneEmpty(abs) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(path.join(abs, e.name));
  }
  if (abs !== ROOT) {
    try { if (fs.readdirSync(abs).length === 0) { fs.rmdirSync(abs); removedDirs++; } } catch {}
  }
})(ROOT);

console.log(`strip-residue: removed ${removedFiles} residue files, ${removedDirs} directories`);
