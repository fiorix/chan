<script lang="ts">
  // Hybrid Nav cheatsheet. Shown while `h` is toggled inside Hybrid
  // NAV (entered via `Cmd+.`). Each key-cap is a clickable <button>
  // in addition to the visible label, so the cheatsheet doubles as a
  // mouse-driveable command palette. Clicks dispatch a synthetic
  // KeyboardEvent on the document; App.svelte's onWindowKey listener
  // picks it up and routes through the same `handlePaneModeKey`
  // dispatcher that handles real keystrokes, so keystroke and click
  // are two trigger surfaces over one switch.
  //
  // Visual style: small, dense, TUI-density. Not an OverlayShell, to
  // keep the focus / Escape semantics inside App.svelte; this is
  // purely a passive informational panel.

  import { windowCaps } from "../state/windowCaps";

  type Cap = {
    /// Visible label on the kbd-shaped button (e.g. "↑", "W", "Tab").
    label: string;
    /// Dispatch key - matches `KeyboardEvent.key`. `undefined` means
    /// the cap is descriptive only (no action; renders as inert kbd).
    /// Used for compound descriptors like "Shift + [ ] - =" that
    /// can't be fired by a single click.
    key?: string;
    /// Optional aria-label override; defaults to "`label`: `action`".
    aria?: string;
  };
  /// The capability a row's action needs, matching the guard on the
  /// corresponding case in App.svelte's handlePaneModeKey. A row whose
  /// capability this window lacks is not rendered: every cap here is a
  /// clickable button, so an unfiltered row is an action the user can focus,
  /// hear announced, and press for nothing.
  type Needs = "files" | "drafts" | "workspace";
  type Row = {
    caps: Cap[];
    action: string;
    needs?: Needs;
  };
  type Group = { title: string; rows: Row[]; needs?: Needs };

  function dispatchKey(key: string): void {
    // Synthetic KeyboardEvents are routed through the same document-
    // level keydown listener (`App.svelte:onWindowKey`) that handles
    // real keystrokes. `isTrusted` is false on synthetic events, but
    // the pane-mode dispatcher doesn't inspect that flag.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }

  const ALL_GROUPS: Group[] = [
    {
      title: "Move",
      rows: [
        {
          caps: [
            { label: "↑", key: "ArrowUp" },
            { label: "←", key: "ArrowLeft" },
            { label: "↓", key: "ArrowDown" },
            { label: "→", key: "ArrowRight" },
          ],
          action: "Move focus",
        },
        {
          caps: [
            { label: "W", key: "w" },
            { label: "A", key: "a" },
            // `s` / `S` both map to swap-down (Search is on `f`, see
            // Spawn section), so cap dispatch matches the W / A / D
            // lowercase-key pattern with no case-split.
            { label: "S", key: "s" },
            { label: "D", key: "d" },
          ],
          action: "Swap tile with neighbour",
        },
      ],
    },
    {
      // Spawn chords STAGE additions into the draft layout.
      // Multiple presses stack: three T's queue three terminals on
      // the focused pane. Enter materializes; Esc discards.
      title: "Stage (Enter to commit, Esc to discard)",
      rows: [
        { caps: [{ label: "t", key: "t" }], action: "Stage Terminal" },
        { caps: [{ label: "o", key: "o" }], action: "Stage File Browser", needs: "files" },
        { caps: [{ label: "g", key: "g" }], action: "Stage Graph", needs: "workspace" },
        { caps: [{ label: "b", key: "b" }], action: "Stage Dashboard", needs: "workspace" },
        { caps: [{ label: "n", key: "n" }], action: "Stage New Draft", needs: "drafts" },
        { caps: [{ label: "i", key: "i" }], action: "Stage Diagram", needs: "drafts" },
      ],
    },
    {
      title: "Split",
      rows: [
        { caps: [{ label: "/", key: "/" }], action: "Split right" },
        { caps: [{ label: "?", key: "?" }], action: "Split down" },
      ],
    },
    {
      // Arrow direction is opposite to the dock side it toggles:
      // `<` opens the dock on the right, `>` opens the dock on the
      // left.
      title: "Dock",
      needs: "files",
      rows: [
        { caps: [{ label: "<", key: "<" }], action: "Toggle right-side file browser dock" },
        { caps: [{ label: ">", key: ">" }], action: "Toggle left-side file browser dock" },
      ],
    },
    {
      // `[` / `]` shift the divider in the direction the bracket
      // points (regardless of which side of the split the focused
      // pane sits on). `-` / `=` mirror it on the vertical axis.
      title: "Resize",
      rows: [
        {
          caps: [
            { label: "[", key: "[" },
            { label: "]", key: "]" },
          ],
          action: "Move divider left / right",
        },
        {
          caps: [
            { label: "-", key: "-" },
            { label: "=", key: "=" },
          ],
          action: "Move divider up / down",
        },
        {
          // Shift modifier can't be expressed as a single key click;
          // leave this row descriptive-only so the user still sees
          // the "larger nudge" affordance documented but can't
          // mis-fire it from the mouse.
          caps: [{ label: "Shift + [ ] - =" }],
          action: "Larger nudge",
        },
        { caps: [{ label: "0", key: "0" }], action: "Equalize siblings" },
      ],
    },
    {
      title: "Commit",
      rows: [
        { caps: [{ label: "Enter", key: "Enter" }], action: "Commit draft" },
        { caps: [{ label: "Esc", key: "Escape" }], action: "Discard draft" },
        { caps: [{ label: "h", key: "h" }], action: "Toggle this help" },
        { caps: [{ label: "Tab", key: "Tab" }], action: "Flip side" },
      ],
    },
  ];

  /// Whether this window can run an action needing `needs`. Undefined means
  /// the action works anywhere (focus, splits, resize).
  function have(needs?: Needs): boolean {
    switch (needs) {
      case undefined:
        return true;
      case "files":
        return windowCaps.files;
      case "drafts":
        return windowCaps.drafts;
      case "workspace":
        return windowCaps.workspace;
    }
  }

  // Each window sees the keys it can actually run. Pure derived - no $state
  // mutation - and empty groups drop out entirely (Dock, in a window with no
  // filesystem).
  const groups = $derived(
    ALL_GROUPS.filter((g) => have(g.needs))
      .map((g) => ({ ...g, rows: g.rows.filter((r) => have(r.needs)) }))
      .filter((g) => g.rows.length > 0),
  );

  function rowKey(row: Row): string {
    return row.caps.map((c) => c.label).join(" ");
  }

  function capAria(cap: Cap, action: string): string {
    return cap.aria ?? `${cap.label}: ${action}`;
  }
</script>

<div class="pane-mode-help" aria-label="Hybrid Nav help" role="dialog">
  <div class="title">Hybrid Nav (Cmd+.)</div>
  <div class="grid">
    {#each groups as g (g.title)}
      <section class="group">
        <h4>{g.title}</h4>
        <dl>
          {#each g.rows as row (rowKey(row))}
            <dt>
              {#each row.caps as cap (cap.label)}
                {#if cap.key !== undefined}
                  <button
                    type="button"
                    class="kbd kbd-button"
                    aria-label={capAria(cap, row.action)}
                    onclick={() => dispatchKey(cap.key!)}
                  >{cap.label}</button>
                {:else}
                  <kbd>{cap.label}</kbd>
                {/if}
              {/each}
            </dt>
            <dd>{row.action}</dd>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
  <div class="hint">Press <kbd>h</kbd> or <kbd>Esc</kbd> to dismiss</div>
</div>

<style>
  /* easeOutBack bubble-pop matching the rest of the chrome
     (OverlayShell, HamburgerMenu, tab-menu bubbles). The
     transform-origin stays on the centre so the centred panel scales
     out of its own midpoint rather than pivoting on a corner. */
  .pane-mode-help {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 26010;
    max-width: min(960px, 92vw);
    max-height: 80vh;
    overflow: auto;
    padding: 14px 18px 12px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
    font-size: 13px;
    pointer-events: auto;
    transform-origin: center;
    animation: pane-mode-help-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes pane-mode-help-pop {
    0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
    100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .pane-mode-help { animation: none; }
  }
  .title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 10px;
    letter-spacing: 0.02em;
    color: var(--text);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px 24px;
  }
  .group h4 {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 10px;
    row-gap: 2px;
    align-items: baseline;
  }
  dt {
    margin: 0;
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  dd {
    margin: 0;
    color: var(--text);
  }
  kbd, .kbd {
    display: inline-block;
    padding: 1px 6px;
    font: 11px/1.5 var(--chan-editor-code-family, ui-monospace, monospace);
    color: var(--text);
    background: var(--bg-card, var(--bg));
    border: 1px solid var(--border);
    border-radius: 3px;
    white-space: nowrap;
  }
  .kbd-button {
    /* Button reset against the inherited form styles + cursor for
       affordance. Hover paints with the same accent the focus-border
       toggle uses, so the cheatsheet's clickability is consistent
       with the rest of the chrome chrome. */
    cursor: pointer;
    transition: background-color 0.12s ease, border-color 0.12s ease,
      color 0.12s ease;
  }
  .kbd-button:hover {
    background: var(--hover-bg);
    border-color: var(--link);
    color: var(--text);
  }
  .kbd-button:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
  }
  .hint {
    margin-top: 10px;
    font-size: 11px;
    color: var(--text-secondary);
  }
</style>
