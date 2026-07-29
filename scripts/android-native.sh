#!/usr/bin/env bash
# Fetch the pinned Android arm64 Xray executable into gen/android jniLibs.
# It is stored as libxray.so so Android extracts it into nativeLibraryDir, then
# VpnService executes it with its TUN descriptor inherited through XRAY_TUN_FD.
set -euo pipefail

XRAY_VER="26.6.27"
XRAY_SHA256="9621d72c2f706f47d7bc3c79b5326c12aa29d29013beada1c60df84ff8fe3a0f"
ABI="arm64-v8a"
ROOT="$(pwd)"
JNI="$ROOT/src-tauri/gen/android/app/src/main/jniLibs/$ABI"

mkdir -p "$JNI"

if [ ! -f "$JNI/libxray.so" ]; then
  echo "fetching xray-core $XRAY_VER (android arm64)…"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/x.zip" \
    "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VER}/Xray-android-arm64-v8a.zip"
  echo "$XRAY_SHA256  $TMP/x.zip" | sha256sum -c -
  unzip -o -q "$TMP/x.zip" xray -d "$TMP"
  install -m 0755 "$TMP/xray" "$JNI/libxray.so"
fi

echo "Android Xray ready in $JNI"
