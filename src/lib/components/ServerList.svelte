<script lang="ts">
  import FlagIcon from "./FlagIcon.svelte";
  import { t } from "$lib/i18n.svelte";
  import { isAndroid } from "$lib/platform";
  import { createLongPress } from "$lib/long-press";
  import type { PingState, ServerEntry } from "$lib/subs.svelte";

  let {
    servers,
    selectedServerId,
    pings,
    hiddenIds = [],
    pinnedIds = [],
    onSelect,
    onDetails,
    onMenu,
  }: {
    servers: ServerEntry[];
    selectedServerId: string | null;
    pings: Record<string, PingState>;
    /** Entries the user hid; rendered dimmed while the card reveals them. */
    hiddenIds?: string[];
    /** Entries the user pinned: marked like a pinned subscription, and listed
     *  first. */
    pinnedIds?: string[];
    onSelect: (id: string) => void;
    onDetails: (server: ServerEntry) => void;
    /** Ask the page to open the location menu at a point. The page owns THE menu:
     *  a state per card left two of them on screen when the user right-clicked in
     *  two different subscriptions. */
    onMenu: (server: ServerEntry, point: { x: number; y: number }) => void;
  } = $props();

  const hiddenSet = $derived(new Set(hiddenIds));
  const pinnedSet = $derived(new Set(pinnedIds));

  /** The row a finger is currently on — Android only. */
  let pendingRow: ServerEntry | null = null;

  const press = createLongPress({
    onTrigger: (point) => {
      if (!pendingRow) return;
      onMenu(pendingRow, point);
    },
  });

  function openFromEvent(
    event: MouseEvent | KeyboardEvent,
    server: ServerEntry,
  ): void {
    if (event instanceof MouseEvent && event.clientX !== 0) {
      onMenu(server, { x: event.clientX, y: event.clientY });
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    onMenu(server, { x: rect.left, y: rect.bottom });
  }

  function handleContextmenu(event: MouseEvent, server: ServerEntry): void {
    if (isAndroid) return;
    event.preventDefault();
    openFromEvent(event, server);
  }

  function handleKeydown(event: KeyboardEvent, server: ServerEntry): void {
    // The standard menu key, plus Shift+F10 where a keyboard has no such key.
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
      return;
    event.preventDefault();
    openFromEvent(event, server);
  }

  // Android: a press opens the menu after a delay, and dies the moment the list
  // moves under the finger. Desktop never arms this — right-click opens at once.
  function handlePointerdown(event: PointerEvent, server: ServerEntry): void {
    if (!isAndroid || event.pointerType === "mouse") return;
    pendingRow = server;
    press.onPress(event.clientX, event.clientY);
  }

  function handlePointermove(event: PointerEvent): void {
    if (!isAndroid) return;
    press.onMove(event.clientX, event.clientY);
  }

  function handlePointerup(): void {
    if (!isAndroid) return;
    press.onRelease();
  }

  function handleRowClick(server: ServerEntry): void {
    // A long press ends in a click as well; that click must not also select the
    // location the user meant to open a menu on.
    if (press.consumeClick()) return;
    onSelect(server.id);
  }

  $effect(() => {
    // Any scroll, anywhere, kills an armed press: if this same press already
    // scrolled the subscriptions, it must not open a menu.
    const onCancel = () => press.cancel();
    window.addEventListener("scroll", onCancel, true);
    return () => window.removeEventListener("scroll", onCancel, true);
  });
</script>

<ul class="server-list">
  {#each servers as server (server.id)}
    {@const ping = pings[server.id]}
    <li
      class="srv-row"
      class:active={selectedServerId === server.id}
      class:hidden-row={hiddenSet.has(server.id)}
    >
      <button
        class="srv-btn"
        aria-haspopup="menu"
        onclick={() => handleRowClick(server)}
        oncontextmenu={(e) => handleContextmenu(e, server)}
        onkeydown={(e) => handleKeydown(e, server)}
        onpointerdown={(e) => handlePointerdown(e, server)}
        onpointermove={handlePointermove}
        onpointerup={handlePointerup}
        onpointercancel={handlePointerup}
      >
        <FlagIcon flag={server.flag ?? ""} />
        <div class="srv-info">
          <div class="srv-name">
            {#if pinnedSet.has(server.id)}
              <svg class="pin-mark" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
              </svg>
            {/if}{server.name}
          </div>
          <div class="srv-tr dim">{server.transport}</div>
        </div>
        <!-- The latency belongs INSIDE the row button. As a sibling it sat
             between the row and the chevron as a 44px strip answering no click,
             no long press and no right-click. -->
        <span class="srv-ping" aria-label="latency">
          {#if ping === "pinging"}
            …
          {:else if ping === "timeout"}
            {t("ping.na")}
          {:else if typeof ping === "number"}
            {t("ping.ms", { n: ping })}
          {/if}
        </span>
      </button>
      <button
        class="srv-detail"
        aria-label="Location details"
        onclick={() => onDetails(server)}
        oncontextmenu={(e) => handleContextmenu(e, server)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" class="chev" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </li>
  {/each}
</ul>

<style>
  .server-list {
    list-style: none;
    margin: 0;
    padding: 4px 0 0;
    /* A long press on text is the WebView's own "select text" gesture: it haptics
       and shows a selection handle, which is exactly what the location menu is
       trying to do. Take the text away from it. Inputs and the JSON editor keep
       theirs. */
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .srv-row {
    position: relative;
    display: flex;
    align-items: stretch;
    background: transparent;
    transition: background var(--transition);
  }
  .srv-row::before {
    content: "";
    position: absolute;
    z-index: 1;
    top: 0;
    left: 0;
    right: 0;
    border-top: 1px solid var(--bg);
    pointer-events: none;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(html:not(.is-android)) .srv-row:not(.active):hover {
      background: var(--bg-elev-2);
    }
  }
  .srv-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 4px 10px 14px;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    border-radius: 0;
  }
  .srv-detail {
    flex-shrink: 0;
    width: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-dim);
  }
  @media (hover: hover) and (pointer: fine) {
    :global(html:not(.is-android)) .srv-detail:hover {
      color: var(--text);
    }
  }
  .srv-row.active { background: var(--accent-faint); }
  /* A hidden location, shown only while the card reveals them. */
  .srv-row.hidden-row .srv-btn,
  .srv-row.hidden-row .srv-ping { opacity: 0.45; }
  .srv-info { flex: 1; min-width: 0; }
  .srv-name {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pin-mark {
    margin-right: 5px;
    color: var(--text-dim);
    vertical-align: -1px;
  }
  .srv-tr {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 2px;
  }
  .chev { color: inherit; flex-shrink: 0; }
  .srv-ping {
    flex-shrink: 0;
    align-self: center;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    min-width: 44px;
    text-align: right;
    padding-right: 4px;
    color: var(--muted, #888);
  }
</style>
