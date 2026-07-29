#!/bin/sh
set -eu

APK="${1:-src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk}"

if [ ! -f "$APK" ]; then
  echo "missing APK: $APK" >&2
  exit 1
fi

ENTRIES="$(mktemp)"
DEX_PACKAGES="$(mktemp)"
trap 'rm -f "$ENTRIES" "$DEX_PACKAGES"' EXIT
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

reject_entry "assets/xray"
reject_entry "assets/varmlen-probe"
reject_entry "assets/varmlen-setcap.sh"
reject_entry "assets/uninstall.sh"
reject_entry "lib/arm64-v8a/libhev-socks5-tunnel.so"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
APKANALYZER="$SDK/cmdline-tools/latest/bin/apkanalyzer"
if [ ! -x "$APKANALYZER" ]; then
  APKANALYZER="$(find "$SDK/cmdline-tools" -type f -name apkanalyzer | sort -V | tail -n 1)"
fi
if [ ! -x "$APKANALYZER" ]; then
  echo "apkanalyzer is unavailable" >&2
  exit 1
fi
"$APKANALYZER" dex packages --defined-only "$APK" >"$DEX_PACKAGES"

if grep -Fq "app.varmlen.client.TProxyService" "$DEX_PACKAGES"; then
  echo "APK still contains the obsolete tun2socks JNI service" >&2
  exit 1
fi

APKSIGNER="$SDK/build-tools/36.0.0/apksigner"
if [ ! -x "$APKSIGNER" ]; then
  APKSIGNER="$(find "$SDK/build-tools" -type f -name apksigner | sort -V | tail -n 1)"
fi
if [ ! -x "$APKSIGNER" ]; then
  echo "apksigner is unavailable" >&2
  exit 1
fi
"$APKSIGNER" verify "$APK"

echo "Android APK contents and signature: PASS"
