<script lang="ts">
  // Tabular renderer for CSV / TSV files. Mounted when an
  // `isCsv(path)` tab is in `mode === "table"`. Source mode is
  // the escape hatch for files the parser misreads or for bulk
  // edits the table UI doesn't support (column ops, sort,
  // filter).
  //
  // Round-trip model: the tab's content buffer stays
  // authoritative. We parse on mount + when an external write
  // lands; cell commits re-serialize and write back through the
  // bound `value` prop. The serializer uses a minimal quoting
  // policy so a single-cell edit only changes the bytes of the
  // affected line.

  import { tick } from "svelte";
  import { parseCsv, serializeCsv, maxRowWidth } from "./csv";

  let {
    value = $bindable(""),
    delimiter = ",",
    readonly = false,
  }: {
    /// The tab's content buffer. Bidirectional: cell commits
    /// re-serialize and write back here, which the host (FileTab)
    /// propagates to autosave.
    value: string;
    /// Field separator. "," for .csv, "\t" for .tsv. The host
    /// derives this from the file extension via `csvDelimiter`.
    delimiter?: string;
    readonly?: boolean;
  } = $props();

  // Local model. We parse `value` once at mount + whenever the
  // buffer changes from outside (autosave echo, sibling-mirror
  // update, file watcher). `lastSerialized` lets us tell our own
  // commits apart from external writes so we don't reparse the
  // bytes we just emitted (which would lose the in-progress edit
  // state).
  //
  // The initial parse captures `delimiter` at mount; the delimiter
  // is derived from the file extension, which can't change without
  // closing + reopening the tab, so capturing the prop value once
  // is correct.
  // svelte-ignore state_referenced_locally
  let rows = $state<string[][]>(parseCsv(value, delimiter));
  // svelte-ignore state_referenced_locally
  let lastSerialized = value;

  /// Active cell. Null when no edit is in progress. The cell at
  /// (rowIndex, colIndex) renders an <input> instead of a text
  /// node when this matches.
  let editing = $state<{ row: number; col: number } | null>(null);
  /// Working copy of the cell's text while editing. Committed on
  /// blur / Enter; discarded on Escape.
  let draft = $state<string>("");

  $effect(() => {
    if (value === lastSerialized) return;
    // External change. If a cell is mid-edit when the buffer
    // flips, cancel the edit -- the user's draft would clobber
    // the external write on commit. The autosave window is small
    // enough that an in-flight edit racing with a sibling-pane
    // mirror is rare; surfacing the cancel here is the cheapest
    // recovery.
    rows = parseCsv(value, delimiter);
    lastSerialized = value;
    editing = null;
    draft = "";
  });

  function startEdit(r: number, c: number, current: string): void {
    if (readonly) return;
    editing = { row: r, col: c };
    draft = current;
  }

  function commitEdit(): void {
    if (readonly) {
      editing = null;
      draft = "";
      return;
    }
    if (!editing) return;
    const { row, col } = editing;
    // A cell left as it was is not an edit: re-serializing would rewrite
    // the whole file (line endings, quoting, a ragged row's padding).
    if (draft === (rows[row]?.[col] ?? "")) {
      cancelEdit();
      return;
    }
    // Pad short rows up to the column index so an edit into an
    // empty cell of a ragged row materializes the missing fields
    // as empty strings rather than overflowing the array.
    while (rows[row].length <= col) rows[row].push("");
    rows[row][col] = draft;
    pushBuffer();
    editing = null;
    draft = "";
  }

  function cancelEdit(): void {
    editing = null;
    draft = "";
  }

  function pushBuffer(): void {
    const out = serializeCsv(rows, delimiter);
    lastSerialized = out;
    value = out;
  }

  function onKeydown(e: KeyboardEvent): void {
    const at = editing;
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
      if (at) void focusCell(at.row, at.col);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      if (at) void focusCell(at.row, at.col);
      return;
    }
  }

  let tableEl: HTMLElement | undefined = $state();

  /// Give focus back to a cell's button once the edit that replaced it is
  /// gone, so a keyboard user carries on from the cell rather than from the
  /// top of the page. A blur commit leaves focus where the user put it.
  async function focusCell(row: number, col: number): Promise<void> {
    await tick();
    tableEl?.querySelector<HTMLButtonElement>(`button[data-cell="${row}:${col}"]`)?.focus();
  }

  /// Focus the edit's input when it opens.
  function focusOnMount(input: HTMLInputElement): void {
    input.focus();
  }

  // Column count for the rendered table. Use the widest row so
  // ragged inputs (rows with fewer fields than the header) still
  // get padded blank cells the user can click into.
  const colCount = $derived(maxRowWidth(rows));
  /// First row is treated as the header; remaining rows are the
  /// body. Empty file -> single empty row so the user has
  /// something to click into rather than an empty viewport.
  const header = $derived<string[]>(rows.length > 0 ? rows[0] : [""]);
  const body = $derived<string[][]>(rows.length > 1 ? rows.slice(1) : []);
