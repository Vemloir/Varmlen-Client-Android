package app.varmlen.client

import java.util.Locale
import org.junit.Assert.assertEquals
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

    @Test
    fun happSendsItsOrdinarySubscriptionRequest() {
        assertEquals(
            listOf(
                "Connection" to "close",
                "User-agent" to "Happ/4.7.1/Android/17912103176801703550",
                "X-Device-Locale" to "ru",
            ),
            subscriptionRequestHeaders("happ", facts),
        )
    }

    @Test
    fun happsTokenFollowsTheParityOfTheDayAndTheTelevisionBuild() {
        assertEquals(
            "Happ/4.7.1/Android/17912103176801703650",
            happUserAgent(facts.copy(dayOfMonth = 24)),
        )
        assertEquals(
            "Happ/4.7.1/AndroidTV/17912103176801703550",
            happUserAgent(facts.copy(television = true)),
        )
    }

    @Test
    fun incySendsItsHeadersInOrderWithThisDevicesFacts() {
        assertEquals(
            listOf(
                "User-Agent" to "InCy/1.0",
                "Accept" to "*/*",
                "Accept-Language" to "ru-RU",
                "x-hwid" to "9774d56d682e549c",
                "x-device-os" to "Android",
                "x-ver-os" to "14",
                "x-device-model" to "samsung SM-S918B",
                "x-app-version" to "3.7.9",
                "x-device-locale" to "ru_RU",
                "x-client" to "INCY",
            ),
            subscriptionRequestHeaders("incy", facts),
        )
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
