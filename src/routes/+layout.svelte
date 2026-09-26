<script lang="ts">
  import "../app.css";
  import { onMount, tick } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { NAV } from "$lib/nav";
  import { navPath } from "$lib/nav-path";
  import { entryZone, routeOf, tabOf, zoneOf, zoneOrder } from "$lib/nav-zones";
  import { paneDrag } from "$lib/pane-drag.svelte";
  import { appSplitAvailable } from "$lib/split-availability";
  import { swipeNav } from "$lib/swipe-nav";
  import { stripGeometry } from "$lib/scroll-strip";
  import { slideDirection } from "$lib/swipe";
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
  import { watchKeyboard } from "$lib/keyboard";
  // The pages a swipe can reach without a navigation. Imported as components so
  // the neighbour can be mounted beside the page while the finger is still down.
  import HomePage from "./+page.svelte";
  import SplitPage from "./split/+page.svelte";
  import SettingsPage from "./settings/+page.svelte";

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

  // The WebView here is a component, not a browser: a right-click must never
  // offer Back / Forward / Stop / Reload. Editable fields keep their own
  // Cut/Copy/Paste, which is the only menu a user ever wants from this gesture.
  $effect(() => {
    const onContext = (event: MouseEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContext, { capture: true });

    // Same for the keyboard: Backspace and Alt+arrows are browser history
    // gestures, and in a WebView they leave the app instead of doing nothing.
    // Inside a field Backspace still deletes.
    const onKeydown = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      const editable =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (event.key === "Backspace" && !editable) {
        event.preventDefault();
        return;
      }
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeydown, { capture: true });

    return () => {
      document.removeEventListener("contextmenu", onContext, { capture: true });
      document.removeEventListener("keydown", onKeydown, { capture: true });
    };
  });

  let { children } = $props();

  // Read through a $derived so the active-tab class re-evaluates reliably on every
  // navigation (intermittent stale state otherwise), and through `navPath` because
  // the origin Tauri serves the bundle from has no path at all.
  const currentPath = $derived(navPath());
  const TAB_PATHS = NAV.map((item) => item.path);
  /* The strip a swipe travels along. It is longer than the tab bar: the split page is
     two places wide -- applications, then websites -- and dragging between them moves
     the reader even though the address does not. */
  /* On Android there is no VPN mode to ask: the tunnel is the VpnService and per-app
     routing is what it does, so the applications place is always in the strip. */
  const appsAvailable = $derived(appSplitAvailable());
  const currentZone = $derived(zoneOf(currentPath, split.tab));

  // Which way a new page arrives. Recorded while the path changes and cleared
  // when the animation is over, so a re-render cannot restart it.
  let slide = $state<"next" | "prev" | null>(null);
  /** The element the finger drags: the current page and its neighbour together.
   *  Read through a getter because the action is attached to the content area
   *  before this child exists. */
  let trackEl: HTMLDivElement | undefined = $state();

  /* The scrollbar is drawn here, over the gutter of whichever page is live. It cannot
     live in the page: the page is the thing a swipe moves, and the bar travelled across
     the screen with it -- a strip sliding sideways says nothing about where the reader
     has got to. Drawn as a real element it can also fade, which a scrollbar
     pseudo-element cannot do at all. */
  let contentEl = $state<HTMLElement | undefined>();
  let strip = $state({ top: 0, height: 0, offset: 0, visible: false });
  let stripTarget: HTMLElement | null = null;
  let stripResize: ResizeObserver | undefined;

  /** The scroller of the live page. The half of the split page that is off screen is
   *  inert, so it is not the one the bar should describe. */
  function liveScroller(): HTMLElement | null {
    const list = document.querySelectorAll<HTMLElement>(".page-shell:not(.preview) [data-scroll]");
    for (const el of list) if (!el.hasAttribute("inert")) return el;
    return null;
  }

  function syncStrip(node?: HTMLElement | null): void {
    const el = node ?? stripTarget ?? liveScroller();
    if (!el) {
      strip = { top: 0, height: 0, offset: 0, visible: false };
      return;
    }
    stripTarget = el;
    const g = stripGeometry(el.scrollTop, el.scrollHeight, el.clientHeight);
    strip = {
      top: g.top,
      height: g.height,
      offset: el.getBoundingClientRect().top,
      visible: g.visible,
    };
    if (stripResize) {
      stripResize.disconnect();
      stripResize.observe(el);
    }
  }
  /** The neighbour mounted beside the page while a swipe is in progress. */
  let preview = $state<{ path: string; side: "next" | "prev" } | null>(null);
  /** A page that was dragged in is already standing where it belongs; running the
   *  arrival keyframes on top of that reads as a stutter. */
  let draggedIn: string | null = null;
  let previousPath = "/";

  /** Which side of the page the neighbour belongs on. */
  function setPreview(to: string | null): void {
    if (!to) {
      preview = null;
      return;
    }
    const order = zoneOrder(appsAvailable);
    preview = { path: to, side: order.indexOf(to) >= order.indexOf(currentZone) ? "next" : "prev" };
  }

  /** A page opens where the reader left it. A gesture that arrives at the split page
   *  from another page lands on the half that is selected there, not on the half the
   *  direction of the swipe happens to point at; a gesture on the page itself still
   *  moves between its halves. */
  function landingZone(zone: string): string {
    if (routeOf(zone) !== "/split" || navPath() === "/split") return zone;
    return entryZone(split.tab, appSplitAvailable());
  }

  /** A zone is reached either by navigating or by moving the split page between its
   *  two halves -- and only by navigating when the reader is not on that page yet. */
  async function goToZone(zone: string): Promise<void> {
    const route = routeOf(zone);
    draggedIn = route;
    if (route !== navPath()) await goto(route);
    const tab = tabOf(zone);
    if (tab) split.setTab(tab);
    await tick();
  }

  $effect(() => {
    const path = navPath();
    const direction = slideDirection(previousPath, path, TAB_PATHS);
    previousPath = path;
    if (draggedIn === path) {
      draggedIn = null;
      slide = null;
      return;
    }
    if (!direction) {
      slide = null;
      return;
    }
    slide = direction;
    const timer = setTimeout(() => (slide = null), 200);
    return () => clearTimeout(timer);
  });

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

  // The keyboard is ours to follow on Android: see $lib/keyboard.
  onMount(() => (isAndroid ? watchKeyboard() : undefined));

  /* The bar follows the page it belongs to: on scroll, when the content under it grows
     (flags, ping results, subscription cards), when the window changes size, and when
     the route or the split half changes under it. */
  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      stripResize = new ResizeObserver(() => syncStrip());
    }
    const onScroll = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (el && typeof el.scrollHeight === "number") syncStrip(el);
    };
    const onResize = () => syncStrip();
    contentEl?.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    void tick().then(() => syncStrip());
    return () => {
      contentEl?.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      stripResize?.disconnect();
      stripResize = undefined;
    };
  });

  $effect(() => {
    page.url.pathname;
    split.tab;
    void tick().then(() => syncStrip());
  });

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
  // the pending timer immediately. On Android the in-process timer is stopped
  // outright: WorkManager owns network timing there, so a WebView timer would be
  // a second, weaker scheduler racing the one that survives a closed app.
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

  // Live-reconnect when the config changes (location / split / mode / settings)
  // while connected. Reading these here registers them as effect dependencies.
  $effect(() => {
    void subs.selectedKey;
    void settings.killswitch;
    void settings.allowLan;
    void split.appsMode;
    void split.sitesMode;
    void split.apps;
    void split.sites;
    conn.onConfigChanged();
  });

  // Android: match the system-bar icon colour to the theme (light theme → dark
  // icons, so the clock / battery / wifi stay visible on the white background).
  $effect(() => {
    if (isAndroid) setStatusBar(theme.current === "light").catch(() => {});
  });
