package app.varmlen.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VpnEgressPolicyTest {
    @Test
    fun connectedRequiresEveryConcreteOutbound() {
        assertTrue(allEgressProbesHealthy(listOf(true, true, true)))
        assertFalse(allEgressProbesHealthy(listOf(true, false, true)))
        assertFalse(allEgressProbesHealthy(emptyList()))
    }
}