</script>

<div class="csv-table" bind:this={tableEl}>
  {#if rows.length === 0}
    <div class="empty-hint">
      Empty file. Flip to Source mode to add rows.
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          {#each Array.from({ length: colCount }) as _, c (c)}
            {@const cell = header[c] ?? ""}
            {#if editing && editing.row === 0 && editing.col === c}
              <th>
                <input
                  type="text"
                  bind:value={draft}
                  onblur={commitEdit}
                  onkeydown={onKeydown}
                  use:focusOnMount
                />
              </th>
            {:else}
              <th>
                <button
                  type="button"
                  class="cell"
                  data-cell={`${0}:${c}`}
                  disabled={readonly}
                  onclick={() => startEdit(0, c, cell)}
                >{cell || " "}</button>
              </th>
            {/if}
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each body as row, ri (ri)}
          {@const realRow = ri + 1}
          <tr>
            {#each Array.from({ length: colCount }) as _, c (c)}
              {@const cell = row[c] ?? ""}
              {#if editing && editing.row === realRow && editing.col === c}
                <td>
                  <input
                    type="text"
                    bind:value={draft}
                    onblur={commitEdit}
                    onkeydown={onKeydown}
                    use:focusOnMount
                  />
                </td>
              {:else}
                <td>
                  <button
                    type="button"
                    class="cell"
                    data-cell={`${realRow}:${c}`}
                    disabled={readonly}
                    onclick={() => startEdit(realRow, c, cell)}
                  >{cell || " "}</button>
                </td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .csv-table {
    flex: 1;
    min-height: 0;
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    background: var(--bg);
    padding: 12px;
  }
  .empty-hint {
    color: var(--text-secondary);
    font-style: italic;
    padding: 12px;
  }
  table {
    border-collapse: collapse;
    font-family: var(--chan-editor-code-family, ui-monospace, SFMono-Regular, monospace);
    font-size: 13.5px;
    color: var(--text);
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--bg-card);
    color: var(--text-heading);
    font-weight: 600;
    text-align: left;
    border-bottom: 2px solid var(--border);
    z-index: 1;
  }
  th,
  td {
    border: 1px solid var(--border);
    padding: 6px 10px;
    min-width: 80px;
    max-width: 360px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: cell;
  }
  /* Zebra striping. Same shade the file tree uses for its
     alternating rows so the two surfaces speak the same visual
     dialect. */
  /* A cell's text is a button, so the cell is a tab stop that opens its
     edit. The button fills the cell and carries its padding, ellipsis and
     cursor, so a click anywhere in the cell reaches it. */
  th:has(> .cell),
  td:has(> .cell) {
    padding: 0;
  }
  .cell {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: cell;
  }
  .cell:disabled {
    cursor: default;
  }
  .cell:focus-visible {
    outline: 2px solid var(--pane-focus, var(--accent));
    outline-offset: -2px;
  }
  tbody tr:nth-child(odd) td {
    background: var(--zebra-bg);
  }
  tbody tr:hover td {
    background: var(--hover-bg);
  }
  th input,
  td input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: 2px;
    padding: 4px 6px;
    font: inherit;
  }
  th input:focus,
  td input:focus {
    outline: 2px solid var(--pane-focus, var(--accent));
    outline-offset: -1px;
  }
</style>
