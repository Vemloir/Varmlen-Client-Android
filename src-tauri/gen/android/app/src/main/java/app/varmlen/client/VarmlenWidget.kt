package app.varmlen.client

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.widget.RemoteViews
import java.io.File
import java.util.Locale

/**
 * Home-screen widget, 4x1 at the least: the location's flag -- the app's own
 * square flag picture, inset like the button -- and name, the tunnel's live
 * upload and download speed and a connect button that lights up in the app's
 * accent while connected. A location without a country shows a plain white
 * flag.
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

    /** The widget's padding on every side (widget_4x1.xml). */
    private const val WIDGET_PADDING_DP = 8
    private const val LANGUAGE_FILE = "widget-language.txt"
    private val LANGUAGES = setOf("en", "ru")

    /** The app's language, which the widget speaks instead of the system's.
     *  Returns whether it changed. */
    fun saveLanguage(context: Context, language: String): Boolean {
        if (language !in LANGUAGES) return false
        val file = File(context.filesDir, LANGUAGE_FILE)
        val current = try { file.readText() } catch (_: Throwable) { "" }
        if (current == language) return false
        return try { file.writeText(language); true } catch (_: Throwable) { false }
    }

    /** A context whose resources are in the app's language, when it set one. */
    private fun localized(context: Context): Context {
        val language = try {
            File(context.filesDir, LANGUAGE_FILE).readText().trim()
        } catch (_: Throwable) { "" }
        if (language !in LANGUAGES) return context
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocale(Locale(language))
        return context.createConfigurationContext(configuration)
    }
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
        for (id in ids) {
            val views = build(context, state)
            squareButton(views, manager.getAppWidgetOptions(id))
            try { manager.updateAppWidget(id, views) } catch (_: Throwable) {}
        }
    }

    /**
     * The flag and the button are as wide as the widget is high, less the
     * padding, so both are square and inset the same on every side whatever
     * height the launcher gives a cell. Android 12 can resize a view in a
     * widget; earlier versions keep the layout's width.
     */
    private fun squareButton(views: RemoteViews, options: Bundle?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        // A portrait home screen lays the widget out at its maximum height.
        val height = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT) ?: 0
        if (height <= 0) return
        val side = (height - 2 * WIDGET_PADDING_DP).coerceIn(44, 96)
        views.setViewLayoutWidth(R.id.widget_toggle, side.toFloat(), TypedValue.COMPLEX_UNIT_DIP)
        views.setViewLayoutWidth(R.id.widget_flag, side.toFloat(), TypedValue.COMPLEX_UNIT_DIP)
    }

    private fun build(context: Context, state: WidgetState): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_4x1)
        // The launcher would resolve the layout's own strings in the system's
        // language, so every word is set here in the app's.
        val strings = localized(context)
        val live = state.phase == WidgetPhase.CONNECTED
        val (up, upUnit) = speedParts(state.upBps ?: 0)
        val (down, downUnit) = speedParts(state.downBps ?: 0)
        views.setTextViewText(R.id.widget_up, if (live) up else "—")
        views.setTextViewText(R.id.widget_up_unit, if (live) upUnit else "")
        views.setTextViewText(R.id.widget_down, if (live) down else "—")
        views.setTextViewText(R.id.widget_down_unit, if (live) downUnit else "")
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
        views.setContentDescription(R.id.widget_toggle, strings.getString(
            when (state.phase) {
                WidgetPhase.CONNECTED -> R.string.widget_disconnect
                WidgetPhase.CONNECTING -> R.string.widget_connecting
                WidgetPhase.DISCONNECTED -> R.string.widget_connect
            }
        ))
        views.setImageViewResource(R.id.widget_flag, flagDrawable(context, state.icon))
        views.setTextViewText(
            R.id.widget_name,
            state.name.ifEmpty { strings.getString(R.string.widget_no_location) },
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

    /** The square flag picture for a label's leading flag emoji, rendered from
     *  the app's flag set by scripts/widget-flags.sh. */
    private fun flagDrawable(context: Context, icon: String): Int {
        val code = countryCode(icon) ?: return R.drawable.widget_flag_none
        @Suppress("DiscouragedApi")
        val id = context.resources.getIdentifier("widget_flag_$code", "drawable", context.packageName)
        return if (id != 0) id else R.drawable.widget_flag_none
    }

    fun openAppIntent(context: Context): Intent =
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

/** A speed as the notification and the widget show it: whole B/s and KB/s,
 *  MB/s with one decimal. */
internal fun speedParts(bytesPerSecond: Long): Pair<String, String> {
    val b = bytesPerSecond.coerceAtLeast(0)
    return when {
        b < 1024 -> "$b" to "B/s"
        b < 1024 * 1024 -> "${b / 1024}" to "KB/s"
        else -> String.format("%.1f", b / 1048576.0) to "MB/s"
    }
}

/** The two-letter code a flag emoji spells (🇫🇮 -> "fi"), as the app's
 *  `countryCodeFromFlag` reads it; null for anything else. */
internal fun countryCode(icon: String): String? {
    val points = icon.trim().codePoints().toArray()
    if (points.size != 2 || points.any { it !in 0x1F1E6..0x1F1FF }) return null
    return points.joinToString("") { ('a' + (it - 0x1F1E6)).toString() }
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
