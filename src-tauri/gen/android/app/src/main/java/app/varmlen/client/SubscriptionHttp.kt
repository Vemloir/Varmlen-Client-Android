package app.varmlen.client

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Socket
import java.net.URL
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

internal const val MAX_SUBSCRIPTION_BODY_BYTES = 8 * 1024 * 1024
internal const val MAX_SUBSCRIPTION_REDIRECTS = 5

private const val SUBSCRIPTION_HTTP_TIMEOUT_MS = 15_000
private const val MAX_SUBSCRIPTION_HEADER_VALUE_LENGTH = 8 * 1024
private val RETAINED_SUBSCRIPTION_HEADERS = setOf(
    "profile-title",
    "profile-update-interval",
    "subscription-userinfo",
    "support-url",
    "profile-web-page-url",
    "announce",
)

internal data class SubscriptionHttpResponse(
    val body: String,
    val headers: Map<String, String>,
)

/**
 * Fetch through Android's platform HTTP/TLS stack. Interactive imports and
 * WorkManager refreshes deliberately share this path so providers see the same
 * TLS client and redirect/SSRF/body-size policy in both cases.
 */
internal fun fetchSubscriptionHttp(
    sourceUrl: String,
    userAgent: String,
    deviceOs: String = "android",
): SubscriptionHttpResponse {
    var url = URL(sourceUrl)
    repeat(MAX_SUBSCRIPTION_REDIRECTS + 1) { redirect ->
        // Resolve + validate ONCE per hop, then connect to that exact,
        // pre-validated address (openPinnedConnection). Without pinning,
        // HttpURLConnection would resolve `url.host` again on its own at
        // connect time — a second, independent lookup that can return a
        // different (private/local) answer than the one just checked here
        // (DNS rebinding / TOCTOU).
        val pinnedAddress = requireSafeSubscriptionRemote(url)
        val connection = openPinnedConnection(url, pinnedAddress).apply {
            instanceFollowRedirects = false
            connectTimeout = SUBSCRIPTION_HTTP_TIMEOUT_MS
            readTimeout = SUBSCRIPTION_HTTP_TIMEOUT_MS
            requestMethod = "GET"
            useCaches = false
            setRequestProperty("User-Agent", userAgent)
            setRequestProperty("X-Device-OS", deviceOs)
        }
        try {
            val status = connection.responseCode
            if (status in 300..399) {
                check(redirect < MAX_SUBSCRIPTION_REDIRECTS) { "too many redirects" }
                val location = connection.getHeaderField("Location")
                    ?: error("redirect without Location")
                url = URL(url, location)
                return@repeat
            }
            check(status in 200..299) { "HTTP $status" }

            val announcedLength = connection.contentLengthLong
            check(
                announcedLength < 0 ||
                    announcedLength <= MAX_SUBSCRIPTION_BODY_BYTES,
            ) { "subscription too large" }
            val output = ByteArrayOutputStream(
                announcedLength.coerceIn(0, MAX_SUBSCRIPTION_BODY_BYTES.toLong()).toInt(),
            )
            connection.inputStream.buffered().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    check(output.size() <= MAX_SUBSCRIPTION_BODY_BYTES) {
                        "subscription exceeded size limit"
                    }
                }
            }
            val headers = connection.headerFields
                .filterKeys {
                    it != null && it.lowercase() in RETAINED_SUBSCRIPTION_HEADERS
                }
                .mapNotNull { (name, values) ->
                    values.firstOrNull()
                        ?.take(MAX_SUBSCRIPTION_HEADER_VALUE_LENGTH)
                        ?.let { name.lowercase() to it }
                }
                .toMap()
            return SubscriptionHttpResponse(
                body = output.toByteArray().toString(Charsets.UTF_8),
                headers = headers,
            )
        } finally {
            connection.disconnect()
        }
    }
    error("too many redirects")
}

/** Resolve, validate and return ONE safe address for `url`'s host. The
 *  caller must connect to exactly this address (see openPinnedConnection) —
 *  returning it (instead of just checking and discarding it) is what lets
 *  the actual connection be pinned to what was validated. */
internal fun requireSafeSubscriptionRemote(url: URL): InetAddress {
    check(url.protocol == "https" || url.protocol == "http") {
        "unsupported URL scheme"
    }
    // A URL with embedded credentials (`http://user:pass@host/...`) can be
    // used to smuggle a different intended host into some HTTP stacks.
    check(url.userInfo.isNullOrEmpty()) {
        "refusing a subscription URL with embedded credentials"
    }
    val host = url.host.trim()
    check(host.isNotEmpty() && !host.equals("localhost", ignoreCase = true)) {
        "refusing to fetch a local address"
    }
    val addresses = InetAddress.getAllByName(host)
    val safe = addresses.filterNot(::isPrivateSubscriptionAddress)
    check(safe.isNotEmpty()) { "refusing to fetch a local address" }
    return safe.first()
}

