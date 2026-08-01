package app.varmlen.client

import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request

internal const val MAX_SUBSCRIPTION_BODY_BYTES = 8 * 1024 * 1024
internal const val MAX_SUBSCRIPTION_REDIRECTS = 5

private const val SUBSCRIPTION_HTTP_TIMEOUT_MS = 15_000L
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
 * Interactive imports and WorkManager refreshes use one implementation. Every
 * redirect is resolved and checked before a new client is built; that client
 * can connect only to the exact addresses that passed the policy. OkHttp keeps
 * the original URL hostname for Host, TLS SNI, and certificate verification.
 */
internal fun fetchSubscriptionHttp(
    sourceUrl: String,
    userAgent: String,
    deviceOs: String = "android",
): SubscriptionHttpResponse {
    var url = URL(sourceUrl)
    repeat(MAX_SUBSCRIPTION_REDIRECTS + 1) { redirect ->
        val approved = approvedSubscriptionAddresses(url)
        val client = OkHttpClient.Builder()
            .dns(PinnedSubscriptionDns(url.host, approved))
            .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(SUBSCRIPTION_HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(SUBSCRIPTION_HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(SUBSCRIPTION_HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(SUBSCRIPTION_HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
        val request = Request.Builder()
            .url(url.toString())
            .get()
            .header("User-Agent", userAgent)
            .header("X-Device-OS", deviceOs)
            .build()

        client.newCall(request).execute().use { response ->
            if (response.code in 300..399) {
                check(redirect < MAX_SUBSCRIPTION_REDIRECTS) { "too many redirects" }
                val location = response.header("Location")
                    ?: error("redirect without Location")
                url = URL(url, location)
                return@repeat
            }
            check(response.isSuccessful) { "HTTP ${response.code}" }
            val body = response.body ?: error("empty subscription response")
            val announcedLength = body.contentLength()
            check(
                announcedLength < 0 || announcedLength <= MAX_SUBSCRIPTION_BODY_BYTES,
            ) { "subscription too large" }

            val output = ByteArrayOutputStream(
                announcedLength.coerceIn(0, MAX_SUBSCRIPTION_BODY_BYTES.toLong()).toInt(),
            )
            body.byteStream().buffered().use { input ->
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
            val headers = RETAINED_SUBSCRIPTION_HEADERS.mapNotNull { name ->
                response.header(name)
                    ?.take(MAX_SUBSCRIPTION_HEADER_VALUE_LENGTH)
                    ?.let { name to it }
            }.toMap()
            return SubscriptionHttpResponse(
                body = output.toByteArray().toString(Charsets.UTF_8),
                headers = headers,
            )
        }
    }
    error("too many redirects")
}

internal class PinnedSubscriptionDns(
    private val hostname: String,
    private val approved: List<InetAddress>,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(this.hostname, ignoreCase = true) || approved.isEmpty()) {
            throw UnknownHostException("hostname was not approved for this request")
        }
        return approved
    }
}

internal fun approvedSubscriptionAddresses(url: URL): List<InetAddress> {
    check(url.protocol == "https" || url.protocol == "http") {
        "unsupported URL scheme"
    }
    check(url.userInfo.isNullOrEmpty()) {
        "refusing a subscription URL with embedded credentials"
    }
    val host = url.host.trim()
    check(host.isNotEmpty() && !host.equals("localhost", ignoreCase = true)) {
        "refusing to fetch a local address"
    }
    val addresses = InetAddress.getAllByName(host).toList()
    check(addresses.isNotEmpty() && addresses.none(::isBlockedSubscriptionAddress)) {
        "refusing to fetch a non-public address"
    }
    return addresses
}

internal fun isBlockedSubscriptionAddress(address: InetAddress): Boolean {
    val normalized = normalizeMappedIpv4(address)
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
        val first = octets[0]
        val second = octets[1]
        val third = octets[2]
        return when {
            first == 0 -> true
            first == 10 -> true
            first == 100 && second in 64..127 -> true
            first == 127 -> true
            first == 169 && second == 254 -> true
            first == 172 && second in 16..31 -> true
            first == 192 && second == 0 && (third == 0 || third == 2) -> true
            first == 192 && second == 88 && third == 99 -> true
            first == 192 && second == 168 -> true
            first == 198 && second in 18..19 -> true
            first == 198 && second == 51 && third == 100 -> true
            first == 203 && second == 0 && third == 113 -> true
            first >= 224 -> true
            else -> false
        }
    }
    if (normalized is Inet6Address) {
        val bytes = normalized.address
        val first = bytes[0].toInt() and 0xff
        val second = bytes[1].toInt() and 0xff
        val documentation = first == 0x20 && second == 0x01 &&
            (bytes[2].toInt() and 0xff) == 0x0d &&
            (bytes[3].toInt() and 0xff) == 0xb8
        return first and 0xfe == 0xfc || documentation
    }
    return true
}

private fun normalizeMappedIpv4(address: InetAddress): InetAddress {
    if (address !is Inet6Address) return address
    val bytes = address.address
    val mapped = bytes.size == 16 &&
        bytes.take(10).all { it == 0.toByte() } &&
        bytes[10] == 0xff.toByte() &&
        bytes[11] == 0xff.toByte()
    return if (mapped) InetAddress.getByAddress(bytes.copyOfRange(12, 16)) else address
}
