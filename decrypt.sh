#!/usr/bin/env bash
#
# Recover plaintext notes from the encrypted docs/ folder using the password.
# Because docs/ is fully decryptable with the password + salt, this repo doubles
# as an encrypted backup: clone it anywhere and restore your notes with this.
#
# Usage:
#   STATICRYPT_PASSWORD='your-strong-passphrase' ./decrypt.sh [output-dir]
#
# Default output: .plaintext-restore/  (gitignored)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$ROOT/.plaintext-restore}"

: "${STATICRYPT_PASSWORD:?Set STATICRYPT_PASSWORD to recover plaintext}"

rm -rf "$OUT"
cd "$ROOT"
npx --yes staticrypt@3 docs --decrypt -r -d "$OUT" --config .staticrypt.json

echo "Restored plaintext -> $OUT/docs"
