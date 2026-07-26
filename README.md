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

A VpnService builds the tun interface; hev-socks5-tunnel (tun2socks) bridges it to the bundled Android xray running as a local SOCKS proxy. The per-app split is enforced by the VpnService, the per-site split by xray routing. See [ANDROID.md](./ANDROID.md) for the full data plane and toolchain notes.

## Build

```bash
source ~/varmlen-android-env.sh          # JDK 17, Android SDK and NDK, rust android targets
bash scripts/android-native.sh           # fetch xray-android and build tun2socks into jniLibs
npm install
npm run tauri android build -- --target aarch64 --apk --aab
```

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

[MIT](./LICENSE). Bundles [xray-core](https://github.com/XTLS/Xray-core) (MPL-2.0) and [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel); see [NOTICE](./NOTICE).
