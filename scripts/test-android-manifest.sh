#!/bin/sh
set -eu

MANIFEST="${1:-src-tauri/gen/android/app/src/main/AndroidManifest.xml}"

if [ ! -f "$MANIFEST" ]; then
  echo "missing Android manifest: $MANIFEST" >&2
  exit 1
fi

require() {
  pattern="$1"
  message="$2"
  if ! grep -q "$pattern" "$MANIFEST"; then
    echo "$message" >&2
    exit 1
  fi
}

require 'android.service.quicksettings.action.QS_TILE_PREFERENCES' \
  "Quick Settings long-press preference activity is missing"
require 'android:allowBackup="false"' \
  "Android backup must be disabled for stored VPN credentials"
require 'android.service.quicksettings.ACTIVE_TILE' \
  "Quick Settings tile must declare active mode"
require 'android.service.quicksettings.TOGGLEABLE_TILE' \
  "Quick Settings tile must declare toggle semantics"

echo "Android manifest security: PASS"
