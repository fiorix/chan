<script lang="ts">
  import TerminalConnectionNotice from "../components/TerminalConnectionNotice.svelte";

  let notice = $state(false);
  let findOpen = $state(false);
  let inspectorOpen = $state(false);
  let inspectorWidth = $state(280);

  export function show(): void {
    notice = true;
  }
  export function hide(): void {
    notice = false;
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
</script>

<TerminalConnectionNotice {notice} {findOpen} {inspectorOpen} {inspectorWidth} />
