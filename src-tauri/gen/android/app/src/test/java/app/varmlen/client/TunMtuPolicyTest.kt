package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The MTU the interface is built with. Clamped rather than reset: someone who asked
 * for 1100 meant "smaller than default", and answering with 1500 — the one value
 * that does not work on such a network — would be the worse lie.
 *
 * The rule lives on this side of the boundary as well as in Rust, because the Quick
 * Settings tile relaunches the tunnel from a saved preference without asking Rust
 * anything at all. An interface that silently came back at 1500 after a screen
 * timeout would make the setting a lie whenever the user was not looking.
 */
class TunMtuPolicyTest {
    @Test
    fun aUsableMtuPassesThroughUntouched() {
        assertEquals(1500, VarmlenVpnService.tunMtu(1500))
        assertEquals(1420, VarmlenVpnService.tunMtu(1420))
        assertEquals(1280, VarmlenVpnService.tunMtu(1280))
        assertEquals(9000, VarmlenVpnService.tunMtu(9000))
    }

    @Test
    fun anImpossibleMtuIsPushedBackIntoRangeInsteadOfBeingForgotten() {
        assertEquals(1280, VarmlenVpnService.tunMtu(0))
        assertEquals(1280, VarmlenVpnService.tunMtu(1))
        assertEquals(9000, VarmlenVpnService.tunMtu(65535))
    }
}