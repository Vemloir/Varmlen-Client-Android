<script lang="ts">
  import FlagIcon from "./FlagIcon.svelte";
  import { groupLocations } from "$lib/location-groups";
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

  let expanded = $state<Record<string, boolean>>({});
  const groups = $derived(groupLocations(servers));

  function toggle(groupId: string): void {
    expanded[groupId] = !expanded[groupId];
  }
</script>

{#snippet pingValue(server: ServerEntry)}
  {@const ping = pings[server.id]}
  {#if ping === "pinging"}…
  {:else if ping === "timeout"}{t("ping.na")}
  {:else if typeof ping === "number"}{t("ping.ms", { n: ping })}
  {/if}
{/snippet}

{#snippet serverRow(server: ServerEntry, child = false)}
  <li class="srv-row" class:group-child={child} class:active={selectedServerId === server.id}>
    <span class="srv-stripe"></span>
    <button class="srv-btn" onclick={() => onSelect(server.id)}>
      <FlagIcon flag={server.flag ?? ""} />
      <div class="srv-info">
        <div class="srv-name">{server.name}</div>
        <div class="srv-tr dim">{server.transport}</div>
      </div>
    </button>
    <span class="srv-ping" aria-label="latency">{@render pingValue(server)}</span>
    <button class="srv-detail" aria-label="Location details" onclick={() => onDetails(server)}>
      <svg width="16" height="16" viewBox="0 0 24 24" class="chev" aria-hidden="true">
        <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </li>
{/snippet}

<ul class="server-list">
  {#each groups as group (group.id)}
    {#if group.servers.length === 1}
      {@render serverRow(group.servers[0])}
    {:else}
      {@const primary = group.servers[0]}
      {@const active = group.servers.some((server) => server.id === selectedServerId)}
      <li class="srv-row group-parent" class:active>
        <span class="srv-stripe"></span>
        <button class="srv-btn" onclick={() => onSelect(primary.id)}>
          <FlagIcon flag={group.flag ?? ""} />
          <div class="srv-info">
            <div class="srv-name">{group.name}</div>
            <div class="srv-tr dim">
              {primary.transport} · {t("home.variants", { n: group.servers.length })}
            </div>
          </div>
        </button>
        <span class="srv-ping" aria-label="latency">{@render pingValue(primary)}</span>
        <button
          class="srv-detail"
          aria-label={expanded[group.id] ? "Collapse location variants" : "Expand location variants"}
          aria-expanded={expanded[group.id] ?? false}
          onclick={() => toggle(group.id)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            class="chev group-chev"
            class:expanded={expanded[group.id]}
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </li>
      {#if expanded[group.id]}
        {#each group.servers as server (server.id)}
          {@render serverRow(server, true)}
        {/each}
      {/if}
    {/if}
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
  .srv-row:hover { background: var(--bg-elev-2); }
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
  .group-child { background: color-mix(in srgb, var(--bg-elev-2) 45%, transparent); }
  .group-child .srv-btn { padding-left: 30px; }
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
  .srv-detail:hover { color: var(--text); }
  .srv-stripe {
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: transparent;
    transition: background var(--transition);
  }
  .srv-row.active .srv-stripe { background: var(--accent); }
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
  .group-chev { transition: transform var(--transition); }
  .group-chev.expanded { transform: rotate(90deg); }
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
