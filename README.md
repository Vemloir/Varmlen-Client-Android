# Varmlen Client Android

Open-source xray-core VPN client for Android, with independent per-app and per-domain split tunneling. Built on Tauri 2 and SvelteKit; the UI, subscription parser and xray config generator are shared with the [desktop client](https://github.com/demented484/Varmlen-Client-Linux).

> Status: working, tested on a physical device. Not on Google Play yet; install the APK directly.

## Features

- VLESS, VMess, Trojan, Shadowsocks over REALITY or TLS; transports tcp, ws, grpc, xhttp, httpupgrade.
- Import a subscription URL, a single share-link, several links, or a raw xray/v2ray JSON config, pasted from the clipboard or entered by hand.
- Split tunneling with independent modes for apps and for sites (whitelist or blacklist each).
- Quick Settings tile to toggle the VPN straight from the notification shade.
- Runs in its own process, so the VPN survives the app being swiped away.

## Architecture

`VpnService` creates the Android TUN and passes its file descriptor directly to
the bundled Xray native TUN inbound. Android enforces the per-app split,
including UDP; Xray applies per-site routing, DNS policy, and remote transports.
Remote SOCKS servers are supported as provider configurations, but Varmlen does
not run a local SOCKS bridge. See [ANDROID.md](./ANDROID.md).

## Build

```bash
source ~/varmlen-android-env.sh          # JDK 17, Android SDK and NDK, rust android targets
bash scripts/android-native.sh           # verify/fetch pinned xray-android
npm install
npm run tauri android build -- --target aarch64 --apk
```

Release signing accepts the legacy external `VARMLEN_KEYSTORE_PROPERTIES`
file, or `VARMLEN_KEYSTORE_FILE`, `VARMLEN_KEYSTORE_PASSWORD_FILE`, and
optionally `VARMLEN_KEY_ALIAS`. Secrets stay outside the repository.

Before publishing, run:

```bash
npm test
npm run check
npm audit --audit-level=low
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
scripts/test-android-manifest.sh
scripts/test-android-vpn-contract.sh
scripts/test-android-native-script.sh
scripts/test-android-apk.sh <signed-apk>
```

Version 0.2.0 is arm64-only. Because the 0.1.2 signing key was lost, back up
subscriptions and uninstall 0.1.2 before installing 0.2.0.

## License

[MIT](./LICENSE). Bundles [xray-core](https://github.com/XTLS/Xray-core)
(MPL-2.0); see [NOTICE](./NOTICE).
