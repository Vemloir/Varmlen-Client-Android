#!/bin/sh
set -eu

APK="${1:-src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk}"

if [ ! -f "$APK" ]; then
  echo "missing APK: $APK" >&2
  exit 1
fi

ENTRIES="$(mktemp)"
trap 'rm -f "$ENTRIES"' EXIT
unzip -Z1 "$APK" >"$ENTRIES"

require_entry() {
  path="$1"
  if ! grep -qx "$path" "$ENTRIES"; then
    echo "APK is missing required entry: $path" >&2
    exit 1
  fi
}

reject_entry() {
  path="$1"
  if grep -qx "$path" "$ENTRIES"; then
    echo "APK contains desktop-only payload: $path" >&2
    exit 1
  fi
}

require_entry "lib/arm64-v8a/libvarmlen_lib.so"
require_entry "lib/arm64-v8a/libxray.so"
require_entry "lib/arm64-v8a/libhev-socks5-tunnel.so"

reject_entry "assets/xray"
reject_entry "assets/varmlen-probe"
reject_entry "assets/varmlen-setcap.sh"
reject_entry "assets/uninstall.sh"

APKSIGNER="${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools/36.0.0/apksigner"
if [ ! -x "$APKSIGNER" ]; then
  APKSIGNER="$(find "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" -type f -name apksigner | sort -V | tail -n 1)"
fi
if [ ! -x "$APKSIGNER" ]; then
  echo "apksigner is unavailable" >&2
  exit 1
fi
"$APKSIGNER" verify "$APK"

echo "Android APK contents and signature: PASS"
