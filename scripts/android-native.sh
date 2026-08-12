#!/usr/bin/env bash
# Fetch the pinned Android arm64 Xray executable into gen/android jniLibs.
# It is stored as libxray.so so Android extracts it into nativeLibraryDir, then
# VpnService executes it with its TUN descriptor inherited through XRAY_TUN_FD.
set -euo pipefail

XRAY_VER="26.7.28"
XRAY_SHA256="a442892c175fa648fc56866ec872aac441c5a6b8946a1b60f0258ae16a7fb402"
ABI="arm64-v8a"
ROOT="$(pwd)"
JNI="$ROOT/src-tauri/gen/android/app/src/main/jniLibs/$ABI"
MARKER="$JNI/libxray.so.version"

mkdir -p "$JNI"

if [ ! -f "$JNI/libxray.so" ] || [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$XRAY_VER" ]; then
  echo "fetching xray-core $XRAY_VER (android arm64)…"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/x.zip" \
    "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VER}/Xray-android-arm64-v8a.zip"
  echo "$XRAY_SHA256  $TMP/x.zip" | sha256sum -c -
  unzip -o -q "$TMP/x.zip" xray -d "$TMP"
  install -m 0755 "$TMP/xray" "$JNI/libxray.so"
  printf '%s\n' "$XRAY_VER" >"$MARKER"
fi

echo "Android Xray ready in $JNI"
