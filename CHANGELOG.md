# Changelog

## Unreleased

- Home and Split are two panes of one gesture. Swiping between them follows the
  finger 1:1 in the middle of the travel and gives way at the ends, so the edge
  still feels like an edge; the gesture is released on distance OR on a flick, so
  a slow drag to the middle commits instead of snapping back; one gesture drives
  one pane, and a drag the system takes away (`pointercancel`) hands the pane back
  rather than leaving it stopped in the middle of the screen. The tab you were on
  is remembered with the split, and each half keeps its own scroll position.

- The bottom bar is labelled again, and whether it is is a setting. The bar
  carries its own plate colour and the page lifts into it with a fade the shell
  draws; the old CSS mask is gone, because a mask makes a stacking context and the
  dialogs fell behind it.

- The pill on the home screen reports the session: up, down, and how long it has
  been up, read from the tunnel interface itself instead of restated from the last
  connection. Where the counter cannot be read the rate shows `—/s` and not
  `0 B/s`: a dash says this device will not tell me, a zero says nothing is
  moving, and printing the second when the first is true is a lie about an idle
  connection.

- The interface MTU is a setting that does something. It travels from Settings to
  the core's tun inbound and to `VpnService.Builder.setMtu`, and it is part of the
  connection signature, so changing it rebuilds a tunnel that is already up
  instead of reading as applied. Out-of-range values are clamped to 1280..9000
  rather than reset: someone who typed 1100 meant smaller than default, and
  answering with 1500 -- the one value that fails on such a network -- would be
  the worse lie. The same rule is applied again in Kotlin, because the Quick
  Settings tile relaunches the tunnel from a saved preference without asking the
  Rust side anything, and an interface that quietly came back at 1500 after a
  screen timeout would make the setting a lie whenever the user was not looking.

- Settings are grouped by what they belong to: Interface (MTU, simultaneous
  pings, tab labels), VPN (kill switch, LAN, notifications, the system-VPN row),
  Appearance, Diagnostics. "Simultaneous pings" is a real field now: it is the
  number of locations a card probes at once. It starts at 4 rather than at "no
  limit", because every probe on a phone is a short-lived process and a burst of
  forty made healthy locations show up as n/a. Both number fields are wide enough
  to show the number they hold.

- A subscription that failed to update says so. The card states the failure and
  keeps showing the list it still has, instead of refreshing quietly and leaving
  him to guess whether the eleven locations he sees are current.

- Revealing a card's hidden locations survives a trip to Settings and back: the
  card is showing them to him, and that is not a fact about the page.

- The latency of a location is inside the row button. As a sibling it stole the
  tap: pressing the label selected the location as if the row had been pressed,
  and on a phone the label is where a thumb lands.

- Split sites are written without the asterisk: `example.com` means the domain and
  its subdomains, `=example.com` means that name alone, and the add dialog is one
  field with the kind on a tooltip. Everything the user types is a hostname, so
  the field no longer asks him to spell a wildcard.

- One rounding family and one panel colour. Cards, rows, pills and dialogs share
  the same radii and hairlines, controls are cut out of the plate they sit on
  rather than painted on top of it, and nothing in the app is selectable except
  the fields he types into.

- A manually added configuration no longer pretends to be a subscription: its card
  carries no refresh (nothing fetches it) and no ⋮ menu (rename, JSON, pin and
  remove are subscription actions), only the ping. Its locations are deleted for
  real from the row menu, and when the last one goes, the card goes with it.

- Hiding a location has no duration setting any more, and the setting itself is
  deleted rather than left inert. A background update is not something the user
  did, so hiding could undo itself while the app was simply open; an explicit
  refresh is the provider's business, not the user's undo button. A hidden row
  stays hidden until he shows it again on the card, and the only other way back is
  removing the subscription and importing it again -- a re-import is a new
  subscription, not a refresh of the old one -- so hiding stays durable without
  becoming unrecoverable. A stored hiding mode is ignored.

- Hiding one location no longer hides the location behind it. Hiding and pinning
  were keyed by the ENDPOINT, and a provider can put two rows on one endpoint
  exactly -- the "auto choice" balancer of a JSON profile exposes the same first
  proxy outbound as the location behind it, so hiding one row hid its neighbour.
  A row is now keyed by endpoint AND label, the way the selection already resolves
  it: the row you pointed at is the row that goes away. Renaming a location brings
  back a hidden one and unpins a pinned one, because that row is gone under a new
  name. Keys written by older builds are rewritten to the row they can only have
  meant; when several rows share the old key the intent is lost, so those locations
  show again rather than stay hidden.

