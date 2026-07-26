package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VpnAppPolicyTest {
    @Test(expected = IllegalArgumentException::class)
    fun emptyAllowlistIsRejected() {
        vpnAppPolicy(emptyArray(), true, "app.varmlen.client")
    }

    @Test
    fun allowlistNeverMixesAllowedAndDisallowedApplications() {
        val policy = vpnAppPolicy(
            arrayOf("com.valve.game", "com.valve.game"),
            true,
            "app.varmlen.client"
        )

        assertEquals(listOf("com.valve.game"), policy.allowed)
        assertTrue(policy.disallowed.isEmpty())
    }

    @Test
    fun denylistAlwaysKeepsTheVpnProcessOutsideItsOwnTunnel() {
        val policy = vpnAppPolicy(
            arrayOf("com.game.one", "com.game.one"),
            false,
            "app.varmlen.client"
        )

        assertTrue(policy.allowed.isEmpty())
        assertEquals(
            listOf("com.game.one", "app.varmlen.client"),
            policy.disallowed
        )
    }
}
