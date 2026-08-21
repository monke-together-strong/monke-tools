#!/bin/sh
set -eu

BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

exec "$BUNDLE_ROOT/mt" activate-release-install "$BUNDLE_ROOT" "$@"
