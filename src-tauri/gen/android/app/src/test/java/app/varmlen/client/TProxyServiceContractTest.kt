package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Test

class TProxyServiceContractTest {
    private val type = Class.forName(
        "app.varmlen.client.TProxyService",
        false,
        javaClass.classLoader,
    )

    @Test
    fun nativeDescriptorsMatchPinnedHevJni() {
        assertEquals(
            java.lang.Boolean.TYPE,
            type.getDeclaredMethod(
                "TProxyStartService",
                String::class.java,
                java.lang.Integer.TYPE,
            ).returnType,
        )
        assertEquals(
            java.lang.Boolean.TYPE,
            type.getDeclaredMethod("TProxyStopService").returnType,
        )
        assertEquals(
            java.lang.Boolean.TYPE,
            type.getDeclaredMethod("TProxyIsRunning").returnType,
        )
        assertEquals(
            LongArray::class.java,
            type.getDeclaredMethod("TProxyGetStats").returnType,
        )
    }
}
