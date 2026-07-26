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
reject "$SERVICE" 'startForeground failed (continuing)' \
  "foreground-service startup still fails open"

echo "Android VPN acknowledgement contract: PASS"
