#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR="$ROOT_DIR/builds"
LOCAL_BUILD_ARTIFACT_RETENTION=2
MONKE_HOME=${MONKE_HOME:-"$HOME/.monke"}
INSTALLATION_LOCK="$MONKE_HOME/locks/installation.lock"
INSTALLATION_LOCK_RECLAIM="$INSTALLATION_LOCK.reclaim"
INSTALLATION_LOCK_HELD=false
INSTALLATION_LOCK_RECLAIM_HELD=false

release_installation_lock() {
  if [ "$INSTALLATION_LOCK_HELD" = true ]; then
    rm -f -- "$INSTALLATION_LOCK"
    INSTALLATION_LOCK_HELD=false
  fi
  if [ "$INSTALLATION_LOCK_RECLAIM_HELD" = true ]; then
    rmdir -- "$INSTALLATION_LOCK_RECLAIM"
    INSTALLATION_LOCK_RECLAIM_HELD=false
  fi
}

reclaim_stale_installation_lock() {
  if ! mkdir "$INSTALLATION_LOCK_RECLAIM" 2>/dev/null; then
    return
  fi
  INSTALLATION_LOCK_RECLAIM_HELD=true

  lock_pid=$(sed -n 's/^[[:space:]]*{"acquiredAt":[0-9][0-9]*,"pid":\([1-9][0-9]*\)}[[:space:]]*$/\1/p' "$INSTALLATION_LOCK" 2>/dev/null || true)
  if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f -- "$INSTALLATION_LOCK"
  fi

  rmdir -- "$INSTALLATION_LOCK_RECLAIM"
  INSTALLATION_LOCK_RECLAIM_HELD=false
}

acquire_installation_lock() {
  mkdir -p "$(dirname -- "$INSTALLATION_LOCK")"
  attempts=0
  while [ "$attempts" -lt 100 ]; do
    if [ ! -e "$INSTALLATION_LOCK_RECLAIM" ] && (
      set -C
      umask 077
      acquired_at=$(($(date +%s) * 1000))
      printf '{"acquiredAt":%s,"pid":%s}\n' "$acquired_at" "$$" >"$INSTALLATION_LOCK"
    ) 2>/dev/null; then
      INSTALLATION_LOCK_HELD=true
      return
    fi

    reclaim_stale_installation_lock

    attempts=$((attempts + 1))
    sleep 0.05
  done

  printf 'Timed out waiting for the installation lock at %s. Wait for the other installation to finish and retry.\n' "$INSTALLATION_LOCK" >&2
  printf 'If no installation is running, remove the stale lock or its .reclaim marker and retry.\n' >&2
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
  # NUL-separated names reach cksum unquoted, and `./` keeps names such as `-` from reading as options.
  captured_untracked_state=$(
    cd "$ROOT_DIR" &&
      git ls-files --others --exclude-standard -z |
      xargs -0 sh -c 'for file do cksum "./$file"; done' sh
  )
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

if [ -f "$ROOT_DIR/monke.yml" ]; then
  (cd "$ROOT_DIR" && bun run src/index.ts skills restore --repo)
fi

if ! capture_source_state; then
  printf 'Source checkout changed while the installer was reading its Git state. Rerun vpr install:local.\n' >&2
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
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --define "process.env.MONKE_TOOLS_BUILD_IDENTITY=\"$TOOL_BUILD_IDENTITY\"" \
  --outfile "$STAGED_MT" \
  "$ROOT_DIR/src/index.ts"
chmod +x "$STAGED_MT"
cleanup_old_bun_builds

# The Git snapshot excludes generated imports, so restore the pinned copies again before activation.
if [ -f "$ROOT_DIR/monke.yml" ]; then
  (cd "$ROOT_DIR" && bun run src/index.ts skills restore --repo)
fi

if ! capture_source_state ||
  [ "$CAPTURED_SOURCE_COMMIT" != "$SOURCE_COMMIT" ] ||
  [ "$CAPTURED_SOURCE_SNAPSHOT" != "$SOURCE_SNAPSHOT" ]; then
  printf 'Source checkout changed while the Local tool install was running. Rerun vpr install:local.\n' >&2
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
