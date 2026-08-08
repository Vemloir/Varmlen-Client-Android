package app.varmlen.client

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubscriptionHttpPolicyTest {
    @Test
    fun rejectsEveryNonPublicAddressClassIncludingMappedLoopback() {
        val blocked = listOf(
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
        )
        blocked.forEach { address ->
            assertTrue(address, isBlockedSubscriptionAddress(InetAddress.getByName(address)))
        }
        assertFalse(isBlockedSubscriptionAddress(InetAddress.getByName("201.24.125.125")))
        assertFalse(isBlockedSubscriptionAddress(InetAddress.getByName("1.1.1.1")))
        assertFalse(isBlockedSubscriptionAddress(InetAddress.getByName("192.0.1.1")))
    }

    @Test
    fun addressApprovalUsesTheSelectedNetworksResolver() {
        var resolvedHost: String? = null
        val approved = approvedSubscriptionAddresses(java.net.URL("https://sub.proxen.net/path")) {
            resolvedHost = it
            arrayOf(InetAddress.getByName("201.24.125.125"))
        }

        assertEquals("sub.proxen.net", resolvedHost)
        assertEquals(listOf(InetAddress.getByName("201.24.125.125")), approved)
    }

    @Test
    fun pinnedDnsReturnsOnlyTheAlreadyApprovedAddresses() {
        val approved = listOf(InetAddress.getByName("201.24.125.125"))
        val dns = PinnedSubscriptionDns("sub.proxen.net", approved)

        assertEquals(approved, dns.lookup("sub.proxen.net"))
        assertEquals(approved, dns.lookup("SUB.PROXEN.NET"))
    }

    @Test(expected = java.net.UnknownHostException::class)
    fun pinnedDnsNeverResolvesAnUnexpectedHostname() {
        PinnedSubscriptionDns(
            "sub.proxen.net",
            listOf(InetAddress.getByName("201.24.125.125")),
        ).lookup("redirected.example")
    }
}
