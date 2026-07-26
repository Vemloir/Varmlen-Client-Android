<script lang="ts">
  import { countryCodeFromFlag } from "$lib/flags";

  let { flag }: { flag: string } = $props();
  const countryCode = $derived(countryCodeFromFlag(flag));
</script>

<span class="flag-slot" aria-hidden="true">
  {#if countryCode}
    <span class="flag-image fi fi-{countryCode}"></span>
  {:else if flag}
    <span class="flag-fallback">{flag}</span>
  {/if}
</span>

<style>
  .flag-slot {
    width: 28px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .flag-image {
    width: 28px;
    height: 20px;
    border-radius: 4px;
    background-size: cover;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  }
  .flag-fallback {
    font-size: 18px;
    line-height: 1;
  }
</style>
