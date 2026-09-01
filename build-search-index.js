#!/usr/bin/env node
//
// Build a full-text search index from the STAGED (already-obfuscated) site tree
// and inject it into the root index.html placeholder, BEFORE encryption. The
// index therefore ships encrypted inside index.html and is only usable after the
// reader unlocks the home page.
//
// Each entry: { u: obfuscated href, t: page title, s: subject (hierarchy), x: text }
//
// Usage: node build-search-index.js <staging-dir>

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || ".");

function walk(abs, rel, acc) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    const a = path.join(abs, e.name);
    if (e.isDirectory()) walk(a, r, acc);
    else if (e.name.toLowerCase().endsWith(".html")) acc.push(r);
  }
  return acc;
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
   .replace(/&mdash;/g, "—").replace(/&rarr;/g, "→").replace(/&hellip;/g, "…");

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, " ")   // drop <title>/meta boilerplate
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? stripTags(m[1]) : "";
}

function titleOf(html) {
  // Notes use <h2> as their heading (<h1> is reserved for subject index pages),
  // so fall back h1 -> h2 -> <title>.
  return (
    firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    firstMatch(html, /<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
    firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i).replace(/\s*[-–—·|:]\s*Vishnu Gandarapu.*$/i, "").replace(/\s+Notes$/i, "") ||
    "Untitled"
  );
}

const files = walk(ROOT, "", []);

// Subject (hierarchy) display name = the <h1> of each top-level directory's index.html.
const subjectName = {};
for (const f of files) {
  const parts = f.split("/");
  if (parts.length === 2 && parts[1] === "index.html") {
    subjectName[parts[0]] = titleOf(fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
}

const index = [];
for (const f of files) {
  if (f === "index.html") continue; // the search host page itself
  const parts = f.split("/");
  const topDir = parts.length > 1 ? parts[0] : "";
  const html = fs.readFileSync(path.join(ROOT, f), "utf8");
  const text = stripTags(html);
  if (!text) continue;
  const isSubjectIndex = parts.length === 2 && parts[1] === "index.html";
  const subject = subjectName[topDir] || topDir || "Notes";
  const title = isSubjectIndex ? "Overview" : titleOf(html);
  index.push({ u: f, t: title, s: subject, x: text });
}

// Inject into root index.html placeholder.
const idxPath = path.join(ROOT, "index.html");
let home = fs.readFileSync(idxPath, "utf8");
// JSON with "<" escaped so "</script>" can never appear inside the script block.
const json = JSON.stringify(index).replace(/</g, "\\u003c");
const replaced = home.replace(
  /(<script id="search-index" type="application\/json">)[\s\S]*?(<\/script>)/,
  (m, a, b) => a + json + b
);
if (replaced === home) {
  console.error("build-search-index: placeholder <script id=\"search-index\"> not found in index.html");
  process.exit(1);
}
fs.writeFileSync(idxPath, replaced);

const bytes = Buffer.byteLength(json, "utf8");
console.log(`search-index: ${index.length} pages indexed, ${(bytes / 1024 / 1024).toFixed(2)} MB embedded`);
