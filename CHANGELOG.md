# Changelog

## 0.2.0

### Corrected Android reissue

- Fixed the tun2socks JNI descriptors that prevented the original 0.2.0 APK
  from connecting.
- Treat a native tun2socks startup failure as a fail-closed connection error.
- Added Copy, Copied, and Copy failed states to the full in-app VPN log viewer.
- Added a release-APK gate that compares the DEX and bundled native JNI
  contracts before publication.

### Android VPN

- The UI reports connected only after the foreground service, Xray, TUN, and
  tun2socks confirm startup.
- Foreground-service failures now fail closed.
- Empty or entirely uninstalled selective-app allowlists are rejected instead
  of silently routing almost every application through the VPN.
- Allowed and disallowed application APIs are no longer mixed.
- Quick Settings connection data is saved only after a successful connection.
- Stale frontend connect and reconnect results are ignored.

### Quick Settings

- Long-pressing the Varmlen tile opens the app through
  `QS_TILE_PREFERENCES`, including Xiaomi/POCO System UI.
- The tile declares active, toggleable, and connectivity metadata.
- The tile remains unavailable while connecting and updates only after service
  confirmation.

### Security and packaging

- Android backup is disabled for locally stored VPN configuration.
- Android's real Always-on VPN/lockdown settings replace the non-functional
  desktop kill-switch toggle.
- Xray is pinned by SHA-256 and hev-socks5-tunnel by commit.
- Android Xray and tun2socks are now included in the release, while Linux Xray,
  setcap scripts, and desktop helper payloads are removed.
- Added APK, manifest, native-dependency, frontend, Rust, and Kotlin gates.

### Signing migration

The private key used for 0.1.2 is no longer available. Android cannot install
0.2.0 over 0.1.2. Back up subscriptions, uninstall the old app, then install
0.2.0. Future 0.2.x releases use the new 0.2 certificate.
