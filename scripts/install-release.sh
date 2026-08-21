#!/bin/sh
set -eu

BUNDLE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

case "${1:-}" in
  --verify)
    for required_path in \
      install-manifest.json \
      instructions/GLOBAL.md \
      mt \
      skills/codex \
      skills/imported \
      skills/internal \
      skills/references
    do
      if [ ! -e "$BUNDLE_ROOT/$required_path" ]; then
        printf 'Release bundle entry is missing: %s\n' "$required_path" >&2
        exit 1
      fi
    done
    "$BUNDLE_ROOT/mt" --version >/dev/null
    ;;
  *)
    if [ -t 0 ]; then
      exec "$BUNDLE_ROOT/mt" activate-release-install "$BUNDLE_ROOT" --interactive "$@"
    fi
    if [ -t 1 ] && [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then
      exec "$BUNDLE_ROOT/mt" activate-release-install "$BUNDLE_ROOT" --interactive "$@" </dev/tty
    fi
    exec "$BUNDLE_ROOT/mt" activate-release-install "$BUNDLE_ROOT" "$@"
    ;;
esac
