// Net-new Panes commands: the focus-border colour picks (one flat row per
// colour). The reuse-existing Panes entries (splits, prev / next, close,
// flip) live in core.ts. Each pick runs the SAME applyNamedFocusColor path
// as the pane hamburger button: selection alone is not enough, because the
// focused-pane border prefers the `--pane-highlight-color` doc-root var,
// which masks a selection-only change whenever it is already set. Register
// with registerCommands. See state/commands.ts for the Command shape.

import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { registerCommands, type Command } from "../commands";
import { applyNamedFocusColor } from "../paneColor";
import { setWindowFocusColor, type FocusColor } from "../tabs.svelte";

function focusColor(color: FocusColor): Command {
  return {
    id: `app.pane.focusColor.${color}`,
    title: `Focus border: ${color}`,
    category: "Panes",
    requirement: "any",
    keywords: ["focus", "border", "colour", "color", "pane"],
    available: () => true,
    run: () =>
      applyNamedFocusColor(color, setWindowFocusColor, (hex) => {
        // Best-effort persist, mirroring the pane menu: a read-only /
        // no-store surface answers 403/404; log, never throw.
        void api.setLocalColor(hex).catch((err: unknown) => {
          const status = err instanceof ApiError ? err.status : "?";
          console.warn(`setLocalColor failed (status ${status}); colour not persisted`, err);
        });
      }),
  };
}

registerCommands([
  focusColor("blue"),
  focusColor("orange"),
  focusColor("green"),
  focusColor("pink"),
]);
