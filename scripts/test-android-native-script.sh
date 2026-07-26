#!/bin/sh
set -eu

SCRIPT="scripts/android-native.sh"

grep -q '^XRAY_SHA256="[0-9a-f]\{64\}"$' "$SCRIPT" || {
  echo "Android Xray download is not pinned by SHA-256" >&2
  exit 1
}
grep -q '^HEV_COMMIT="[0-9a-f]\{40\}"$' "$SCRIPT" || {
  echo "hev-socks5-tunnel source is not pinned to a commit" >&2
  exit 1
}
grep -q 'sha256sum -c' "$SCRIPT" || {
  echo "Android Xray checksum is declared but never verified" >&2
  exit 1
}

echo "Android native dependency pins: PASS"
