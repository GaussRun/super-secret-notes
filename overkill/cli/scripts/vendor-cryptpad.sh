#!/usr/bin/env bash
# Fetches the CryptPad client modules the experimental cryptpad backend reuses.
# Pinned to one upstream commit. The files are AGPL-3.0-or-later and committed; see THIRD_PARTY.md.
set -euo pipefail
COMMIT=9808cf25c1091d6cf532df13bf5a70ba332f8d4d
BASE="https://raw.githubusercontent.com/cryptpad/cryptpad/$COMMIT/src/common"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/backends/cryptpad/vendor/cryptpad"
mkdir -p "$DEST/outer"
printf '{ "type": "commonjs" }\n' > "$DEST/package.json"
for f in common-util.js common-hash.js common-signing-keys.js common-realtime.js \
         pinpad.js rpc.js outer/login-block.js outer/http-command.js; do
  curl -fsSL "$BASE/$f" -o "$DEST/$f"
  echo "fetched $f"
done