- Long-press a location for its menu: ping, rename, pin, hide -- or delete, for a
  location of a manually added configuration. The gesture dies the moment it stops
  being a press: a finger that wanders more than 10 px, a list that scrolls under
  it, or a lift before 500 ms opens nothing, and the click a long press ends with
  no longer selects the location behind the menu. The list text is no longer
  selectable either, so the WebView's own "select text" haptics do not compete
  with it. Hidden locations drop out of the card and come back on the card's own
  "N hidden" line, and pinned ones move to
  the top of the list with the same pin mark a pinned card carries. The menu is
  one per app and as wide as its longest item, measured from the text, because
  `max-content` is not honoured the same way in every WebView.
- The ✕ of a modal answered only when the user missed the icon. An icon-only
  button is clicked on its `<svg>`, and an `SVGElement` is not an `HTMLElement`,
  so the old filter dropped exactly the clicks that were meant to close it.
- A refresh no longer moves the chosen location into another card. The card the
  user picked from owns the choice while it exists; the endpoint key now carries
  transport, security, SNI, flow, path and the two REALITY fields, because
  providers put several locations on one endpoint and separate them only by those;
  when several locations still share a key, the tie is broken by the label the
  user chose rather than by the order in the provider's list.
- Android: ask a profile's resolver over a transport the proxy actually carries.
  Full JSON profiles hard-wire `8.8.8.8`-style UDP resolvers and the client
  forces every resolver connection through the selected proxy -- the anti-leak
  invariant -- but forwarded UDP/53 is what proxy servers routinely drop. A
  client log said it exactly: `from DNS accepted udp:8.8.8.8:53 [... -> proxy]`
  followed by `app/observatory/burst: error ping
  http://www.gstatic.com/generate_204 with proxy: context deadline exceeded` for
  every member of the profile. The tunnel is up, the resolver is not, so the
  observatory cannot resolve its own probe URL, the balancer keeps the profile's
  fallback outbound, and every lookup in every app hangs -- "latency is green,
  nothing works", working again on its own once a UDP query happens through.
  Across Proxen's fleet UDP DNS answered on 9 of 23 endpoints, TCP on 16 and DoH
  on 16. A plain IP resolver now becomes DoH of the same operator first, then the
  same IP over TCP, then the provider's own UDP entry: one set per operator,
  still forced through the proxy, nothing substituted. With UDP/53 blocked in a
  test config, the old plan resolved 0 of 11 endpoints and the new one resolved 9
  of 11 -- the two remaining do not carry proxy traffic either.
- Android: the client no longer picks a different country by itself. A refresh
  regenerates every location id, so the chosen one was re-found by its endpoint
  (`protocol:host:port:uuid`) -- and a composite JSON profile exposes its FIRST
  proxy outbound as that host, which is exactly what a provider rotates: when
  Proxen moved the primary of «США», the stored endpoint matched nothing and the
  selection fell back to the first location of the first subscription, so the
  active location jumped to another country on its own. The selection is now
  re-found by endpoint and then by the location label inside the same
  subscription; a location that really vanished leaves nothing selected and says
  so instead of choosing another one, and its identity is kept, so an update that
  brings it back restores the choice.
- Android: the xray row in Settings states its status without the essay about
  why the core version cannot be changed there; the version manager stays
  hidden, since there is nothing on that screen for the user to act on.

## 0.3.2

- Android: a location whose profile resolves through Quad9 reported n/a while
  it carried traffic normally. Latency is only shown when both an ordinary web
  request and the profile's own DNS-over-HTTPS resolver answer through the same
  path, but `reqwest` was built without `http2` and `9.9.9.9/dns-query` -- the
  default resolver -- rejects a HTTP/1.1 `application/dns-message` POST with
  `505`, so no location on the default resolver ever showed a number. The
  resolver is now asked in the first probe round and dropped in the second,
  which measures the proxy path alone: a provider that refuses it costs the
  probe five seconds and not its latency.
- Android: the TUN is now IPv4-only (the same default as v2rayNG). On the vast
  majority of proxy servers — which have IPv4-only egress — apps that prefer
  IPv6 (YouTube, Google Play, ...) were getting AAAA records from their own
  DoH/DoT resolvers, and every IPv6 attempt died at the remote server with
  "network is unreachable". Without an IPv6 address/route on the TUN, an app's
  IPv6 attempt is dropped locally in milliseconds and Happy-Eyeballs falls
  back to IPv4, fixing Google/YouTube on HY2 locations.
- Android: the Xray core stays bundled with the APK (marked "Bundled",
  immutable). Android 10+ refuses to execute binaries downloaded into the app's
  private storage (the OS W^X policy), so the version manager is hidden on
  Android; a stale downloaded-core selection self-heals to the bundled core
  instead of breaking the connect.
