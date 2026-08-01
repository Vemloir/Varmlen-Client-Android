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

    /** Runs `xray run -test -c configPath` synchronously (call off the main
     *  thread). Used to preflight the exact candidate config BEFORE the TUN
     *  is established or any policy is switched. */
    @JvmStatic
    external fun validate(binary: String, configPath: String, logPath: String): Boolean

    /** The fixed loopback port the config's egress-probe inbound listens on. */
    @JvmStatic
    external fun probePort(): Int

    @JvmStatic
    external fun isRunning(): Boolean

    @JvmStatic
    external fun stop()
}
