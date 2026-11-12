// The window's focus border colour and the focused pane's dividers.
//
// Focus border colour is one choice over the window's presets, and the pane
// menu's colour rows are its options: the document-root colour applies
// immediately. Once the app's initial load has finished, the store writes
// the chosen preset into the reload address and queues the session save. The
// border reads `--pane-highlight-color` before the selected preset, so both
// change. The colour is the whole window's, so the command is listed with
// the window.
//
// The divider commands are Hybrid Nav's resize keys outside the mode: each
// moves the divider of the nearest split that holds the focused pane along
// its axis, by the mode's step and within its bounds, and Equalize panes
// halves the pane's own split. They change the live layout at once, where
// the keys stage the move in the mode's draft. A tmux window's layout is
// tmux's, which Hybrid Nav and a divider drag ask through tmux, so the
// commands are not offered there. The rest of the Pane scope lives in
// core.ts.

import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { openChoice, registerCommands, type Command } from "../commands";
import { applyNamedFocusColor } from "../paneColor";
import {
  chooseWindowFocusColor,
  schedulePersistStateToHash,
  scheduleSessionSave,
} from "../store.svelte";
import {
  equalizePane,
  focusColorForWindow,
  layout,
  tmuxPaneTabs,
  type FocusColor,
  type SplitNode,
} from "../tabs.svelte";

const FOCUS_COLORS: readonly FocusColor[] = ["blue", "orange", "green", "pink", "grey"];

function applyFocusColor(color: FocusColor): void {
  applyNamedFocusColor(color, chooseWindowFocusColor, (hex) => {
    // Best-effort persist: a read-only / no-store surface answers 403/404.
    // Log the status, never throw, so a failed persist on a surface that
    // does have a store is visible and the menu and the launcher carry on.
    void api.setLocalColor(hex).catch((err: unknown) => {
      const status = err instanceof ApiError ? err.status : "?";
      console.warn(`setLocalColor failed (status ${status}); colour not persisted`, err);
    });
  });
}

type Axis = SplitNode["direction"];

/// The share of a split one divider command moves its divider by, and the
/// share a pane keeps at either end: Hybrid Nav's resize step and bounds.
const DIVIDER_STEP = 0.02;
const DIVIDER_MIN = 0.05;
const DIVIDER_MAX = 0.95;

function parentSplit(childId: string): SplitNode | null {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind === "split" && (node.a === childId || node.b === childId)) return node;
  }
  return null;
}

/// The split whose divider the focused pane's commands move along `axis`:
/// the nearest one that holds the pane and is laid out on that axis.
function dividerSplit(axis: Axis): SplitNode | null {
  let split = parentSplit(layout.activePaneId);
  while (split && split.direction !== axis) split = parentSplit(split.id);
  return split;
}

/// Whether tmux lays this window's panes out.
function tmuxOwnsLayout(): boolean {
  return tmuxPaneTabs().length > 0;
}

/// A divider drag saves the layout itself, since the layout's own save
/// follows the panes and not a split's share. So does a command.
function saveLayout(): void {
  schedulePersistStateToHash();
  scheduleSessionSave();
}

/// Move the focused pane's divider along `axis`: toward the right or the
/// bottom when `forward`, toward the left or the top otherwise.
function moveDivider(axis: Axis, forward: boolean): void {
  if (tmuxOwnsLayout()) return;
  const split = dividerSplit(axis);
  if (!split) return;
  const moved = split.ratio + (forward ? DIVIDER_STEP : -DIVIDER_STEP);
  split.ratio = Math.max(DIVIDER_MIN, Math.min(DIVIDER_MAX, moved));
  saveLayout();
}

function equalizePanes(): void {
  if (tmuxOwnsLayout() || !parentSplit(layout.activePaneId)) return;
  equalizePane(layout.activePaneId);
  saveLayout();
}

const TMUX_REASON = "Not available in a tmux window";

function dividerCommand(spec: {
  id: string;
  title: string;
  order: number;
  axis: Axis;
  forward: boolean;
  keywords: readonly string[];
}): Command {
  const { axis, forward } = spec;
  return {
    id: spec.id,
    title: spec.title,
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: spec.order,
    requirement: "any",
    keywords: [...spec.keywords, "resize", "divider", "split", "size"],
    available: () => !tmuxOwnsLayout() && dividerSplit(axis) !== null,
    unavailableReason: () =>
      tmuxOwnsLayout()
        ? TMUX_REASON
        : axis === "row"
          ? "Needs a pane to the left or the right"
          : "Needs a pane above or below",
    // The share of the split left of or above the divider. Reporting it keeps
    // the launcher open on the row, so the divider moves a step per Enter.
    state: () => {
      const split = dividerSplit(axis);
      return split ? `${Math.round(split.ratio * 100)}%` : null;
    },
    run: () => moveDivider(axis, forward),
  };
}

registerCommands([
  {
    id: "app.pane.focusColor",
    title: "Focus border colour",
    category: "Panes",
    scope: "window",
    order: 10,
    kind: "choice",
    requirement: "any",
    keywords: ["Focus border", "focus", "border", "color", "pane"],
    available: () => true,
    state: () => focusColorForWindow(),
    options: () =>
      FOCUS_COLORS.map((color) => ({
        id: color,
        label: color,
        checked: focusColorForWindow() === color,
        run: () => applyFocusColor(color),
      })),
    run: () => openChoice("app.pane.focusColor"),
  },
  dividerCommand({
    id: "app.pane.dividerLeft",
    title: "Move divider left",
    order: 5,
    axis: "row",
    forward: false,
    keywords: ["Move divider left / right", "narrower", "wider"],
  }),
  dividerCommand({
    id: "app.pane.dividerRight",
    title: "Move divider right",
    order: 6,
    axis: "row",
    forward: true,
    keywords: ["Move divider left / right", "narrower", "wider"],
  }),
  dividerCommand({
    id: "app.pane.dividerUp",
    title: "Move divider up",
    order: 7,
    axis: "column",
    forward: false,
    keywords: ["Move divider up / down", "shorter", "taller"],
  }),
  dividerCommand({
    id: "app.pane.dividerDown",
    title: "Move divider down",
    order: 8,
    axis: "column",
    forward: true,
    keywords: ["Move divider up / down", "shorter", "taller"],
  }),
  {
    id: "app.pane.equalize",
    title: "Equalize panes",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 9,
    requirement: "any",
    keywords: ["Equalize siblings", "resize", "divider", "split", "size", "even", "balance", "halves"],
    available: () => !tmuxOwnsLayout() && parentSplit(layout.activePaneId) !== null,
    unavailableReason: () => (tmuxOwnsLayout() ? TMUX_REASON : "Needs a split pane"),
    run: equalizePanes,
  },
]);
