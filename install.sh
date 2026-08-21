#!/bin/sh
set -eu

REPOSITORY=monke-together-strong/monke-tools
RELEASE_CATALOG_URL="https://github.com/$REPOSITORY/releases/download/monke-tools-catalog/stable.tsv"
SUPPORTED_PLATFORMS='macOS arm64, Linux x64'

SYSTEM=$(uname -s)
MACHINE=$(uname -m)
case "$SYSTEM:$MACHINE" in
  Darwin:arm64) PLATFORM=macos-arm64 ;;
  Linux:x86_64 | Linux:x64) PLATFORM=linux-x64 ;;
  *)
    printf 'Unsupported platform %s/%s; supported platforms: %s\n' "$SYSTEM" "$MACHINE" "$SUPPORTED_PLATFORMS" >&2
    exit 1
    ;;
esac

MONKE_HOME_ROOT=${MONKE_HOME:-"${HOME:?HOME is required when MONKE_HOME is unset}/.monke"}
mkdir -p "$MONKE_HOME_ROOT/install-staging"
STAGING_ROOT=$(CDPATH= cd -- "$MONKE_HOME_ROOT/install-staging" && pwd)
WORK_DIRECTORY=$(mktemp -d "$STAGING_ROOT/public-bootstrap-XXXXXX")
case "$WORK_DIRECTORY" in
  "$STAGING_ROOT"/public-bootstrap-*) ;;
  *) printf 'Could not create a safe Release bootstrap directory\n' >&2; exit 1 ;;
esac
printf '%s\n' "$$" > "$WORK_DIRECTORY/.monke-tools-bootstrap-pid"

cleanup() {
  case "${WORK_DIRECTORY:-}" in
    "$STAGING_ROOT"/public-bootstrap-*)
      if [ -d "$WORK_DIRECTORY" ] && [ ! -L "$WORK_DIRECTORY" ]; then
        rm -rf -- "$WORK_DIRECTORY"
      fi
      ;;
  esac
}
trap cleanup 0
trap 'exit 1' 1 2 15

github_curl() {
  token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
  if [ -n "$token" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl --config - --proto '=https' --tlsv1.2 -fsSL "$@"
    return
  fi
  curl --proto '=https' --tlsv1.2 -fsSL "$@"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    return 1
  fi
}

stable_version() {
  printf '%s\n' "$1" | awk -F. '
    NF != 3 { exit 1 }
    {
      for (i = 1; i <= 3; i += 1) {
        if ($i !~ /^(0|[1-9][0-9]*)$/) exit 1
      }
    }
  '
}

release_catalog="$WORK_DIRECTORY/stable.tsv"
if ! github_curl -o "$release_catalog" "$RELEASE_CATALOG_URL"; then
  printf 'Stable Release catalog lookup failed\n' >&2
  exit 1
fi

selected_contract="$WORK_DIRECTORY/selected-release.tsv"
if ! awk -F '\t' '
  NR == 1 && NF == 7 && $1 == "1" { print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7; valid = 1; next }
  { invalid = 1 }
  END { if (!valid || invalid) exit 1 }
' "$release_catalog" >"$selected_contract"; then
  printf 'Stable Release catalog metadata is malformed\n' >&2
  exit 1
fi

tab=$(printf '\t')
IFS="$tab" read -r selected_version selected_tag selected_commit macos_digest linux_digest checksums_digest < "$selected_contract"
if ! stable_version "$selected_version" || [ "$selected_tag" != "monke-tools-v$selected_version" ]; then
  printf 'Stable Release catalog identity is invalid\n' >&2
  exit 1
fi
archive_name="$selected_tag-$PLATFORM.tar.gz"
checksums_name="$selected_tag-checksums.txt"
case "$PLATFORM" in
  macos-arm64) asset_digest=$macos_digest ;;
  linux-x64) asset_digest=$linux_digest ;;
esac
case "$selected_commit" in
  ????????????????????????????????????????) ;;
  *) printf 'Selected Release commit metadata is invalid\n' >&2; exit 1 ;;
esac
case "$selected_commit" in
  *[!0-9a-f]*) printf 'Selected Release commit metadata is invalid\n' >&2; exit 1 ;;
esac

case "$asset_digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) printf 'Stable Release catalog is missing valid platform asset digest metadata\n' >&2; exit 1 ;;
esac
case "${asset_digest#sha256:}" in
  *[!0-9a-f]*) printf 'Stable Release catalog has invalid platform asset digest metadata\n' >&2; exit 1 ;;
esac
case "$checksums_digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) printf 'Stable Release catalog has no valid checksums digest metadata\n' >&2; exit 1 ;;
esac
case "${checksums_digest#sha256:}" in
  *[!0-9a-f]*) printf 'Stable Release catalog has invalid checksums digest metadata\n' >&2; exit 1 ;;
esac

archive_path="$WORK_DIRECTORY/$archive_name"
checksums_path="$WORK_DIRECTORY/$checksums_name"
release_download="https://github.com/$REPOSITORY/releases/download/$selected_tag"
if ! github_curl -o "$archive_path" "$release_download/$archive_name"; then
  printf 'Release archive download failed: %s\n' "$archive_name" >&2
  exit 1
fi
if ! github_curl -o "$checksums_path" "$release_download/$checksums_name"; then
  printf 'Release checksums download failed: %s\n' "$checksums_name" >&2
  exit 1
fi
if ! actual_checksums_digest=$(sha256_file "$checksums_path"); then
  printf 'SHA-256 verification is unavailable; install sha256sum or shasum\n' >&2
  exit 1
fi
if [ "$actual_checksums_digest" != "${checksums_digest#sha256:}" ]; then
  printf 'Release checksums do not match stable catalog digest metadata\n' >&2
  exit 1
fi

expected_checksum=$(awk -v name="$archive_name" '
  $2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {
    if (found) exit 2
    checksum = $1
    found = 1
  }
  END { if (found == 1) print checksum; else exit 1 }
' "$checksums_path") || {
  printf 'Published checksum is missing or invalid for %s\n' "$archive_name" >&2
  exit 1
}

if ! actual_checksum=$(sha256_file "$archive_path"); then
  printf 'SHA-256 verification is unavailable; install sha256sum or shasum\n' >&2
  exit 1
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
  printf 'Release archive checksum does not match the published checksums\n' >&2
  exit 1
fi
if [ "$actual_checksum" != "${asset_digest#sha256:}" ]; then
  printf 'Release archive checksum does not match GitHub asset digest metadata (%s != %s)\n' "$actual_checksum" "${asset_digest#sha256:}" >&2
  exit 1
fi

bundle_root="$WORK_DIRECTORY/bundle"
mkdir "$bundle_root"
if ! tar -tzf "$archive_path" >/dev/null 2>&1 || ! tar -xzf "$archive_path" -C "$bundle_root"; then
  printf 'Release archive extraction failed\n' >&2
  exit 1
fi
if [ ! -f "$bundle_root/install.sh" ] || [ -L "$bundle_root/install.sh" ]; then
  printf 'Verified Release bundle installer is missing\n' >&2
  exit 1
fi

printf 'Verified monke-tools Release %s for %s\n' "$selected_version" "$PLATFORM"
MONKE_TOOLS_EXPECTED_ARTIFACT_NAME=$archive_name \
MONKE_TOOLS_EXPECTED_RELEASE_TAG=$selected_tag \
MONKE_TOOLS_EXPECTED_RELEASE_VERSION=$selected_version \
MONKE_TOOLS_EXPECTED_SOURCE_COMMIT=$selected_commit \
  "$bundle_root/install.sh" "$@"
