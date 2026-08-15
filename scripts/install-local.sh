#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_DIR="$HOME/.local/bin"
BUILD_DIR="$ROOT_DIR/builds"
DIST_DIR="$ROOT_DIR/dist"
LOCAL_BUILD_ARTIFACT_RETENTION=2
TARGET_MT="$INSTALL_DIR/mt"
TARGET_MONKE="$INSTALL_DIR/monke"
REMOVED_TARGET="$INSTALL_DIR/monke-tools"

install_homebrew_dependencies() {
  if [ ! -f "$ROOT_DIR/Brewfile" ] || [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    return
  fi

  if ! command -v brew >/dev/null 2>&1; then
    printf '%s\n' 'Homebrew is required to install monke-tools developer dependencies' >&2
    exit 1
  fi

  if brew bundle check --file="$ROOT_DIR/Brewfile" >/dev/null 2>&1; then
    return
  fi

  printf '%s\n' 'Installing Homebrew dependencies...'
  brew bundle install --file="$ROOT_DIR/Brewfile"
}

install_wrapper() {
  target="$1"
  printf '%s\n' '#!/bin/sh' 'exec "$(dirname "$0")/mt" "$@"' > "$target"
  chmod +x "$target"
}

cleanup_old_bun_builds() {
  ls -t "$BUILD_DIR"/.*.bun-build 2>/dev/null |
    sed "1,${LOCAL_BUILD_ARTIFACT_RETENTION}d" |
    while IFS= read -r old_build; do
      rm -f -- "$old_build"
    done
}

install_homebrew_dependencies
mkdir -p "$INSTALL_DIR" "$DIST_DIR" "$BUILD_DIR"

cd "$BUILD_DIR"
bun build --compile --outfile "$DIST_DIR/mt" "$ROOT_DIR/src/index.ts"
rm -f -- "$DIST_DIR/monke-tools" "$DIST_DIR/monke"
cp "$DIST_DIR/mt" "$TARGET_MT"
install_wrapper "$TARGET_MONKE"
chmod +x "$TARGET_MT"
rm -f -- "$REMOVED_TARGET"
cleanup_old_bun_builds

"$TARGET_MT" install-dependencies
printf 'Installed mt and monke to %s and %s\n' "$TARGET_MT" "$TARGET_MONKE"
MONKE_TOOLS_BINARY="$TARGET_MT" "$TARGET_MT" shell install
"$TARGET_MT" skills local-install "$ROOT_DIR" "$@"
