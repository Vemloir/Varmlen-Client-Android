package app.varmlen.client

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URL

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
        requireSafeSubscriptionRemote(url)
        val connection = (url.openConnection() as HttpURLConnection).apply {
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

internal fun requireSafeSubscriptionRemote(url: URL) {
    check(url.protocol == "https" || url.protocol == "http") {
        "unsupported URL scheme"
    }
    val host = url.host.trim()
    check(host.isNotEmpty() && !host.equals("localhost", ignoreCase = true)) {
        "refusing to fetch a local address"
    }
    val addresses = InetAddress.getAllByName(host)
    check(addresses.isNotEmpty() && addresses.none(::isPrivateSubscriptionAddress)) {
        "refusing to fetch a local address"
    }
}

private fun isPrivateSubscriptionAddress(address: InetAddress): Boolean {
    if (
        address.isAnyLocalAddress ||
        address.isLoopbackAddress ||
        address.isLinkLocalAddress ||
        address.isSiteLocalAddress ||
        address.isMulticastAddress
    ) {
        return true
    }
    if (address is Inet4Address) {
        val octets = address.address.map { it.toInt() and 0xff }
        return octets[0] == 100 && octets[1] in 64..127
    }
    val bytes = address.address
    return bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc
}
