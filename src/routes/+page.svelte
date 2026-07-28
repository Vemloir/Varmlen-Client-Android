<script lang="ts">
  import { onBackButtonPress } from "@tauri-apps/api/app";
  import type { PluginListener } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { conn } from "$lib/conn.svelte";
  import { subs } from "$lib/subs.svelte";
  import { t } from "$lib/i18n.svelte";
  import { readClipboard } from "$lib/api";
  import { isAndroid } from "$lib/platform";
  import { placePopup, portal } from "$lib/popup";
  import FlagIcon from "$lib/components/FlagIcon.svelte";
  import LocationEditor from "$lib/components/LocationEditor.svelte";
  import ServerList from "$lib/components/ServerList.svelte";
  import {
    formatJson,
    isJsonInput,
  } from "$lib/subscription-json";
  import type { LocationEditDraft } from "$lib/location-draft";

  import type { Subscription, ServerEntry } from "$lib/subs.svelte";

  let showImport = $state(false);
  let importMode = $state<"choose" | "link" | "json">("choose");
  let subUrl = $state("");
  let importError = $state<string | null>(null);
  let openMenuFor = $state<string | null>(null);
  let infoFor = $state<Subscription | null>(null);
  let renameFor = $state<Subscription | null>(null);
  let renameDraft = $state("");
  let jsonFor = $state<Subscription | null>(null);
  let jsonDraft = $state("");
  let jsonError = $state<string | null>(null);
  let jsonSaving = $state(false);
  let detailFor = $state<ServerEntry | null>(null);
  // Fixed-position coords for the "…" menu so it escapes the card's overflow:hidden.
  let menuPos = $state({ top: 0, right: 0 });

  function toggleMenu(subId: string, e: MouseEvent) {
    if (openMenuFor === subId) {
      openMenuFor = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const itemCount = subs.list.find((s) => s.id === subId)?.sourceJson ? 5 : 4;
    // Items are ~36px each; flip up / clamp so the menu always fits.
    menuPos = placePopup(r, 200, itemCount * 36 + 8);
    openMenuFor = subId;
  }

  // Close the … menu on scroll / resize / outside-click — without a blocking
  // backdrop, so the list still scrolls (and the menu hides the instant it does).
  $effect(() => {
    if (openMenuFor === null) return;
    const close = () => (openMenuFor = null);
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (t as Element).closest?.(".menu, .head-btn")) return;
      openMenuFor = null;
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", onDown, true);
    };
  });

  function openInfo(sub: Subscription) {
    infoFor = sub;
    openMenuFor = null;
  }
  function openRename(sub: Subscription) {
    renameFor = sub;
    renameDraft = sub.name;
    openMenuFor = null;
  }
  function commitRename() {
    if (renameFor) subs.rename(renameFor.id, renameDraft);
    renameFor = null;
  }
  function openJson(sub: Subscription) {
    jsonFor = sub;
    jsonDraft = formatJson(sub.sourceJson ?? "{}");
    jsonError = null;
    openMenuFor = null;
  }
  async function saveJson(): Promise<void> {
    if (!jsonFor || !jsonDraft.trim()) return;
    jsonError = null;
    jsonSaving = true;
    try {
      await subs.updateJson(jsonFor.id, jsonDraft);
      jsonFor = null;
    } catch (e) {
      jsonError = e instanceof Error ? e.message : String(e);
    } finally {
      jsonSaving = false;
    }
  }
  function openDetails(server: ServerEntry): void {
    (document.activeElement as HTMLElement | null)?.blur?.();
    detailFor = server;
  }
  function closeDetails(): void {
    // Explicitly release WebView's native textarea/input session before the
    // editor DOM disappears. Otherwise a JSON editor can leave a stale Android
    // IME target that swallows close/save clicks in the next modal.
    (document.activeElement as HTMLElement | null)?.blur?.();
    detailFor = null;
  }
  async function saveLocationDraft(draft: LocationEditDraft): Promise<void> {
    if (!detailFor) return;
    await subs.saveServerDraft(detailFor.id, draft);
    closeDetails();
  }

  // Tauri's Android app plugin emits this while a frontend listener exists.
  // Register only while this editor is open, so Back closes the sheet and
  // otherwise keeps the platform's normal navigation/exit behaviour.
  $effect(() => {
    if (!isAndroid || !detailFor) return;
    let disposed = false;
    let listener: PluginListener | null = null;
    void onBackButtonPress(closeDetails)
      .then((registered) => {
        if (disposed) void registered.unregister();
        else listener = registered;
      })
      .catch((error) => console.error("could not listen for Android Back:", error));
    return () => {
      disposed = true;
      void listener?.unregister();
    };
  });

  // Subscription headers (support / web-page URLs) are attacker-controlled, so
  // only hand the OS opener a vetted web/Telegram scheme — never file:, etc.
  // Web schemes only. tg: action URIs (tg://proxy, tg://socks, tg://msg_url)
  // from an attacker-controlled Support-Url could inject a proxy/contact via the
  // OS opener — https://t.me/… links still work.
  const SAFE_SCHEMES = new Set(["http:", "https:"]);
  async function open(url: string | null) {
    if (!url) return;
    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      return;
    }
    if (SAFE_SCHEMES.has(scheme)) await openUrl(url);
  }

  const statusLabel = $derived(t(`status.${conn.status}`));


  function openImport(): void {
    importMode = "choose";
    subUrl = "";
    importError = null;
    showImport = true;
  }

  async function importSubscription(): Promise<void> {
    if (!subUrl.trim()) return;
    importError = null;
    try {
      await subs.importFromUrl(subUrl);
      subUrl = "";
      showImport = false;
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
      importMode = isJsonInput(subUrl) ? "json" : "link";
    }
  }

  /** Quick path: read the clipboard and import it straight away. */
  async function importFromClipboard(): Promise<void> {
    importError = null;
    let text = "";
    try {
      // Android's WebView blocks navigator.clipboard, so read it natively there.
      text = (isAndroid ? await readClipboard() : await navigator.clipboard.readText())?.trim() ?? "";
    } catch {
      // Clipboard blocked — fall back to the compact link entry.
      importMode = "link";
      importError = t("import.clipboardFail");
      return;
    }
    if (!text) {
      importMode = "link";
      importError = t("import.clipboardEmpty");
      return;
    }
    subUrl = text;
    await importSubscription();
  }

  function fmtImported(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
</script>

<div class="home">
<header class="topbar">
  <button class="icon-btn" onclick={openImport} aria-label="Add subscription">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  </button>
</header>

<section class="hero">
    <button
      class="power"
      data-status={conn.status}
      onclick={() => conn.toggle()}
      aria-label={conn.status === "connected" ? "Disconnect" : "Connect"}
    >
      <svg viewBox="0 0 64 64" width="54" height="54" class="power-icon" aria-hidden="true">
        <path
          d="M22 18a16 16 0 1 0 20 0"
          stroke="currentColor"
          stroke-width="3.5"
          stroke-linecap="round"
          fill="none"
        />
        <line x1="32" y1="11" x2="32" y2="30" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" />
      </svg>
    </button>
    <div class="status-text" data-status={conn.status}>{statusLabel}</div>
    {#if conn.error}
      <div class="conn-error" class:blocked={conn.status === "dropped"}>{conn.error}</div>
    {/if}
    {#if conn.status === "dropped"}
      <button class="link-btn" onclick={() => conn.clearDrop()}>{t("conn.allowTraffic")}</button>
    {/if}
  </section>

  <main class="scroll fade-y">

  {#each subs.ordered as sub (sub.id)}
    <section class="sub-card" class:pinned={sub.pinned}>
      <header class="sub-head">
        <button
          class="chev-toggle"
          onclick={() => subs.toggleCollapse(sub.id)}
          aria-label={sub.collapsed ? "Expand" : "Collapse"}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            class="chev-icon"
            style="transform: rotate({sub.collapsed ? -90 : 0}deg)"
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <div class="sub-info">
          <div class="sub-title">
            {#if sub.pinned}
              <svg class="pin-mark" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
              </svg>
            {/if}{sub.name}
          </div>
          {#if sub.updateIntervalHours}
            <div class="sub-meta muted">{t("home.autoUpdate", { h: sub.updateIntervalHours })}</div>
          {/if}
        </div>

        <button
          class="head-btn"
          class:spinning={sub.refreshing}
          onclick={() => subs.refresh(sub.id)}
          aria-label="Refresh"
          disabled={sub.refreshing}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M21 12a9 9 0 1 1-3.13-6.84M21 4v5h-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="head-btn"
          onclick={() => subs.pingSub(sub.id)}
          aria-label="Ping"
          disabled={subs.isSubPinging(sub.id)}
        >
          <!-- speedometer / gauge — Happ's ping affordance -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 21a9 9 0 1 0-9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M12 12l5-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          </svg>
        </button>
        <div class="menu-wrap">
          <button
            class="head-btn"
            aria-label="Subscription menu"
            onclick={(e) => toggleMenu(sub.id, e)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
          {#if openMenuFor === sub.id}
            <div class="menu" role="menu" use:portal style="top: {menuPos.top}px; right: {menuPos.right}px;">
              <button role="menuitem" class="menu-item" onclick={() => openInfo(sub)}>
                {t("menu.info")}
              </button>
              <button role="menuitem" class="menu-item" onclick={() => openRename(sub)}>
                {t("menu.rename")}
              </button>
              {#if sub.sourceJson}
                <button role="menuitem" class="menu-item" onclick={() => openJson(sub)}>
                  {t("menu.json")}
                </button>
              {/if}
              <button
                role="menuitem"
                class="menu-item"
                onclick={() => { subs.togglePin(sub.id); openMenuFor = null; }}
              >
                {sub.pinned ? t("menu.unpin") : t("menu.pin")}
              </button>
              <button
                role="menuitem"
                class="menu-item danger"
                onclick={() => { subs.remove(sub.id); openMenuFor = null; }}
              >
                {t("menu.remove")}
              </button>
            </div>
          {/if}
        </div>
      </header>

      {#if subs.hasTraffic(sub) || sub.webPageUrl || sub.supportUrl}
      <div class="sub-traffic">
        {#if sub.webPageUrl}
          <button class="round-btn" aria-label="Website" onclick={() => open(sub.webPageUrl)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
          </button>
        {/if}
        {#if subs.hasTraffic(sub)}
          <div class="traffic-bar">
            <span class="traffic-text">{subs.trafficText(sub)}</span>
          </div>
        {/if}
        {#if sub.supportUrl}
          <button class="round-btn" aria-label="Telegram" onclick={() => open(sub.supportUrl)}>
            <svg width="23" height="23" viewBox="0 0 128 128" fill="currentColor" aria-hidden="true">
              <path d="M28.9700376,63.3244248 C47.6273373,55.1957357 60.0684594,49.8368063 66.2934036,47.2476366 C84.0668845,39.855031 87.7600616,38.5708563 90.1672227,38.528 C90.6966555,38.5191258 91.8804274,38.6503351 92.6472251,39.2725385 C93.294694,39.7979149 93.4728387,40.5076237 93.5580865,41.0057381 C93.6433345,41.5038525 93.7494885,42.63857 93.6651041,43.5252052 C92.7019529,53.6451182 88.5344133,78.2034783 86.4142057,89.5379542 C85.5170662,94.3339958 83.750571,95.9420841 82.0403991,96.0994568 C78.3237996,96.4414641 75.5015827,93.6432685 71.9018743,91.2836143 C66.2690414,87.5912212 63.0868492,85.2926952 57.6192095,81.6896017 C51.3004058,77.5256038 55.3966232,75.2369981 58.9976911,71.4967761 C59.9401076,70.5179421 76.3155302,55.6232293 76.6324771,54.2720454 C76.6721165,54.1030573 76.7089039,53.4731496 76.3346867,53.1405352 C75.9604695,52.8079208 75.4081573,52.921662 75.0095933,53.0121213 C74.444641,53.1403447 65.4461175,59.0880351 48.0140228,70.8551922 C45.4598218,72.6091037 43.1463059,73.4636682 41.0734751,73.4188859 C38.7883453,73.3695169 34.3926725,72.1268388 31.1249416,71.0646282 C27.1169366,69.7617838 23.931454,69.0729605 24.208838,66.8603276 C24.3533167,65.7078514 25.9403832,64.5292172 28.9700376,63.3244248 Z" />
            </svg>
          </button>
        {/if}
      </div>
      {/if}

      {#if sub.description}
        <div class="description">{sub.description}</div>
      {/if}

      {#if subs.expiresText(sub)}
        <div class="expires muted small">{t("home.expires", { date: subs.expiresText(sub) ?? "" })}</div>
      {/if}

      {#if !sub.collapsed}
        <ServerList
          servers={sub.servers}
          selectedServerId={subs.selectedServerId}
          pings={subs.pings}
          onSelect={(id) => subs.selectServer(id)}
          onDetails={openDetails}
        />
      {/if}
    </section>
  {/each}

  {#if subs.list.length === 0}
    <div class="empty muted">{t("home.empty")}</div>
  {/if}
</main>
</div>

{#if infoFor}
  <div class="modal-backdrop" onclick={() => (infoFor = null)} role="presentation">
    <div
      class="modal card"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (infoFor = null)}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Subscription info"
    >
      <header class="modal-head">
        <h2>{infoFor.name}</h2>
        <button class="icon-btn" onclick={() => (infoFor = null)} aria-label={t("common.close")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <dl class="info-grid">
        <dt>{t("info.url")}</dt>
        <dd class="mono small">{infoFor.url}</dd>

        <dt>{t("info.imported")}</dt>
        <dd>{fmtImported(infoFor.importedAt)}</dd>

        {#if infoFor.updateIntervalHours}
          <dt>{t("info.autoUpdate")}</dt>
          <dd>{t("info.everyH", { h: infoFor.updateIntervalHours })}</dd>
        {/if}

        <dt>{t("info.traffic")}</dt>
        <dd>{subs.trafficText(infoFor)}</dd>

        {#if subs.expiresText(infoFor)}
          <dt>{t("info.expires")}</dt>
          <dd>{subs.expiresText(infoFor)}</dd>
        {/if}

        <dt>{t("info.servers")}</dt>
        <dd>{infoFor.servers.length}</dd>

        {#if infoFor.supportUrl}
          <dt>{t("info.support")}</dt>
          <dd><a href={infoFor.supportUrl} target="_blank" rel="noopener">{infoFor.supportUrl}</a></dd>
        {/if}
      </dl>
      {#if infoFor.description}
        <p class="info-desc">{infoFor.description}</p>
      {/if}
    </div>
  </div>
{/if}

{#if detailFor}
  <div class="modal-backdrop" onclick={closeDetails} role="presentation">
    <div
      class="modal card location-modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && closeDetails()}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Location details"
    >
      <header class="modal-head">
        <h2 class="location-title">
          <FlagIcon flag={detailFor.flag ?? ""} />
          <span>{detailFor.name}</span>
        </h2>
        <button type="button" class="icon-btn" onclick={closeDetails} aria-label={t("common.close")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <div class="location-editor-scroll">
        <LocationEditor
          server={detailFor}
          onSave={saveLocationDraft}
          onCancel={closeDetails}
        />
      </div>
    </div>
  </div>
{/if}

{#if jsonFor}
  <div class="modal-backdrop" onclick={() => (jsonFor = null)} role="presentation">
    <div
      class="modal card json-modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (jsonFor = null)}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={t("json.title")}
    >
      <header class="modal-head">
        <h2>{t("json.title")}</h2>
        <button class="icon-btn" onclick={() => (jsonFor = null)} aria-label={t("common.close")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      {#if jsonFor.jsonEdited}
        <p class="muted">{t("json.edited")}</p>
      {/if}
      <textarea
        class="json-editor"
        bind:value={jsonDraft}
        spellcheck="false"
        disabled={jsonSaving}
      ></textarea>
      {#if jsonError}
        <div class="error">{jsonError}</div>
      {/if}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick={() => (jsonFor = null)} disabled={jsonSaving}>
          {t("common.cancel")}
        </button>
        <button class="btn btn-primary" onclick={saveJson} disabled={jsonSaving || !jsonDraft.trim()}>
          {jsonSaving ? t("json.saving") : t("json.save")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if renameFor}
  <div class="modal-backdrop" onclick={() => (renameFor = null)} role="presentation">
    <div
      class="modal card"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (renameFor = null)}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Rename subscription"
    >
      <h2>{t("rename.title")}</h2>
      <input
        type="text"
        bind:value={renameDraft}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick={() => (renameFor = null)}>{t("common.cancel")}</button>
        <button class="btn btn-primary" onclick={commitRename} disabled={!renameDraft.trim()}>
          {t("common.save")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showImport}
  <div class="modal-backdrop" onclick={() => (showImport = false)} role="presentation">
    <div
      class="modal card"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (showImport = false)}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Add subscription"
    >
      <header class="modal-head">
        <h2>{t("import.title")}</h2>
        <button class="icon-btn" onclick={() => (showImport = false)} aria-label={t("common.close")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      {#if importMode === "choose"}
        <p class="muted">{t("import.hint")}</p>
        <div class="import-choice">
          <button class="btn btn-primary" onclick={importFromClipboard} disabled={subs.importing}>
            {subs.importing ? t("import.importing") : t("import.fromClipboard")}
          </button>
          <button class="btn" onclick={() => (importMode = "link")} disabled={subs.importing}>
            {t("import.link")}
          </button>
          <button class="btn" onclick={() => (importMode = "json")} disabled={subs.importing}>
            {t("import.json")}
          </button>
        </div>
        {#if importError}
          <div class="error">{importError}</div>
        {/if}
      {:else if importMode === "link"}
        <p class="muted">{t("import.linkHint")}</p>
        <input
          type="text"
          class="import-link"
          placeholder="https://…"
          bind:value={subUrl}
          onkeydown={(e) => e.key === "Enter" && void importSubscription()}
          disabled={subs.importing}
        />
        {#if importError}
          <div class="error">{importError}</div>
        {/if}
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick={() => (importMode = "choose")} disabled={subs.importing}>
            {t("import.back")}
          </button>
          <button class="btn btn-primary" onclick={importSubscription} disabled={subs.importing || !subUrl.trim()}>
            {subs.importing ? t("import.importing") : t("import.add")}
          </button>
        </div>
      {:else}
        <p class="muted">{t("import.jsonHint")}</p>
        <textarea
          class="import-json"
          placeholder={'{\n  "outbounds": [ … ]\n}'}
          bind:value={subUrl}
          spellcheck="false"
          disabled={subs.importing}
        ></textarea>
        {#if importError}
          <div class="error">{importError}</div>
        {/if}
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick={() => (importMode = "choose")} disabled={subs.importing}>
            {t("import.back")}
          </button>
          <button class="btn btn-primary" onclick={importSubscription} disabled={subs.importing || !subUrl.trim()}>
            {subs.importing ? t("import.importing") : t("import.add")}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Flex column so the top bar + power-button hero stay fixed and only the
     subscriptions list scrolls. */
  .home {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    /* App name removed — keep the add button on the right. */
    justify-content: flex-end;
    padding: 14px 16px 6px;
    flex-shrink: 0;
  }
  .icon-btn {
    width: 38px;
    height: 38px;
    padding: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text);
    background: transparent;
    border: none;
  }
  @media (hover: hover) {
    .icon-btn:hover {
      background: var(--bg-elev-2);
    }
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 4px;
  }
  /* The header X is the modal's only close affordance — keep it compact. */
  .modal-head .icon-btn {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    color: var(--text-muted);
  }
  @media (hover: hover) {
    .modal-head .icon-btn:hover {
      color: var(--text);
    }
  }
  .location-title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .scroll {
    /* Fills the space under the fixed hero and is the only scrolling region. */
    flex: 1;
    min-height: 0;
    /* Always show the scrollbar (6px, see app.css) and mirror its width on
       the left via padding, so the panels sit centred regardless of scroll
       state. `scrollbar-gutter: stable both-edges` would do this, but it's
       not in older WebKitGTK and the rule silently falls back to right-only,
       which is the asymmetric look we want to avoid. */
    overflow-y: scroll;
    overflow-x: hidden;
    padding: 8px 14px 24px 20px;
  }

  /* ---------- power hero (fixed, above the scroll) ---------- */
  .hero {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    /* Raised up toward the top bar — minimal top padding so the power button
       and the subscriptions panel sit higher. */
    padding: 4px 0 16px;
    position: relative;
  }
  .power {
    width: 168px;
    height: 168px;
    border-radius: 50%;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-muted);
    /* The icon is always centred; the timer is absolutely positioned below it
       so connecting/connected never shifts the icon up. */
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    position: relative;
    transition: background var(--transition), border-color var(--transition),
      color var(--transition);
    z-index: 1;
  }
  @media (hover: hover) {
    .power:hover {
      border-color: var(--border-strong);
      color: var(--text);
    }
  }
  .power[data-status="connecting"] {
    color: var(--accent);
  }
  /* A spinning ring makes "connecting" unmistakable (motion is visible
     regardless of theme colour, and keeps the webview repainting). */
  .power[data-status="connecting"]::after {
    content: "";
    position: absolute;
    inset: -7px;
    border-radius: 50%;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  .power[data-status="connected"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-on);
  }
  .status-text {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    margin-top: 6px;
  }
  .status-text[data-status="connected"] { color: var(--accent); }
  .status-text[data-status="connecting"] { color: var(--accent); }
  .status-text[data-status="dropped"] { color: var(--danger); }
  /* Dropped = kill switch holding traffic blocked: ring the power button red. */
  .power[data-status="dropped"] {
    border-color: var(--danger);
    color: var(--danger);
  }
  .conn-error {
    margin-top: 10px;
    max-width: 340px;
    text-align: center;
    font-size: 13px;
    color: var(--danger);
    background: var(--danger-faint);
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    line-height: 1.45;
  }
  .link-btn {
    margin-top: 8px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 13px;
    text-decoration: underline;
    cursor: pointer;
  }
  @media (hover: hover) {
    .link-btn:hover { color: var(--text); }
  }


  /* ---------- subscription card ---------- */
  .sub-card {
    background: var(--bg-elev);
    border: none;
    border-radius: var(--radius);
    margin-bottom: 10px;
    overflow: hidden;
  }
  .sub-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 8px 8px 6px;
  }
  .chev-toggle {
    width: 28px;
    height: 28px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    background: transparent;
    border: none;
  }
  .chev-icon {
    transition: transform var(--transition);
  }
  .sub-info {
    flex: 1;
    min-width: 0;
  }
  .sub-title {
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pin-mark {
    color: var(--accent);
    vertical-align: -1px;
    margin-right: 5px;
    flex-shrink: 0;
  }
  .sub-meta {
    font-size: 11px;
    margin-top: 1px;
  }
  .head-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 50%;
    color: var(--text-muted);
    background: transparent;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  @media (hover: hover) {
    .head-btn:hover {
      background: var(--bg-elev-2);
      color: var(--text);
    }
  }
  .head-btn.spinning svg {
    animation: spin 900ms linear infinite;
    color: var(--accent);
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .menu-wrap {
    position: relative;
  }
  .menu {
    position: fixed;
    /* Explicit width: a fixed element with right set + width:auto stretches to
       the left edge in Android WebView instead of shrinking to its content. */
    width: 240px;
    max-width: calc(100vw - 24px);
    left: auto;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow);
    padding: 4px;
    z-index: 200;
  }
  .menu-item {
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border-radius: 6px;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 13px;
  }
  @media (hover: hover) {
    .menu-item:hover {
      background: var(--bg-elev-3);
    }
  }
  .menu-item.danger {
    color: var(--danger);
  }

  .sub-traffic {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 12px 10px;
  }
  .round-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 50%;
    border: none;
    color: var(--accent);
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  @media (hover: hover) {
    .round-btn:hover {
      background: var(--accent-faint);
    }
  }
  .traffic-bar {
    flex: 1;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: 100px;
    padding: 6px 14px;
    text-align: center;
  }
  .traffic-text {
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    font-weight: 500;
  }
  .description {
    padding: 0 14px 8px;
    font-size: 12px;
    color: var(--text-muted);
    white-space: pre-line;
    line-height: 1.4;
  }
  .expires {
    padding: 0 14px 8px;
    font-size: 11px;
  }
  .info-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 14px;
    margin: 0;
  }
  .info-grid dt {
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .info-grid dd {
    margin: 0;
    word-break: break-all;
    font-size: 13px;
  }
  .info-grid a {
    color: var(--accent);
    text-decoration: underline;
  }
  .mono {
    font-family: ui-monospace, "JetBrains Mono", monospace;
  }
  .info-desc {
    background: var(--bg-elev-2);
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    margin: 0;
    font-size: 12px;
    white-space: pre-line;
    line-height: 1.45;
    color: var(--text-muted);
  }
  .small {
    font-size: 11px;
  }

  .empty {
    text-align: center;
    padding: 40px 16px;
    font-size: 13px;
  }

  /* ---------- modal ---------- */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 100;
    animation: fadeIn var(--transition);
  }
  .modal {
    width: calc(100% - 24px);
    margin: 12px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: slideUp 180ms cubic-bezier(0.2, 0, 0, 1);
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
  }
  .location-modal {
    overflow: hidden;
  }
  .location-editor-scroll {
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 2px;
  }
  .modal h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .modal p { margin: 0; font-size: 13px; }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .import-choice {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 4px 0;
  }
  .import-choice .btn {
    width: 100%;
    padding: 12px;
  }
  .import-link {
    width: 100%;
  }
  .import-json,
  .json-editor {
    width: 100%;
    resize: vertical;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
  }
  .import-json {
    min-height: 180px;
  }
  .json-modal {
    max-height: calc(100dvh - 24px);
  }
  .json-editor {
    min-height: 280px;
    flex: 1;
  }
  .error {
    color: var(--danger);
    background: var(--danger-faint);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
</style>
