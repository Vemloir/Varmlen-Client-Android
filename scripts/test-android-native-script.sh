#!/bin/sh
set -eu

SCRIPT="scripts/android-native.sh"

grep -q '^XRAY_SHA256="[0-9a-f]\{64\}"$' "$SCRIPT" || {
  echo "Android Xray download is not pinned by SHA-256" >&2
  exit 1
}
grep -q 'sha256sum -c' "$SCRIPT" || {
  echo "Android Xray checksum is declared but never verified" >&2
  exit 1
}
if grep -q 'hev-socks5-tunnel\|libhev-socks5-tunnel\|tun2socks' "$SCRIPT"; then
  echo "obsolete Android tun2socks dependency is still present" >&2
  exit 1
fi

echo "Android native Xray dependency: PASS"
