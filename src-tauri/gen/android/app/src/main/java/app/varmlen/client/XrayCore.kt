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
     *  thread). Used to preflight the candidate's proxy/routing policy in its
     *  device-free form BEFORE the TUN is established or policy is switched. */
    @JvmStatic
    external fun validate(binary: String, configPath: String, logPath: String): Boolean

    /** Appends through the same bounded rotating writer used for Xray output. */
    @JvmStatic
    external fun appendLog(logPath: String, message: String)

    @JvmStatic
    external fun isRunning(): Boolean

    @JvmStatic
    external fun stop()
}
