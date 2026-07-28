package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SubscriptionRefreshStoreTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private fun schedule(id: String = "sub-1") = SubscriptionRefreshSchedule(
        id = id,
        url = "https://vpn.example/subscription",
        userAgent = "happ",
        intervalHours = 4,
        lastSuccessAt = 1_784_985_600_000,
        nextUpdateAt = 1_785_000_000_000,
    )

    @Test
    fun schedulesRoundTripInsideTheProvidedPrivateDirectory() {
        val store = SubscriptionRefreshStore(temporaryFolder.root)
        store.replaceSchedules(listOf(schedule()))

        assertEquals(listOf(schedule()), store.readSchedules())
        assertTrue(store.scheduleFile.canonicalPath.startsWith(temporaryFolder.root.canonicalPath))
        assertFalse(temporaryFolder.root.resolve("subscription-refresh-schedules.json.tmp").exists())
    }

    @Test
    fun workNamesAreStableUniqueAndBounded() {
        val first = subscriptionRefreshWorkName("sub-1")
        val second = subscriptionRefreshWorkName("sub-2")

        assertEquals(first, subscriptionRefreshWorkName("sub-1"))
        assertTrue(first.startsWith("varmlen-subscription-refresh-"))
        assertTrue(first.length <= 96)
        assertTrue(first != second)
    }

    @Test
    fun clearAllDropsSchedulesAndPendingResponses() {
        val store = SubscriptionRefreshStore(temporaryFolder.root)
        store.replaceSchedules(listOf(schedule()))
        store.stage(
            StagedSubscriptionResponse(
                id = "sub-1",
                body = "first",
                headers = mapOf("profile-title" to "One"),
                refreshedAt = 1_785_000_000_000,
            ),
        )

        store.clearAll()

        assertTrue(store.readSchedules().isEmpty())
        assertTrue(store.drain().isEmpty())
    }

    @Test
    fun newerResponseReplacesTheUndrainedResponseForTheSameSubscription() {
        val store = SubscriptionRefreshStore(temporaryFolder.root)
        store.stage(
            StagedSubscriptionResponse(
                id = "sub-1",
                body = "first",
                headers = emptyMap(),
                refreshedAt = 1,
            ),
        )
        store.stage(
            StagedSubscriptionResponse(
                id = "sub-1",
                body = "second",
                headers = mapOf("profile-title" to "Latest"),
                refreshedAt = 2,
            ),
        )

        val drained = store.drain()

        assertEquals(1, drained.size)
        assertEquals("second", drained.single().body)
        assertEquals(2, drained.single().refreshedAt)
        assertTrue(store.drain().isEmpty())
    }

    @Test
    fun errorsAreBoundedBeforeTheyReachPersistentWorkState() {
        val bounded = boundedSubscriptionRefreshError("x".repeat(4_000))

        assertEquals(512, bounded.length)
    }

    @Test
    fun userAgentUsesTheSelectedBrandAndDetectedArchitecture() {
        assertEquals(
            "Happ/Android/arm64",
            subscriptionRefreshUserAgent("happ", "arm64-v8a"),
        )
        assertEquals(
            "Varmlen/Android/x86_64",
            subscriptionRefreshUserAgent("unknown", "x86_64"),
        )
    }

    @Test
    fun reopeningKeepsAnExistingDueWorkButARealRefreshMovesTheBoundary() {
        val existing = schedule().copy(nextUpdateAt = 100)
        val mountRecalculation = existing.copy(nextUpdateAt = 200)
        assertEquals(
            listOf(existing),
            mergeSubscriptionRefreshSchedules(
                listOf(existing),
                listOf(mountRecalculation),
            ),
        )

        val refreshed = mountRecalculation.copy(lastSuccessAt = existing.lastSuccessAt + 1)
        assertEquals(
            listOf(refreshed),
            mergeSubscriptionRefreshSchedules(listOf(existing), listOf(refreshed)),
        )
    }
}
