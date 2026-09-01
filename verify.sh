#!/usr/bin/env bash
#
# Publish gate: assert that a built docs/ tree leaks nothing in cleartext.
# Exits non-zero (and prints every failure) if any check fails, so publish.sh
# aborts before committing. Reads no secrets and prints none.
# Written for portability (works on bash 3.2, macOS default).
#
# Usage: ./verify.sh [docs-dir]   (default: ./docs)

set -uo pipefail

DIR="${1:-$(cd "$(dirname "$0")" && pwd)/docs}"
[ -d "$DIR" ] || { echo "verify: no such dir: $DIR" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILLOG="$TMP/fail"
: > "$FAILLOG"
note() { echo "FAIL[$1] $2" >> "$FAILLOG"; }

# Plaintext "shell" of a page = the file with long base64/hex ciphertext runs
# removed, so fragment/secret greps can't false-positive on random ciphertext.
shell() { perl -0pe 's/[A-Za-z0-9+\/=]{200,}/ /g' "$1"; }

# --- 1. Only *.html or .nojekyll may exist. ---
find "$DIR" -type f ! -name '*.html' ! -name '.nojekyll' > "$TMP/other" || true
if [ -s "$TMP/other" ]; then
  note 1 "non-HTML files present in docs/ ($(wc -l < "$TMP/other" | tr -d ' ')):"
  sed 's/^/        /' "$TMP/other" >> "$FAILLOG"
fi

FRAGMENTS='sec/|-introduction|privilege-escalation|MERGE_REPORT|RETIRE_LEARN|content-map|taxonomy|__pycache__|requirements\.txt|\.mjs|conceptId|/learn/'
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
KEYHDR='BEGIN [A-Z ]*PRIVATE KEY'
CRED='(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']'

count=0
find "$DIR" -type f -name '*.html' -print0 > "$TMP/html0"
while IFS= read -r -d '' f; do
  count=$((count + 1))
  rel="${f#$DIR/}"

  # --- 2. StatiCrypt payload present. ---
  grep -q 'staticryptEncryptedMsgUniqueVariableName' "$f" || note 2 "no StatiCrypt payload: $rel"

  # --- 3. Neutral outer metadata (ciphertext has no '<', so whole-file is safe). ---
  grep -oE '<title[^>]*>[^<]*</title>' "$f" | sed -E 's/<[^>]+>//g' > "$TMP/titles" || true
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    [ "$t" = "Private notes" ] || note 3 "unexpected <title> '$t': $rel"
  done < "$TMP/titles"
  grep -qiE '<meta[^>]*name="description"' "$f" && note 3 "meta description present: $rel"
  grep -qiE '<meta[^>]*(property|name)="(og|twitter):' "$f" && note 3 "OpenGraph/Twitter tag present: $rel"

  # --- 4 & 5. Fragment / secret scan over the ciphertext-stripped shell. ---
  shell "$f" > "$TMP/sh"
  if grep -qiE "$FRAGMENTS" "$TMP/sh"; then
    note 4 "source fragment in cleartext: $rel"
    grep -noiE "$FRAGMENTS" "$TMP/sh" | head -3 | sed 's/^/        /' >> "$FAILLOG"
  fi
  grep -qE  "$EMAIL"  "$TMP/sh" && note 5 "email in cleartext: $rel"
  grep -qE  "$KEYHDR" "$TMP/sh" && note 5 "private key header in cleartext: $rel"
  grep -qiE "$CRED"   "$TMP/sh" && note 5 "credential assignment in cleartext: $rel"
done < "$TMP/html0"

if [ -s "$FAILLOG" ]; then
  cat "$FAILLOG"
  echo "verify: FAILED — do not publish." >&2
  exit 1
fi
echo "verify: OK — $count encrypted pages, no cleartext leaks."
