<script lang="ts">
  import LauncherDemo from "./LauncherDemo.svelte";
  import { applyTheme, themeState } from "./state/theme.svelte";
  import { DEFAULT_WAVE_SPEED } from "./lib/plasmaBackground";
  let speed = $state(DEFAULT_WAVE_SPEED);
  $effect(applyTheme);
</script>

<div class="preview">
  <LauncherDemo animatedBackground waveSpeed={speed} />
</div>
<div class="tuning" data-theme={themeState.theme}>
  <label for="wave-speed">Wave speed</label>
  <input id="wave-speed" type="range" min="0" max="1.5" step="0.05" bind:value={speed} />
  <output>{speed.toFixed(2)}×</output>
  <select aria-label="Preview theme" bind:value={themeState.theme}>
    <option value="dark">Dark</option>
    <option value="light">Light</option>
  </select>
</div>

<style>
  .preview { height: 100vh; }
  .tuning {
    position: fixed;
    z-index: 100;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-card);
    font-size: 12px;
  }
  output { min-width: 3.5em; }
  input { accent-color: var(--brand); }
</style>
