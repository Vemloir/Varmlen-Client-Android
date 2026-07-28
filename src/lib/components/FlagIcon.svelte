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
  {:else}
    <svg class="globe" viewBox="0 0 24 24" fill="none">
      <circle class="globe-outline" cx="12" cy="12" r="9"></circle>
      <path class="globe-arc" d="M10 3.7C7.4 8.7 7.4 15.3 10 20.3"></path>
      <path class="globe-arc" d="M14 3.7C16.6 8.7 16.6 15.3 14 20.3"></path>
      <path class="globe-arc" d="M4.1 9C9.1 11 14.9 11 19.9 9"></path>
      <path class="globe-arc" d="M4.1 15C9.1 13 14.9 13 19.9 15"></path>
    </svg>
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
  .globe {
    width: 22px;
    height: 22px;
    color: var(--text-dim);
  }
  .globe-outline,
  .globe-arc {
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
