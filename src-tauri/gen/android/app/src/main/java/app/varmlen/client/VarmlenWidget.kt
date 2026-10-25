package app.varmlen.client

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.RemoteViews
import java.io.File
import java.util.Locale

/**
 * Home-screen widget, 4x1 at the least: the location's flag and name, the
 * tunnel's live upload and download speed and a connect button that lights up
 * in the app's accent while connected. A location without a flag shows a
 * plain white flag.
 *
 * The VPN service runs in its own process and pushes every state change and,
 * while connected, the speed once a second. The provider renders the same
 * views from what is on disk when the launcher asks (a widget added, a
 * reboot), and handles the button the way the Quick Settings tile does.
 */
class VarmlenWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        VarmlenWidget.render(context, VarmlenWidget.restingState(context))
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        id: Int,
        options: Bundle,
    ) {
        VarmlenWidget.render(context, VarmlenWidget.restingState(context))
    }
}

/**
 * The widget's connect button. The launcher must be able to reach the widget
 * provider, so that receiver is exported; this one is not, so only the
 * widget's own PendingIntent -- sent as this app -- can toggle the VPN, never
 * another app's broadcast.
 */
class VarmlenWidgetToggleReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == VarmlenWidget.ACTION_TOGGLE) toggle(context)
    }

    private fun toggle(context: Context) {
        if (VarmlenVpnService.isRunning(context)) {
            VarmlenVpnService.stop(context)
            return
        }
        // Consent and a remembered location are both needed to connect
        // without the app; the button opens the app when either is missing.
        if (VpnService.prepare(context) != null || !VarmlenVpnService.hasSavedConfig(context)) {
            try { context.startActivity(VarmlenWidget.openAppIntent(context)) } catch (_: Throwable) {}
            return
        }
        VarmlenWidget.render(context, VarmlenWidget.restingState(context).copy(phase = WidgetPhase.CONNECTING))
        VarmlenVpnService.start(context)
    }
}

enum class WidgetPhase { DISCONNECTED, CONNECTING, CONNECTED }

data class WidgetState(
    val phase: WidgetPhase,
    /** Bytes per second; null when there is nothing to measure. */
    val upBps: Long? = null,
    val downBps: Long? = null,
    val icon: String = "",
    val name: String = "",
)

object VarmlenWidget {
    const val ACTION_TOGGLE = "app.varmlen.client.WIDGET_TOGGLE"
    private const val LOCATION_FILE = "widget-location.txt"

    private const val NO_FLAG = "🏳️"
    private const val ICON_IDLE = 0xFFFFFFFF.toInt()
    private const val ICON_CONNECTING = 0xFF8C8C8C.toInt()
    private const val ICON_ON_ACCENT = 0xFF1E1E1E.toInt()

    /** Remember the location a connect used, for the widget's flag and name. */
    fun saveLocation(context: Context, label: String) {
        try { File(context.filesDir, LOCATION_FILE).writeText(label) } catch (_: Throwable) {}
    }

    private fun savedLocation(context: Context): String =
        try { File(context.filesDir, LOCATION_FILE).readText() } catch (_: Throwable) { "" }

    /** What the widget shows without a live push from the service. */
    fun restingState(context: Context): WidgetState {
        val (icon, name) = splitLocationLabel(savedLocation(context))
        val phase = if (VarmlenVpnService.isRunning(context)) WidgetPhase.CONNECTED else WidgetPhase.DISCONNECTED
        return WidgetState(phase = phase, icon = icon, name = name)
    }

    /** Push a state from the VPN service. Does nothing without a widget. */
    fun push(context: Context, phase: WidgetPhase, upBps: Long? = null, downBps: Long? = null) {
        val (icon, name) = splitLocationLabel(savedLocation(context))
        render(context, WidgetState(phase, upBps, downBps, icon, name))
    }

