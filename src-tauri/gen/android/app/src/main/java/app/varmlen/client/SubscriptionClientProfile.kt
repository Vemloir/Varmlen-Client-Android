package app.varmlen.client

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Calendar
import java.util.Locale

/**
 * What a subscription request looks like for the client the user chose to
 * present as.
 *
 * Providers decide what to serve -- and some whether to serve at all -- by the
 * client asking, and they look at more than the User-Agent. Varmlen asks as
 * itself by default; it can also send the headers Happ, INCY or V2RayTun send
 * when they add or refresh a subscription, in their order and spelling. Happ's
 * and INCY's requests are the ones Happ 4.8.0 and INCY 3.7.9 sent to a
 * capturing server; V2RayTun's is read from V2RayTun 5.25.81 by static
 * analysis.
 * OkHttp then adds Host and Accept-Encoding after them, as it does for the
 * real clients.
 * Every value that describes the device is this device's own: its ANDROID_ID
 * (unique per app signing key and device since Android 8), release, maker,
 * model and locale. A provider's device limit therefore counts this phone
 * once, as it would the real client.
 *
 * Happ's own backend also expects an X-Credential JWT signed with a secret
 * from its native library; Happ does not send it to other subscription
 * servers, and it is not reproduced.
 */
internal data class SubscriptionDeviceFacts(
    val androidId: String,
    val release: String,
    val manufacturer: String,
    val brand: String,
    val model: String,
    val locale: Locale,
    val dayOfMonth: Int,
    val television: Boolean,
    val abi: String,
)

/** The client versions whose requests were captured or analysed. A newer
 *  release may change its headers, so these move only with a fresh capture. */
internal const val HAPP_MIMIC_VERSION = "4.8.0"

/** Happ's User-Agent token is fixed per build -- it opens with the build's
 *  Unix time -- except for one digit that follows the day of the month. */
private const val HAPP_TOKEN_HEAD = "17921395329952009"
private const val HAPP_TOKEN_TAIL = "31"
internal const val INCY_MIMIC_VERSION = "3.7.9"
internal const val V2RAYTUN_MIMIC_VERSION = "5.25.81"

internal fun subscriptionRequestHeaders(
    choice: String,
    facts: SubscriptionDeviceFacts,
): List<Pair<String, String>> = when (choice.lowercase(Locale.ROOT)) {
    "happ" -> listOf(
        "Connection" to "close",
        "User-agent" to happUserAgent(facts),
        "X-Device-Locale" to facts.locale.language,
        "X-HWID" to facts.androidId,
        "X-Device-OS" to happPlatform(facts),
        "X-Ver-OS" to facts.release,
        "X-Device-model" to facts.model,
    )
    "incy" -> listOf(
        "User-Agent" to "INCY/$INCY_MIMIC_VERSION/android Dalvik/2.1.0",
        "Accept" to "*/*",
        "Accept-Language" to facts.locale.toLanguageTag(),
        "x-hwid" to incyHwid(facts.androidId),
        "x-device-os" to "Android",
        "x-ver-os" to facts.release,
        "x-device-model" to "${facts.manufacturer} ${facts.model}",
        "x-app-version" to INCY_MIMIC_VERSION,
        "x-device-locale" to facts.locale.toString(),
        "x-client" to "INCY",
    )
    "v2raytun" -> listOf(
        "User-agent" to "v2raytun/android",
        "X-HWID" to facts.androidId.uppercase(Locale.ROOT),
        "X-Device-OS" to "Android",
        "X-Ver-OS" to "Android ${facts.release}",
        "X-Device-Model" to "${facts.brand} ${facts.model}",
        "X-App-Version" to V2RAYTUN_MIMIC_VERSION,
    )
    else -> listOf(
        "User-Agent" to subscriptionRefreshUserAgent("varmlen", facts.abi),
        "X-Device-OS" to "android",
    )
}.map { (name, value) -> name to headerSafe(value) }

/**
 * `Happ/<version>/<Android|AndroidTV>/<token>`, where the token's third digit
 * from the end follows the parity of the day of the month: 6 on even days, 5
 * on odd.
 */
internal fun happUserAgent(facts: SubscriptionDeviceFacts): String {
    val parity = if (facts.dayOfMonth % 2 == 0) "6" else "5"
    return "Happ/$HAPP_MIMIC_VERSION/${happPlatform(facts)}/$HAPP_TOKEN_HEAD$parity$HAPP_TOKEN_TAIL"
}

/**
 * INCY's HWID is sixteen bytes written as an upper-case UUID
 * (`5BB0A38F-106D-678C-4643-999D6BC97C00`), not a well-formed one: its version
 * and variant digits are arbitrary. How INCY derives them is not visible, so
 * this device's are a hash of its ANDROID_ID -- the same on every request.
 */
internal fun incyHwid(androidId: String): String {
    val hex = MessageDigest.getInstance("SHA-256")
        .digest("incy-hwid:$androidId".toByteArray(Charsets.UTF_8))
        .take(16)
        .joinToString("") { "%02X".format(it) }
    return listOf(hex.substring(0, 8), hex.substring(8, 12), hex.substring(12, 16),
        hex.substring(16, 20), hex.substring(20, 32)).joinToString("-")
}

private fun happPlatform(facts: SubscriptionDeviceFacts): String =
    if (facts.television) "AndroidTV" else "Android"

/** OkHttp refuses header values outside printable ASCII; a device model can
 *  carry other characters, and a refused request would fail the import. */
private fun headerSafe(value: String): String =
    value.map { if (it in ' '..'~') it else '?' }.joinToString("").trim()

internal fun currentSubscriptionDeviceFacts(context: Context): SubscriptionDeviceFacts =
    SubscriptionDeviceFacts(
        androidId = deviceHwid(context),
        release = Build.VERSION.RELEASE.orEmpty(),
        manufacturer = Build.MANUFACTURER.orEmpty(),
        brand = Build.BRAND.orEmpty(),
        model = Build.MODEL.orEmpty(),
        locale = Locale.getDefault(),
        dayOfMonth = Calendar.getInstance().get(Calendar.DAY_OF_MONTH),
        television = context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK),
        abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty(),
    )

private const val DEVICE_PREFERENCES = "varmlen_device"
private const val FALLBACK_HWID_KEY = "fallbackHwid"

/** ANDROID_ID, or a random one generated once and kept when the platform
 *  reports none, so the device still counts as one. */
@SuppressLint("HardwareIds")
private fun deviceHwid(context: Context): String {
    val androidId = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ANDROID_ID,
    )
    if (!androidId.isNullOrBlank()) return androidId
    val preferences = context.getSharedPreferences(DEVICE_PREFERENCES, Context.MODE_PRIVATE)
    preferences.getString(FALLBACK_HWID_KEY, null)?.let { return it }
    val bytes = ByteArray(8).also { SecureRandom().nextBytes(it) }
    val generated = bytes.joinToString("") { "%02x".format(it) }
    preferences.edit().putString(FALLBACK_HWID_KEY, generated).apply()
    return generated
}
