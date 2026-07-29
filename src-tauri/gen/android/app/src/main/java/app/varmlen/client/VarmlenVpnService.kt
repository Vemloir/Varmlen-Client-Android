package app.varmlen.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.net.TrafficStats
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.service.quicksettings.TileService
import android.system.Os
import android.system.OsConstants
import androidx.core.content.ContextCompat
import java.io.File

/**
 * The Android data plane. VpnService owns the OS tunnel and per-package policy,
 * then passes the established TUN file descriptor directly to Xray's native
 * Android TUN inbound.
 */
class VarmlenVpnService : VpnService() {
    private var tun: ParcelFileDescriptor? = null
    private var xray: Process? = null

    /** Set during an intentional teardown so the xray-exit watcher doesn't treat
     *  a deliberate kill as a crash. */
    @Volatile private var stopping = false

    // Live notification (speed + uptime), refreshed once a second.
    private val notifHandler = Handler(Looper.getMainLooper())
    private var connectedAt = 0L
    private var lastTx = 0L
    private var lastRx = 0L
    private var lastStatsAt = 0L
    private val statsTick = object : Runnable {
        override fun run() {
            updateNotification()
            notifHandler.postDelayed(this, 1000)
        }
    }

    companion object {
        const val ACTION_CONNECT = "app.varmlen.client.CONNECT"
        const val ACTION_DISCONNECT = "app.varmlen.client.DISCONNECT"
        /** Broadcast (package-local) the app's plugin listens to, so the UI
         *  updates instantly when the VPN is toggled outside the app (notification
         *  Disconnect, tile, system revoke) without polling. */
        const val ACTION_STATE = "app.varmlen.client.VPN_STATE"
        const val EXTRA_RUNNING = "running"
        const val EXTRA_CONFIG = "config"
        const val EXTRA_DNS = "dns"
        const val EXTRA_APPS = "apps"
        const val EXTRA_APPS_ALLOW = "appsAllow"
        const val EXTRA_LOG_LEVEL = "logLevel"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_ERROR = "error"
        const val LOG_FILE = "varmlen.log"
        private const val CHANNEL = "varmlen_vpn"
        private const val NOTIF_ID = 1
        private const val TUN_ADDR = "10.10.10.2"
        private const val TUN_ADDR_V6 = "fd00:7661:726d:6c65::2"
        private const val MTU = 1500
        private const val PREFS = "varmlen_vpn"
        private const val WANT_FILE = "vpn_want.flag"

        /** Actual running state — the SOURCE OF TRUTH for the UI/tile. Checks the
         *  app's running services (works cross-process for our own service)
         *  rather than a persisted flag, so a flag left over after a reboot /
         *  force-stop / system disconnect can't show a phantom "connected". */
        fun isRunning(ctx: Context): Boolean {
            // Fast path: the want-flag flips to 0 the instant we tear down, so a
            // disconnect (notification / tile / crash) reads immediately instead
            // of waiting several seconds for getRunningServices to drop the
            // already-stopped service.
            if (!wantsRunning(ctx)) return false
            // The flag can be a stale "1" after a reboot / force-stop, so confirm
            // the service is actually alive before reporting connected.
            return try {
                val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
                @Suppress("DEPRECATION")
                am.getRunningServices(Int.MAX_VALUE).any {
                    it.service.className == VarmlenVpnService::class.java.name
                }
            } catch (_: Throwable) { false }
        }

        /** Persisted "should be running" — used ONLY for START_STICKY restart
         *  recovery (do we re-establish after an OOM kill?), never for the UI. */
        private fun setWant(ctx: Context, on: Boolean) {
            try { File(ctx.filesDir, WANT_FILE).writeText(if (on) "1" else "0") } catch (_: Throwable) {}
        }
        private fun wantsRunning(ctx: Context): Boolean =
            try { File(ctx.filesDir, WANT_FILE).readText() == "1" } catch (_: Throwable) { false }

        /** Whether a previous connect saved a config we can re-launch without
         *  the app being open (used by the Quick Settings tile). */
        fun hasSavedConfig(ctx: Context): Boolean =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("config", null) != null

        /** Re-launch the VPN from the last saved config (tile / shade). */
        fun start(ctx: Context) {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val config = p.getString("config", null) ?: return
            val i = Intent(ctx, VarmlenVpnService::class.java).setAction(ACTION_CONNECT)
            i.putExtra(EXTRA_CONFIG, config)
            i.putExtra(EXTRA_DNS, p.getString("dns", "1.1.1.1"))
            i.putExtra(EXTRA_APPS, (p.getStringSet("apps", emptySet()) ?: emptySet()).toTypedArray())
            i.putExtra(EXTRA_APPS_ALLOW, p.getBoolean("appsAllow", false))
            i.putExtra(EXTRA_LOG_LEVEL, p.getString("logLevel", "warn"))
            ContextCompat.startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) {
            stop(ctx, null)
        }

        fun stop(ctx: Context, requestId: String?) {
            val intent = Intent(ctx, VarmlenVpnService::class.java)
                .setAction(ACTION_DISCONNECT)
            if (requestId != null) intent.putExtra(EXTRA_REQUEST_ID, requestId)
            ctx.startService(intent)
        }
    }

