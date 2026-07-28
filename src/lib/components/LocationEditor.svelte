<script lang="ts">
  import { t } from "$lib/i18n.svelte";
  import {
    createLocationDraft,
    type LocationEditDraft,
    type LocationField,
  } from "$lib/location-draft";
  import type { ServerEntry } from "$lib/subs.svelte";

  let {
    server,
    onSave,
    onCancel,
  }: {
    server: ServerEntry;
    onSave: (draft: LocationEditDraft) => void | Promise<void>;
    onCancel: () => void;
  } = $props();

  let draft = $state<LocationEditDraft>({ kind: "json", source: "" });
  let loadedServerId = $state("");
  $effect.pre(() => {
    if (loadedServerId === server.id) return;
    loadedServerId = server.id;
    draft = structuredClone(server.editDraft ?? createLocationDraft(server.raw));
  });
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  const fieldDraft = $derived(
    draft.kind === "fields" ? draft : null,
  );
  const protocol = $derived(fieldDraft?.values.protocol.toLowerCase() ?? "");
  const transport = $derived(fieldDraft?.values.transport.toLowerCase() ?? "");
  const security = $derived(fieldDraft?.values.security.toLowerCase() ?? "");

  function setField(field: LocationField, value: string): void {
    if (draft.kind === "fields") draft.values[field] = value;
  }

  function addRawParam(): void {
    if (draft.kind !== "fields") return;
    draft.rawParams.push({ id: crypto.randomUUID(), key: "", value: "" });
  }

  function removeRawParam(id: string): void {
    if (draft.kind !== "fields") return;
    draft.rawParams = draft.rawParams.filter((row) => row.id !== id);
  }

  async function save(): Promise<void> {
    saving = true;
    saveError = null;
    try {
      await onSave(structuredClone(draft));
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }
</script>

{#snippet inputField(field: LocationField, label: string, type = "text")}
  <label class="field">
    <span>{label}</span>
    <input
      {type}
      value={fieldDraft?.values[field] ?? ""}
      oninput={(event) =>
        setField(field, (event.currentTarget as HTMLInputElement).value)}
      spellcheck="false"
    />
  </label>
{/snippet}

{#if draft.kind === "json"}
  <label class="json-field">
    <span>{t("location.json")}</span>
    <textarea class="json-editor" bind:value={draft.source} spellcheck="false"></textarea>
  </label>
{:else}
  <div class="fields-grid">
    {@render inputField("label", t("location.name"))}
    <label class="field">
      <span>{t("location.protocol")}</span>
      <select
        value={draft.values.protocol}
        onchange={(event) =>
          setField("protocol", (event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="vless">VLESS</option>
        <option value="vmess">VMess</option>
        <option value="trojan">Trojan</option>
        <option value="shadowsocks">Shadowsocks</option>
      </select>
    </label>
    {@render inputField("host", t("location.address"))}
    {@render inputField("port", t("location.port"), "text")}

    {#if protocol === "vless" || protocol === "vmess"}
      {@render inputField("uuid", "UUID")}
    {:else if protocol === "trojan"}
      {@render inputField("password", t("location.password"), "text")}
    {:else if protocol === "shadowsocks"}
      {@render inputField("method", t("location.method"))}
      {@render inputField("password", t("location.password"), "text")}
    {/if}

    {@render inputField("transport", t("location.transport"))}
    {@render inputField("security", t("location.security"))}

    {#if security === "tls" || security === "reality"}
      {@render inputField("sni", "SNI")}
      {@render inputField("fingerprint", t("location.fingerprint"))}
    {/if}
    {#if security === "reality"}
      {@render inputField("public_key", t("location.publicKey"))}
      {@render inputField("short_id", t("location.shortId"))}
      {@render inputField("flow", "Flow")}
    {/if}
    {#if transport === "ws" || transport === "xhttp" || transport === "httpupgrade" || transport === "grpc"}
      {@render inputField("path", t("location.path"))}
      {@render inputField("mode", t("location.mode"))}
    {/if}
    {@render inputField("packet_encoding", t("location.packetEncoding"))}
  </div>

  <div class="params-head">
    <span>{t("location.extraParams")}</span>
    <button class="add-param" type="button" onclick={addRawParam}>
      {t("location.addParam")}
    </button>
  </div>
  <div class="raw-params">
    {#each draft.rawParams as row (row.id)}
      <div class="param-row">
        <input bind:value={row.key} placeholder={t("location.paramKey")} spellcheck="false" />
        <input bind:value={row.value} placeholder={t("location.paramValue")} spellcheck="false" />
        <button
          class="remove-param"
          type="button"
          onclick={() => removeRawParam(row.id)}
          aria-label={t("common.remove")}
        >×</button>
      </div>
    {/each}
  </div>
{/if}

{#if saveError}
  <div class="error">{saveError}</div>
{/if}

<div class="modal-actions">
  <button class="btn btn-ghost" onclick={onCancel} disabled={saving}>
    {t("common.cancel")}
  </button>
  <button class="btn btn-primary" onclick={() => void save()} disabled={saving}>
    {saving ? t("json.saving") : t("common.save")}
  </button>
</div>

<style>
  .fields-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 8px;
  }
  .field,
  .json-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
  }
  .field input,
  .field select {
    color: var(--text);
    font-size: 13px;
    font-weight: 400;
  }
  .json-editor {
    min-height: min(56vh, 440px);
    resize: vertical;
    color: var(--text);
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    line-height: 1.45;
  }
  .params-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
  }
  .add-param {
    border: none;
    padding: 5px 8px;
    color: var(--text);
    font-size: 11px;
  }
  .raw-params {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 7px;
  }
  .param-row {
    display: grid;
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) 32px;
    gap: 6px;
  }
  .param-row input {
    min-width: 0;
    padding: 8px 9px;
    font-size: 12px;
  }
  .remove-param {
    padding: 0;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
  }
  @media (max-width: 420px) {
    .fields-grid { grid-template-columns: 1fr; }
  }
</style>
