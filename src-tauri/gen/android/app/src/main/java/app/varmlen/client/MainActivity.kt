package app.varmlen.client

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** Last keyboard height sent to the page, in CSS px, so an unchanged inset
   *  (every system-bar tweak re-dispatches insets) costs no JavaScript. */
  private var imeHeightCss = -1

  /**
   * The keyboard lifts the sheet, not the window. Left to the default, Android
   * pans the whole window up to uncover the focused field -- the page vanishes
   * above the screen and the sheet is left floating over black. The activity is
   * `adjustResize` and edge-to-edge, which on current Android resizes nothing, so
   * the keyboard's height is handed to the page as `--ime-height` and the sheet
   * pads itself above it (app.css, `.modal-backdrop`).
   */
  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val css = Math.round(imePx / resources.displayMetrics.density)
      if (css != imeHeightCss) {
        imeHeightCss = css
        webView.evaluateJavascript(
          "document.documentElement.style.setProperty('--ime-height','${css}px')",
          null,
        )
      }
      // The WebView still needs the insets for env(safe-area-inset-*).
      ViewCompat.onApplyWindowInsets(view, insets)
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
