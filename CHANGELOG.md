# Changelog

## 0.2.6

- Publish the current corrected Android client as a matching pre-release for
  the Linux 0.2.6 cycle.
- Keep per-app split tunneling on Android's native `VpnService`; the
  Linux-only Proxy-mode process limitation does not apply to Android.
- Include the corrected location-editor bounds, modal lifecycle, touch actions,
  location states, parallel latency checks, and log containment from the final
  0.2.5 source state.

## 0.2.5

- Add editable location details: exact source JSON for JSON profiles and
  structured parameters for URI-based locations.
- Refresh subscriptions at their configured interval even while the app UI is
  closed and the VPN is disconnected, using Android background work.
- Allow automatic subscription refresh to be disabled and let provider updates
  replace local location edits.
- Add location dividers and a neutral globe for entries without a country flag,
  and remove the selected-location stripe.
- Make location dividers span the full card width using the page background
  color.
- Pretty-print valid location JSON in the editor and make reopening the same
  location toggle its details closed.
- Simplify protocol labels: show only Hysteria or Hysteria2 for those protocols
  and omit redundant REALITY suffixes.

## 0.2.4

- Make one-shot HTTP latency checks use a composite location's deterministic
  fallback outbound instead of racing its cold load balancer and observatory.
- Match Xray's health-check request with an HTTP HEAD probe to the provider's
  gstatic 204 endpoint, reducing inflated latency and fixing Proxen USA probes.

## 0.2.3

- Send client-family subscription User-Agents as
  `<client>/<platform>/<architecture>` without an application version.
- Fix Happ and INCY compatibility with providers such as Proxen that select
  full Xray JSON profiles only when the client family is slash-delimited.

## 0.2.2

- Preserve complete multi-outbound Xray profiles as one logical location,
  including provider balancers and observatories.
- Add selectable Varmlen, Happ, INCY, and v2rayTun subscription User-Agents
  with an Android header and no app-version device churn.
- Keep provider JSON lossless and editable while retaining Varmlen's own DNS
  and Android app split-tunnel policy.
- Support Xray JSON outbounds for VLESS, VMess, Trojan, Shadowsocks, Hysteria,
  WireGuard, HTTP, and SOCKS; omit forbidden WireGuard stream settings.
- Stop grouping similarly named locations. Migrate local Configuration N cards
  into one flat Configuration/Configurations card without a network request.
- Make repeated disconnect requests idempotent and acknowledge them even when
  teardown is already in progress, fixing a power button that could appear stuck.

## 0.2.1

- Fixed disconnect so the UI waits for the Android VPN service to tear down
  tun2socks, Xray, and the TUN before reporting success.
- Use a stable Android Varmlen subscription user agent without an app version.
- Preserve provider location names, editable source JSON, and the exact Xray
  proxy outbound instead of showing JSON locations as `IP:port`.
- Preserve Proxen XHTTP `extra`, mode, and XMUX settings.
- Group primary and backup variants under one expandable location.
- Accept Xray JSON outbounds for VMess, Trojan, Shadowsocks, Hysteria,
  WireGuard, HTTP, and SOCKS in addition to VLESS.
- Reparse JSON already stored by 0.2.0 locally, without downloading the
  subscription again.

## 0.2.0

### Corrected Android reissue

- Fixed the tun2socks JNI descriptors that prevented the original 0.2.0 APK
  from connecting.
- Treat a native tun2socks startup failure as a fail-closed connection error.
- Added Copy, Copied, and Copy failed states to the full in-app VPN log viewer.
- Added a release-APK gate that compares the DEX and bundled native JNI
  contracts before publication.
- Locked VPN DNS to the single tun2socks data path; the Android `VpnService`
  remains the only component that assigns the tunnel DNS server.

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
- Release signing can read the keystore password from an external file and
  explicitly enables APK Signature Schemes v2 and v3.

### Signing migration

The private key used for 0.1.2 is no longer available. Android cannot install
0.2.0 over 0.1.2. Back up subscriptions, uninstall the old app, then install
0.2.0. Future 0.2.x releases use the new 0.2 certificate.
