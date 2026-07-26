package app.varmlen.client

import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile (notification shade) that toggles the VPN. Starting needs
 * a saved config (a previous connect) + VPN consent; if either is missing, it
 * opens the app instead.
 */
class VarmlenTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        setTile(VarmlenVpnService.isRunning(this))
    }

    override fun onClick() {
        super.onClick()
        if (VarmlenVpnService.isRunning(this)) {
            VarmlenVpnService.stop(this)
            setTile(false)
            return
        }
        // Can't start in the background without consent + a remembered config.
        if (VpnService.prepare(this) != null || !VarmlenVpnService.hasSavedConfig(this)) {
            openApp()
            return
        }
        VarmlenVpnService.start(this)
        setTileUnavailable()
    }

    private fun openApp() {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE)
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(i)
        }
    }

    private fun setTile(active: Boolean) {
        val t = qsTile ?: return
        t.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.updateTile()
    }

    private fun setTileUnavailable() {
        val t = qsTile ?: return
        t.state = Tile.STATE_UNAVAILABLE
        t.updateTile()
    }
}