    fun render(context: Context, state: WidgetState) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        val ids = try {
            manager.getAppWidgetIds(ComponentName(context, VarmlenWidgetProvider::class.java))
        } catch (_: Throwable) { return }
        if (ids.isEmpty()) return
        val views = build(context, state)
        for (id in ids) {
            try { manager.updateAppWidget(id, views) } catch (_: Throwable) {}
        }
    }

    private fun build(context: Context, state: WidgetState): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_4x1)
        val live = state.phase == WidgetPhase.CONNECTED
        views.setTextViewText(R.id.widget_up, if (live) mbps(state.upBps ?: 0) else "—")
        views.setTextViewText(R.id.widget_down, if (live) mbps(state.downBps ?: 0) else "—")
        views.setInt(
            R.id.widget_toggle, "setBackgroundResource",
            if (live) R.drawable.widget_button_active else R.drawable.widget_button,
        )
        views.setInt(
            R.id.widget_toggle_icon, "setColorFilter",
            when (state.phase) {
                WidgetPhase.CONNECTED -> ICON_ON_ACCENT
                WidgetPhase.CONNECTING -> ICON_CONNECTING
                WidgetPhase.DISCONNECTED -> ICON_IDLE
            },
        )
        views.setContentDescription(R.id.widget_toggle, context.getString(
            when (state.phase) {
                WidgetPhase.CONNECTED -> R.string.widget_disconnect
                WidgetPhase.CONNECTING -> R.string.widget_connecting
                WidgetPhase.DISCONNECTED -> R.string.widget_connect
            }
        ))
        views.setTextViewText(R.id.widget_flag, state.icon.ifEmpty { NO_FLAG })
        views.setTextViewText(
            R.id.widget_name,
            state.name.ifEmpty { context.getString(R.string.widget_no_location) },
        )
        val openApp = PendingIntent.getActivity(
            context, 0, openAppIntent(context),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        views.setOnClickPendingIntent(R.id.widget_root, openApp)
        // Without a remembered location there is nothing to connect to, and a
        // receiver may not open the app from the background on Android 10+, so
        // the button opens it directly.
        val canToggle = live || VarmlenVpnService.hasSavedConfig(context)
        views.setOnClickPendingIntent(R.id.widget_toggle, if (canToggle) {
            PendingIntent.getBroadcast(
                context, 0,
                Intent(context, VarmlenWidgetToggleReceiver::class.java).setAction(ACTION_TOGGLE),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        } else openApp)
        return views
    }

    fun openAppIntent(context: Context): Intent =
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

/** Megabits per second, as the widget shows them: one decimal below 100. */
internal fun mbps(bytesPerSecond: Long): String {
    val value = bytesPerSecond.coerceAtLeast(0) * 8 / 1_000_000.0
    return if (value < 100) String.format(Locale.ROOT, "%.1f", value)
    else String.format(Locale.ROOT, "%.0f", value)
}

/**
 * Split a location label into its leading icon and the rest, the way the app
 * does (`splitLabelEmoji`): a flag -- two regional indicators -- or another
 * leading emoji, with its variation selectors and joined parts.
 */
internal fun splitLocationLabel(label: String): Pair<String, String> {
    val text = label.trim()
    if (text.isEmpty()) return "" to ""
    val first = text.codePointAt(0)
    val end = when {
        isRegionalIndicator(first) && text.length > 2 && isRegionalIndicator(text.codePointAt(2)) -> 4
        isEmojiStart(first) -> emojiSequenceEnd(text)
        else -> 0
    }
    return text.substring(0, end) to text.substring(end).trim()
}

private fun isRegionalIndicator(codePoint: Int) = codePoint in 0x1F1E6..0x1F1FF

private fun isEmojiStart(codePoint: Int) =
    codePoint in 0x1F300..0x1FAFF || codePoint in 0x2600..0x27BF

/** End of one emoji sequence: the base, then any variation selector, skin
 *  tone, or zero-width joiner followed by another emoji. */
private fun emojiSequenceEnd(text: String): Int {
    var index = Character.charCount(text.codePointAt(0))
    while (index < text.length) {
        val codePoint = text.codePointAt(index)
        index += when {
            codePoint == 0xFE0F || codePoint in 0x1F3FB..0x1F3FF -> Character.charCount(codePoint)
            codePoint == 0x200D && index + 1 < text.length ->
                1 + Character.charCount(text.codePointAt(index + 1))
            else -> return index
        }
    }
    return index
}
