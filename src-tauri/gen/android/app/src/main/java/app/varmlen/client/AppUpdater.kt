package app.varmlen.client

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray

/**
 * In-app updates from this repository's GitHub releases.
 *
 * Settings shows the newest stable release and the newest preview. Installing
 * one downloads its APK for this device's ABI, checks it against the SHA-256
 * GitHub publishes for the asset and against the signing certificate of the
 * installed app, and only then hands it to Android's package installer, which
 * asks the user. A tampered or foreign APK never reaches the installer.
 */
internal data class ReleaseCandidate(
    val tag: String,
    val version: String,
    val prerelease: Boolean,
    val publishedAt: String,
    val assetName: String,
    val url: String,
    val size: Long,
    val sha256: String,
)

internal data class ReleaseChoice(val stable: ReleaseCandidate?, val preview: ReleaseCandidate?)

private const val RELEASES_URL =
    "https://api.github.com/repos/Vemloir/Varmlen-Client-Android/releases?per_page=30"
private const val DOWNLOAD_PREFIX =
    "https://github.com/Vemloir/Varmlen-Client-Android/releases/download/"
private const val MAX_RELEASES_BYTES = 4L * 1024 * 1024
private const val MAX_APK_BYTES = 256L * 1024 * 1024

/** The APK asset suffix built for each ABI the releases ship. */
private fun assetSuffixes(abis: List<String>): List<String> =
    abis.mapNotNull {
        when (it) {
            "arm64-v8a" -> "_arm64.apk"
            "armeabi-v7a" -> "_armv7.apk"
            "x86_64" -> "_x86_64.apk"
            else -> null
        }
    } + "_universal.apk"

/** The newest stable release and the newest preview with an APK for these
 *  ABIs and a published SHA-256. Drafts are never offered. */
internal fun chooseReleases(json: String, abis: List<String>): ReleaseChoice {
    val suffixes = assetSuffixes(abis)
    val candidates = mutableListOf<ReleaseCandidate>()
    val releases = JSONArray(json)
    for (index in 0 until releases.length()) {
        val release = releases.optJSONObject(index) ?: continue
        if (release.optBoolean("draft")) continue
        val tag = release.optString("tag_name")
        val version = tag.removePrefix("v")
        if (parseVersion(version) == null) continue
        val assets = release.optJSONArray("assets") ?: continue
        val asset = suffixes.firstNotNullOfOrNull { suffix ->
            (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }
                .firstOrNull { it.optString("name").endsWith(suffix) }
        } ?: continue
        val url = asset.optString("browser_download_url")
        val sha256 = asset.optString("digest").removePrefix("sha256:").lowercase()
        if (!url.startsWith(DOWNLOAD_PREFIX) ||
            !Regex("^[0-9a-f]{64}$").matches(sha256)) continue
        candidates += ReleaseCandidate(
            tag = tag,
            version = version,
            prerelease = release.optBoolean("prerelease"),
            publishedAt = release.optString("published_at"),
            assetName = asset.optString("name"),
            url = url,
            size = asset.optLong("size"),
            sha256 = sha256,
        )
    }
    val newest = Comparator<ReleaseCandidate> { a, b -> compareVersions(a.version, b.version) }
    return ReleaseChoice(
        stable = candidates.filter { !it.prerelease }.maxWithOrNull(newest),
        preview = candidates.filter { it.prerelease }.maxWithOrNull(newest),
    )
}

private data class Version(val numbers: List<Int>, val prerelease: String?)

private fun parseVersion(text: String): Version? {
    val match = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$").find(text.trim())
        ?: return null
    val (major, minor, patch, pre) = match.destructured
    return Version(listOf(major.toInt(), minor.toInt(), patch.toInt()), pre.ifEmpty { null })
}

/** Semantic-version order: 0.4.0-preview < 0.4.0 < 0.4.1-preview < 0.4.1. */
internal fun compareVersions(a: String, b: String): Int {
    val left = parseVersion(a) ?: return if (parseVersion(b) == null) 0 else -1
    val right = parseVersion(b) ?: return 1
    for (index in 0 until 3) {
        val order = left.numbers[index].compareTo(right.numbers[index])
        if (order != 0) return order
    }
    return when {
        left.prerelease == right.prerelease -> 0
        left.prerelease == null -> 1
        right.prerelease == null -> -1
        else -> left.prerelease.compareTo(right.prerelease)
    }
}

