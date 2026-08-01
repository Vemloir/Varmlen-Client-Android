package app.varmlen.client

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.webkit.WebView
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import java.io.ByteArrayOutputStream
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.UUID

@InvokeArg
class BarStyleArgs {
    /** true when the app is in LIGHT theme → dark system-bar icons. */
    var light: Boolean = false
}

@InvokeArg
class ClipboardWriteArgs {
    var text: String = ""
}

@InvokeArg
class ConnectArgs {
    var config: String = ""
    /** Device-free variant of `config`, validated with `xray run -test`
     *  before the candidate config may replace the active tunnel. */
    var validationConfig: String = ""
    var dns: String = "1.1.1.1"
    var apps: Array<String> = arrayOf()
    var appsAllow: Boolean = false
    var logLevel: String = "warn"
}

@InvokeArg
class SubscriptionRefreshItemArgs {
    var id: String = ""
    var url: String = ""
    var userAgent: String = "varmlen"
    var intervalHours: Int = 0
    var lastSuccessAt: Long = 0
    var nextUpdateAt: Long = 0
}

@InvokeArg
class SyncSubscriptionRefreshArgs {
    var schedules: Array<SubscriptionRefreshItemArgs> = arrayOf()
}

@InvokeArg
class FetchSubscriptionArgs {
    var url: String = ""
    var userAgent: String = ""
    var deviceOs: String = "android"
}

/** Tauri bridge: the Rust `vpn_connect`/`vpn_disconnect` commands call into this
 *  on Android to drive the VpnService (with the system consent dialog). */
