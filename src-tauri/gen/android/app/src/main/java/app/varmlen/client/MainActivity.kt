package app.varmlen.client

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** Last keyboard height sent to the page, in CSS px, so an unchanged inset
   *  (every system-bar tweak re-dispatches insets) costs no JavaScript. */
  private var imeHeightCss = -1

  /**
   * The keyboard lifts the sheet, not the window. Two things slide the whole app
   * off the top of the screen when a field is focused: Android panning the window
   * (the default soft-input mode), and a current WebView that is told about the
   * keyboard shrinking its visual viewport and panning that to the field (WebView
   * 124 did not do this; 156 does). The activity is `adjustResize`, which under
   * edge-to-edge resizes nothing, and the WebView gets the insets without the
   * keyboard in them. The page gets the keyboard's height instead -- as
   * `--ime-height` for the sheets to pad themselves above it, and as a
   * `varmlen-ime` event for $lib/keyboard to reveal a covered field.
   */
  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val css = Math.round(imePx / resources.displayMetrics.density)
      if (css != imeHeightCss) {
        imeHeightCss = css
        webView.evaluateJavascript(
          "document.documentElement.style.setProperty('--ime-height','${css}px');" +
            "window.dispatchEvent(new CustomEvent('varmlen-ime',{detail:$css}))",
          null,
        )
      }
      // The WebView still needs the other insets, for env(safe-area-inset-*).
      val withoutKeyboard = WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
      ViewCompat.onApplyWindowInsets(view, withoutKeyboard)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Ask for notification permission ONCE (Android 13+). The VPN shows a live
    // status notification with speed + uptime. If the user declines, they can
    // grant it later from Settings (we don't re-prompt on every launch).
    if (Build.VERSION.SDK_INT >= 33) {
      val prefs = getSharedPreferences("varmlen_ui", Context.MODE_PRIVATE)
      val asked = prefs.getBoolean("asked_notif", false)
      if (!asked &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
      ) {
        try {
          requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        } catch (_: Throwable) {}
        prefs.edit().putBoolean("asked_notif", true).apply()
      }
    }
  }
}
