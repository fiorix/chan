<script lang="ts">
  // The keys of the screen in front, along the bottom edge of the window: each
  // key as keycaps and what it does, set as the command deck's footer sets its
  // keys. The values are the footer's own; they are not shared with it because
  // the deck's keycap rule also sets its row shortcuts and its keys sheet, and
  // its shortcut column is measured in that face. The bar is a legend and holds
  // no control, so nothing in it takes focus, and a window too narrow for one
  // line clips its end as the footer does. On the Gateways screen it lists the
  // two letters that act there.
  import { screen, type LauncherScreen } from "../state/screen.svelte";

  type KeyHint = { keys: readonly string[]; does: string };

  const SCREEN_KEYS: Record<LauncherScreen, readonly KeyHint[]> = {
    computers: [
      { keys: ["↑", "↓"], does: "rows" },
      { keys: ["←", "→"], does: "controls" },
      { keys: ["Enter"], does: "focuses" },
      { keys: ["g"], does: "screens" },
      { keys: ["o"], does: "on/off" },
      { keys: ["t"], does: "terminal" },
      { keys: ["w"], does: "workspace window" },
      { keys: ["h"], does: "show/hide" },
    ],
    gateways: [
      { keys: ["g"], does: "screens" },
      { keys: ["o"], does: "on/off" },
    ],
  };

  const hints = $derived(SCREEN_KEYS[screen.current]);
</script>

<div class="key-bar">
  {#each hints as hint (hint.does)}
    <span class="key-hint">{#each hint.keys as key (key)}<kbd>{key}</kbd>{/each}<span>{hint.does}</span></span>
  {/each}
</div>

<style>
  .key-bar {
    display: flex;
    align-items: center;
    height: 30px;
    padding: 0 14px;
    gap: 14px;
    overflow: hidden;
    border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 11px;
    white-space: nowrap;
  }

  .key-hint {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 4px;
  }

  kbd {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
    border-radius: 6px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg) 56%, transparent);
    font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
