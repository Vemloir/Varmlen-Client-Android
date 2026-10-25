package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdaterTest {
    private val sha = "3dfcd5c53457750f62ad882035aa5f677fe1254e14432c48f9a1b440d5b62283"
    private val prefix = "https://github.com/Vemloir/Varmlen-Client-Android/releases/download"

    private fun release(
        tag: String,
        prerelease: Boolean,
        asset: String = "Varmlen_${tag.removePrefix("v").substringBefore('-')}_arm64.apk",
        url: String = "$prefix/$tag/$asset",
        digest: String? = "sha256:$sha",
        draft: Boolean = false,
    ) = """
        {"tag_name": "$tag", "prerelease": $prerelease, "draft": $draft,
         "published_at": "2026-10-26T00:00:00Z",
         "assets": [{"name": "SHA256SUMS", "browser_download_url": "$prefix/$tag/SHA256SUMS", "size": 1},
                    {"name": "$asset", "browser_download_url": "$url", "size": 22722243
                     ${digest?.let { ", \"digest\": \"$it\"" } ?: ""}}]}
    """.trimIndent()

    @Test
    fun theNewestStableAndTheNewestPreviewAreOffered() {
        val json = "[" + listOf(
            release("v0.4.1-preview", true),
            release("v0.4.0-preview", true),
            release("v0.3.2", false),
            release("v0.3.1", false),
        ).joinToString(",") + "]"
        val choice = chooseReleases(json, listOf("arm64-v8a"))
        assertEquals("v0.3.2", choice.stable?.tag)
        assertEquals("v0.4.1-preview", choice.preview?.tag)
        assertEquals("Varmlen_0.4.1_arm64.apk", choice.preview?.assetName)
        assertEquals(sha, choice.preview?.sha256)
    }

    @Test
    fun releasesWithoutAnApkForThisDeviceADigestOrAnOfficialUrlAreSkipped() {
        val json = "[" + listOf(
            release("v0.5.0", false, digest = null),
            release("v0.4.9", false, url = "https://evil.example/Varmlen_0.4.9_arm64.apk"),
            release("v0.4.8", false, draft = true),
            release("v0.4.7", false, asset = "Varmlen_0.4.7_x86.apk"),
            release("v0.3.2", false),
        ).joinToString(",") + "]"
        val choice = chooseReleases(json, listOf("arm64-v8a"))
        assertEquals("v0.3.2", choice.stable?.tag)
        assertNull(choice.preview)
        assertNull(chooseReleases(json, listOf("x86")).stable?.takeIf { it.tag != "v0.4.7" })
    }

    @Test
    fun versionsCompareAsSemanticVersions() {
        assertTrue(compareVersions("0.4.0-preview", "0.4.0") < 0)
        assertTrue(compareVersions("0.4.1-preview", "0.4.0") > 0)
        assertTrue(compareVersions("0.10.0", "0.9.9") > 0)
        assertEquals(0, compareVersions("0.4.0", "0.4.0"))
        assertTrue(compareVersions("0.3.2", "0.4.0") < 0)
        assertTrue(compareVersions("garbage", "0.1.0") < 0)
    }
}
