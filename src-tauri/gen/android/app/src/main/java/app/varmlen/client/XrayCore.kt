package app.varmlen.client

/**
 * JNI bridge to the Rust process launcher.
 *
 * Java ProcessBuilder closes VpnService's TUN descriptor before exec. The Rust
 * launcher duplicates it natively and passes that live descriptor to Xray.
 */
object XrayCore {
    init {
        System.loadLibrary("varmlen_lib")
    }

    @JvmStatic
    external fun start(
        binary: String,
        configPath: String,
        assetDir: String,
        logPath: String,
        tunFd: Int,
    ): Boolean

    @JvmStatic
    external fun isRunning(): Boolean

    @JvmStatic
    external fun stop()
}
