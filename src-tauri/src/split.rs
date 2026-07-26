//! Split-tunnel selection — shared by the xray config generator and the
//! OS-level per-app router (the helper).
//!
//! One `mode` applies to BOTH the apps and sites lists:
//!   - selective = whitelist (only listed apps/sites are tunneled; default direct)
//!   - general   = blacklist (everything is tunneled; listed entries are
//!     exceptions that stay direct)
//!
//! Both dimensions are enforced inside xray's routing: the app dimension via
//! xray's native `process` matcher (the native tun preserves each app's local
//! socket, so xray resolves the owning process via /proc), the site dimension
//! via `domain` rules.

use serde::Deserialize;

/// Split-tunnel selection passed from the UI (only enabled entries). Apps and
/// sites carry INDEPENDENT modes.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SplitInput {
    /// Apps mode: "selective" | "general". Empty → "general" so an uninitialised
    /// input doesn't accidentally cut the user's network.
    #[serde(default)]
    pub apps_mode: String,
    /// Sites mode: "selective" | "general".
    #[serde(default)]
    pub sites_mode: String,
    /// Process / binary names (desktop) or package names (Android) of enabled apps.
    #[serde(default)]
    pub apps: Vec<String>,
    /// Enabled site patterns (e.g. "example.com" or "*.example.com").
    #[serde(default)]
    pub sites: Vec<String>,
}

impl SplitInput {
    /// selective = whitelist (only listed apps are tunneled).
    pub fn apps_selective(&self) -> bool {
        self.apps_mode == "selective"
    }
    /// selective = whitelist (only listed sites are tunneled).
    pub fn sites_selective(&self) -> bool {
        self.sites_mode == "selective"
    }

    /// Enabled, non-empty app/process names.
    pub fn enabled_apps(&self) -> Vec<String> {
        self.apps
            .iter()
            .filter(|a| !a.is_empty())
            .cloned()
            .collect()
    }
}
