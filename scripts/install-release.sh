#!/bin/sh
set -eu

BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

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
    printf '%s\n' 'Install this bundle through the supported monke-tools Release bootstrap.' >&2
    exit 2
    ;;
esac