</script>

<div class="app">
  <main
    bind:this={contentEl}
    class="content"
    use:swipeNav={{
      path: () => zoneOf(navPath(), split.tab),
      order: () => zoneOrder(appsAvailable),
      go: goToZone,
      route: routeOf,
      // Split tunnelling is one route with two sections: a swipe between them moves
      // the sections, not the window, because the pill above them is chrome.
      panes: (offset) => (offset === null ? paneDrag.release() : paneDrag.drag(offset)),
    landing: landingZone,
      track: () => trackEl ?? null,
      preview: setPreview,
    }}
  >
    <div bind:this={trackEl} class="page-track">
      <div class="page-shell" class:from-right={slide === "next"} class:from-left={slide === "prev"}>
        {@render children?.()}
      </div>
      {#if preview}
        <!-- The tab the finger is dragging towards, for real: same components,
             same stores, no data of its own to invent. It cannot be touched
             because the finger is busy with the gesture. -->
        <div
          class="page-shell preview"
          class:preview--next={preview.side === "next"}
          class:preview--prev={preview.side === "prev"}
          aria-hidden="true"
        >
          {#if preview.path === "/"}
            <HomePage preview={preview.path} />
          {:else if preview.path.startsWith("/split")}
            <SplitPage preview={preview.path} />
          {:else if preview.path.startsWith("/settings")}
            <SettingsPage preview={preview.path} />
          {/if}
        </div>
      {/if}
    </div>
    <!-- Over the pages, under the pill (5) and under every modal (100). The fade
         is a layer rather than a mask on the scroll container: a mask makes that
         container a stacking context, and every modal inside it then paints under
         the tab pill -- dimmed page, bright pill. -->
    <div class="edge-fade" aria-hidden="true"></div>
    <div
      class="scroll-strip"
      class:scroll-strip--on={strip.visible}
      style={`transform: translate(0, ${Math.round(strip.offset + strip.top)}px); height: ${Math.round(strip.height)}px`}
      aria-hidden="true"
    ></div>
  </main>

  <nav class="tabbar">
    {#each NAV as item}
      <a
        href={item.path}
        class="tab"
        class:active={isActive(item.path)}
        class:no-label={!settings.navLabels}
        aria-label={t(item.labelKey)}
        aria-current={isActive(item.path) ? "page" : undefined}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path d={item.icon} fill="currentColor" />
        </svg>
        {#if settings.navLabels}<span>{t(item.labelKey)}</span>{/if}
      </a>
    {/each}
  </nav>
</div>

<style>
  .app {
    position: fixed;
    inset: 0;
    background: var(--bg);
  }

  /* The pages run to the bottom edge of the window and the pill floats over
     them. A panel taking a row of its own in this flex column cut every list on
     a hard line above itself, and painted the pill over any open modal. */
  .content {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Sideways is ours, up and down is the list's. Left at `auto`, a touch screen's
       Chromium (the Android WebView, WebView2 on a Windows tablet) claims a sideways
       drag as its own pan a few pixels in and answers with `pointercancel`, which
       springs the page back: every swipe on a phone died that way. WebKitGTK does not
       do this, which is why the same code swiped on Linux. */
    touch-action: pan-y;
  }
  /* And again on everything inside it: Chromium intersects touch-action only up to the
     nearest scroller, so the lists underneath, at `auto`, still gave the drag away.
     `:where` keeps this at no specificity, so an element that sets its own
     touch-action (the log's scrollbar) keeps it. */
  :global(:where(.content) *) {
    touch-action: pan-y;
  }

  /* The scrollbar, drawn by the shell. Only its opacity animates: the position and the
     length are the reader's place in the document and must be exactly where the finger
     left them. It sits in the gutter the page already reserves for a native bar, so
     nothing about the page's own measurements changes. */
  .scroll-strip {
    position: absolute;
    top: 0;
    right: 0;
    width: 6px;
    border-radius: 3px;
    background: var(--border);
    opacity: 0;
    transition: opacity 90ms linear;
    pointer-events: none;
    z-index: 4;
  }
  .scroll-strip--on {
    opacity: 1;
  }
  /* Not on Android. A phone reserves no gutter for a bar at all (`@media (pointer:
     coarse)` zeroes the scrollbar box in app.css), the platform's own overlay bar is
     the idiom there, and a 6px plate that is always on costs width the location rows
     need. The code stays, because it is the same shell on both platforms. */
  :global(html.is-android) .scroll-strip {
    display: none;
  }
  /* Out of the way while a swipe is in progress -- and back the moment it is over.
     `:global`, because the class is put on the element at runtime by the swipe action,
     and Svelte drops a selector whose class the component never mentions. */
  :global(.swiping) .scroll-strip {
    opacity: 0;
  }

  /* A band at the bottom edge that ends just above the tab pill, so a list leaves
     the window in shade instead of on a cut. Its height is the pill's own geometry:
     inset, height, and the lift past its top edge. */
  .edge-fade {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--fade-height);
    pointer-events: none;
    z-index: 3;
    background: linear-gradient(to top, var(--bg) 45%, transparent);
  }

  /* Every page is absolutely positioned inside this, so it is the one thing that
     can move for a tab change without asking the pages to cooperate. */
  .page-track {
    position: absolute;
    inset: 0;
  }

  .page-shell {
    position: absolute;
    inset: 0;
    /* No will-change here on purpose. It would give this element its own layer
       and therefore its own stacking context, and every modal rendered inside a
       page would then sit under the tab pill -- dimmed page, bright pill. */
  }

  /* The neighbour sits outside the viewport, ready to be dragged in. */
  .preview {
    left: auto;
    right: auto;
    width: 100%;
    pointer-events: none;
  }
  .preview--next {
    left: 100%;
  }
  .preview--prev {
    right: 100%;
  }
  /* Transform and opacity only, and the arriving page rather than a crossfade:
     the outgoing page is already gone by the time the new one is rendered, and
     pretending otherwise would need both mounted at once. */
  @keyframes page-from-right {
    from { transform: translateX(28px); opacity: 0.35; }
    to { transform: none; opacity: 1; }
  }
  @keyframes page-from-left {
    from { transform: translateX(-28px); opacity: 0.35; }
    to { transform: none; opacity: 1; }
  }
  .page-shell.from-right { animation: page-from-right 180ms cubic-bezier(0.2, 0, 0, 1); }
  .page-shell.from-left { animation: page-from-left 180ms cubic-bezier(0.2, 0, 0, 1); }

  /* Without the label the icon sits alone, so it gets the height the label used to
     take and stays on the same centre line. */
  .tab.no-label {
    padding: 9px 4px;
  }

  .tabbar {
    position: absolute;
    left: 50%;
    bottom: max(var(--nav-inset), env(safe-area-inset-bottom));
    transform: translateX(-50%);
    /* Under every modal (they are at 100), over the pages. */
    z-index: 5;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    /* The partitions are gaps rather than drawn lines: they run the full height
       of the pill by construction, and what scrolls behind them stays visible. */
    gap: 2px;
    width: var(--nav-width);
    height: var(--nav-height);
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 6px 4px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    transition: color var(--transition);
    /* Solid, one tone below the cards. The pill itself is opaque -- only the
       partitions are open, and what scrolls behind those 2px stays visible. */
    background: var(--nav-bg);
  }
  /* The pill keeps one stadium silhouette: only the outer corners round off. */
  .tab:first-child {
    border-radius: 999px 0 0 999px;
  }
  .tab:last-child {
    border-radius: 0 999px 999px 0;
  }
  @media (hover: hover) {
    .tab:hover {
      color: var(--text);
    }
  }
  .tab.active { color: var(--accent); }
</style>
