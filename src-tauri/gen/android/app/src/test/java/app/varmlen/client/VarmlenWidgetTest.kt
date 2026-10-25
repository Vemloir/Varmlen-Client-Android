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
    fun aFlagEmojiNamesItsCountryAndNothingElseDoes() {
        assertEquals("fi", countryCode("🇫🇮"))
        assertEquals("un", countryCode("🇺🇳"))
        assertEquals(null, countryCode("☁️"))
        assertEquals(null, countryCode(""))
        assertEquals(null, countryCode("🇫"))
    }

    @Test
    fun speedsReadAsInTheNotification() {
        java.util.Locale.setDefault(java.util.Locale.ROOT)
        assertEquals("0" to "B/s", speedParts(0))
        assertEquals("0" to "B/s", speedParts(-5))
        assertEquals("1023" to "B/s", speedParts(1023))
        assertEquals("512" to "KB/s", speedParts(512 * 1024 + 300))
        assertEquals("1.2" to "MB/s", speedParts(1_258_291))
        assertEquals("8.4" to "MB/s", speedParts(8_808_038))
    }
}
