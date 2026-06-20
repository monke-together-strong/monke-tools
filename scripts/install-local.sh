#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_DIR="$HOME/.local/bin"
BUILD_DIR="$ROOT_DIR/builds"
LOCAL_BUILD_ARTIFACT_RETENTION=2
TARGET_SHORT="$INSTALL_DIR/mt"
TARGET_FULL="$INSTALL_DIR/monke-tools"

cleanup_old_bun_builds() {
  ls -t "$BUILD_DIR"/.*.bun-build 2>/dev/null |
    sed "1,${LOCAL_BUILD_ARTIFACT_RETENTION}d" |
    while IFS= read -r old_build; do
      rm -f -- "$old_build"
    done
}

mkdir -p "$INSTALL_DIR" "$ROOT_DIR/dist" "$BUILD_DIR"

cd "$BUILD_DIR"
bun build --compile --outfile "$ROOT_DIR/dist/monke-tools" "$ROOT_DIR/src/index.ts"
cp "$ROOT_DIR/dist/monke-tools" "$TARGET_FULL"
printf '%s\n' '#!/bin/sh' 'exec "$(dirname "$0")/monke-tools" "$@"' > "$TARGET_SHORT"
chmod +x "$TARGET_FULL" "$TARGET_SHORT"
cleanup_old_bun_builds

"$TARGET_FULL" install-dependencies
printf 'Installed monke-tools to %s and %s\n' "$TARGET_FULL" "$TARGET_SHORT"
"$TARGET_FULL" skills local-install "$ROOT_DIR"