@TauriPlugin
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
    private var pendingArgs: ConnectArgs? = null
    private data class PendingConnect(val id: String, val invoke: Invoke)
    private var pendingConnect: PendingConnect? = null
    private data class PendingDisconnect(val id: String, val invoke: Invoke)
    private var pendingDisconnect: PendingDisconnect? = null
    private val connectTimeouts = Handler(Looper.getMainLooper())

    // Bridges the VpnService's (other-process) state broadcast to a JS event, so
    // the UI updates instantly on a notification/tile/system disconnect.
    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            val running = i?.getBooleanExtra(VarmlenVpnService.EXTRA_RUNNING, false) ?: false
            val requestId = i?.getStringExtra(VarmlenVpnService.EXTRA_REQUEST_ID)
            val error = i?.getStringExtra(VarmlenVpnService.EXTRA_ERROR)
            val data = JSObject()
            data.put("running", running)
            trigger("vpnState", data)
            val connect = pendingConnect
            when (
                connect?.let {
                    vpnRequestOutcome(
                        VpnRequestKind.CONNECT,
                        it.id,
                        requestId,
                        running,
                    )
                }
            ) {
                VpnRequestOutcome.RESOLVE -> {
                    pendingConnect = null
                    connect.invoke.resolve()
                }
                VpnRequestOutcome.REJECT -> {
                    pendingConnect = null
                    connect.invoke.reject(error ?: "VPN service failed to start")
                }
                else -> Unit
            }

            val disconnect = pendingDisconnect
            when (
                disconnect?.let {
                    vpnRequestOutcome(
                        VpnRequestKind.DISCONNECT,
                        it.id,
                        requestId,
                        running,
                    )
                }
            ) {
                VpnRequestOutcome.RESOLVE -> {
                    pendingDisconnect = null
                    disconnect.invoke.resolve()
                }
                VpnRequestOutcome.REJECT -> {
                    pendingDisconnect = null
                    disconnect.invoke.reject(error ?: "VPN service failed to stop")
                }
                else -> Unit
            }
        }
    }

    override fun load(webView: WebView) {
        super.load(webView)
        val filter = IntentFilter(VarmlenVpnService.ACTION_STATE)
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                activity.registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                activity.registerReceiver(stateReceiver, filter)
            }
        } catch (_: Throwable) {}
    }

    @Command
    fun connect(invoke: Invoke) {
        val args = invoke.parseArgs(ConnectArgs::class.java)
        val consent = VpnService.prepare(activity)
        if (consent != null) {
            // First run: ask for VPN permission, then start on the result.
            pendingArgs = args
            startActivityForResult(invoke, consent, "onConsent")
            return
        }
        beginConnect(invoke, args)
    }

    @ActivityCallback
    fun onConsent(invoke: Invoke, result: ActivityResult) {
        val args = pendingArgs
        pendingArgs = null
        if (result.resultCode == Activity.RESULT_OK && args != null) {
            beginConnect(invoke, args)
        } else {
            invoke.reject("VPN permission denied")
        }
    }

    @Command
    fun disconnect(invoke: Invoke) {
        pendingConnect?.invoke?.reject("VPN connection request cancelled by disconnect")
        pendingConnect = null
        pendingDisconnect?.invoke?.reject("Superseded by a newer VPN disconnect request")
        val requestId = UUID.randomUUID().toString()
        pendingDisconnect = PendingDisconnect(requestId, invoke)
        try {
            VarmlenVpnService.stop(activity, requestId)
        } catch (error: Throwable) {
            pendingDisconnect = null
            invoke.reject(error.message ?: "Could not stop VPN service")
            return
        }
        connectTimeouts.postDelayed({
            val pending = pendingDisconnect
            if (pending?.id == requestId) {
                pendingDisconnect = null
                pending.invoke.reject("VPN service did not confirm shutdown within 15 seconds")
            }
        }, 15_000)
    }

    @Command
    fun status(invoke: Invoke) {
        val ret = JSObject()
        ret.put("running", VarmlenVpnService.isRunning(activity))
        invoke.resolve(ret)
    }

    @Command
    fun readLog(invoke: Invoke) {
        val ret = JSObject()
        // Bounded tail, not the whole (potentially multi-MB) file — see
        // VarmlenVpnService.readLogTail.
        ret.put("log", VarmlenVpnService.readLogTail(activity))
        invoke.resolve(ret)
    }

    @Command
    fun clearLog(invoke: Invoke) {
        try { java.io.File(activity.filesDir, VarmlenVpnService.LOG_FILE).writeText("") } catch (_: Throwable) {}
        invoke.resolve()
    }

    /** Persist exact one-shot schedules in WorkManager. This bridge never
     * starts the VPN service or an Activity. */
    @Command
    fun syncSubscriptionRefresh(invoke: Invoke) {
        val args = invoke.parseArgs(SyncSubscriptionRefreshArgs::class.java)
        Thread {
            try {
                val schedules = args.schedules.map {
                    SubscriptionRefreshSchedule(
                        id = it.id,
                        url = it.url,
                        userAgent = it.userAgent,
                        intervalHours = it.intervalHours,
                        lastSuccessAt = it.lastSuccessAt,
                        nextUpdateAt = it.nextUpdateAt,
                    )
                }
                SubscriptionRefreshScheduler.sync(activity.applicationContext, schedules)
                invoke.resolve()
            } catch (error: Throwable) {
                invoke.reject(
                    boundedSubscriptionRefreshError(
                        error.message ?: "Could not schedule subscription refresh",
                    ),
                )
            }
        }.apply { isDaemon = true; start() }
    }

    @Command
    fun cancelSubscriptionRefresh(invoke: Invoke) {
        try {
            SubscriptionRefreshScheduler.cancelAll(activity.applicationContext)
            invoke.resolve()
        } catch (error: Throwable) {
            invoke.reject(
                boundedSubscriptionRefreshError(
                    error.message ?: "Could not cancel subscription refresh",
                ),
            )
        }
    }

    @Command
    fun drainSubscriptionRefreshes(invoke: Invoke) {
        Thread {
            try {
                val results = JSArray()
                SubscriptionRefreshStore(activity.applicationContext).drain().forEach { response ->
                    val headers = JSObject()
                    response.headers.forEach { (name, value) -> headers.put(name, value) }
                    results.put(JSObject().apply {
                        put("id", response.id)
                        put("body", response.body)
                        put("headers", headers)
                        put("refreshedAt", response.refreshedAt)
                    })
                }
                invoke.resolve(JSObject().apply { put("results", results) })
            } catch (error: Throwable) {
                invoke.reject(
                    boundedSubscriptionRefreshError(
                        error.message ?: "Could not read subscription refreshes",
                    ),
                )
            }
        }.apply { isDaemon = true; start() }
    }

    /** Interactive imports use Android's platform TLS stack, exactly like
     * WorkManager refreshes and other native Android VPN clients. */
    @Command
    fun fetchSubscription(invoke: Invoke) {
        val args = invoke.parseArgs(FetchSubscriptionArgs::class.java)
        Thread {
            try {
                val response = fetchSubscriptionHttp(
                    args.url,
                    args.userAgent,
                    args.deviceOs,
                )
                val headers = JSObject()
                response.headers.forEach { (name, value) -> headers.put(name, value) }
                invoke.resolve(JSObject().apply {
                    put("body", response.body)
                    put("headers", headers)
                })
            } catch (error: Throwable) {
                invoke.reject(
                    boundedSubscriptionRefreshError(
                        error.message ?: "Could not fetch subscription",
                    ),
                )
            }
        }.apply { isDaemon = true; start() }
    }

    /** Read the system clipboard (Android blocks navigator.clipboard in WebView). */
    @Command
    fun readClipboard(invoke: Invoke) {
        val ret = JSObject()
        val text = try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString() ?: ""
        } catch (_: Throwable) { "" }
        ret.put("text", text)
        invoke.resolve(ret)
    }

    @Command
    fun writeClipboard(invoke: Invoke) {
        val args = invoke.parseArgs(ClipboardWriteArgs::class.java)
        try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("Varmlen VPN log", args.text))
            invoke.resolve()
        } catch (error: Throwable) {
            invoke.reject(error.message ?: "Could not write to the clipboard")
        }
    }

    /** Dark/light system-bar icons to match the app theme. */
    @Command
    fun setBarStyle(invoke: Invoke) {
        val args = invoke.parseArgs(BarStyleArgs::class.java)
        activity.runOnUiThread {
            try {
                val w = activity.window
                val c = WindowCompat.getInsetsController(w, w.decorView)
                c.isAppearanceLightStatusBars = args.light
                c.isAppearanceLightNavigationBars = args.light
            } catch (_: Throwable) {}
        }
        invoke.resolve()
    }

    @Command
    fun notificationsEnabled(invoke: Invoke) {
        val ret = JSObject()
        val on = try {
            androidx.core.app.NotificationManagerCompat.from(activity).areNotificationsEnabled()
        } catch (_: Throwable) { true }
        ret.put("enabled", on)
        invoke.resolve(ret)
    }

    @Command
    fun openNotificationSettings(invoke: Invoke) {
        try {
            val i = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, activity.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(i)
        } catch (_: Throwable) {
            try {
                activity.startActivity(
                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(android.net.Uri.parse("package:" + activity.packageName))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Throwable) {}
        }
        invoke.resolve()
    }

    @Command
    fun openVpnSettings(invoke: Invoke) {
        try {
            activity.startActivity(
                Intent(android.provider.Settings.ACTION_VPN_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            invoke.resolve()
        } catch (error: Throwable) {
            invoke.reject(error.message ?: "Could not open Android VPN settings")
        }
    }

    /** Paths the Rust side needs to run xray for a proxy ping: the bundled
     *  binary (in nativeLibraryDir) and a writable config dir (filesDir). */
    @Command
    fun xrayPaths(invoke: Invoke) {
        val ret = JSObject()
        ret.put("bin", java.io.File(activity.applicationInfo.nativeLibraryDir, "libxray.so").absolutePath)
        ret.put("dir", activity.filesDir.absolutePath)
        invoke.resolve(ret)
    }

    /** Launchable apps (the ones a user recognises), for the split-tunnel picker. */
    @Command
    fun listApps(invoke: Invoke) {
        // Heavy (PackageManager query + icon rasterisation). Run off the main
        // thread so the picker modal can paint immediately instead of freezing
        // until the scan finishes.
        Thread {
            val pm = activity.packageManager
            val main = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
            val arr = JSArray()
            val seen = HashSet<String>()
            try {
                for (ri in pm.queryIntentActivities(main, 0)) {
                    val pkg = ri.activityInfo?.packageName ?: continue
                    if (pkg == activity.packageName || !seen.add(pkg)) continue
                    val o = JSObject()
                    o.put("id", pkg)
                    o.put("name", ri.loadLabel(pm).toString())
                    o.put("icon", try { iconDataUri(ri.loadIcon(pm)) } catch (_: Throwable) { null })
                    arr.put(o)
                }
            } catch (_: Throwable) {}
            val ret = JSObject()
            ret.put("apps", arr)
            invoke.resolve(ret)
        }.apply { isDaemon = true; start() }
    }

    /** Rasterise an app icon to a small PNG data URI for the picker. */
    private fun iconDataUri(d: Drawable?): String? {
        if (d == null) return null
        // Small WEBP keeps the DOM light: a few hundred app icons as 96px PNGs
        // exhaust the WebView's image memory and start dropping off-screen ones
        // while scrolling. 64px lossy WEBP is ~5x smaller.
        val size = 64
        val bmp = if (d is BitmapDrawable && d.bitmap != null) {
            Bitmap.createScaledBitmap(d.bitmap, size, size, true)
        } else {
            val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val c = Canvas(b)
            d.setBounds(0, 0, size, size)
            d.draw(c)
            b
        }
        val out = ByteArrayOutputStream()
        val fmt = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY
        else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
        bmp.compress(fmt, 80, out)
        return "data:image/webp;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun beginConnect(invoke: Invoke, args: ConnectArgs) {
        pendingDisconnect?.invoke?.reject("Superseded by a newer VPN connection request")
        pendingDisconnect = null
        pendingConnect?.invoke?.reject("Superseded by a newer VPN connection request")
        val requestId = UUID.randomUUID().toString()
        pendingConnect = PendingConnect(requestId, invoke)
        try {
            startVpn(args, requestId)
        } catch (error: Throwable) {
            pendingConnect = null
            invoke.reject(error.message ?: "Could not start VPN service")
            return
        }
        connectTimeouts.postDelayed({
            val pending = pendingConnect
            if (pending?.id == requestId) {
                pendingConnect = null
                pending.invoke.reject("VPN service did not confirm startup within 15 seconds")
            }
        }, 15_000)
    }

    private fun startVpn(args: ConnectArgs, requestId: String) {
        val intent = Intent(activity, VarmlenVpnService::class.java)
        intent.action = VarmlenVpnService.ACTION_CONNECT
        intent.putExtra(VarmlenVpnService.EXTRA_CONFIG, args.config)
        intent.putExtra(VarmlenVpnService.EXTRA_VALIDATION_CONFIG, args.validationConfig)
        intent.putExtra(VarmlenVpnService.EXTRA_DNS, args.dns)
        intent.putExtra(VarmlenVpnService.EXTRA_APPS, args.apps)
        intent.putExtra(VarmlenVpnService.EXTRA_APPS_ALLOW, args.appsAllow)
        intent.putExtra(VarmlenVpnService.EXTRA_LOG_LEVEL, args.logLevel)
        intent.putExtra(VarmlenVpnService.EXTRA_REQUEST_ID, requestId)
        ContextCompat.startForegroundService(activity, intent)
    }
}
