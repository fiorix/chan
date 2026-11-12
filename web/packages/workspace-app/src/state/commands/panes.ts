// Focus border colour: one choice over the window's presets. An option
// shares the pane menu's apply path: the document-root colour applies
// immediately. Once the app's initial load has finished, the store writes
// the chosen preset into the reload address and queues the session save. The
// border reads `--pane-highlight-color` before the selected preset, so both
// change. The colour is the whole window's, so the command is listed with
// the window. The Pane scope's own commands live in core.ts.

import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { openChoice, registerCommands } from "../commands";
import { applyNamedFocusColor } from "../paneColor";
import { chooseWindowFocusColor } from "../store.svelte";
import { focusColorForWindow, type FocusColor } from "../tabs.svelte";

const FOCUS_COLORS: readonly FocusColor[] = ["blue", "orange", "green", "pink", "grey"];

function applyFocusColor(color: FocusColor): void {
  applyNamedFocusColor(color, chooseWindowFocusColor, (hex) => {
    // Best-effort persist, mirroring the pane menu: a read-only /
    // no-store surface answers 403/404; log, never throw.
    void api.setLocalColor(hex).catch((err: unknown) => {
      const status = err instanceof ApiError ? err.status : "?";
      console.warn(`setLocalColor failed (status ${status}); colour not persisted`, err);
    });
  });
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
]);
