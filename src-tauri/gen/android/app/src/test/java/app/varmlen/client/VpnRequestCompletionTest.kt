package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Test

class VpnRequestCompletionTest {
    @Test
    fun disconnectResolvesOnlyAfterMatchingStoppedBroadcast() {
        assertEquals(
            VpnRequestOutcome.RESOLVE,
            vpnRequestOutcome(
                VpnRequestKind.DISCONNECT,
                pendingRequestId = "disconnect-1",
                broadcastRequestId = "disconnect-1",
                running = false,
            ),
        )
        assertEquals(
            VpnRequestOutcome.IGNORE,
            vpnRequestOutcome(
                VpnRequestKind.DISCONNECT,
                pendingRequestId = "disconnect-1",
                broadcastRequestId = "stale-request",
                running = false,
            ),
        )
        assertEquals(
            VpnRequestOutcome.IGNORE,
            vpnRequestOutcome(
                VpnRequestKind.DISCONNECT,
                pendingRequestId = "disconnect-1",
                broadcastRequestId = "disconnect-1",
                running = true,
            ),
        )
    }

    @Test
    fun connectStillRejectsAMatchingStoppedBroadcast() {
        assertEquals(
            VpnRequestOutcome.REJECT,
            vpnRequestOutcome(
                VpnRequestKind.CONNECT,
                pendingRequestId = "connect-1",
                broadcastRequestId = "connect-1",
                running = false,
            ),
        )
    }
}
