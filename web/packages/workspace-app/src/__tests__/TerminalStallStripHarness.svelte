<script lang="ts">
  import TerminalStallStrip from "../components/TerminalStallStrip.svelte";

  let visible = $state(false);
  let waitMs = $state(0);

  export function show(wait: number): void {
    waitMs = wait;
    visible = true;
  }
  export function count(wait: number): void {
    waitMs = wait;
  }
  export function hide(): void {
    visible = false;
  }
</script>

<TerminalStallStrip {visible} {waitMs} />