internal enum class UpdatePhase { IDLE, DOWNLOADING, VERIFYING, INSTALLING, NEEDS_PERMISSION, ERROR }

internal data class UpdateProgress(
    val phase: UpdatePhase,
    val tag: String = "",
    val downloaded: Long = 0,
    val total: Long = 0,
    val error: String? = null,
)

internal object AppUpdater {
    @Volatile var progress = UpdateProgress(UpdatePhase.IDLE)
        private set
    @Volatile private var lastChoice: ReleaseChoice? = null

    private fun client(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun installedVersion(context: Context): String =
        context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()

    /** Ask GitHub for the releases. Blocking: call off the main thread. */
    fun check(context: Context): ReleaseChoice {
        val request = Request.Builder().url(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .build()
        val body = client().newCall(request).execute().use { response ->
            check(response.isSuccessful) { "GitHub answered HTTP ${response.code}" }
            val body = response.body ?: error("GitHub sent no release list")
            check(body.contentLength() <= MAX_RELEASES_BYTES) { "release list too large" }
            body.string()
        }
        return chooseReleases(body, Build.SUPPORTED_ABIS.toList()).also { lastChoice = it }
    }

    /** Download, verify and hand `tag` to the installer, reporting through
     *  [progress]. Blocking: call off the main thread. */
    fun install(context: Context, tag: String) {
        progress = UpdateProgress(UpdatePhase.DOWNLOADING, tag)
        try {
            val choice = lastChoice ?: check(context)
            val release = listOfNotNull(choice.stable, choice.preview).firstOrNull { it.tag == tag }
                ?: error("release $tag is not offered")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !context.packageManager.canRequestPackageInstalls()) {
                progress = UpdateProgress(UpdatePhase.NEEDS_PERMISSION, tag)
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                        .setData(Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                return
            }
            val apk = download(context, release)
            progress = UpdateProgress(UpdatePhase.VERIFYING, tag, release.size, release.size)
            verifySigner(context, apk, release)
            progress = UpdateProgress(UpdatePhase.INSTALLING, tag, release.size, release.size)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
            context.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (error: Throwable) {
            progress = UpdateProgress(
                UpdatePhase.ERROR, tag, error = (error.message ?: error.javaClass.simpleName).take(300),
            )
        }
    }

    /** The release's APK in the cache, downloaded unless a verified copy is
     *  already there (after the install permission was granted, say). */
    private fun download(context: Context, release: ReleaseCandidate): File {
        check(release.size in 1..MAX_APK_BYTES) { "unexpected APK size ${release.size}" }
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        directory.listFiles()?.filter { it.name != release.assetName }?.forEach { it.delete() }
        val target = File(directory, release.assetName)
        if (target.isFile && sha256(target) == release.sha256) return target
        val partial = File(directory, "${release.assetName}.part")
        partial.delete()
        val request = Request.Builder().url(release.url).build()
        client().newCall(request).execute().use { response ->
            check(response.isSuccessful) { "download answered HTTP ${response.code}" }
            val body = response.body ?: error("empty download")
            val digest = MessageDigest.getInstance("SHA-256")
            var downloaded = 0L
            body.byteStream().use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        downloaded += read
                        check(downloaded <= release.size) { "download exceeded its published size" }
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                        progress = progress.copy(downloaded = downloaded, total = release.size)
                    }
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            check(actual == release.sha256) {
                "the download does not match its published SHA-256"
            }
        }
        check(partial.renameTo(target)) { "could not keep the downloaded APK" }
        return target
    }

    private fun verifySigner(context: Context, apk: File, release: ReleaseCandidate) {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        val archive = pm.getPackageArchiveInfo(apk.absolutePath, flags)
            ?: error("the download is not an Android package")
        check(archive.packageName == context.packageName) {
            "the download is ${archive.packageName}, not Varmlen"
        }
        check(compareVersions(archive.versionName.orEmpty(), release.version.substringBefore('-')) == 0) {
            "the download is version ${archive.versionName}, not ${release.version}"
        }
        val installed = signers(pm.getPackageInfo(context.packageName, flags))
        val offered = signers(archive)
        // Android cannot read an archive's signers before 9 everywhere; the
        // installer still refuses a different signer there.
        if (offered.isNotEmpty()) {
            check(installed.isNotEmpty() && offered == installed) {
                "the download is not signed by Varmlen's key"
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> {
        val certificates = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            info.signatures
        } ?: return emptySet()
        return certificates.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                .joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
