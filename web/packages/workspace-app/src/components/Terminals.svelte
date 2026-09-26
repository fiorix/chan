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
          <!-- The placements are rebuilt on every layout change. Each prop
               is a value of its own, so a terminal's effects re-run only when
               what they read changes, not when another pane's tabs do. -->
          {@const placed = placementById.get(id)}
          {@const tab = placed?.tab}
          {@const paneId = placed?.paneId ?? ""}
          {@const side = placed?.side ?? "a"}
          {@const active = placed?.active ?? false}
          {@const focused = placed?.focused ?? false}
          {#if tab}
            <svelte:boundary>
              <TerminalTab {tab} {paneId} {side} {active} {focused} />
              {#snippet failed(error, reset)}
                <div class="tab-failed" class:offscreen={!active}>
                  <FailureCard
                    title="This tab could not be drawn."
                    {error}
                    hint="The pane's other tabs still work, and so does every other pane."
                    onRetry={reset}
                    closeLabel={tabLabel(tab)}
                    onClose={() => void closeTab(paneId, tab.id)}
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
