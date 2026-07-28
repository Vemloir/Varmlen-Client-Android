<script lang="ts">
  import FlagIcon from "./FlagIcon.svelte";
  import { t } from "$lib/i18n.svelte";
  import type { PingState, ServerEntry } from "$lib/subs.svelte";

  let {
    servers,
    selectedServerId,
    pings,
    onSelect,
    onDetails,
  }: {
    servers: ServerEntry[];
    selectedServerId: string | null;
    pings: Record<string, PingState>;
    onSelect: (id: string) => void;
    onDetails: (server: ServerEntry) => void;
  } = $props();
</script>

<ul class="server-list">
  {#each servers as server (server.id)}
    {@const ping = pings[server.id]}
    <li class="srv-row" class:active={selectedServerId === server.id}>
      <button class="srv-btn" onclick={() => onSelect(server.id)}>
        <FlagIcon flag={server.flag ?? ""} />
        <div class="srv-info">
          <div class="srv-name">{server.name}</div>
          <div class="srv-tr dim">{server.transport}</div>
        </div>
      </button>
      <span class="srv-ping" aria-label="latency">
        {#if ping === "pinging"}…
        {:else if ping === "timeout"}{t("ping.na")}
        {:else if typeof ping === "number"}{t("ping.ms", { n: ping })}
        {/if}
      </span>
      <button class="srv-detail" aria-label="Location details" onclick={() => onDetails(server)}>
        <svg width="16" height="16" viewBox="0 0 24 24" class="chev" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </li>
  {/each}
</ul>

<style>
  .server-list { list-style: none; margin: 0; padding: 4px 0 0; }
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
  .srv-info { flex: 1; min-width: 0; }
  .srv-name {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .srv-tr {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 2px;
  }
  .chev { color: inherit; flex-shrink: 0; }
  .srv-ping {
    align-self: center;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    min-width: 44px;
    text-align: right;
    padding-right: 4px;
    color: var(--muted, #888);
  }
</style>
