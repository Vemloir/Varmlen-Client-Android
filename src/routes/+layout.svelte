<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { NAV } from "$lib/nav";
  import { t } from "$lib/i18n.svelte";
  import { core } from "$lib/core.svelte";
  import { conn } from "$lib/conn.svelte";
  import { subs } from "$lib/subs.svelte";
  import { split } from "$lib/split.svelte";
  import { settings } from "$lib/settings.svelte";
  import {
    cancelSubscriptionRefresh,
    drainSubscriptionRefreshes,
    readLegacyStorage,
    setTrayStatus,
    setCloseToTray,
    setStatusBar,
    syncSubscriptionRefresh,
  } from "$lib/api";
  import { listen } from "@tauri-apps/api/event";
  import { theme } from "$lib/theme.svelte";
  import { isAndroid } from "$lib/platform";

  /** One-shot migration on first launch in a new origin (e.g. release vs dev
   *  use different WebKit storage). Pulls everything from the previous
   *  origin's localStorage and reloads so the stores re-init from it. */
  async function migrateLegacyStorage() {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("varmlen.subs") !== null) return; // already seeded
    try {
      const data = await readLegacyStorage();
      const entries = Object.entries(data ?? {});
      console.log(`[migrate] legacy storage: ${entries.length} keys`);
      if (entries.length === 0) return;
      for (const [k, v] of entries) localStorage.setItem(k, v);
      window.location.reload();
    } catch (e) {
      console.error("[migrate] failed:", e);
    }
  }

  let { children } = $props();

  // Reading `page.url.pathname` through a $derived ensures the active-tab
  // class re-evaluates reliably on every navigation (intermittent stale state
  // otherwise).
  const currentPath = $derived(page.url.pathname);
  function isActive(path: string): boolean {
    if (path === "/") return currentPath === "/";
    return currentPath.startsWith(path);
  }

  // First-launch chores: migrate prior-origin localStorage + install the core.
  // Network permissions are NOT requested here — they're prompted on the first
  // connect (when actually needed), so launch is non-intrusive.
  onMount(async () => {
    await migrateLegacyStorage();
    // xray is the sole core (native TUN + transport).
    await core.autoInit();
  });

  // Reflect the real VPN state on launch: if xray is still running (e.g. the
  // window was just recreated), show "connected" instead of a stale
  // "disconnected".
  onMount(() => void conn.refresh());

  // Re-sync when the app returns to the foreground — the VPN may have been
  // toggled from the Quick Settings tile / notification while we were away.
  onMount(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void conn.refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  });

  // A native (Rust) watcher emits a global `vpn-running` event the instant the
  // tunnel goes up or down — including a disconnect from the notification, the
  // tile, a system revoke, or a crashed core. Global events ride core:event
  // (granted) and aren't throttled like JS timers, so this is the instant path.
  onMount(() => {
    const un = listen<boolean>("vpn-running", (e) => conn.applyExternalState(e.payload));
    return () => void un.then((f) => f());
  });

  // Backstop only, in case an event is ever missed across process churn.
  onMount(() => {
    const id = setInterval(() => {
      if (conn.status === "connected") void conn.refresh();
    }, 2000);
    return () => clearInterval(id);
  });

  // Schedule only the next future provider boundary. Opening the application
  // never triggers a subscription request, and disabling the setting cancels
  // the pending timer immediately.
  $effect(() => {
    if (isAndroid) {
      subs.stopAutoRefresh();
      return;
    }
    if (!settings.subscriptionAutoUpdate) {
      subs.stopAutoRefresh();
      return;
    }
    return subs.startAutoRefresh();
  });

  let drainingSubscriptionRefreshes = false;
  async function drainNativeSubscriptionRefreshes(): Promise<void> {
    if (!isAndroid || drainingSubscriptionRefreshes) return;
    drainingSubscriptionRefreshes = true;
    try {
      await subs.applyStagedRefreshes(await drainSubscriptionRefreshes());
    } catch (error) {
      console.error("could not drain Android subscription refreshes:", error);
    } finally {
      drainingSubscriptionRefreshes = false;
    }
  }

  // Android WorkManager owns network timing even with a closed WebView. While
  // the UI is alive, this cheap local drain keeps newly staged results visible.
  onMount(() => {
    if (!isAndroid) return;
    void drainNativeSubscriptionRefreshes();
    const id = setInterval(() => void drainNativeSubscriptionRefreshes(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void drainNativeSubscriptionRefreshes();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  // Keep persisted native work aligned with subscriptions, selected UA and the
  // global switch. Sync only schedules future work; it never fetches on mount.
  $effect(() => {
    if (!isAndroid) return;
    const enabled = settings.subscriptionAutoUpdate;
    const schedules = subs.backgroundRefreshSchedules(
      settings.subscriptionUserAgent,
    );
    if (enabled) {
      void syncSubscriptionRefresh(schedules).catch((error) =>
        console.error("could not schedule Android subscription refresh:", error),
      );
    } else {
      void cancelSubscriptionRefresh().catch((error) =>
        console.error("could not cancel Android subscription refresh:", error),
      );
    }
  });

  // Tray "Connect / Disconnect" menu item routes back here (the connect logic
  // — current server + split config — lives in the frontend).
  onMount(() => {
    const un = listen("tray://toggle", () => void conn.toggle());
    return () => void un.then((f) => f());
  });

  // Keep the tray tooltip in sync with the (localized) connection status.
  $effect(() => {
    void setTrayStatus(t(`status.${conn.status}`));
  });

  // Push the close-to-tray preference to the backend (on launch + on change),
  // since the window-close handler lives in Rust.
  $effect(() => {
    void setCloseToTray(settings.closeToTray);
  });

  // Live-reconnect when the config changes (location / split / settings)
  // while connected. Reading these here registers them as effect dependencies.
  $effect(() => {
    void subs.selectedKey;
    void settings.killswitch;
    void settings.allowLan;
    void split.appsMode;
    void split.sitesMode;
    void split.apps;
    void split.sites;
    conn.onConfigChanged(subs.providerRefreshRevision);
  });

  // Android: match the system-bar icon colour to the theme (light theme → dark
  // icons, so the clock / battery / wifi stay visible on the white background).
  $effect(() => {
    if (isAndroid) setStatusBar(theme.current === "light").catch(() => {});
  });
</script>

<div class="app">
  <main class="content">
    {@render children?.()}
  </main>

  <nav class="tabbar">
    {#each NAV as item}
      <a href={item.path} class="tab" class:active={isActive(item.path)}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path d={item.icon} fill="currentColor" />
        </svg>
        <span>{t(item.labelKey)}</span>
      </a>
    {/each}
  </nav>
</div>

<style>
  .app {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  .content {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  .tabbar {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    padding: 6px 4px 8px;
    padding-bottom: max(8px, env(safe-area-inset-bottom));
    flex-shrink: 0;
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 4px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    transition: color var(--transition);
    border-radius: var(--radius-sm);
  }
  @media (hover: hover) {
    .tab:hover { color: var(--text); }
  }
  .tab.active { color: var(--accent); }
</style>