private fun isPrivateSubscriptionAddress(address: InetAddress): Boolean {
    // Normalize IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to plain IPv4 first, so
    // it goes through the exact same checks (including CGNAT below) as a
    // literal IPv4 address instead of only the generic IPv6 checks.
    val normalized: InetAddress = (address as? Inet6Address)?.let { v6 ->
        val bytes = v6.address
        val isV4Mapped = bytes.size == 16 &&
            bytes.take(10).all { it == 0.toByte() } &&
            bytes[10] == 0xff.toByte() && bytes[11] == 0xff.toByte()
        if (isV4Mapped) InetAddress.getByAddress(bytes.copyOfRange(12, 16)) else null
    } ?: address

    if (
        normalized.isAnyLocalAddress ||
        normalized.isLoopbackAddress ||
        normalized.isLinkLocalAddress ||
        normalized.isSiteLocalAddress ||
        normalized.isMulticastAddress
    ) {
        return true
    }
    if (normalized is Inet4Address) {
        val octets = normalized.address.map { it.toInt() and 0xff }
        return octets[0] == 100 && octets[1] in 64..127 // CGNAT (RFC 6598)
    }
    val bytes = normalized.address
    return bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc // ULA fc00::/7
}

/** Opens a connection to `pinnedAddress` — the exact address that was just
 *  validated — while preserving the original hostname for the HTTP `Host`
 *  header, TLS SNI, and certificate hostname verification. This is the part
 *  that actually closes the DNS-rebinding/TOCTOU gap: HttpURLConnection
 *  normally re-resolves `url.host` on its own at connect time, which can
 *  silently return a different (private/local) address than the one that
 *  was just checked. */
private fun openPinnedConnection(url: URL, pinnedAddress: InetAddress): HttpURLConnection {
    val originalHost = url.host
    val literalHost = if (pinnedAddress is Inet6Address) {
        "[${pinnedAddress.hostAddress}]"
    } else {
        pinnedAddress.hostAddress
    }
    val pinnedUrl = URL(url.protocol, literalHost, url.port, url.file)
    val connection = pinnedUrl.openConnection() as HttpURLConnection
    connection.setRequestProperty("Host", originalHost)
    if (connection is HttpsURLConnection) {
        connection.sslSocketFactory = SniPinningSocketFactory(
            originalHost,
            HttpsURLConnection.getDefaultSSLSocketFactory(),
        )
        connection.hostnameVerifier = HostnameVerifier { _, session ->
            HttpsURLConnection.getDefaultHostnameVerifier().verify(originalHost, session)
        }
    }
    return connection
}

/** Forces the TLS SNI server name (and, via the caller's HostnameVerifier,
 *  certificate validation) to the real subscription hostname, even though
 *  the socket itself connects to a pinned IP literal. Without this, the
 *  origin would see the IP as the TLS server name and the platform verifier
 *  would check the certificate against that IP instead of the real host. */
private class SniPinningSocketFactory(
    private val sniHost: String,
    private val delegate: SSLSocketFactory,
) : SSLSocketFactory() {
    override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites
    override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites

    override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
        pinSni(delegate.createSocket(s, sniHost, port, autoClose))

    override fun createSocket(host: String, port: Int): Socket =
        pinSni(delegate.createSocket(host, port))

    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
        pinSni(delegate.createSocket(host, port, localHost, localPort))

    override fun createSocket(host: InetAddress, port: Int): Socket =
        pinSni(delegate.createSocket(host, port))

    override fun createSocket(
        address: InetAddress,
        port: Int,
        localAddress: InetAddress,
        localPort: Int,
    ): Socket = pinSni(delegate.createSocket(address, port, localAddress, localPort))

    private fun pinSni(socket: Socket): Socket {
        if (socket is SSLSocket) {
            try {
                val params = socket.sslParameters ?: SSLParameters()
                params.serverNames = listOf(SNIHostName(sniHost))
                socket.sslParameters = params
            } catch (_: Throwable) {
                // Best-effort: worst case the handshake uses the peer's
                // default vhost certificate; the HostnameVerifier above
                // still enforces it matches sniHost.
            }
        }
        return socket
    }
}
