#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR="$ROOT_DIR/builds"
LOCAL_BUILD_ARTIFACT_RETENTION=2
MONKE_HOME=${MONKE_HOME:-"$HOME/.monke"}
INSTALLATION_LOCK="$MONKE_HOME/locks/installation.lock"
INSTALLATION_LOCK_HELD=false

release_installation_lock() {
  if [ "$INSTALLATION_LOCK_HELD" = true ]; then
    rm -f -- "$INSTALLATION_LOCK"
    INSTALLATION_LOCK_HELD=false
  fi
}

acquire_installation_lock() {
  mkdir -p "$(dirname -- "$INSTALLATION_LOCK")"
  attempts=0
  while [ "$attempts" -lt 100 ]; do
    if (
      set -C
      umask 077
      acquired_at=$(($(date +%s) * 1000))
      printf '{"acquiredAt":%s,"pid":%s}\n' "$acquired_at" "$$" >"$INSTALLATION_LOCK"
    ) 2>/dev/null; then
      INSTALLATION_LOCK_HELD=true
      return
    fi

    lock_pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$INSTALLATION_LOCK" 2>/dev/null || true)
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -f -- "$INSTALLATION_LOCK"
      attempts=$((attempts + 1))
      sleep 0.05
      continue
    fi

    attempts=$((attempts + 1))
    sleep 0.05
  done

  printf 'Timed out waiting for lock at %s\n' "$INSTALLATION_LOCK" >&2
  exit 1
}

cleanup_old_bun_builds() {
  ls -t "$BUILD_DIR"/.*.bun-build 2>/dev/null |
    sed "1,${LOCAL_BUILD_ARTIFACT_RETENTION}d" |
    while IFS= read -r old_build; do
      rm -f -- "$old_build"
    done
}

capture_source_state() {
  CAPTURED_SOURCE_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD)
  CAPTURED_SOURCE_STATUS=$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)
  captured_tracked_diff=$(git -C "$ROOT_DIR" diff --binary HEAD --)
  captured_untracked_files=$(git -C "$ROOT_DIR" ls-files --others --exclude-standard)
  captured_untracked_state=
  while IFS= read -r untracked_file; do
    if [ -n "$untracked_file" ]; then
      captured_untracked_state="$captured_untracked_state
$untracked_file
$(cksum "$ROOT_DIR/$untracked_file")"
    fi
  done <<EOF
$captured_untracked_files
EOF
  if [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$CAPTURED_SOURCE_COMMIT" ]; then
    return 1
  fi
  CAPTURED_SOURCE_SNAPSHOT=$(
    printf '%s\n%s\n%s\n%s\n' \
      "$CAPTURED_SOURCE_COMMIT" \
      "$CAPTURED_SOURCE_STATUS" \
      "$captured_tracked_diff" \
      "$captured_untracked_state" |
      cksum
  )
}

SYSTEM=$(uname -s | tr '[:upper:]' '[:lower:]')
MACHINE=$(uname -m)
case "$MACHINE" in
  x86_64) MACHINE=x64 ;;
  aarch64) MACHINE=arm64 ;;
esac
PLATFORM="$SYSTEM-$MACHINE"
CREATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

mkdir -p "$BUILD_DIR"
trap release_installation_lock 0
trap 'exit 1' 1 2 15
acquire_installation_lock

if ! capture_source_state; then
  printf 'Source checkout changed while Local provenance was being captured; rerun vp run install:local\n' >&2
  exit 1
fi
SOURCE_COMMIT=$CAPTURED_SOURCE_COMMIT
SOURCE_SNAPSHOT=$CAPTURED_SOURCE_SNAPSHOT
SHORT_COMMIT=$(printf '%.7s' "$SOURCE_COMMIT")
SOURCE_DIRTY=false
if [ -n "$CAPTURED_SOURCE_STATUS" ]; then
  SOURCE_DIRTY=true
fi
TOOL_BUILD_IDENTITY="local+$SHORT_COMMIT"
DIRTY_ARGUMENT=
if [ "$SOURCE_DIRTY" = true ]; then
  TOOL_BUILD_IDENTITY="$TOOL_BUILD_IDENTITY-dirty"
  DIRTY_ARGUMENT=--dirty
fi

mkdir -p "$MONKE_HOME/install-staging"
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

if ! capture_source_state ||
  [ "$CAPTURED_SOURCE_COMMIT" != "$SOURCE_COMMIT" ] ||
  [ "$CAPTURED_SOURCE_SNAPSHOT" != "$SOURCE_SNAPSHOT" ]; then
  printf 'Source checkout changed while the Local tool install was compiling; rerun vp run install:local\n' >&2
  exit 1
fi

"$STAGED_MT" activate-local-install \
  "$STAGED_INSTALL" \
  "$ROOT_DIR" \
  --install-id "$INSTALL_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --created-at "$CREATED_AT" \
  --platform "$PLATFORM" \
  ${DIRTY_ARGUMENT:+"$DIRTY_ARGUMENT"} \
  --installation-lock-held \
  "$@"
