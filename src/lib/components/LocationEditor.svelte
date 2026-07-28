<script lang="ts">
  import { onMount } from "svelte";
  import {
    getLocationEditorOptions,
    type EditorChoice,
    type LocationEditorOptions,
  } from "$lib/api";
  import { t } from "$lib/i18n.svelte";
  import { includeCurrentOption } from "$lib/location-editor-options";
  import type {
    LocationEditDraft,
    LocationField,
  } from "$lib/location-draft";
  import Dropdown from "./Dropdown.svelte";

  let { draft }: { draft: LocationEditDraft } = $props();
  let options = $state<LocationEditorOptions | null>(null);

  onMount(() => {
    let active = true;
    void getLocationEditorOptions()
      .then((value) => {
        if (active) options = value;
      })
      .catch((error) => {
        console.error("could not load Xray editor options:", error);
      });
    return () => {
      active = false;
    };
  });

  const fieldDraft = $derived(
    draft.kind === "fields" ? draft : null,
  );
  const protocol = $derived(fieldDraft?.values.protocol.toLowerCase() ?? "");
  const transport = $derived(fieldDraft?.values.transport.toLowerCase() ?? "");
  const security = $derived(fieldDraft?.values.security.toLowerCase() ?? "");
  const isWireGuard = $derived(protocol === "wireguard");
  const isHysteria = $derived(protocol === "hysteria");
  const transportOptions = $derived(
    isHysteria
      ? options?.transports.filter((option) => option.value === "hysteria") ?? []
      : options?.transports.filter((option) => option.value !== "hysteria") ?? [],
  );
  const securityOptions = $derived(
    isHysteria
      ? options?.securities.filter((option) => option.value === "tls") ?? []
      : options?.securities ?? [],
  );
  const modeOptions = $derived(
    transport === "grpc"
      ? options?.grpcModes ?? []
      : options?.xhttpModes ?? [],
  );

  function setField(field: LocationField, value: string): void {
    if (draft.kind !== "fields") return;
    draft.values[field] = value;
    if (field !== "protocol") return;
    if (value === "hysteria") {
      draft.values.transport = "hysteria";
      draft.values.security = "tls";
    } else if (value === "wireguard") {
      draft.values.transport = "wireguard";
      draft.values.security = "none";
      draft.values.domain_strategy ||= "ForceIP";
    } else {
      if (draft.values.transport === "hysteria" || draft.values.transport === "wireguard") {
        draft.values.transport = "tcp";
      }
      if (!draft.values.security) draft.values.security = "none";
    }
  }

  function addRawParam(): void {
    if (draft.kind !== "fields") return;
    draft.rawParams.push({ id: crypto.randomUUID(), key: "", value: "" });
  }

  function removeRawParam(id: string): void {
    if (draft.kind !== "fields") return;
    draft.rawParams = draft.rawParams.filter((row) => row.id !== id);
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

{#snippet selectField(field: LocationField, label: string, choices: EditorChoice[])}
  <label class="field">
    <span>{label}</span>
    <Dropdown
      field
      value={fieldDraft?.values[field] ?? ""}
      options={includeCurrentOption(choices, fieldDraft?.values[field] ?? "")}
      onChange={(value) => setField(field, value)}
      ariaLabel={label}
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
    {@render selectField("protocol", t("location.protocol"), options?.protocols ?? [])}
    {@render inputField("host", t("location.address"))}
    {@render inputField("port", t("location.port"), "text")}

    {#if protocol === "vless" || protocol === "vmess"}
      {@render inputField("uuid", "UUID")}
    {:else if protocol === "trojan"}
      {@render inputField("password", t("location.password"), "text")}
    {:else if protocol === "shadowsocks"}
      {@render selectField("method", t("location.method"), options?.shadowsocksMethods ?? [])}
      {@render inputField("password", t("location.password"), "text")}
    {:else if protocol === "hysteria"}
      {@render inputField("uuid", t("location.auth"))}
    {:else if protocol === "http" || protocol === "socks"}
      {@render inputField("uuid", t("location.username"))}
      {@render inputField("password", t("location.password"), "text")}
    {:else if protocol === "wireguard"}
      {@render inputField("uuid", t("location.privateKey"))}
      {@render inputField("public_key", t("location.peerPublicKey"))}
      {@render inputField("local_address", t("location.localAddress"))}
      {@render inputField("pre_shared_key", t("location.preSharedKey"))}
      {@render inputField("reserved", t("location.reserved"))}
      {@render inputField("mtu", "MTU")}
      {@render selectField(
        "domain_strategy",
        t("location.domainStrategy"),
        options?.wireguardDomainStrategies ?? [],
      )}
    {/if}

    {#if !isWireGuard}
      {@render selectField("transport", t("location.transport"), transportOptions)}
      {@render selectField("security", t("location.security"), securityOptions)}
    {/if}

    {#if security === "tls" || security === "reality"}
      {@render inputField("sni", "SNI")}
      {@render selectField(
        "fingerprint",
        t("location.fingerprint"),
        options?.fingerprints ?? [],
      )}
    {/if}
    {#if security === "reality"}
      {@render inputField("public_key", t("location.publicKey"))}
      {@render inputField("short_id", t("location.shortId"))}
      {@render selectField("flow", "Flow", options?.flows ?? [])}
    {/if}
    {#if transport === "ws" || transport === "xhttp" || transport === "httpupgrade" || transport === "grpc"}
      {@render inputField("path", t("location.path"))}
    {/if}
    {#if transport === "xhttp" || transport === "grpc"}
      {@render selectField("mode", t("location.mode"), modeOptions)}
    {/if}
    {#if !isWireGuard && !isHysteria}
      {@render selectField(
        "packet_encoding",
        t("location.packetEncoding"),
        options?.packetEncodings ?? [],
      )}
    {/if}
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
  .field input {
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
