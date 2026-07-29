# Android Native Xray TUN Design

## Goal

Replace the Android data plane

`VpnService TUN → hev-socks5-tunnel → local SOCKS5 inbound → Xray`

with

`VpnService TUN fd → Xray native TUN inbound`

and remove the user-facing local Proxy/SOCKS5 mode from the Android client.

## Scope

This change applies only to `Varmlen-Client-Android`. The Linux client's
user-facing Proxy mode is not changed.

Remote SOCKS servers remain a supported Xray outbound protocol. They are
subscription data, not part of Varmlen's removed local SOCKS5 data plane.

## Data plane

`VarmlenVpnService` remains responsible for:

- Android VPN consent and foreground-service lifecycle;
- `VpnService.Builder`, addresses, default route, DNS, and per-app allow/deny;
- keeping Varmlen's own package outside the VPN so the Xray child cannot route
  its uplink back into its own TUN;
- owning and closing the `ParcelFileDescriptor`.

After establishing the TUN, the service calls the `XrayCore` JNI bridge. The
Rust launcher duplicates the descriptor with `dup()` and starts the bundled
Android Xray executable with `XRAY_TUN_FD=<dup>`. This native launch is
required because Android's Java process launcher closes arbitrary descriptors
before exec even when the original `FD_CLOEXEC` flag has been cleared. Xray
26.6.27's Android TUN implementation reads the environment variable, marks the
fd non-blocking, and feeds it directly into its gVisor stack.

Xray receives a native `tun` inbound. Android package split remains enforced by
`VpnService`; Xray applies site and outbound routing without process matching.

## Removed components

- `hev-socks5-tunnel` checkout/build/package logic;
- `libhev-socks5-tunnel.so`;
- `TProxyService` and its JNI contract;
- `socksPort` bridge arguments, intent extras, and persisted values;
- the frontend `vpnMode` setting and all local Proxy-mode copy;
- the Rust/Xray local Proxy connection branch;
- `TunMode::Tun2socks` and the fixed runtime SOCKS port;
- local SOCKS ping inbounds, replaced with loopback HTTP proxy inbounds.

## Failure and shutdown behavior

The service establishes the TUN before starting Xray. Until Xray is running,
captured traffic has nowhere to go and therefore fails closed. Any Xray startup
or runtime failure tears down the service and closes the TUN. Normal disconnect
kills Xray before closing the parent TUN descriptor.

Saved Quick Settings configuration no longer contains a SOCKS port. Existing
saved configurations remain usable because the removed preference is optional
and ignored.

## UI and release copy

Android Settings no longer contains VPN mode selection. The changelog and
GitHub pre-release must explicitly say:

> Removed the user-facing local Proxy (SOCKS5/HTTP) mode and the embedded
> hev-socks5-tunnel bridge. Android now feeds its VpnService TUN fd directly
> into Xray's native TUN inbound.

The notes also state that remote SOCKS server configurations remain supported.

## Verification

- source contracts reject `TProxyService`, `hev-socks5-tunnel`, bridge
  `socksPort`, and the old frontend `vpnMode`;
- source contracts require `XRAY_TUN_FD`, native `tun` inbound, explicit fd
  inheritance through the Rust/JNI launcher, and own-package VPN exclusion;
- Rust tests verify Android routing uses VpnService-owned app split and native
  TUN;
- ping tests verify loopback HTTP proxy inbounds;
- APK inspection verifies arm64-only packaging, valid signature, bundled Xray,
  and absence of `libhev-socks5-tunnel.so`;
- `0.2.6` uses Android `versionCode 2010` so it upgrades the earlier artifacts,
  including the Java-launcher build carrying `2009`.
