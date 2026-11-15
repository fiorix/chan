<script lang="ts">
  import TerminalConnectionNotice from "../components/TerminalConnectionNotice.svelte";

  let stalled = $state(false);
  let waitMs = $state(0);

  export function show(wait: number): void {
    waitMs = wait;
    stalled = true;
  }
  export function count(wait: number): void {
    waitMs = wait;
  }
  export function hide(): void {
    stalled = false;
  }
</script>

<TerminalConnectionNotice {stalled} lost={false} notice={false} {waitMs} findOpen={false} inspectorOpen={false} inspectorWidth={0} />
