package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Test

class VarmlenWidgetTest {
    @Test
    fun aFlagIsSplitFromTheLocationName() {
        assertEquals("🇫🇮" to "Finland | Helsinki", splitLocationLabel("🇫🇮 Finland | Helsinki"))
        assertEquals("🇳🇱" to "Netherlands | Vless", splitLocationLabel("  🇳🇱Netherlands | Vless "))
    }

    @Test
    fun anotherLeadingEmojiIsTheIconAndPlainLabelsHaveNone() {
        assertEquals("☁️" to "vpn", splitLocationLabel("☁️ vpn"))
        assertEquals("🏳️‍🌈" to "Mixed", splitLocationLabel("🏳️‍🌈 Mixed"))
        assertEquals("" to "Finland | Helsinki", splitLocationLabel("Finland | Helsinki"))
        assertEquals("" to "", splitLocationLabel(""))
        // A lone regional indicator is not a flag.
        assertEquals("" to "🇫 x", splitLocationLabel("🇫 x"))
    }

    @Test
    fun speedsAreShownInMegabitsWithOneDecimalBelowAHundred() {
        assertEquals("0.0", mbps(0))
        assertEquals("0.0", mbps(-5))
        assertEquals("18.4", mbps(2_300_000))
        assertEquals("42.7", mbps(5_337_500))
        assertEquals("120", mbps(15_000_000))
    }
}
