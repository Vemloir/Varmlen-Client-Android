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

    /**
     * A refused reconfigure arrives with running = true: the tunnel the user already
     * had is still up, and the request that failed is the replacement. Answering
     * "done" because a tunnel exists would tell the app that its edit applied, and
     * the Split page would then show a list the core is not using.
     */
    @Test
    fun connectRejectsARefusedReconfigureEvenThoughTheTunnelRuns() {
        assertEquals(
            VpnRequestOutcome.REJECT,
            vpnRequestOutcome(
                VpnRequestKind.CONNECT,
                pendingRequestId = "connect-2",
                broadcastRequestId = "connect-2",
                running = true,
                error = "Xray rejected the generated config",
            ),
        )
        // Without an error the same broadcast is an ordinary successful connect.
        assertEquals(
            VpnRequestOutcome.RESOLVE,
            vpnRequestOutcome(
                VpnRequestKind.CONNECT,
                pendingRequestId = "connect-2",
                broadcastRequestId = "connect-2",
                running = true,
            ),
        )
        // A disconnect is still refused by a tunnel that will not stop, error or not.
        assertEquals(
            VpnRequestOutcome.IGNORE,
            vpnRequestOutcome(
                VpnRequestKind.DISCONNECT,
                pendingRequestId = "disconnect-2",
                broadcastRequestId = "disconnect-2",
                running = true,
                error = "stop failed",
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
