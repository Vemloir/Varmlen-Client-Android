package app.varmlen.client

import org.junit.Assert.assertEquals
import org.junit.Test

class XrayCoreContractTest {
    private val type = Class.forName(
        "app.varmlen.client.XrayCore",
        false,
        javaClass.classLoader,
    )

    @Test
    fun nativeDescriptorsMatchTheRustLauncher() {
        assertEquals(
            java.lang.Boolean.TYPE,
            type.getDeclaredMethod(
                "start",
                String::class.java,
                String::class.java,
                String::class.java,
                String::class.java,
                java.lang.Integer.TYPE,
            ).returnType,
        )
        assertEquals(
            java.lang.Boolean.TYPE,
            type.getDeclaredMethod("isRunning").returnType,
        )
        assertEquals(
            java.lang.Void.TYPE,
            type.getDeclaredMethod("stop").returnType,
        )
    }
}
