#!/bin/sh
set -eu

SERVICE="src-tauri/gen/android/app/src/main/java/app/varmlen/client/VarmlenVpnService.kt"
PLUGIN="src-tauri/gen/android/app/src/main/java/app/varmlen/client/VpnPlugin.kt"

require() {
  file="$1"
  pattern="$2"
  message="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

reject() {
  file="$1"
  pattern="$2"
  message="$3"
  if grep -q "$pattern" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

require "$SERVICE" 'EXTRA_REQUEST_ID' \
  "VPN service does not correlate a connect result with its caller"
require "$SERVICE" 'EXTRA_ERROR' \
  "VPN service cannot report a structured startup failure"
require "$PLUGIN" 'pendingConnect' \
  "VPN plugin resolves before the service confirms startup"
require "$SERVICE" 'startForegroundOrThrow' \
  "foreground-service startup is not fail-closed"
require "$SERVICE" 'XRAY_TUN_FD' \
  "VPN service does not pass its TUN fd to Xray"
require "$SERVICE" 'F_SETFD' \
  "VPN service does not explicitly control TUN fd inheritance"
require "$SERVICE" 'FD_CLOEXEC' \
  "VPN service does not restore close-on-exec after starting Xray"
require "$SERVICE" 'addDisallowedApplication(packageName)' \
  "Varmlen does not exclude its own Xray process from VPN capture"
reject "$SERVICE" 'startForeground failed (continuing)' \
  "foreground-service startup still fails open"
reject "$SERVICE" 'TProxyService' \
  "VPN service still calls the obsolete tun2socks JNI bridge"
reject "$SERVICE" 'socksPort' \
  "VPN service still carries the obsolete local SOCKS port"
reject "$SERVICE" 'tun2socks' \
  "VPN service still documents or starts tun2socks"
reject "$PLUGIN" 'socksPort' \
  "VPN plugin still carries the obsolete local SOCKS port"

echo "Android VPN acknowledgement contract: PASS"