    /** Append a line to filesDir/varmlen.log so the in-app log viewer (and Rust)
     *  can read it without adb. */
    private fun log(msg: String, e: Throwable? = null) {
        try {
            val f = File(filesDir, LOG_FILE)
            f.appendText("[${System.currentTimeMillis()}] $msg\n")
            if (e != null) f.appendText(android.util.Log.getStackTraceString(e) + "\n")
        } catch (_: Throwable) {}
        android.util.Log.i("VarmlenVpn", msg, e)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                log("disconnect")
                stopAll(requestId = intent.getStringExtra(EXTRA_REQUEST_ID))
                return START_NOT_STICKY
            }
            ACTION_CONNECT -> {
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
                try {
                    startAll(
                        intent.getStringExtra(EXTRA_CONFIG) ?: error("no config"),
                        intent.getStringExtra(EXTRA_DNS) ?: "1.1.1.1",
                        intent.getStringArrayExtra(EXTRA_APPS) ?: emptyArray(),
                        intent.getBooleanExtra(EXTRA_APPS_ALLOW, false),
                        intent.getStringExtra(EXTRA_LOG_LEVEL) ?: "warn",
                        requestId
                    )
                } catch (e: Throwable) {
                    log("connect failed", e)
                    stopAll(e.message ?: e.javaClass.simpleName, requestId)
                }
            }
            else -> {
                // Restarted by the system (START_STICKY, null intent after an
                // OOM kill). Re-establish from the saved config if we were meant
                // to be running; otherwise stop.
                if (wantsRunning(this) && hasSavedConfig(this)) {
                    log("auto-restart from saved config")
                    start(this)
                } else {
                    stopSelf()
                    return START_NOT_STICKY
                }
            }
        }
        // STICKY: if the OS kills us, restart and (above) re-establish the tunnel.
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep the VPN alive when the app is swiped from recents — do NOT stop.
        log("task removed — VPN stays up")
        super.onTaskRemoved(rootIntent)
    }

    private fun startAll(
        config: String, dns: String,
        apps: Array<String>, appsAllow: Boolean, logLevel: String,
        requestId: String?
    ) {
        // A reconnect may reach this same Service instance before Android has
        // delivered onDestroy() for an earlier stop. Never carry the previous
        // idempotency guard into the new data plane or its next Disconnect
        // action would be ignored forever.
        stopAllInProgress = false
        log("startAll nativeTun dns=$dns apps=${apps.size} allow=$appsAllow level=$logLevel")
        val xrayBin = File(applicationInfo.nativeLibraryDir, "libxray.so")
        require(xrayBin.isFile && xrayBin.canExecute()) {
            "Bundled Xray executable is missing"
        }
        startForegroundOrThrow()
        val cfgFile = File(filesDir, "xray.json").apply { writeText(config) }

        // Establish the replacement TUN before stopping an existing data plane.
        // Android atomically switches VPN routing to the new descriptor, so a
        // reconnect can briefly block while Xray starts but cannot leak traffic.
        val builder = Builder()
            .setSession("Varmlen")
            .setMtu(MTU)
            .addAddress(TUN_ADDR, 30)
            .addAddress(TUN_ADDR_V6, 126)
            .addRoute("0.0.0.0", 0)
            .addRoute("::", 0)
            .addDnsServer(dns)
        val appPolicy = vpnAppPolicy(apps, appsAllow, packageName)
        var installedAllowedApps = 0
        for (pkg in appPolicy.allowed) {
            try {
                builder.addAllowedApplication(pkg)
                installedAllowedApps += 1
            } catch (_: Exception) {
                log("selected allowlist app is no longer installed: $pkg")
            }
        }
        if (appPolicy.allowed.isNotEmpty() && installedAllowedApps == 0) {
            error("None of the selected allowlist applications are installed")
        }
        if (appPolicy.allowed.isEmpty()) {
            // Xray is a child of this package. Excluding our UID prevents its
            // remote sockets from feeding back into the VPN tunnel.
            builder.addDisallowedApplication(packageName)
        }
        for (pkg in appPolicy.disallowed) {
            if (pkg == packageName) continue
            try {
                builder.addDisallowedApplication(pkg)
            } catch (_: Exception) {
                log("selected denylist app is no longer installed: $pkg")
            }
        }
        val fd = builder.establish() ?: error("establish() returned null")
        val previousTun = tun
        val previousXray = xray
        tun = fd
        log("tun established fd=${fd.fd}")

        // Retire the old process only after the new TUN has taken ownership of
        // VPN routing. Until the new Xray starts, packets are blocked in the TUN.
        stopping = true
        xray = null
        try { previousXray?.destroy() } catch (_: Throwable) {}
        try { previousTun?.close() } catch (_: Throwable) {}
        stopping = false

        // Xray's Android TUN inbound reads the inherited descriptor from this
        // environment variable. ParcelFileDescriptor is close-on-exec by
        // default, so clear that bit only around ProcessBuilder.start(), then
        // restore it in the parent immediately.
        val originalFdFlags = Os.fcntlInt(fd.fileDescriptor, OsConstants.F_GETFD, 0)
        val processBuilder =
            ProcessBuilder(xrayBin.absolutePath, "run", "-c", cfgFile.absolutePath)
                .directory(filesDir)
                .redirectErrorStream(true)
        processBuilder.environment()["XRAY_TUN_FD"] = fd.fd.toString()
        log("exec xray native TUN: ${xrayBin.absolutePath} fd=${fd.fd}")
        val proc = try {
            Os.fcntlInt(
                fd.fileDescriptor,
                OsConstants.F_SETFD,
                originalFdFlags and OsConstants.FD_CLOEXEC.inv(),
            )
            processBuilder.start()
        } finally {
            Os.fcntlInt(fd.fileDescriptor, OsConstants.F_SETFD, originalFdFlags)
        }
        xray = proc
        // Drain Xray output into the log and fail closed on an unexpected exit.
        Thread {
            try {
                proc.inputStream.bufferedReader().forEachLine { log("xray: $it") }
            } catch (_: Throwable) {}
            if (!stopping && proc === xray) {
                log("xray exited unexpectedly — disconnecting")
                notifHandler.post { stopAll() }
            }
        }.apply { isDaemon = true; start() }
        Thread.sleep(150)
        check(proc.isAlive) { "Xray exited during startup" }

        // Save only a configuration that reached the connected state. A failed
        // attempt must not poison later starts from the Quick Settings tile.
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("config", config)
            .putString("dns", dns)
            .putStringSet("apps", apps.toSet())
            .putBoolean("appsAllow", appsAllow)
            .putString("logLevel", logLevel)
            .apply()
        setWant(this, true)
        broadcastState(true, requestId = requestId)
        // Start the per-second speed + uptime notification updates.
        connectedAt = System.currentTimeMillis()
        lastTx = 0L; lastRx = 0L; lastStatsAt = 0L
        notifHandler.removeCallbacks(statsTick)
        notifHandler.post(statsTick)
        log("connected")
    }

    private fun broadcastState(
        running: Boolean,
        error: String? = null,
        requestId: String? = null
    ) {
        try {
            val intent = Intent(ACTION_STATE)
                .setPackage(packageName)
                .putExtra(EXTRA_RUNNING, running)
            if (error != null) intent.putExtra(EXTRA_ERROR, error)
            if (requestId != null) intent.putExtra(EXTRA_REQUEST_ID, requestId)
            sendBroadcast(intent)
            TileService.requestListeningState(
                this,
                ComponentName(this, VarmlenTileService::class.java)
            )
        } catch (_: Throwable) {}
    }

    /** Stop Xray before closing its TUN descriptor. */
    private fun teardown() {
        stopping = true
        notifHandler.removeCallbacks(statsTick)
        try { xray?.destroy() } catch (_: Throwable) {}
        xray = null
        try { tun?.close() } catch (_: Throwable) {}
        tun = null
    }

    @Volatile private var stopAllInProgress = false

    @Synchronized
    private fun stopAll(
        error: String? = null,
        requestId: String? = null,
        requestStopSelf: Boolean = true,
    ) {
        if (stopAllInProgress) {
            // Teardown is already complete or in progress. A newer explicit
            // disconnect still needs a matching acknowledgement; silently
            // returning here leaves the Rust command pending for 15 seconds and
            // makes the power button appear broken.
            setWant(this, false)
            broadcastState(false, error, requestId)
            if (requestStopSelf) stopSelf()
            return
        }
        stopAllInProgress = true
        setWant(this, false)
        teardown()
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Throwable) {}
        // Confirm only after every data-plane component is down. The plugin
        // keeps disconnect() pending until it receives this request ID.
        broadcastState(false, error, requestId)
        if (requestStopSelf) stopSelf()
    }

    override fun onRevoke() {
        // The system (or another VPN / the user via system settings) revoked us.
        log("VPN revoked by system")
        stopAll()
        super.onRevoke()
    }

    override fun onDestroy() {
        stopAll(requestStopSelf = false)
        super.onDestroy()
    }

    /** Foreground startup is mandatory. Continuing after this fails produces a
     *  VPN that Android is allowed to kill seconds later while the UI says it
     *  is connected, so failures propagate to the pending connect request. */
    private fun startForegroundOrThrow() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "VPN", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notif = buildNotif("Connecting…")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotif(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, VarmlenVpnService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Varmlen")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Disconnect", stopIntent).build())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    /** Refresh the notification with the current up/down speed and uptime. */
    private fun updateNotification() {
        val now = System.currentTimeMillis()
        var up = 0L
        var down = 0L
        val tx = TrafficStats.getUidTxBytes(applicationInfo.uid)
        val rx = TrafficStats.getUidRxBytes(applicationInfo.uid)
        if (tx != TrafficStats.UNSUPPORTED.toLong() && rx != TrafficStats.UNSUPPORTED.toLong()) {
            if (lastStatsAt > 0) {
                val dt = (now - lastStatsAt).coerceAtLeast(1)
                up = (tx - lastTx) * 1000 / dt
                down = (rx - lastRx) * 1000 / dt
            }
            lastTx = tx; lastRx = rx; lastStatsAt = now
        }
        val uptime = if (connectedAt > 0) (now - connectedAt) / 1000 else 0
        val text = "↑ ${speed(up)}   ↓ ${speed(down)}   ${duration(uptime)}"
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIF_ID, buildNotif(text))
        } catch (_: Throwable) {}
    }

    private fun speed(bps: Long): String {
        val b = bps.coerceAtLeast(0)
        return when {
            b < 1024 -> "$b B/s"
            b < 1024 * 1024 -> "${b / 1024} KB/s"
            else -> String.format("%.1f MB/s", b / 1048576.0)
        }
    }

    private fun duration(sec: Long): String {
        val h = sec / 3600
        val m = (sec % 3600) / 60
        val s = sec % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, s)
        else String.format("%02d:%02d", m, s)
    }
}
