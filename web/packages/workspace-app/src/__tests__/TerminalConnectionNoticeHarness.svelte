<script lang="ts">
  import TerminalConnectionNotice from "../components/TerminalConnectionNotice.svelte";

  let stalled = $state(false);
  let waitMs = $state(0);
  let findOpen = $state(false);
  let inspectorOpen = $state(false);
  let inspectorWidth = $state(280);
  let lost = $state(false);

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
  export function find(open: boolean): void {
    findOpen = open;
  }
  export function inspect(open: boolean): void {
    inspectorOpen = open;
  }
  export function width(value: number): void {
    inspectorWidth = value;
  }
  export function lose(value: boolean): void {
    lost = value;
  }
</script>

<TerminalConnectionNotice {stalled} {lost} notice={false} {waitMs} {findOpen} {inspectorOpen} {inspectorWidth} />
