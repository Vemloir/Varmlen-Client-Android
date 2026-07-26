<script lang="ts">
  import { theme } from "$lib/theme.svelte";
  import { settings, type VpnMode, type PingMethod, type LogLevel } from "$lib/settings.svelte";
  import { i18n, t, LANGUAGES, type Lang } from "$lib/i18n.svelte";
  import { core } from "$lib/core.svelte";
  import { capsGranted, grantCaps, autostartStatus, setAutostart, vpnLog, clearVpnLog, notificationsEnabled, openNotificationSettings, openVpnSettings } from "$lib/api";
  import Dropdown from "$lib/components/Dropdown.svelte";
  import { onMount, tick } from "svelte";
  import { isAndroid } from "$lib/platform";

  const logLevelOptions = $derived([
    { value: "debug", label: "debug" },
    { value: "warn", label: "warn" },
    { value: "error", label: "error" },
  ]);

  // In-app log viewer (esp. for Android, where the data folder is hard to reach).
  let showLog = $state(false);
  let logText = $state("");
  let logBusy = $state(false);
  let logEl = $state<HTMLElement>();
  async function refreshLog() {
    logBusy = true;
    try {
      logText = (await vpnLog()) || "";
    } catch (e) {
      logText = e instanceof Error ? e.message : String(e);
    } finally {
      logBusy = false;
    }
    // Newest entries are at the end — show them.
    await tick();
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    updateThumb();
  }
  async function openLog() {
    showLog = true;
    await refreshLog();
  }
  async function wipeLog() {
    try {
      await clearVpnLog();
    } catch {}
    await refreshLog();
  }

  // Custom, touch-grabbable scrollbar for the log (the native WebView one is
  // tiny and janky to drag). The thumb tracks scrollTop and, while dragged,
  // captures the pointer so it stays grabbed until the finger lifts.
  let thumbH = $state(0);
  let thumbY = $state(0);
  let trackH = $state(0);
  let dragging = $state(false);
  let dragStartY = 0;
  let dragStartScroll = 0;
  const MIN_THUMB = 44;

  function updateThumb() {
    const el = logEl;
    if (!el) return;
    trackH = el.clientHeight;
    const ratio = el.scrollHeight > 0 ? el.clientHeight / el.scrollHeight : 1;
    thumbH = ratio >= 1 ? 0 : Math.max(MIN_THUMB, trackH * ratio);
    const maxScroll = el.scrollHeight - el.clientHeight;
    const maxThumb = trackH - thumbH;
    thumbY = maxScroll > 0 ? (el.scrollTop / maxScroll) * maxThumb : 0;
  }
  function onThumbDown(e: PointerEvent) {
    if (!logEl) return;
    dragging = true;
    dragStartY = e.clientY;
    dragStartScroll = logEl.scrollTop;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onThumbMove(e: PointerEvent) {
    if (!dragging || !logEl) return;
    const maxThumb = trackH - thumbH;
    const maxScroll = logEl.scrollHeight - logEl.clientHeight;
    if (maxThumb <= 0) return;
    logEl.scrollTop = dragStartScroll + ((e.clientY - dragStartY) / maxThumb) * maxScroll;
  }
  function onThumbUp(e: PointerEvent) {
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  }

  // Autostart lives in ~/.config/autostart (backend is the source of truth);
  // sync the toggles from it on open. `minimized` only applies when enabled.
  let autostart = $state(false);
  let autostartMinimized = $state(false);
  onMount(async () => {
    try {
      const s = await autostartStatus();
      autostart = s.enabled;
      autostartMinimized = s.minimized;
    } catch (e) {
      console.error("autostart status:", e);
    }
  });

  // Notification permission state (Android), re-checked when returning from the
  // system settings the user was sent to.
  let notifOn = $state(true);
  async function refreshNotif() {
    if (isAndroid) {
      try { notifOn = await notificationsEnabled(); } catch {}
    }
  }
  onMount(() => {
    refreshNotif();
    const onVis = () => { if (document.visibilityState === "visible") refreshNotif(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  });
  async function toggleAutostart(on: boolean) {
    autostart = on;
    if (!on) autostartMinimized = false;
    try {
      await setAutostart(on, autostartMinimized);
    } catch (e) {
      console.error("set autostart:", e);
    }
  }
  async function toggleAutostartMinimized(on: boolean) {
    autostartMinimized = on;
    if (autostart) {
      try {
        await setAutostart(true, on);
      } catch (e) {
        console.error("set autostart:", e);
      }
    }
  }

  const modeOptions = $derived([
    { value: "tun", label: t("mode.tun") },
    { value: "proxy", label: t("mode.proxy") },
  ]);
  const modeSub = $derived(settings.vpnMode === "proxy" ? t("mode.proxySub") : t("mode.tunSub"));

  const pingOptions = $derived([
    { value: "tcp", label: t("ping.tcp") },
    { value: "proxy", label: t("ping.proxy") },
  ]);

  // Refresh the core's status when Settings opens (cheap GitHub check).
  $effect(() => {
    void core.check();
  });

  /** Tri-state so we don't flash "Not installed" while the very first check
   *  is still in flight (the helper check is async but the section paints
   *  instantly). "checking" renders the neutral yellow dot + a soft label
   *  until we actually know. */
  type HelperState = "checking" | "ok" | "missing";
  let helperState = $state<HelperState>("checking");
  let helperBusy = $state(false);
  let helperErr = $state<string | null>(null);

  async function refreshHelper(allowChecking = false) {
    if (allowChecking) helperState = "checking";
    try {
      helperState = (await capsGranted()) ? "ok" : "missing";
    } catch {
      helperState = "missing";
    }
  }
  $effect(() => {
    void refreshHelper(true);
  });

  async function setupHelper() {
    helperBusy = true;
    helperErr = null;
    try {
      await grantCaps();
      for (let i = 0; i < 10; i++) {
        await refreshHelper();
        if (helperState === "ok") break;
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (e) {
      helperErr = e instanceof Error ? e.message : String(e);
    } finally {
      helperBusy = false;
    }
  }

  const helperStatus = $derived.by(() => {
    if (helperState === "checking") return t("helper.checking");
    if (helperState === "ok") return t("helper.ready");
    return helperErr ?? t("helper.notInstalled");
  });

  // The versions modal is shared by both cores; `activeCore` is whichever the
  // user opened it for.
  let showVersions = $state(false);
  let activeCore = $state(core);

  function openVersions(which: typeof core) {
    activeCore = which;
    showVersions = true;
    // The "Available" list loads only when the user clicks Fetch; "Downloaded"
    // shows immediately from the already-known installed versions.
  }

  function formatReleaseDate(d: string | null): string {
    if (!d) return "";
    const dt = new Date(d);
    if (!Number.isFinite(dt.getTime())) return "";
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()}`;
  }

  /** Compact byte formatter for the download speed indicator. */
  function formatBps(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}/s`;
  }
  function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function coreStatus(store: typeof core): string {
    if (store.checking && !store.info) return t("core.checking");
    const info = store.info;
    if (!info) return store.error ? t("core.checkFailed") : t("core.checking");
    if (info.active) {
      return info.has_update && info.latest
        ? `${info.active} → ${info.latest}`
        : info.active;
    }
    return info.latest
      ? `${t("core.notInstalled")} · ${t("core.latest", { v: info.latest })}`
      : t("core.notInstalled");
  }

</script>

{#snippet delBtn(tag: string, disabled: boolean)}
  <button
    class="btn btn-sm btn-danger"
    onclick={() => activeCore.uninstall(tag)}
    {disabled}
    title={t("core.delete")}
  >
    <svg class="btn-ico" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 3a1 1 0 0 0-1 1v1H4a1 1 0 1 0 0 2h1l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13h1a1 1 0 1 0 0-2h-4V4a1 1 0 0 0-1-1H9zm1 2h4v1h-4V5zm-3 3h10l-.9 12.1a.1.1 0 0 1-.1.1H8.1a.1.1 0 0 1-.1-.1L7 8zm3 2a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0v-6a1 1 0 0 0-1-1zm4 0a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0v-6a1 1 0 0 0-1-1z" />
    </svg>
    <span>{t("core.delete")}</span>
  </button>
{/snippet}

<header class="topbar">
  <h1>{t("settings.title")}</h1>
</header>

<main class="scroll fade-y">
  <section>
    <h2>{t("settings.appearance")}</h2>
    <div class="card theme-card">
      <div class="theme-row">
        <button
          class="theme-tile"
          class:active={theme.current === "dark"}
          onclick={() => theme.set("dark")}
          aria-pressed={theme.current === "dark"}
        >
          <div class="swatch swatch-dark"></div>
          <span>{t("settings.dark")}</span>
        </button>
        <button
          class="theme-tile"
          class:active={theme.current === "light"}
          onclick={() => theme.set("light")}
          aria-pressed={theme.current === "light"}
        >
          <div class="swatch swatch-light"></div>
          <span>{t("settings.light")}</span>
        </button>
      </div>
    </div>
  </section>

  <section>
    <h2>{t("settings.vpnMode")}</h2>
    <div class="list">
      <div class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.vpnMode")}</div>
          <div class="row-sub muted">{modeSub}</div>
        </div>
        <Dropdown
          value={settings.vpnMode}
          options={modeOptions}
          onChange={(v) => settings.setVpnMode(v as VpnMode)}
          ariaLabel={t("settings.vpnMode")}
        />
      </div>
    </div>
  </section>

  <section>
    <h2>{t("settings.general")}</h2>
    <div class="list">
      <div class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.language")}</div>
        </div>
        <Dropdown
          value={i18n.lang}
          options={LANGUAGES}
          onChange={(v) => i18n.set(v as Lang)}
          ariaLabel={t("settings.language")}
        />
      </div>
      {#if isAndroid}
      <button type="button" class="row log-row" onclick={() => openVpnSettings()}>
        <div class="row-text">
          <div class="row-title">{t("settings.androidKillswitch")}</div>
          <div class="row-sub muted">{t("settings.androidKillswitchSub")}</div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      {:else}
      <label class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.killswitch")}</div>
          <div class="row-sub muted">{t("settings.killswitchSub")}</div>
        </div>
        <span class="switch">
          <input
            type="checkbox"
            checked={settings.killswitch}
            onchange={(e) => settings.setKillswitch((e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="slider"></span>
        </span>
      </label>
      {/if}
      <label class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.allowLan")}</div>
          <div class="row-sub muted">{t("settings.allowLanSub")}</div>
        </div>
        <span class="switch">
          <input
            type="checkbox"
            checked={settings.allowLan}
            onchange={(e) => settings.setAllowLan((e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="slider"></span>
        </span>
      </label>
      <!-- Tray / window / autostart are desktop concepts; hide on Android. -->
      {#if !isAndroid}
      <label class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.closeToTray")}</div>
          <div class="row-sub muted">{t("settings.closeToTraySub")}</div>
        </div>
        <span class="switch">
          <input
            type="checkbox"
            checked={settings.closeToTray}
            onchange={(e) => settings.setCloseToTray((e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="slider"></span>
        </span>
      </label>
      <label class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.autostart")}</div>
          <div class="row-sub muted">{t("settings.autostartSub")}</div>
        </div>
        <span class="switch">
          <input
            type="checkbox"
            checked={autostart}
            onchange={(e) => toggleAutostart((e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="slider"></span>
        </span>
      </label>
      <label class="row" class:disabled={!autostart}>
        <div class="row-text">
          <div class="row-title">{t("settings.autostartMinimized")}</div>
          <div class="row-sub muted">{t("settings.autostartMinimizedSub")}</div>
        </div>
        <span class="switch">
          <input
            type="checkbox"
            checked={autostartMinimized}
            disabled={!autostart}
            onchange={(e) => toggleAutostartMinimized((e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="slider"></span>
        </span>
      </label>
      {/if}
      <div class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.pingMethod")}</div>
          <div class="row-sub muted">{t("settings.pingMethodSub")}</div>
        </div>
        <Dropdown
          value={settings.pingMethod}
          options={pingOptions}
          onChange={(v) => settings.setPingMethod(v as PingMethod)}
          ariaLabel={t("settings.pingMethod")}
        />
      </div>
    </div>
  </section>

  <section>
    <h2>{t("settings.core")}</h2>
    <div class="list">
      <div class="row">
        <div class="row-text">
          <div class="row-title">xray <span class="muted" style="font-weight:400">· TUN</span></div>
          <div class="row-sub muted">{coreStatus(core)}</div>
        </div>
        <button class="btn" onclick={() => openVersions(core)} title={t("core.versionsTitle")}>
          <svg class="btn-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.9"
              stroke-linecap="round" />
          </svg>
          <span>{t("core.versions")}</span>
        </button>
      </div>
    </div>
    {#if core.error}
      <div class="row-sub" style="color: var(--danger); padding: 0 4px;">{core.error}</div>
    {/if}
  </section>

  {#if showVersions}
    {@const installed = activeCore.info?.installed ?? []}
    {@const available = activeCore.releases.filter((r) => !activeCore.isInstalled(r.tag))}
    <div class="modal-backdrop" onclick={() => (showVersions = false)} role="presentation">
      <div
        class="modal card"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === "Escape" && (showVersions = false)}
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-label={t("core.versionsTitle")}
      >
        <header class="modal-head">
          <h2>{t("core.versionsTitle")}</h2>
          <button
            class="icon-btn"
            onclick={() => (showVersions = false)}
            aria-label={t("common.close")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <!-- Downloaded — shown immediately, before any fetch. -->
        <h3 class="ver-section">{t("core.downloaded")}</h3>
        {#if installed.length === 0}
          <p class="muted ver-empty">{t("core.noDownloaded")}</p>
        {:else}
          <ul class="ver-list">
            {#each installed as v (v.tag)}
              {@const isSwitching = activeCore.switchingTag === v.tag}
              <li class="ver-row" class:current={v.active}>
                <div class="ver-info">
                  <span class="ver-tag">{v.tag}</span>
                  {#if v.active}<span class="ver-meta muted">{t("core.active")}</span>{/if}
                </div>
                <div class="ver-actions">
                  {#if !v.active}
                    <button
                      class="btn btn-primary btn-sm"
                      onclick={() => activeCore.activate(v.tag)}
                      disabled={isSwitching}
                    >
                      {isSwitching ? "…" : t("core.use")}
                    </button>
                  {/if}
                  {@render delBtn(v.tag, isSwitching)}
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- Available — loaded on demand via Fetch. -->
        <div class="ver-section-head">
          <h3 class="ver-section">{t("core.available")}</h3>
          <button
            class="btn btn-sm"
            onclick={() => activeCore.loadReleases()}
            disabled={activeCore.releasesLoading}
          >
            {activeCore.releasesLoading ? t("core.updating") : t("core.fetch")}
          </button>
        </div>
        {#if activeCore.releases.length === 0}
          {#if activeCore.releasesLoading}
            <p class="muted ver-empty">{t("core.checking")}</p>
          {:else if activeCore.error}
            <p class="ver-empty" style="color: var(--danger)">{activeCore.error}</p>
          {:else}
            <p class="muted ver-empty">{t("core.fetchHint")}</p>
          {/if}
        {:else if available.length === 0}
          <p class="muted ver-empty">{t("core.upToDate")}</p>
        {:else}
          <ul class="ver-list">
            {#each available as r (r.tag)}
              {@const ver = r.tag.replace(/^v/, "")}
              {@const prog = activeCore.progress[ver]}
              {@const isDownloading = activeCore.busyTags.has(ver)}
              {@const pct = prog && prog.total > 0
                ? Math.min(100, Math.round((prog.downloaded / prog.total) * 100))
                : 0}
              <li class="ver-row">
                <div class="ver-info">
                  <span class="ver-tag">{r.tag}</span>
                  <span class="ver-meta muted">
                    {formatReleaseDate(r.date)}
                    {#if r.prerelease}<span class="badge">{t("core.preview")}</span>{/if}
                  </span>
                </div>
                <div class="ver-actions">
                  {#if isDownloading && prog}
                    <div class="progress" aria-label="downloading">
                      <div class="progress-track">
                        <div class="progress-fill" style="width: {pct}%"></div>
                      </div>
                      <div class="progress-meta muted">
                        {formatBytes(prog.downloaded)}
                        {#if prog.total > 0}/ {formatBytes(prog.total)} · {pct}%{/if}
                        · {formatBps(prog.speed_bps)}
                      </div>
                    </div>
                  {:else}
                    <button
                      class="btn btn-sm"
                      onclick={() => activeCore.install(r.tag)}
                      disabled={isDownloading}
                    >
                      <svg class="btn-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"
                          stroke="currentColor" stroke-width="1.9"
                          stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                      <span>{t("core.download")}</span>
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}

  {#if isAndroid}
  <section>
    <h2>{t("settings.permissions")}</h2>
    <div class="list">
      <button type="button" class="row log-row" onclick={() => openNotificationSettings()}>
        <div class="row-text">
          <div class="row-title">{t("settings.notifications")}</div>
          <div class="row-sub muted">
            {notifOn ? t("settings.notificationsOn") : t("settings.notificationsOff")}
          </div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </section>
  {/if}

  <section>
    <h2>{t("settings.diagnostics")}</h2>
    <div class="list">
      <div class="row">
        <div class="row-text">
          <div class="row-title">{t("settings.logLevel")}</div>
          <div class="row-sub muted">{t("settings.logLevelSub")}</div>
        </div>
        <Dropdown
          value={settings.logLevel}
          options={logLevelOptions}
          onChange={(v) => settings.setLogLevel(v as LogLevel)}
          ariaLabel={t("settings.logLevel")}
        />
      </div>
      <button type="button" class="row log-row" onclick={openLog}>
        <div class="row-text">
          <div class="row-title">{t("settings.viewLog")}</div>
          <div class="row-sub muted">{t("settings.viewLogSub")}</div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </section>

  <!-- Network permissions (file caps via pkexec) are a desktop concept; on
       Android the VPN consent dialog handles permission per-connect. -->
  {#if !isAndroid}
  <section>
    <h2>{t("settings.helper")}</h2>
    <div class="list">
      <div class="row">
        <span
          class="status-dot"
          class:on={helperState === "ok" && !helperBusy}
          class:off={helperState === "missing" && !helperBusy}
          class:busy={helperState === "checking" || helperBusy}
        ></span>
        <div class="row-text">
          <div class="row-title">{t("helper.title")}</div>
          <div class="row-sub muted">{helperStatus}</div>
        </div>
        {#if helperState !== "checking"}
          <button
            class="btn {helperState === "ok" ? '' : 'btn-primary'}"
            onclick={setupHelper}
            disabled={helperBusy}
          >
            {helperBusy
              ? t("helper.installing")
              : helperState === "ok"
                ? t("helper.reinstall")
                : t("helper.install")}
          </button>
        {/if}
      </div>
      {#if helperErr}
        <div class="row-sub" style="color: var(--danger); padding: 6px 14px;">{helperErr}</div>
      {/if}
    </div>
  </section>
  {/if}

</main>

{#if showLog}
  <div class="modal-backdrop" onclick={() => (showLog = false)} role="presentation">
    <div
      class="modal card log-modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (showLog = false)}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={t("settings.viewLog")}
    >
      <header class="modal-head">
        <h2>{t("settings.viewLog")}</h2>
        <button class="icon-btn" onclick={() => (showLog = false)} aria-label={t("common.close")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <div class="log-wrap">
        <pre id="vpn-log" class="log-text" bind:this={logEl} onscroll={updateThumb}>{logText || t("settings.logEmpty")}</pre>
        {#if thumbH > 0}
          <div class="log-sb">
            <div
              class="log-sb-thumb"
              class:dragging
              role="scrollbar"
              aria-orientation="vertical"
              aria-controls="vpn-log"
              aria-label="Scroll log"
              aria-valuenow={trackH > thumbH ? Math.round((thumbY / (trackH - thumbH)) * 100) : 0}
              tabindex="-1"
              style="height: {thumbH}px; transform: translateY({thumbY}px)"
              onpointerdown={onThumbDown}
              onpointermove={onThumbMove}
              onpointerup={onThumbUp}
              onpointercancel={onThumbUp}
            ></div>
          </div>
        {/if}
      </div>
      <div class="modal-actions">
        <button class="btn" onclick={wipeLog}>{t("settings.logClear")}</button>
        <button class="btn btn-primary" onclick={refreshLog} disabled={logBusy}>
          {t("settings.logRefresh")}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .log-row {
    width: 100%;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text);
    /* <button> defaults to centered text; match the other (div) rows. */
    text-align: left;
  }
  .log-modal {
    width: min(560px, 94vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .log-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    margin: 8px 0;
    display: flex;
  }
  .log-text {
    flex: 1;
    overflow: auto;
    padding: 10px 12px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-muted);
  }
  /* Hide the native scrollbar — we draw our own grabbable one. */
  .log-text::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
  .log-sb {
    position: absolute;
    top: 4px;
    bottom: 4px;
    right: 3px;
    width: 10px;
  }
  .log-sb-thumb {
    position: absolute;
    top: 0;
    right: 0;
    width: 10px;
    border-radius: 5px;
    background: var(--border-strong);
    /* So the browser doesn't steal the touch for scrolling — we drive it. */
    touch-action: none;
    cursor: grab;
  }
  .log-sb-thumb.dragging,
  .log-sb-thumb:active {
    background: var(--text-dim);
    cursor: grabbing;
  }
  .topbar {
    display: flex;
    align-items: center;
    padding: 14px 16px 6px;
    flex-shrink: 0;
  }
  .topbar h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
  }

  .scroll {
    position: absolute;
    inset: 56px 0 0 0;
    /* Always reserve the scrollbar (no `auto`/`stable both-edges` — older
       WebKitGTK doesn't honour `both-edges` and falls back to right-only,
       which is exactly the asymmetric look we're trying to avoid). The
       scrollbar is 6px (see app.css). We add 6px to padding-left so the
       visible gap from the app edge to the panel edge is identical on
       both sides. */
    overflow-y: scroll;
    /* Top padding clears the fade-y mask so the first section label isn't
       dimmed at rest. */
    padding: 12px 14px 24px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h2 {
    margin: 0;
    padding: 0 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .theme-card { padding: 12px; }
  .theme-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .theme-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
  }
  .theme-tile.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-faint);
  }
  .swatch {
    width: 100%;
    height: 56px;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .swatch-dark { background: linear-gradient(135deg, #1a1a1a 50%, #2e2e2e 50%); }
  .swatch-light { background: linear-gradient(135deg, #ffffff 50%, #ebebeb 50%); }

  /* Same .list-row layout as the design system, but using <label> so the
     entire row activates the toggle without the cell extending past the
     visual edge. */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    cursor: pointer;
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  /* Sub-setting that only applies when its parent toggle is on. */
  .row.disabled {
    opacity: 0.45;
    cursor: default;
  }
  @media (hover: hover) {
    .row:hover {
      background: var(--bg-elev-2);
    }
  }
  .list {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .row-text {
    flex: 1;
    min-width: 0;
  }
  .row-title { font-size: 14px; }
  .row-sub { font-size: 12px; margin-top: 2px; }

  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-right: 2px;
  }
  .status-dot.on {
    background: #2eb872;
    box-shadow: 0 0 0 3px rgba(46, 184, 114, 0.18);
  }
  .status-dot.off {
    background: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-faint);
  }
  .status-dot.busy {
    background: var(--warn);
    box-shadow: 0 0 0 3px rgba(245, 165, 36, 0.22);
    animation: status-pulse 1.2s ease-in-out infinite;
  }
  @keyframes status-pulse {
    50% { opacity: 0.45; }
  }

  /* ---------- version-picker modal ---------- */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 16px;
  }
  .modal {
    width: min(500px, 100%);
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .modal h2 {
    margin: 0;
    font-size: 16px;
    color: var(--text);
    text-transform: none;
    letter-spacing: 0;
    padding: 0;
  }
  .modal p { margin: 0; font-size: 13px; }
  .icon-btn {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 6px;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background var(--transition), color var(--transition);
  }
  @media (hover: hover) {
    .icon-btn:hover { background: var(--bg-elev-2); color: var(--text); }
  }

  /* The Versions button on the core row carries its own icon. */
  .btn-ico {
    margin-right: 6px;
    vertical-align: -2px;
  }

  .ver-section {
    margin: 6px 0 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .ver-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 8px;
  }
  .ver-section-head .ver-section {
    margin: 0;
  }
  .ver-empty {
    margin: 0;
    font-size: 13px;
    padding: 2px 2px 0;
  }
  .ver-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 42vh;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev-2);
  }
  .ver-list li + li { border-top: 1px solid var(--border); }
  .ver-row {
    color: var(--text);
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
  }
  .ver-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .ver-row.current {
    background: var(--accent-faint);
  }
  .ver-row.current .ver-tag { color: var(--accent); }
  .ver-tag { font-weight: 600; font-size: 13px; }
  .ver-meta { font-size: 11px; display: flex; align-items: center; gap: 6px; }
  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .ver-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* Compact variant of the standard btn for the row actions. */
  :global(.btn.btn-sm) {
    font-size: 12px;
    padding: 6px 10px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  /* Destructive (delete) — outline red so it reads as "removes data" without
     screaming for attention next to a primary action. */
  /* Rest state used to be near-invisible (faint border, transparent fill).
     Give it a clearly visible danger border + a subtle fill at rest, and a
     stronger fill on hover. */
  :global(.btn.btn-danger) {
    border-color: var(--danger);
    color: var(--danger);
    background: var(--danger-faint);
  }
  @media (hover: hover) {
    :global(.btn.btn-danger:hover:not(:disabled)) {
      background: var(--danger-faint-2);
      border-color: var(--danger);
    }
  }


  /* Download progress: filled bar + bytes/speed line. */
  .progress {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 160px;
    flex-shrink: 0;
  }
  .progress-track {
    height: 6px;
    background: var(--bg-elev);
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 120ms linear;
  }
  .progress-meta {
    font-size: 11px;
    text-align: right;
  }
</style>
