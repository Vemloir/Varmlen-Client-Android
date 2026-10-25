package app.varmlen.client

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SubscriptionClientProfileTest {
    private val facts = SubscriptionDeviceFacts(
        androidId = "9774d56d682e549c",
        release = "14",
        manufacturer = "samsung",
        brand = "samsung",
        model = "SM-S918B",
        locale = Locale("ru", "RU"),
        dayOfMonth = 25,
        television = false,
        abi = "arm64-v8a",
    )

    /** Happ 4.8.0 on a Galaxy S25 Ultra (Android 16), captured on the 25th. */
    @Test
    fun happSendsTheRequestCapturedFromHapp480() {
        val captured = facts.copy(
            androidId = "466aeb2e62b7254e",
            release = "16",
            model = "SM-S938B",
            dayOfMonth = 25,
        )
        assertEquals(
            listOf(
                "Connection" to "close",
                "User-agent" to "Happ/4.8.0/Android/17921395329952009531",
                "X-Device-Locale" to "ru",
                "X-HWID" to "466aeb2e62b7254e",
                "X-Device-OS" to "Android",
                "X-Ver-OS" to "16",
                "X-Device-model" to "SM-S938B",
            ),
            subscriptionRequestHeaders("happ", captured),
        )
    }

    @Test
    fun happsTokenFollowsTheParityOfTheDayAndTheTelevisionBuild() {
        assertEquals(
            "Happ/4.8.0/Android/17921395329952009631",
            happUserAgent(facts.copy(dayOfMonth = 24)),
        )
        assertEquals(
            "Happ/4.8.0/AndroidTV/17921395329952009531",
            happUserAgent(facts.copy(television = true)),
        )
        assertEquals(
            "AndroidTV",
            subscriptionRequestHeaders("happ", facts.copy(television = true))
                .first { it.first == "X-Device-OS" }.second,
        )
    }

    /** INCY 3.7.9 on a Galaxy S25 Ultra (Android 16), captured over HTTPS. */
    @Test
    fun incySendsTheRequestCapturedFromIncy379() {
        val captured = facts.copy(release = "16", model = "SM-S938B")
        val headers = subscriptionRequestHeaders("incy", captured)
        assertEquals(
            listOf(
                "User-Agent" to "INCY/3.7.9/android Dalvik/2.1.0",
                "Accept" to "*/*",
                "Accept-Language" to "ru-RU",
                "x-hwid" to incyHwid("9774d56d682e549c"),
                "x-device-os" to "Android",
                "x-ver-os" to "16",
                "x-device-model" to "samsung SM-S938B",
                "x-app-version" to "3.7.9",
                "x-device-locale" to "ru_RU",
                "x-client" to "INCY",
            ),
            headers,
        )
    }

    @Test
    fun incysHwidIsAStableUpperCaseUuidShapeOfThisDevice() {
        val hwid = incyHwid("9774d56d682e549c")
        assertTrue(Regex("^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$").matches(hwid))
        assertEquals(hwid, incyHwid("9774d56d682e549c"))
        assertNotEquals(hwid, incyHwid("0000000000000001"))
    }

    @Test
    fun v2rayTunSendsTheUppercaseHwidAndBrand() {
        assertEquals(
            listOf(
                "User-agent" to "v2raytun/android",
                "X-HWID" to "9774D56D682E549C",
                "X-Device-OS" to "Android",
                "X-Ver-OS" to "Android 14",
                "X-Device-Model" to "samsung SM-S918B",
                "X-App-Version" to "5.25.81",
            ),
            subscriptionRequestHeaders("v2raytun", facts),
        )
    }

    @Test
    fun varmlenAndUnknownChoicesAskAsVarmlen() {
        val varmlen = listOf(
            "User-Agent" to "Varmlen/Android/arm64",
            "X-Device-OS" to "android",
        )
        assertEquals(varmlen, subscriptionRequestHeaders("varmlen", facts))
        assertEquals(varmlen, subscriptionRequestHeaders("anything", facts))
    }

    @Test
    fun valuesOkHttpWouldRefuseAreMadePrintable() {
        val headers = subscriptionRequestHeaders("incy", facts.copy(model = "Мой\nphone"))
        assertEquals("samsung ????phone", headers.first { it.first == "x-device-model" }.second)
    }
}
