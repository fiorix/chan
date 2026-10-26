<script lang="ts">
  import { onMount } from "svelte";
  import App from "./App.svelte";
  import { createLauncherDemoApi, type LauncherDemoVariant } from "./api/demo";
  import { resetBackend, setBackend } from "./api/backend";
  import { library, loadLibrary, stopWatching } from "./state/library.svelte";
  import { closeDialog, openNewDialog } from "./state/dialog.svelte";
  import { cancelConfirm } from "./state/confirm.svelte";
  import { clearSelection } from "./state/selection.svelte";
  import { clearAllControlAttention, markControlAttention } from "./state/controlAttention.svelte";
  import { setDemoMode } from "./state/demo.svelte";
  import { themeState } from "./state/theme.svelte";

  let {
    onOpenWindow,
    variant = "populated",
    hints = false,
    animatedBackground = false,
    waveSpeed,
  }: {
    onOpenWindow?: (id: string) => void;
    variant?: LauncherDemoVariant;
    hints?: boolean;
    animatedBackground?: boolean;
    waveSpeed?: number;
  } = $props();

  // The marketing mock always demos the dark theme to match the desktop
  // screenshots and the dark widget frame, regardless of the visitor's
  // prefers-color-scheme (which would otherwise start it light and render the
  // theme toggle as a moon instead of the desktop's sun).
  themeState.theme = "dark";

  // Initial-value capture is deliberate: the embed wires the handler, variant,
  // and hints once at mount and never swaps them.
  // svelte-ignore state_referenced_locally
  const api = createLauncherDemoApi({ onOpenWindow, variant });
  setBackend(api);

  async function resetDemoData(): Promise<void> {
    stopWatching();
    api.reset();
    closeDialog();
    cancelConfirm();
    clearSelection();
    clearAllControlAttention();
    await loadLibrary();
    if (api.attentionDevserverId) markControlAttention(api.attentionDevserverId);
  }

  // The populated hero repurposes FolderPlus into "Reset demo data"; the empty
  // manual embeds keep the real New-workspace flow, so they register no reset.
  // svelte-ignore state_referenced_locally
  setDemoMode({ reset: variant === "populated" ? resetDemoData : null });

  // First-run hints ride on the frame as data attributes so the EMBEDDING page
  // can render callout bubbles outside the mock window (the frame's overflow:
  // hidden would clip anything inside, and stacked in-window bubbles cover the
  // card). Each flag tracks live library state: it clears once the action is
  // done and returns if the user discards everything again.
  const hintTerminal = $derived(
    hints && !library.windows.some((w) => w.library_id === "local" && w.kind === "terminal"),
  );
  const hintWorkspace = $derived(
    hints && !library.workspaces.some((w) => w.devserver_id === null),
  );

  onMount(() => {
    void resetDemoData().then(() => {
      // The devserver embed is ABOUT the Add-devserver form, so it greets the
      // reader with the dialog already open (closable and reopenable via the
      // real Add devserver button).
      if (variant === "devserver") openNewDialog("devserver", { initialFocus: false });
    });
    return () => {
      stopWatching();
      setDemoMode(null);
      clearAllControlAttention();
      resetBackend();
    };
  });
</script>

<div
  class="launcher-demo-frame"
  class:animated-background={animatedBackground}
  data-theme={themeState.theme}
  data-hint-terminal={hintTerminal ? "true" : undefined}
  data-hint-workspace={hintWorkspace ? "true" : undefined}>
  <App {animatedBackground} {waveSpeed} />
</div>

<style>
  .launcher-demo-frame {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    font-size: 14px;
    height: 100%;
    isolation: isolate;
    min-height: 100%;
    overflow: hidden;
    position: relative;
    transform: translateZ(0);
  }

  :global(.launcher-demo-frame .topbar) {
    flex: 0 0 auto;
    position: static;
  }

  /* Match the desktop launcher: the content column shares the top bar's 1.25rem
     side padding, so each machine card's edge aligns under the "Computers" title
     and the card internals (icon indent, gaps) fall back to the shipped launcher
     CSS instead of the embed-only nudges. Only the vertical padding is tightened
     for the shorter widget frame. */
  :global(.launcher-demo-frame .content) {
    background: var(--bg);
    flex: 1 1 auto;
    margin: 0;
    max-width: none;
    min-height: 0;
    overflow: auto;
    padding: 0.75rem 1.25rem 0.5rem;
  }

  :global(.launcher-demo-frame .content.with-bulk-bar) {
    padding-bottom: 4.25rem;
  }
  :global(.launcher-demo-frame.animated-background .content) {
    background: transparent;
  }
</style>
