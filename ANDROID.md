# Varmlen on Android

The Android port reuses the entire Svelte UI, the subscription parser, and the
xray config generator. Only the data plane is platform-specific.

**Status:** builds a signed arm64 APK with Xray verified inside the package.
The service reports startup success/failure back to the UI.

## Architecture

```
Connect (UI) → vpn_connect (Rust, cfg android) → mobile_vpn::connect
   → VpnPlugin (Kotlin, Tauri plugin) → VarmlenVpnService (VpnService)
        ├── VpnService.Builder → TUN fd (IPv4/IPv6, DNS, per-app policy)
        └── XRAY_TUN_FD=<fd> exec libxray.so → native Xray TUN inbound
```

- **xray** runs as the bundled `libxray.so` (Android arm64 binary), exec'd from
  `nativeLibraryDir` — `useLegacyPackaging = true` extracts it.
- `VpnService` temporarily clears `FD_CLOEXEC`, starts Xray with
  `XRAY_TUN_FD=<fd>`, then restores the descriptor flags in the parent.
- Per-app split maps to package names: selective = `addAllowedApplication`,
  general = `addDisallowedApplication`. Varmlen's own UID stays outside capture
  so Xray's remote sockets cannot loop back into the TUN.
- Remote SOCKS configurations remain valid Xray outbounds. There is no local
  SOCKS listener in the VPN data plane.

## Build

Prereqs (already set up on the dev machine; see `~/varmlen-android-env.sh`):
JDK 17, Android SDK (platform-34, build-tools 34, NDK r26+), rustup with the
android targets (`aarch64/armv7/i686/x86_64-linux-android`).

```bash
source ~/varmlen-android-env.sh          # ANDROID_HOME, NDK_HOME, JAVA_HOME, PATH
bash scripts/android-native.sh           # verify/fetch pinned xray-android
npm run tauri android build -- --target aarch64 --apk
```

(`npm run tauri android dev` runs it on a connected device/emulator with live
reload.)

The current release is arm64-v8a only. A physical-device smoke test should
verify connect, disconnect, IPv4/IPv6, DNS, UDP game traffic, per-app allow and
deny modes, notification/tile control, and reconnect without a direct-traffic
window.
