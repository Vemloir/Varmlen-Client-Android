package app.varmlen.client

/**
 * hev-socks5-tunnel's built-in Android JNI. libhev-socks5-tunnel.so is built
 * with -DPKGNAME=app/varmlen/client, so its JNI_OnLoad registers these natives
 * onto this exact class (package/name must match). TProxyStartService spawns
 * hev's work thread with the correct signal mask + JVM attach and returns
 * immediately; TProxyStopService joins it.
 */
object TProxyService {
    init {
        System.loadLibrary("hev-socks5-tunnel")
    }

    external fun TProxyStartService(configPath: String, fd: Int): Boolean
    external fun TProxyStopService(): Boolean
    external fun TProxyIsRunning(): Boolean
    external fun TProxyGetStats(): LongArray?
}
