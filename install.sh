#!/bin/sh
set -eu

REPOSITORY=monke-together-strong/monke-tools
RELEASES_API="https://api.github.com/repos/$REPOSITORY/releases"
SUPPORTED_PLATFORMS='macOS arm64, Linux x64'
RELEASES_PER_PAGE=100
MAX_RELEASE_PAGES=10000

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
WORK_DIRECTORY=$(mktemp -d "$STAGING_ROOT/update-bootstrap-XXXXXX")
case "$WORK_DIRECTORY" in
  "$STAGING_ROOT"/update-bootstrap-*) ;;
  *) printf 'Could not create a safe Release bootstrap directory\n' >&2; exit 1 ;;
esac

cleanup() {
  case "${WORK_DIRECTORY:-}" in
    "$STAGING_ROOT"/update-bootstrap-*)
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

version_is_greater() {
  awk -v candidate="$1" -v current="$2" 'BEGIN {
    split(candidate, left, ".")
    split(current, right, ".")
    for (i = 1; i <= 3; i += 1) {
      if (length(left[i]) > length(right[i])) exit 0
      if (length(left[i]) < length(right[i])) exit 1
      if (("v" left[i]) > ("v" right[i])) exit 0
      if (("v" left[i]) < ("v" right[i])) exit 1
    }
    exit 1
  }'
}

parse_release_page() {
  awk '
    function emit() {
      if (tag != "" && draft != "" && prerelease != "") {
        print tag "\t" draft "\t" prerelease
        tag = ""
        draft = ""
        prerelease = ""
      }
    }
    {
      remaining = $0
      while (match(remaining, /(^|[^\\])"(tag_name|draft|prerelease)"[[:space:]]*:[[:space:]]*("[^"]*"|true|false)/)) {
        token = substr(remaining, RSTART, RLENGTH)
        sub(/^[^"]/, "", token)
        if (token ~ /^"tag_name"/) {
          sub(/^"tag_name"[[:space:]]*:[[:space:]]*"/, "", token)
          sub(/"$/, "", token)
          tag = token
        } else if (token ~ /^"draft"/) {
          sub(/^"draft"[[:space:]]*:[[:space:]]*/, "", token)
          draft = token
        } else {
          sub(/^"prerelease"[[:space:]]*:[[:space:]]*/, "", token)
          prerelease = token
        }
        emit()
        remaining = substr(remaining, RSTART + RLENGTH)
      }
    }
    END {
      if (tag != "" || draft != "" || prerelease != "") exit 2
    }
  ' "$1"
}

parse_asset_digest() {
  awk -v target="$2" '
    function finish_object() {
      if (names[depth] == target) {
        matches += 1
        if (digests[depth] == "") invalid = 1
        result = digests[depth]
      }
      delete names[depth]
      delete digests[depth]
      delete keys[depth]
      delete expecting[depth]
    }
    {
      for (position = 1; position <= length($0); position += 1) {
        character = substr($0, position, 1)
        if (in_string) {
          if (escaped) {
            value = value character
            escaped = 0
          } else if (character == "\\") {
            escaped = 1
          } else if (character == "\"") {
            in_string = 0
            if (string_is_value) {
              if (keys[depth] == "name") names[depth] = value
              if (keys[depth] == "digest") digests[depth] = value
              expecting[depth] = 0
            } else {
              pending = value
            }
          } else {
            value = value character
          }
          continue
        }

        if (character == "{") {
          expecting[depth] = 0
          depth += 1
        } else if (character == "}") {
          finish_object()
          depth -= 1
        } else if (character == "\"") {
          in_string = 1
          string_is_value = expecting[depth]
          value = ""
        } else if (character == ":") {
          keys[depth] = pending
          pending = ""
          expecting[depth] = 1
        } else if (character == ",") {
          keys[depth] = ""
          expecting[depth] = 0
          pending = ""
        }
      }
    }
    END {
      if (matches == 0) exit 3
      if (matches != 1 || invalid) exit 4
      print result
    }
  ' "$1"
}

page=1
selected_version=
selected_tag=
selected_metadata="$WORK_DIRECTORY/selected-release.json"
while [ "$page" -le "$MAX_RELEASE_PAGES" ]; do
  page_file="$WORK_DIRECTORY/releases-$page.json"
  if ! github_curl -o "$page_file" "$RELEASES_API?per_page=$RELEASES_PER_PAGE&page=$page"; then
    printf 'GitHub Release lookup failed on page %s\n' "$page" >&2
    exit 1
  fi
  empty_check=$(tr -d '[:space:]' <"$page_file")
  if [ "$empty_check" = '[]' ]; then
    break
  fi

  candidates="$WORK_DIRECTORY/release-candidates-$page.tsv"
  if ! parse_release_page "$page_file" >"$candidates" || [ ! -s "$candidates" ]; then
    printf 'GitHub Release lookup returned malformed metadata on page %s\n' "$page" >&2
    exit 1
  fi

  tab=$(printf '\t')
  while IFS="$tab" read -r tag draft prerelease; do
    case "$tag" in
      monke-tools-v*) version=${tag#monke-tools-v} ;;
      *) version= ;;
    esac
    if [ "$draft" = false ] && [ "$prerelease" = false ] && [ -n "$version" ] && stable_version "$version"; then
      if [ -z "$selected_version" ] || version_is_greater "$version" "$selected_version"; then
        selected_version=$version
        selected_tag=$tag
      fi
    fi
  done <"$candidates"
  page=$((page + 1))
done

if [ -z "$selected_version" ]; then
  printf 'No stable monke-tools Release was found\n' >&2
  exit 1
fi
if [ "$page" -gt "$MAX_RELEASE_PAGES" ]; then
  printf 'GitHub Release lookup exceeded the pagination safety limit\n' >&2
  exit 1
fi

if ! github_curl -o "$selected_metadata" "$RELEASES_API/tags/$selected_tag"; then
  printf 'GitHub Release metadata lookup failed for %s\n' "$selected_tag" >&2
  exit 1
fi

archive_name="$selected_tag-$PLATFORM.tar.gz"
checksums_name="$selected_tag-checksums.txt"
if asset_digest=$(parse_asset_digest "$selected_metadata" "$archive_name"); then
  :
else
  asset_status=$?
  if [ "$asset_status" -eq 3 ]; then
    printf 'Selected Release is missing platform asset %s\n' "$archive_name" >&2
  else
    printf 'Selected Release platform asset metadata is ambiguous or incomplete\n' >&2
  fi
  exit 1
fi
case "$asset_digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) printf 'Selected Release asset has no valid SHA-256 digest metadata\n' >&2; exit 1 ;;
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

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum=$(sha256sum "$archive_path" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum=$(shasum -a 256 "$archive_path" | awk '{ print $1 }')
else
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
"$bundle_root/install.sh" "$@"
