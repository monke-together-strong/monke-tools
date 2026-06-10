#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_DIR="$HOME/.local/bin"
TARGET_SHORT="$INSTALL_DIR/mt"
TARGET_FULL="$INSTALL_DIR/monke-tools"

mkdir -p "$INSTALL_DIR" "$ROOT_DIR/dist"

cd "$ROOT_DIR"
bun build --compile --outfile "$ROOT_DIR/dist/monke-tools" ./src/index.ts
cp "$ROOT_DIR/dist/monke-tools" "$TARGET_FULL"
printf '%s\n' '#!/bin/sh' 'exec "$(dirname "$0")/monke-tools" "$@"' > "$TARGET_SHORT"
chmod +x "$TARGET_FULL" "$TARGET_SHORT"

"$TARGET_FULL" install-dependencies
printf 'Installed monke-tools to %s and %s\n' "$TARGET_FULL" "$TARGET_SHORT"
"$TARGET_FULL" skills local-install "$ROOT_DIR"
