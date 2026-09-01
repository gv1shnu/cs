#!/usr/bin/env node

// Convert StatiCrypt's persistent "Remember me" implementation into a
// browser-tab session. The stored value is a derived unlock key, not the raw
// password, and sessionStorage discards it when the tab's session ends.

const fs = require("fs");
const path = require("path");

const root = process.argv[2];

if (!root) {
  console.error("Usage: node sessionize-staticrypt.js <encrypted-output-dir>");
  process.exit(1);
}

function* htmlFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(fullPath);
    else if (entry.isFile() && entry.name.endsWith(".html")) yield fullPath;
  }
}

let converted = 0;

for (const file of htmlFiles(root)) {
  const original = fs.readFileSync(file, "utf8");
  if (!original.includes("staticryptInitiator")) continue;

  let updated = original
    .replace(
      /\b(?:window\.)?localStorage(?=\.(?:getItem|setItem|removeItem)\b)/g,
      "sessionStorage",
    )
    .replace(/isRememberEnabled = false/g, "isRememberEnabled = true")
    .replace(/"isRememberEnabled":false/g, '"isRememberEnabled":true')
    // Drop the "remember" checkbox entirely: session unlock is always on, so
    // there is nothing for the reader to opt into. Remove the label/checkbox
    // element, force the submit handler to always remember, and drop the code
    // that would have unhidden the (now absent) checkbox.
    .replace(
      /\s*<label id="staticrypt-remember-label"[\s\S]*?<\/label>/,
      "",
    )
    .replace(
      /isRememberChecked = document\.getElementById\("staticrypt-remember"\)\.checked;/,
      "isRememberChecked = true;",
    )
    .replace(
      /\s*\/\/ show the remember me checkbox\s*\n\s*if \(isRememberEnabled\) \{\s*\n\s*document\.getElementById\("staticrypt-remember-label"\)\.classList\.remove\("hidden"\);\s*\n\s*\}/,
      "",
    );

  const initMarker = "            // init the staticrypt engine";
  const cleanupMarker = "            // Remove persistent unlock data written by older builds.";
  if (!updated.includes(cleanupMarker)) {
    updated = updated.replace(
      initMarker,
      `${cleanupMarker}\n` +
        '            window["localStorage"].removeItem(templateConfig.rememberPassphraseKey);\n' +
        '            window["localStorage"].removeItem(templateConfig.rememberExpirationKey);\n\n' +
        initMarker,
    );
  }

  const checks = [
    [
      !/\b(?:window\.)?localStorage\.(?:getItem|setItem|removeItem)\b/.test(updated),
      "persistent localStorage access remains",
    ],
    [updated.includes("sessionStorage.setItem"), "sessionStorage writer is missing"],
    [updated.includes("sessionStorage.getItem"), "sessionStorage reader is missing"],
    [updated.includes("isRememberEnabled = true"), "remember feature is disabled"],
    [updated.includes('"isRememberEnabled":true'), "remember config is disabled"],
    [!updated.includes('id="staticrypt-remember"'), "remember checkbox was not removed"],
    [updated.includes("isRememberChecked = true;"), "session unlock is not forced on"],
    [updated.includes(cleanupMarker), "legacy persistent unlock cleanup is missing"],
  ];

  for (const [ok, message] of checks) {
    if (!ok) throw new Error(`${file}: ${message}`);
  }

  if (updated !== original) fs.writeFileSync(file, updated);
  converted += 1;
}

if (converted === 0) {
  throw new Error(`No StatiCrypt HTML files found under ${root}`);
}

console.log(`Session-only unlock enabled in ${converted} encrypted HTML files.`);
