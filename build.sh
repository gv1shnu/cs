#!/usr/bin/env bash
#
# Encrypt the entire notes site locally and write ONLY ciphertext into docs/,
# which is the sole thing this repo commits. Plaintext notes live in this
# working directory but are gitignored and never pushed to GitHub.
#
#   - Every .html page's CONTENT is AES-256 encrypted (via staticrypt).
#   - Other assets (css/js/images/...) are copied through as-is.
#   - A fixed salt (.staticrypt.json) is shared by every page, so a reader
#     unlocks once per browser tab and can browse all pages in that tab.
#   - The derived unlock key lives only in sessionStorage and is discarded when
#     the tab's browser session ends.
#
# Usage:
#   STATICRYPT_PASSWORD='your-strong-passphrase' ./build.sh
#   git add docs && git commit -m "publish" && git push
#
# Preview before committing:
#   python3 -m http.server -d docs 8000   # open http://localhost:8000

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STAGE="$ROOT/.enc-build/site"
ENCOUT="$ROOT/.enc-build/out/site"
PUBLISH="$ROOT/docs"

# Where the plaintext notes live. Auto-detected so a plain
# `STATICRYPT_PASSWORD=... ./publish.sh` just works:
#   - normal setup: gitignored plaintext (with its index.html home page) at the
#     repo root -> build from the root;
#   - otherwise, if a recovered backup exists (e.g. after ./decrypt.sh), build
#     from .plaintext-restore/docs automatically.
# Set SITE_SRC to force a specific source; you shouldn't normally need to.
RESTORE="$ROOT/.plaintext-restore/docs"
if [ -n "${SITE_SRC:-}" ]; then
  SRC="$(cd "$SITE_SRC" && pwd)"
elif [ -f "$ROOT/index.html" ]; then
  SRC="$ROOT"
elif [ -f "$RESTORE/index.html" ]; then
  SRC="$RESTORE"
  echo "build: no notes at repo root — building from recovered plaintext (.plaintext-restore/docs)."
else
  SRC="$ROOT"   # nothing usable; the empty-stage guard below reports it clearly
fi

: "${STATICRYPT_PASSWORD:?Set STATICRYPT_PASSWORD to the site password before building}"

rm -rf "$ROOT/.enc-build"
mkdir -p "$STAGE"

# Stage the plaintext site, excluding VCS / build / tooling / the output itself.
# Every tooling and meta file at the repo root is excluded by name so it can
# never be staged, obfuscated, and shipped as a cleartext artifact. (strip-residue
# and inline-assets are a second line of defence for anything nested in the notes.)
rsync -a \
  --exclude '.git' \
  --exclude '.enc-build' \
  --exclude 'docs' \
  --exclude 'node_modules' \
  --exclude '.plaintext-restore' \
  --exclude '.DS_Store' \
  --exclude '.staticrypt.json' \
  --exclude '.gitignore' \
  --exclude 'build.sh' \
  --exclude 'publish.sh' \
  --exclude 'verify.sh' \
  --exclude 'decrypt.sh' \
  --exclude 'obfuscate.js' \
  --exclude 'build-search-index.js' \
  --exclude 'strip-residue.js' \
  --exclude 'inline-assets.js' \
  --exclude 'sessionize-staticrypt.js' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  --exclude 'README.md' \
  --exclude 'index.md' \
  --exclude 'LICENSE' \
  --exclude 'ENCRYPTION.md' \
  "$SRC/./" "$STAGE/"

# Fail loudly if the source produced nothing to publish. The home page must exist
# (build-search-index injects the index into it); without it the pipeline would
# otherwise crash deep inside with a cryptic ENOENT.
if [ ! -f "$STAGE/index.html" ]; then
  echo "build: staged tree has no index.html — nothing to encrypt." >&2
  echo "       Source was: $SRC" >&2
  echo "       Point SITE_SRC at your plaintext notes (they must contain index.html)," >&2
  echo "       e.g. after ./decrypt.sh:  SITE_SRC=.plaintext-restore/docs ./build.sh" >&2
  exit 1
fi

# Obfuscate paths on the staged copy: rename dirs/files to opaque tokens and
# rewrite internal links, so the published repo leaks no topic names.
node "$ROOT/obfuscate.js" "$STAGE"

# Build the full-text search index from the (obfuscated) pages and inject it into
# the home page, before encryption — so the index ships encrypted too.
node "$ROOT/build-search-index.js" "$STAGE"

# Drop build/meta residue (topic maps, reports, dev scripts, bytecode, licenses)
# so it is never encrypted-and-shipped or, worse, shipped in cleartext.
node "$ROOT/strip-residue.js" "$STAGE"

# Fold every remaining runtime asset (css/js/images) INTO the HTML that uses it,
# then sweep the leftover non-HTML files. After this, the staged tree is HTML only,
# so staticrypt encrypts 100% of the site's real content.
node "$ROOT/inline-assets.js" "$STAGE"

# Encrypt. staticrypt reads the fixed salt from .staticrypt.json and the password
# from $STATICRYPT_PASSWORD. Output nests under the input basename ("site").
cd "$ROOT"
npx --yes staticrypt@3 .enc-build/site -r -d .enc-build/out \
    --config .staticrypt.json \
    --remember 0 \
    --short \
    --template-title "Private notes" \
    --template-instructions "These notes are encrypted. Enter the password to read them." \
    --template-remember "Keep unlocked for this tab"

# StatiCrypt's remember feature uses persistent localStorage. Convert the public
# password wrapper to sessionStorage, make session unlock unconditional, and drop
# the (now redundant) checkbox from the prompt.
node "$ROOT/sessionize-staticrypt.js" "$ENCOUT"

# Replace docs/ with the freshly encrypted site (--delete prunes stale pages).
mkdir -p "$PUBLISH"
rsync -a --delete --exclude '.git' "$ENCOUT/" "$PUBLISH/"
touch "$PUBLISH/.nojekyll"

echo "Built encrypted site -> $PUBLISH  (commit the docs/ folder)"