- Android: a real in-app kill switch (Settings → General, on by default). When
  the core dies unexpectedly, Varmlen now keeps the VPN session alive — captured
  traffic is blocked, nothing leaks direct — and retries the core every 15 s,
  with the notification showing "Tunnel down — traffic blocked, retrying…" and
  the UI reporting the blocked "dropped" state. With the kill switch off the
  old fail-open behaviour is kept (VPN tears down, traffic goes direct).
  Android's system-level Always-on VPN / Block connections without VPN remains
  available as an optional extra (it also covers Varmlen being closed).

## 0.3.1

- Use hostname-based Cloudflare and Google DoH with static bootstrap addresses
  and parallel fallback, avoiding DNS stalls on routes that reject HTTPS to a
  bare IP while keeping every resolver connection inside the VPN.
- Accept provider hostname DNS only with an explicit public-IP bootstrap,
  preserve compatible provider DNS fields, and apply the Google APIs hostname
  compatibility mapping used by established Xray clients.
- Keep Android latency checks parallel but cap temporary Xray processes, allow
  HY2/QUIC cold starts more time, and use independent HTTP 204 probes to avoid
  false `n/a` results when one connectivity-check host is unavailable.
- Measure Hysteria2, WireGuard, mKCP and QUIC locations through their real
  proxy path instead of failing an inapplicable TCP-connect probe.
- Keep the APK-bundled core on stable Xray 26.3.27. The first 0.3.1 asset
  briefly bundled prerelease 26.7.28 and was replaced (versionCode 3013
  updates it on installed devices). Known trade-off: 26.3.27 predates the
  Hysteria client-reuse and native-TUN UDP FullCone dataplane fixes, so
  QUIC-heavy apps on HY2 locations may remain partially offline.
- Preserve public literal-IP DNS servers from full JSON profiles, including
  ordinary UDP DNS such as `8.8.8.8`, and force them through the selected
  proxy instead of silently replacing them with Cloudflare DoH.
- Preserve a full JSON location's safe public DNS-over-HTTPS resolver instead
  of replacing it with Cloudflare, fixing Hysteria2 profiles whose tunnel can
  reach the provider resolver but not `1.1.1.1`.
- Probe the effective resolver from the imported profile before reporting a
  location as reachable.
- Keep non-site provider routing such as protocol, public-IP, and port policy;
  Varmlen still owns website/app split, the final route, native TUN capture,
  LAN permission, and DNS leak prevention.
- Treat a location as reachable only when ordinary HTTP traffic and the same
  Cloudflare DNS-over-HTTPS path used by the active tunnel both work through
  one concrete proxy outbound.
- Keep composite-profile probes parallel and report the fastest fully usable
  outbound instead of accepting a path that can connect but cannot resolve DNS.
- Validate full proxy and DNS health even when displaying raw TCP latency, so a
  reachable server socket no longer appears as a working VPN location.

## 0.3.0

- Increment the APK revision so existing 0.3.0 installations can update to
  this corrected build without uninstalling.
- Stop rejecting a running VPN because a synthetic Internet probe failed or a
  composite profile's balancer was still warming up.
- Remove unsupported Android `SO_MARK` from Xray outbounds and bind those
  outbounds to the physical interface when Android lockdown is enabled.
- Open the Android VPN settings reliably for Always-on VPN and lockdown,
  including an OEM settings fallback.
- Pin the APK-bundled core to stable Xray 26.3.27 and clearly identify it as
  APK-managed instead of exposing nonfunctional download/version controls.
- Treat every successful subscription response as authoritative: quota, usage,
  and expiry values omitted by the provider are now cleared instead of showing
  stale data from an earlier refresh.
- Wait for Android to publish a validated default network, then bind DNS and
  the subscription request to it, fixing first-launch imports without retries.
- Add the official ISRG Root X2 trust anchor alongside Android system roots so
  Let's Encrypt X2-only subscription endpoints work on Android versions below 14.
- Structurally validate generated Xray configurations before touching the VPN,
  without making an external test destination part of connection startup.
- Pin subscription DNS, validate redirects, and bound response downloads.
- Harden raw JSON handling, rotated logs, connection teardown, and the Android
  VPN lifecycle.

## 0.2.6

- Removed the user-facing local Proxy mode and its embedded
  `hev-socks5-tunnel` bridge. Android now passes its `VpnService` TUN file
  descriptor directly to Xray's native TUN inbound.
- Removed the local SOCKS data plane, JNI service, fixed SOCKS port, and native
  bridge library. Remote SOCKS server configurations remain supported.
- Keep Android per-app split in `VpnService`, including UDP traffic, while Xray
  applies site routing and DNS policy.
- Capture IPv4 and IPv6 through the VPN and preserve fail-closed reconnects by
  establishing the replacement TUN before retiring the previous data plane.
- Use loopback HTTP inbounds for via-proxy latency probes.
- Launch Xray through a native Rust/JNI bridge so the duplicated
  `VpnService` TUN descriptor survives exec instead of being closed by
  Android's Java process launcher.

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
