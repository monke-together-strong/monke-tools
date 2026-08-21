#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR="$ROOT_DIR/builds"
LOCAL_BUILD_ARTIFACT_RETENTION=2
MONKE_HOME=${MONKE_HOME:-"$HOME/.monke"}

cleanup_old_bun_builds() {
  ls -t "$BUILD_DIR"/.*.bun-build 2>/dev/null |
    sed "1,${LOCAL_BUILD_ARTIFACT_RETENTION}d" |
    while IFS= read -r old_build; do
      rm -f -- "$old_build"
    done
}

SOURCE_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD)
SHORT_COMMIT=$(git -C "$ROOT_DIR" rev-parse --short=7 HEAD)
SOURCE_DIRTY=false
if [ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ]; then
  SOURCE_DIRTY=true
fi
TOOL_BUILD_IDENTITY="local+$SHORT_COMMIT"
DIRTY_ARGUMENT=
if [ "$SOURCE_DIRTY" = true ]; then
  TOOL_BUILD_IDENTITY="$TOOL_BUILD_IDENTITY-dirty"
  DIRTY_ARGUMENT=--dirty
fi

SYSTEM=$(uname -s | tr '[:upper:]' '[:lower:]')
MACHINE=$(uname -m)
case "$MACHINE" in
  x86_64) MACHINE=x64 ;;
  aarch64) MACHINE=arm64 ;;
esac
PLATFORM="$SYSTEM-$MACHINE"
CREATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

mkdir -p "$MONKE_HOME/install-staging" "$BUILD_DIR"
STAGED_INSTALL=$(mktemp -d "$MONKE_HOME/install-staging/local-$SHORT_COMMIT-XXXXXX")
INSTALL_ID=$(basename "$STAGED_INSTALL")
STAGED_MT="$STAGED_INSTALL/mt"

cd "$BUILD_DIR"
bun build --compile \
  --define "process.env.MONKE_TOOLS_BUILD_IDENTITY=\"$TOOL_BUILD_IDENTITY\"" \
  --outfile "$STAGED_MT" \
  "$ROOT_DIR/src/index.ts"
chmod +x "$STAGED_MT"
cleanup_old_bun_builds

"$STAGED_MT" activate-local-install \
  "$STAGED_INSTALL" \
  "$ROOT_DIR" \
  --install-id "$INSTALL_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --created-at "$CREATED_AT" \
  --platform "$PLATFORM" \
  ${DIRTY_ARGUMENT:+"$DIRTY_ARGUMENT"} \
  "$@"
