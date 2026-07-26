# Varmlen on Android

The Android port reuses the entire Svelte UI, the subscription parser, and the
xray config generator. Only the data plane is platform-specific.

**Status:** builds an installable arm64 APK/AAB with Xray and tun2socks verified
inside the package. The service reports startup success/failure back to the UI.
The 0.2.0 changes still need a device smoke test, especially on OEM Android
variants.

## Architecture

```
Connect (UI) → vpn_connect (Rust, cfg android) → mobile_vpn::connect
   → VpnPlugin (Kotlin, Tauri plugin) → VarmlenVpnService (VpnService)
        ├── VpnService.Builder → tun fd  (addAddress/route/dns, per-app)
        ├── exec libxray.so  → local SOCKS on 127.0.0.1:2081  (the desktop
        │                       `Tun2socks` config variant, reused verbatim)
        └── TProxy.startTun2socks(yaml, fd)  → hev-socks5-tunnel bridges the
                                tun fd to the SOCKS proxy (via libtproxy.so JNI)
```

- **xray** runs as the bundled `libxray.so` (Android arm64 binary), exec'd from
  `nativeLibraryDir` — `useLegacyPackaging = true` extracts it.
- **tun2socks** is hev-socks5-tunnel (`libhev-socks5-tunnel.so`), built with
  `-DPKGNAME=app/varmlen/client` so its **built-in** Android JNI registers
  `TProxyStartService`/`TProxyStopService` onto `app.varmlen.client.TProxyService`
  (it spawns hev's work thread with the right signal mask — a hand-rolled
  `hev_socks5_tunnel_main` call on a JVM thread segfaults).
- Per-app split maps to package names: selective = `addAllowedApplication`,
  general = `addDisallowedApplication`.

## Build

Prereqs (already set up on the dev machine; see `~/varmlen-android-env.sh`):
JDK 17, Android SDK (platform-34, build-tools 34, NDK r26+), rustup with the
android targets (`aarch64/armv7/i686/x86_64-linux-android`).

```bash
source ~/varmlen-android-env.sh          # ANDROID_HOME, NDK_HOME, JAVA_HOME, PATH
bash scripts/android-native.sh           # fetch xray-android + build tun2socks → jniLibs
npm run tauri android build -- --target aarch64 --apk --aab
```

(`npm run tauri android dev` runs it on a connected device/emulator with live
reload.)

## Remaining work (needs a device)

- Verify the VpnService consent flow + that the tun ↔ tun2socks ↔ xray path
  actually passes traffic; iterate on the tun2socks yaml / xray socks port.
- API-34 foreground-service-type for VPN may need adjustment
  (`foregroundServiceType` / the `startForeground` type argument).
- Per-app: the on-Android app list should come from `PackageManager` (the
  desktop `.desktop` scanner returns empty on Android) — package names, not
  process names.
- DNS handling + IPv6 routing under the tunnel.
- Currently arm64-v8a only; add the other ABIs for store distribution.
- Hide desktop-only UI on Android (the "grant network permissions" / pkexec
  flow, the file-based app picker).
