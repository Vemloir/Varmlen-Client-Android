#!/bin/sh
set -eu

SERVICE="src-tauri/gen/android/app/src/main/java/app/varmlen/client/VarmlenVpnService.kt"
PLUGIN="src-tauri/gen/android/app/src/main/java/app/varmlen/client/VpnPlugin.kt"
CORE="src-tauri/gen/android/app/src/main/java/app/varmlen/client/XrayCore.kt"
NATIVE="src-tauri/src/android_xray.rs"

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
require "$SERVICE" 'XrayCore.start' \
  "VPN service does not pass its TUN fd through the native Xray launcher"
require "$CORE" 'external fun start' \
  "Android Xray JNI bridge does not expose a start function"
require "$CORE" 'external fun stop' \
  "Android Xray JNI bridge does not expose a stop function"
require "$CORE" 'external fun isRunning' \
  "Android Xray JNI bridge cannot detect a runtime Xray exit"
require "$CORE" 'external fun validate' \
  "Android Xray JNI bridge cannot validate a candidate config"
require "$CORE" 'external fun appendLog' \
  "Android Xray JNI bridge does not use the bounded native log writer"
reject "$SERVICE" 'verifyEgress' \
  "Android VPN startup is still gated by a synthetic Internet probe"
reject "$SERVICE" 'probe-in' \
  "Android VPN service still carries the obsolete startup-probe inbound"
reject "$SERVICE" 'Connection verification failed' \
  "Android VPN service can still reject a running tunnel on probe failure"
require "$NATIVE" 'libc::dup' \
  "native Xray launcher does not duplicate the TUN fd for child inheritance"
require "$NATIVE" 'XRAY_TUN_FD' \
  "native Xray launcher does not pass the duplicated TUN fd to Xray"
require "$NATIVE" 'BoundedLog' \
  "native Xray launcher does not continuously rotate its log"
require "$SERVICE" 'addDisallowedApplication(packageName)' \
  "Varmlen does not exclude its own Xray process from ordinary VPN capture"
require "$SERVICE" 'isLockdownEnabled' \
  "Android VPN service does not detect the system kill switch"
require "$SERVICE" 'bindOutboundsToInterface' \
  "Android VPN service cannot keep Xray outbounds alive under lockdown"
require "$SERVICE" 'setUnderlyingNetworks' \
  "Android VPN service does not declare its physical network under lockdown"
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
reject "$SERVICE" 'ProcessBuilder' \
  "VPN service still launches Xray through Android ProcessBuilder, which closes the TUN fd"

echo "Android VPN acknowledgement contract: PASS"
