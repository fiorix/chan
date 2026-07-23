<script lang="ts">
  import type { PaneSide, TerminalTab as TerminalTabState } from "../state/tabs.svelte";
  import TerminalTab from "./TerminalTab.svelte";

  let {
    tab,
  }: {
    tab: TerminalTabState;
  } = $props();

  let currentPaneId = $state("pane-1");
  let currentSide = $state<PaneSide>("a");

  export function move(nextPaneId: string, nextSide: PaneSide): void {
    currentPaneId = nextPaneId;
    currentSide = nextSide;
  }
</script>

<TerminalTab
  {tab}
  paneId={currentPaneId}
  side={currentSide}
  active={true}
  focused={true}
/>
