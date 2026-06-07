#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_DIR="$HOME/.local/bin"
TARGET_SHORT="$INSTALL_DIR/mt"
TARGET_FULL="$INSTALL_DIR/monke-tools"

if ! command -v npm >/dev/null 2>&1; then
  printf 'Expected npm on PATH so monke-tools can create an Intent discovery link\n' >&2
  exit 1
fi

link_intent_package_root() {
  global_root=$1
  label=$2
  target="$global_root/monke-tools"

  mkdir -p "$global_root"

  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    printf 'Skipping %s Intent discovery link because %s already exists and is not a symlink\n' "$label" "$target" >&2
    return
  fi

  ln -s "$ROOT_DIR" "$target"
  printf 'Linked monke-tools for %s Intent discovery at %s\n' "$label" "$target"
}

mkdir -p "$INSTALL_DIR" "$ROOT_DIR/dist"

cd "$ROOT_DIR"
bun build --compile --outfile "$ROOT_DIR/dist/monke-tools" ./src/index.ts
cp "$ROOT_DIR/dist/monke-tools" "$TARGET_FULL"
cp "$ROOT_DIR/dist/monke-tools" "$TARGET_SHORT"
chmod +x "$TARGET_FULL" "$TARGET_SHORT"
npm link --silent

NPM_GLOBAL_ROOT=$(npm root -g)
PNPM_GLOBAL_ROOT=""
if command -v pnpm >/dev/null 2>&1; then
  PNPM_GLOBAL_ROOT=$(pnpm root -g 2>/dev/null || true)
fi

printf 'Installed monke-tools to %s and %s\n' "$TARGET_FULL" "$TARGET_SHORT"
printf 'Linked monke-tools for npm Intent discovery at %s/monke-tools\n' "$NPM_GLOBAL_ROOT"
if [ -n "$PNPM_GLOBAL_ROOT" ]; then
  link_intent_package_root "$PNPM_GLOBAL_ROOT" "pnpm"
fi
printf 'Verify from a consumer repo with: bunx @tanstack/intent@latest load monke-tools#core --global\n'
