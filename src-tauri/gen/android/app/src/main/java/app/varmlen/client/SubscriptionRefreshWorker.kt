package app.varmlen.client

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.TimeUnit

class SubscriptionRefreshWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val schedule =
            SubscriptionRefreshScheduler.scheduleFromInput(inputData) ?: return Result.failure()
        val store = SubscriptionRefreshStore(applicationContext)
        if (schedule !in store.readSchedules()) return Result.success()

        return try {
            val response = withContext(Dispatchers.IO) {
                fetchSubscription(schedule)
            }
            // Disable/remove may race an in-flight request. Never stage or
            // reschedule after the frontend has cancelled this subscription.
            if (schedule !in store.readSchedules()) return Result.success()
            val refreshedAt = System.currentTimeMillis()
            store.stage(
                StagedSubscriptionResponse(
                    id = schedule.id,
                    body = response.body,
                    headers = response.headers,
                    refreshedAt = refreshedAt,
                ),
            )
            val next = schedule.copy(
                lastSuccessAt = refreshedAt,
                nextUpdateAt = refreshedAt + TimeUnit.HOURS.toMillis(schedule.intervalHours.toLong()),
            )
            store.upsertSchedule(next)
            SubscriptionRefreshScheduler.enqueueNext(applicationContext, next)
            Result.success()
        } catch (error: Throwable) {
            Log.w(TAG, boundedSubscriptionRefreshError(error.message ?: error.javaClass.simpleName))
            if (schedule !in store.readSchedules()) return Result.success()
            if (runAttemptCount < MAX_RETRIES) {
                Result.retry()
            } else {
                val next = schedule.copy(
                    nextUpdateAt =
                        System.currentTimeMillis() +
                            TimeUnit.HOURS.toMillis(schedule.intervalHours.toLong()),
                )
                store.upsertSchedule(next)
                SubscriptionRefreshScheduler.enqueueNext(applicationContext, next)
                Result.success()
            }
        }
    }

    private fun fetchSubscription(schedule: SubscriptionRefreshSchedule): HttpResponse {
        var url = URL(schedule.url)
        repeat(MAX_REDIRECTS + 1) { redirect ->
            requireSafeRemote(url)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = HTTP_TIMEOUT_MS
                readTimeout = HTTP_TIMEOUT_MS
                requestMethod = "GET"
                setRequestProperty(
                    "User-Agent",
                    subscriptionRefreshUserAgent(
                        schedule.userAgent,
                        Build.SUPPORTED_ABIS.firstOrNull().orEmpty(),
                    ),
                )
                setRequestProperty("X-Device-OS", "android")
            }
            try {
                val status = connection.responseCode
                if (status in 300..399) {
                    check(redirect < MAX_REDIRECTS) { "too many redirects" }
                    val location = connection.getHeaderField("Location")
                        ?: error("redirect without Location")
                    url = URL(url, location)
                    return@repeat
                }
                check(status in 200..299) { "HTTP $status" }
                val announcedLength = connection.contentLengthLong
                check(
                    announcedLength < 0 ||
                        announcedLength <= SubscriptionRefreshStore.MAX_BODY_BYTES,
                ) { "subscription too large" }
                val output = ByteArrayOutputStream(
                    announcedLength.coerceIn(0, SubscriptionRefreshStore.MAX_BODY_BYTES.toLong())
                        .toInt(),
                )
                connection.inputStream.buffered().use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        check(output.size() <= SubscriptionRefreshStore.MAX_BODY_BYTES) {
                            "subscription exceeded size limit"
                        }
                    }
                }
                val headers = connection.headerFields
                    .filterKeys { it != null && it.lowercase() in RETAINED_HEADERS }
                    .mapNotNull { (name, values) ->
                        values.firstOrNull()?.take(MAX_HEADER_VALUE_LENGTH)
                            ?.let { name.lowercase() to it }
                    }
                    .toMap()
                return HttpResponse(
                    body = output.toByteArray().toString(Charsets.UTF_8),
                    headers = headers,
                )
            } finally {
                connection.disconnect()
            }
        }
        error("too many redirects")
    }

    private fun requireSafeRemote(url: URL) {
        check(url.protocol == "https" || url.protocol == "http") {
            "unsupported URL scheme"
        }
        val host = url.host.trim()
        check(host.isNotEmpty() && !host.equals("localhost", ignoreCase = true)) {
            "refusing to fetch a local address"
        }
        val addresses = InetAddress.getAllByName(host)
        check(addresses.isNotEmpty() && addresses.none(::isPrivateAddress)) {
            "refusing to fetch a local address"
        }
    }

    private fun isPrivateAddress(address: InetAddress): Boolean {
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
        if (bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc) return true
        return false
    }

    private data class HttpResponse(
        val body: String,
        val headers: Map<String, String>,
    )

    companion object {
        private const val TAG = "VarmlenSubRefresh"
        private const val HTTP_TIMEOUT_MS = 15_000
        private const val MAX_REDIRECTS = 5
        private const val MAX_RETRIES = 3
        private const val MAX_HEADER_VALUE_LENGTH = 8 * 1024
        private val RETAINED_HEADERS = setOf(
            "profile-title",
            "profile-update-interval",
            "subscription-userinfo",
            "support-url",
            "profile-web-page-url",
            "announce",
        )
    }
}

