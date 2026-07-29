# Android Native Xray TUN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the Android `VpnService` TUN fd directly into Xray 26.6.27 and remove Varmlen's local SOCKS5/tun2socks data plane and user-facing Proxy mode.

**Architecture:** Kotlin owns the Android VPN lifecycle and passes its inherited TUN fd to the bundled Xray child through `XRAY_TUN_FD`. Rust generates a native Xray `tun` inbound with Android-specific routing semantics, while Android package split remains in `VpnService`.

**Tech Stack:** Kotlin/Android `VpnService`, Tauri 2, Rust, Xray-core 26.6.27, Svelte 5, Vitest, Gradle, Android SDK/NDK.

## Global Constraints

- Modify only `Varmlen-Client-Android`; do not touch the Linux repository.
- Do not disconnect or mutate the user's active VPN/network state.
- Keep remote SOCKS outbound/subscription support.
- Publish only a signed arm64 APK; do not build or publish an AAB.
- Keep version name `0.2.6`; use Android `versionCode 2010` so the native
  launcher build upgrades both earlier `2008` and `2009` artifacts.
- Commit messages and release notes must contain no AI attribution.

---

### Task 1: Lock the removal contract

**Files:**
- Modify: `src/lib/card-surface-contract.test.ts`
- Modify: `scripts/test-android-native-script.sh`
- Modify: `scripts/test-android-vpn-contract.sh`
- Modify: `scripts/test-android-apk.sh`

**Interfaces:**
- Consumes: current frontend, Kotlin service, native dependency script, APK.
- Produces: failing contracts for the old local SOCKS5 path and required native TUN fd path.

- [ ] Add assertions that frontend source contains no `vpnMode`, Kotlin contains no `TProxyService`/`socksPort`, the native script contains no `hev-socks5-tunnel`, and APK contains no `libhev-socks5-tunnel.so`.
- [ ] Add assertions requiring `XRAY_TUN_FD`, the Rust/JNI fd launcher, native
  Xray `tun` inbound, and Varmlen package exclusion.
- [ ] Run the focused Vitest and shell contracts and confirm they fail on the old implementation.

### Task 2: Remove frontend and Rust local Proxy mode

**Files:**
- Modify: `src/lib/settings.svelte.ts`
- Modify: `src/routes/settings/+page.svelte`
- Modify: `src/routes/+layout.svelte`
- Modify: `src/lib/conn.svelte.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/i18n.svelte.ts`
- Modify: `src-tauri/src/vpn.rs`
- Modify: `src-tauri/src/xray.rs`

**Interfaces:**
- Consumes: `vpnConnect(server, split, killswitch, allowLan, logLevel)`.
- Produces: one Android connection mode and `build_xray_config` with native TUN plus explicit app-split ownership.

- [ ] Remove `VpnMode`, persisted `vpnMode`, selector copy, selector UI, live-reconnect dependency, and the `mode` API argument.
- [ ] Remove Rust `mode` command argument, `mode == "proxy"` launch branch, fixed runtime SOCKS port, and `TunMode::Tun2socks`.
- [ ] Separate inbound type from app-split ownership so Android native TUN does not emit Linux process rules.
- [ ] Run focused frontend and Rust tests until green.

### Task 3: Replace tun2socks with inherited native TUN fd

**Files:**
- Modify: `src-tauri/src/mobile_vpn.rs`
- Add: `src-tauri/src/android_xray.rs`
- Modify: `src-tauri/gen/android/app/src/main/java/app/varmlen/client/VpnPlugin.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/app/varmlen/client/VarmlenVpnService.kt`
- Add: `src-tauri/gen/android/app/src/main/java/app/varmlen/client/XrayCore.kt`
- Delete: `src-tauri/gen/android/app/src/main/java/app/varmlen/client/TProxyService.kt`
- Modify: `src-tauri/gen/android/app/build.gradle.kts`
- Modify: `scripts/android-native.sh`

**Interfaces:**
- Consumes: Xray config and Android app split from Rust.
- Produces: a foreground `VpnService` that starts Xray with `XRAY_TUN_FD=<fd>` and no SOCKS bridge.

- [ ] Remove `socksPort` from plugin arguments, intent extras, persistence, logging, and start signatures.
- [ ] Establish the Android TUN before Xray, pass its fd through JNI, duplicate
  it in Rust, and natively start Xray with `XRAY_TUN_FD=<dup>`.
- [ ] Remove all `TProxyService` calls and hev YAML generation.
- [ ] Remove hev from build scripts and package metadata.
- [ ] Run Kotlin/native contracts and Gradle compilation.

### Task 4: Remove local SOCKS ping and update documentation

**Files:**
- Modify: `src-tauri/src/xray.rs`
- Modify: `src-tauri/src/vpn.rs`
- Modify: `README.md`
- Modify: `ANDROID.md`
- Modify: `CHANGELOG.md`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: per-outbound loopback ports.
- Produces: HTTP proxy ping inbounds and explicit release copy.

- [ ] Change generated ping inbounds from `socks` to `http`.
- [ ] Change `reqwest` ping proxy URLs from `socks5h://` to `http://`.
- [ ] Update tests and error messages from SOCKS ports to HTTP proxy ports.
- [ ] Document direct `VpnService` fd handoff, explicit component removal,
  retained remote SOCKS support, and `versionCode 2010`.
- [ ] Run focused ping/config tests.

### Task 5: Full verification and corrected pre-release

**Files:**
- Build: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
- Release asset: `Varmlen_0.2.6_arm64.apk`

**Interfaces:**
- Consumes: signed release keystore at `/home/daniil/varmlen-android-signing/key.properties`.
- Produces: corrected GitHub Android `v0.2.6` pre-release.

- [ ] Run all Vitest, Svelte, audit, Cargo test/clippy, Android contract, and formatting checks.
- [ ] Build only the signed arm64 APK with `npm run tauri android build -- --target aarch64 --apk`.
- [ ] Verify manifest `0.2.6/2010`, arm64 ABI, certificate digest, APK contents, and absence of hev.
- [ ] Commit and push functional source changes.
- [ ] Replace the Android `v0.2.6` tag/release with the corrected commit and APK.
- [ ] Download the GitHub asset, compare SHA-256 byte-for-byte, and repeat manifest/signature/content verification.
