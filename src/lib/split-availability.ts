/** Whether the applications half of the split page is a place a swipe can stop at.
 *
 *  On Linux this depends on the VPN mode: in proxy mode there is no per-application
 *  routing to promise, so the applications zone is not in the strip at all and the
 *  swipe meets a wall instead of a tab that goes nowhere.
 *
 *  On Android there is no mode to ask. The tunnel IS the VpnService, and per-application
 *  routing is what a VpnService does -- the service is handed the split when the tunnel
 *  starts (`src-tauri/src/mobile_vpn.rs`) -- so the applications half always exists.
 */
export function appSplitAvailable(): boolean {
  return true;
}