object SubscriptionRefreshScheduler {
    const val WORK_TAG = "varmlen-subscription-refresh"
    private const val KEY_ID = "id"
    private const val KEY_URL = "url"
    private const val KEY_USER_AGENT = "userAgent"
    private const val KEY_INTERVAL_HOURS = "intervalHours"
    private const val KEY_LAST_SUCCESS_AT = "lastSuccessAt"
    private const val KEY_NEXT_UPDATE_AT = "nextUpdateAt"

    fun sync(context: Context, schedules: List<SubscriptionRefreshSchedule>) {
        val store = SubscriptionRefreshStore(context)
        val previousItems = store.readSchedules()
        val previous = previousItems.associateBy { it.id }
        val effective = mergeSubscriptionRefreshSchedules(previousItems, schedules)
        store.replaceSchedules(effective)
        val workManager = WorkManager.getInstance(context)
        val incomingIds = schedules.mapTo(HashSet()) { it.id }
        previous.keys
            .filterNot(incomingIds::contains)
            .forEach { workManager.cancelUniqueWork(subscriptionRefreshWorkName(it)) }
        effective.forEach { schedule ->
            val unchanged = previous[schedule.id] == schedule
            workManager.enqueueUniqueWork(
                subscriptionRefreshWorkName(schedule.id),
                if (unchanged) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE,
                request(schedule),
            )
        }
    }

    fun cancelAll(context: Context) {
        SubscriptionRefreshStore(context).clearAll()
        WorkManager.getInstance(context).cancelAllWorkByTag(WORK_TAG)
    }

    fun enqueueNext(context: Context, schedule: SubscriptionRefreshSchedule) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            subscriptionRefreshWorkName(schedule.id),
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request(schedule),
        )
    }

    private fun request(
        schedule: SubscriptionRefreshSchedule,
        now: Long = System.currentTimeMillis(),
    ): OneTimeWorkRequest =
        OneTimeWorkRequestBuilder<SubscriptionRefreshWorker>()
            .setInputData(
                Data.Builder()
                    .putString(KEY_ID, schedule.id)
                    .putString(KEY_URL, schedule.url)
                    .putString(KEY_USER_AGENT, schedule.userAgent)
                    .putInt(KEY_INTERVAL_HOURS, schedule.intervalHours)
                    .putLong(KEY_LAST_SUCCESS_AT, schedule.lastSuccessAt)
                    .putLong(KEY_NEXT_UPDATE_AT, schedule.nextUpdateAt)
                    .build(),
            )
            .setInitialDelay((schedule.nextUpdateAt - now).coerceAtLeast(0), TimeUnit.MILLISECONDS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .addTag(WORK_TAG)
            .build()

    internal fun scheduleFromInput(data: Data): SubscriptionRefreshSchedule? {
        val id = data.getString(KEY_ID).orEmpty()
        val url = data.getString(KEY_URL).orEmpty()
        val userAgent = data.getString(KEY_USER_AGENT).orEmpty()
        val intervalHours = data.getInt(KEY_INTERVAL_HOURS, 0)
        val lastSuccessAt = data.getLong(KEY_LAST_SUCCESS_AT, 0)
        val nextUpdateAt = data.getLong(KEY_NEXT_UPDATE_AT, 0)
        return SubscriptionRefreshSchedule(
            id = id,
            url = url,
            userAgent = userAgent,
            intervalHours = intervalHours,
            lastSuccessAt = lastSuccessAt,
            nextUpdateAt = nextUpdateAt,
        ).takeIf {
            it.id.isNotBlank() &&
                it.url.isNotBlank() &&
                it.intervalHours > 0 &&
                it.lastSuccessAt > 0 &&
                it.nextUpdateAt > 0
        }
    }
}
