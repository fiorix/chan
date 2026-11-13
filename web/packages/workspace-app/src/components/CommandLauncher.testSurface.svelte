<script module lang="ts">
  /// How the stand-in takes the keyboard when it is shown: before the call
  /// returns, in a microtask, after a tick, on a zero-delay timer, or as its
  /// field mounts.
  export type SurfaceGrab = "sync" | "microtask" | "tick" | "timer" | "mount";
</script>

<script lang="ts">
  // A stand-in for a surface under the launcher that a row shows: a field that
  // takes the keyboard when shown, the ways the real ones do. The Rich Prompt
  // focuses its composer as it shows and its terminal in a microtask as it
  // hides, a terminal focuses again on a zero-delay timer, and an editor
  // remounted by a mode switch focuses as it mounts.
  import { flushSync, tick } from "svelte";

  let shown = $state(false);
  let grab: SurfaceGrab = "sync";
  let field: HTMLTextAreaElement | null = null;

  function mounted(node: HTMLTextAreaElement): { destroy: () => void } {
    field = node;
    if (grab === "mount") node.focus();
    return {
      destroy: () => {
        field = null;
      },
    };
  }

  export function isShown(): boolean {
    return shown;
  }

  export function show(how: SurfaceGrab): void {
    grab = how;
    shown = true;
    const take = (): void => field?.focus();
    if (how === "mount") return;
    if (how === "tick") {
      void tick().then(take);
    } else if (how === "timer") {
      setTimeout(take, 0);
    } else {
      // The field is in the page before the caller goes on.
      flushSync();
      if (how === "sync") take();
      else queueMicrotask(take);
    }
  }

  export function hide(): void {
    shown = false;
  }
</script>

{#if shown}
  <textarea class="stand-in-surface" use:mounted></textarea>
{/if}
