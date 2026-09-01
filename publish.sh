#!/usr/bin/env bash
#
# One-step publish: encrypt -> verify -> commit -> push.
# Commit messages are sequential: "commit #1", "commit #2", ...
# Pushing is a normal (fast-forward) push; this script never force-pushes.
#
# Usage:
#   STATICRYPT_PASSWORD='your-strong-passphrase' ./publish.sh
#
# Set PUBLISH_NO_PUSH=1 to build+commit but skip the push.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

: "${STATICRYPT_PASSWORD:?Set STATICRYPT_PASSWORD to the site password before publishing}"

# 1. Encrypt the notes into docs/.
./build.sh

# 2. Verification gate: abort BEFORE touching git if anything would leak.
if ! ./verify.sh "$ROOT/docs"; then
  echo "publish: verification failed — nothing committed." >&2
  exit 1
fi

# 3. Stage everything (the gitignore guarantees only ciphertext + tooling stage).
git add -A

# Nothing changed since last publish? Stop cleanly.
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

# 4. Sequential commit message based on the number of the commit being created.
#    existing commits + 1  (0 if this is the very first commit).
existing="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
n=$(( existing + 1 ))
git commit -m "commit #${n}"
echo "Committed: commit #${n}"

# 5. Push (unless told not to).
if [ "${PUBLISH_NO_PUSH:-0}" = "1" ]; then
  echo "PUBLISH_NO_PUSH set — skipping push."
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD)"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No 'origin' remote yet. Add it, then re-run ./publish.sh (commit #${n} is already made):"
  echo "  git remote add origin git@github.com:<you>/<repo>.git"
  exit 1
fi

if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push                       # upstream already set
else
  git push -u origin "$branch"   # first push: set upstream
fi
echo "Pushed commit #${n}."
