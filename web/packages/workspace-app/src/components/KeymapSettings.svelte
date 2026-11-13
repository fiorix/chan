<script lang="ts">
  // The per-OS shortcut assignment surface: every command in the catalog,
  // each with a chord cell per client slot (Web / macOS / Linux / Windows).
  // The current client's slot is marked, but all four are editable from any
  // machine so a user can prepare another OS's chords (the metadata travels
  // with the desktop config). Each cell is a CommandChordAssign bound to its
  // slot, which owns capture, conflict detection and clear. This is body
  // content: the caller (a settings section) provides the surrounding chrome.

  import { allCommands, type Command } from "../state/commands";
  // Populate the catalog before the first read.
  import "../state/commands/install";
  import CommandChordAssign from "./CommandChordAssign.svelte";
  import { currentSlot, type OverrideSlot } from "../state/keymapOverrides.svelte";

  const SLOTS: { slot: OverrideSlot; label: string }[] = [
    { slot: "web", label: "Web" },
    { slot: "macos", label: "macOS" },
    { slot: "linux", label: "Linux" },
    { slot: "windows", label: "Windows" },
  ];

  // Settles once: platform + OS do not change at runtime.
  const active = currentSlot();

  let query = $state("");

  type Group = { category: string; commands: Command[] };

  function matches(cmd: Command, q: string): boolean {
    if (q === "") return true;
    if (cmd.title.toLowerCase().includes(q)) return true;
    return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  }

  const groups = $derived.by<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const byCategory = new Map<string, Command[]>();
    for (const cmd of allCommands()) {
      if (!matches(cmd, q)) continue;
      const list = byCategory.get(cmd.category) ?? [];
      list.push(cmd);
      byCategory.set(cmd.category, list);
    }
    return [...byCategory.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((category) => ({
        category,
        commands: (byCategory.get(category) ?? []).sort((a, b) =>
          a.title.localeCompare(b.title),
        ),
      }));
  });
</script>

<div class="keymap">
  <div class="toolbar">
    <input
      class="search"
      type="text"
      bind:value={query}
      placeholder="Filter commands"
      aria-label="Filter commands"
      autocomplete="off"
      spellcheck="false"
    />
    <p class="hint">
      Shortcuts apply on the matching client: a browser uses Web, chan-desktop
      uses its OS. Unset cells fall back to the built-in chord.
    </p>
  </div>

  <div class="grid" role="table" aria-label="Keyboard shortcuts">
    <div class="row head" role="row">
      <span class="col-cmd" role="columnheader">Command</span>
      {#each SLOTS as s (s.slot)}
        <span class="col-slot" class:active={s.slot === active} role="columnheader">
          {s.label}{#if s.slot === active}<span class="here">this device</span>{/if}
        </span>
      {/each}
    </div>

    {#each groups as group (group.category)}
      <div class="cat" role="rowgroup">
        <div class="cat-label" role="row"><span role="cell">{group.category}</span></div>
        {#each group.commands as cmd (cmd.id)}
          <div class="row" role="row">
            <span class="col-cmd" role="cell">{cmd.title}</span>
            {#each SLOTS as s (s.slot)}
              <span class="col-slot cell" class:active={s.slot === active} role="cell">
                <CommandChordAssign {cmd} slot={s.slot} />
              </span>
            {/each}
          </div>
        {/each}
      </div>
    {/each}

    {#if groups.length === 0}
      <div class="empty">No commands match.</div>
    {/if}
  </div>
</div>

<style>
  .keymap {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 12px;
    color: var(--text);
  }
  .toolbar {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .search {
    box-sizing: border-box;
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elev);
    color: var(--text);
    font: inherit;
    outline: none;
  }
  .search:focus {
    border-color: color-mix(in srgb, var(--text) 34%, transparent);
  }
  .hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) repeat(4, minmax(96px, max-content));
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 8px;
  }
  .row:not(.head):hover {
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-card);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .col-cmd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .col-slot {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-start;
  }
  .col-slot.active {
    color: var(--text);
  }
  .here {
    padding: 0 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent, var(--text)) 16%, transparent);
    color: var(--text-secondary);
    font-size: 9px;
    letter-spacing: 0.02em;
    text-transform: none;
  }
  .cat-label {
    padding: 12px 8px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .cell {
    min-height: 30px;
  }
  .empty {
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 13px;
  }
</style>
