<script lang="ts">
  // Every terminal tab the layout holds, drawn once and keyed by tab id above
  // the pane tree, so restructuring the panes never rebuilds a terminal. Each
  // terminal's element is docked into the terminal layer of the pane that
  // holds it (state/terminalDock.svelte.ts). Each item keeps a wrapper here,
  // in this hidden list, so the keyed list only ever moves the wrappers and
  // never pulls a docked terminal back out of its pane.
  import { activeLayout, closeTab, paneMode, tabLabel } from "../state/tabs.svelte";
  import {
    dockTerminal,
    terminalDocked,
    terminalPlacements,
  } from "../state/terminalDock.svelte";
  import FailureCard from "./FailureCard.svelte";
  import TerminalTab from "./TerminalTab.svelte";

  const placements = $derived(terminalPlacements(activeLayout(), paneMode.active));
  const ids = $derived(placements.map((placement) => placement.tab.id));
  const placementById = $derived(new Map(placements.map((placement) => [placement.tab.id, placement])));
</script>

<div class="terminals" hidden>
  {#each ids as id (id)}
    <div>
      <div class="terminal-dock" {@attach dockTerminal(id, () => placementById.get(id)?.paneId)}>
        {#if terminalDocked(id)}
          {@const placed = placementById.get(id)}
          {#if placed}
            <svelte:boundary>
              <TerminalTab
                tab={placed.tab}
                paneId={placed.paneId}
                side={placed.side}
                active={placed.active}
                focused={placed.focused}
              />
              {#snippet failed(error, reset)}
                <div class="tab-failed" class:offscreen={!placed.active}>
                  <FailureCard
                    title="This tab could not be drawn."
                    {error}
                    hint="The pane's other tabs still work, and so does every other pane."
                    onRetry={reset}
                    closeLabel={tabLabel(placed.tab)}
                    onClose={() => void closeTab(placed.paneId, placed.tab.id)}
                  />
                </div>
              {/snippet}
            </svelte:boundary>
          {/if}
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  /* Docked in a pane's layer, the dock adds no box: the terminal positions
     against the pane body as the pane's own tab bodies do. */
  .terminal-dock {
    display: contents;
  }

  /* A failed terminal's card, where its body would be, hidden on the same
     terms as a background body (Pane's tab card). */
  .tab-failed {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .tab-failed.offscreen {
    display: none;
  }
</style>
