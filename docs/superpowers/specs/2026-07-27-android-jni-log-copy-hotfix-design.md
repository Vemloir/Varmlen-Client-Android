# Android JNI and log-copy hotfix design

## Goal

Replace the broken Android 0.2.0 release with a corrected build that restores
tun2socks startup in release builds and lets a user copy the complete VPN log
from the existing log viewer.

## Confirmed root cause

The pinned `hev-socks5-tunnel` JNI table registers these instance methods on
`app.varmlen.client.TProxyService`:

- `TProxyStartService(String, int): boolean`
- `TProxyStopService(): boolean`
- `TProxyIsRunning(): boolean`
- `TProxyGetStats(): long[]`

The 0.2.0 release DEX instead declares `Start` and `Stop` with a `void` return
type and omits `IsRunning`. `RegisterNatives` therefore fails during
`System.loadLibrary`, producing the reported `NoSuchMethodError`. R8 preserved
the class and native method names; it is not the cause.

## Native fix

`TProxyService.kt` will mirror all four pinned JNI descriptors exactly. VPN
startup will treat a `false` result from `TProxyStartService` as a connection
failure and use the existing fail-closed cleanup path. Shutdown will continue
cleaning up the VPN even if native stop reports failure, while recording that
failure in the VPN log.

The release gate will inspect the built APK's DEX and bundled native library so
that a future Kotlin/native descriptor mismatch fails before publication.

## Copy-log behavior

The existing log modal receives a third action, **Copy** / **Копировать**.

- It copies exactly the complete text currently displayed in the modal.
- It does not refresh implicitly.
- It is disabled when the displayed log is empty.
- Android writes through a native clipboard command because WebView clipboard
  access is unreliable.
- Desktop keeps using the browser clipboard.
- Success changes the label to **Copied** / **Скопировано** for 1.5 seconds.
- Failure changes it to **Copy failed** / **Ошибка копирования** for 1.5
  seconds without clearing or modifying the displayed log.

## Tests and release validation

1. A JVM reflection test asserts all four `TProxyService` method descriptors.
   It must fail against 0.2.0 before the Kotlin declaration is fixed.
2. A TypeScript unit test asserts that log copying writes the exact displayed
   text, rejects empty text, and reports clipboard failures.
3. Existing Rust, TypeScript, Svelte, Kotlin, manifest, VPN-contract, native
   dependency, and APK-content gates remain required.
4. A signed arm64 APK is rebuilt as version 0.2.0 with `versionCode = 2000`.
   No live VPN,
   reconnect, public-IP, or DNS tests are run on the development host.

The existing Android GitHub release and tag are deleted only after the
replacement artifacts and signatures pass. The corrected commit is then tagged
`v0.2.0` and the release is recreated under the same URL. The Linux repository
and Linux 0.2.0 release are not changed.
