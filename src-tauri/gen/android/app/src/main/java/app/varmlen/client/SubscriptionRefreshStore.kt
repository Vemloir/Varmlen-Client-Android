package app.varmlen.client

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

data class SubscriptionRefreshSchedule(
    val id: String,
    val url: String,
    /** Selected client identity: varmlen / happ / incy / v2raytun. */
    val userAgent: String,
    val intervalHours: Int,
    val lastSuccessAt: Long,
    val nextUpdateAt: Long,
)

data class StagedSubscriptionResponse(
    val id: String,
    val body: String,
    val headers: Map<String, String>,
    val refreshedAt: Long,
)

fun subscriptionRefreshWorkName(id: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
        .digest(id.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
        .take(40)
    return "varmlen-subscription-refresh-$digest"
}

fun boundedSubscriptionRefreshError(message: String): String = message.take(512)

fun subscriptionRefreshUserAgent(choice: String, abi: String): String {
    val brand = when (choice.lowercase()) {
        "happ" -> "Happ"
        "incy" -> "INCY"
        "v2raytun" -> "v2rayTun"
        else -> "Varmlen"
    }
    val architecture = when (abi.lowercase()) {
        "arm64-v8a", "aarch64" -> "arm64"
        "armeabi-v7a", "armv7", "arm" -> "armv7"
        "x86_64", "amd64" -> "x86_64"
        "x86", "i686" -> "x86"
        else -> abi.lowercase().ifBlank { "unknown" }
    }
    return "$brand/Android/$architecture"
}

fun mergeSubscriptionRefreshSchedules(
    previous: List<SubscriptionRefreshSchedule>,
    incoming: List<SubscriptionRefreshSchedule>,
): List<SubscriptionRefreshSchedule> {
    val previousById = previous.associateBy { it.id }
    return incoming.map { next ->
        previousById[next.id]
            ?.takeIf {
                it.url == next.url &&
                    it.userAgent == next.userAgent &&
                    it.intervalHours == next.intervalHours &&
                    it.lastSuccessAt == next.lastSuccessAt
            }
            ?: next
    }
}

/** App-private, process-safe enough store for WorkManager schedules and staged
 * responses. Every replacement is written and fsynced before rename. */
class SubscriptionRefreshStore(private val root: File) {
    constructor(context: Context) : this(context.filesDir)

    internal val scheduleFile = File(root, "subscription-refresh-schedules.json")
    private val stagedFile = File(root, "subscription-refresh-staged.json")

    init {
        root.mkdirs()
    }

    fun replaceSchedules(schedules: List<SubscriptionRefreshSchedule>) = synchronized(LOCK) {
        atomicWrite(scheduleFile, encodeSchedules(schedules).toString())
    }

    fun upsertSchedule(schedule: SubscriptionRefreshSchedule) = synchronized(LOCK) {
        val schedules = readSchedules()
            .filterNot { it.id == schedule.id }
            .plus(schedule)
        atomicWrite(scheduleFile, encodeSchedules(schedules).toString())
    }

    fun readSchedules(): List<SubscriptionRefreshSchedule> = synchronized(LOCK) {
        readArray(scheduleFile).mapNotNull(::decodeSchedule)
    }

    fun stage(response: StagedSubscriptionResponse) = synchronized(LOCK) {
        require(response.body.toByteArray(Charsets.UTF_8).size <= MAX_BODY_BYTES) {
            "subscription exceeded size limit"
        }
        val responses = readArray(stagedFile)
            .mapNotNull(::decodeResponse)
            .filterNot { it.id == response.id }
            .plus(response)
            .sortedByDescending { it.refreshedAt }
            .toMutableList()
        while (
            responses.size > 1 &&
            responses.sumOf { it.body.toByteArray(Charsets.UTF_8).size } > MAX_STAGED_BYTES
        ) {
            responses.removeLast()
        }
        atomicWrite(stagedFile, encodeResponses(responses).toString())
    }

    /** Read-and-clear. Clearing is committed first, so a failed disk write
     * cannot make the frontend apply the same response twice. */
    fun drain(): List<StagedSubscriptionResponse> = synchronized(LOCK) {
        val responses = readArray(stagedFile).mapNotNull(::decodeResponse)
        if (responses.isEmpty()) return@synchronized emptyList()
        atomicWrite(stagedFile, JSONArray().toString())
        responses
    }

    fun clearAll() = synchronized(LOCK) {
        atomicWrite(scheduleFile, JSONArray().toString())
        atomicWrite(stagedFile, JSONArray().toString())
    }

    private fun readArray(file: File): List<JSONObject> {
        if (!file.isFile) return emptyList()
        return try {
            val array = JSONArray(file.readText())
            buildList {
                for (index in 0 until array.length()) {
                    array.optJSONObject(index)?.let(::add)
                }
            }
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun atomicWrite(file: File, text: String) {
        root.mkdirs()
        val temporary = File(root, "${file.name}.tmp")
        FileOutputStream(temporary).use { output ->
            output.write(text.toByteArray(Charsets.UTF_8))
            output.fd.sync()
        }
        if (!temporary.renameTo(file)) {
            if (file.exists() && !file.delete()) {
                temporary.delete()
                error("could not replace ${file.name}")
            }
            if (!temporary.renameTo(file)) {
                temporary.delete()
                error("could not commit ${file.name}")
            }
        }
    }

    private fun encodeSchedules(items: List<SubscriptionRefreshSchedule>) = JSONArray().apply {
        items.forEach { item ->
            put(JSONObject().apply {
                put("id", item.id)
                put("url", item.url)
                put("userAgent", item.userAgent)
                put("intervalHours", item.intervalHours)
                put("lastSuccessAt", item.lastSuccessAt)
                put("nextUpdateAt", item.nextUpdateAt)
            })
        }
    }

    private fun decodeSchedule(value: JSONObject): SubscriptionRefreshSchedule? = try {
        SubscriptionRefreshSchedule(
            id = value.getString("id"),
            url = value.getString("url"),
            userAgent = value.getString("userAgent"),
            intervalHours = value.getInt("intervalHours"),
            lastSuccessAt = value.getLong("lastSuccessAt"),
            nextUpdateAt = value.getLong("nextUpdateAt"),
        ).takeIf {
            it.id.isNotBlank() &&
                it.url.isNotBlank() &&
                it.intervalHours > 0 &&
                it.lastSuccessAt > 0 &&
                it.nextUpdateAt > 0
        }
    } catch (_: Throwable) {
        null
    }

    private fun encodeResponses(items: List<StagedSubscriptionResponse>) = JSONArray().apply {
        items.forEach { item ->
            put(JSONObject().apply {
                put("id", item.id)
                put("body", item.body)
                put("refreshedAt", item.refreshedAt)
                put("headers", JSONObject(item.headers))
            })
        }
    }

    private fun decodeResponse(value: JSONObject): StagedSubscriptionResponse? = try {
        val rawHeaders = value.getJSONObject("headers")
        val headers = buildMap {
            rawHeaders.keys().forEach { key ->
                put(key, rawHeaders.optString(key))
            }
        }
        StagedSubscriptionResponse(
            id = value.getString("id"),
            body = value.getString("body"),
            headers = headers,
            refreshedAt = value.getLong("refreshedAt"),
        ).takeIf { it.id.isNotBlank() && it.refreshedAt > 0 }
    } catch (_: Throwable) {
        null
    }

    companion object {
        const val MAX_BODY_BYTES = 8 * 1024 * 1024
        private const val MAX_STAGED_BYTES = 16 * 1024 * 1024
        private val LOCK = Any()
    }
}
