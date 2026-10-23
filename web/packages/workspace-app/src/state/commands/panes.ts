// Each focus-border colour pick shares the pane menu's apply path: the
// document-root colour applies immediately. Once the app's initial load has
// finished, the store writes the chosen preset into the reload address and
// queues the session save. The border reads `--pane-highlight-color` before
// the selected preset, so both change.
// The other Panes commands live in core.ts.

import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { registerCommands, type Command } from "../commands";
import { applyNamedFocusColor } from "../paneColor";
import { chooseWindowFocusColor } from "../store.svelte";
import type { FocusColor } from "../tabs.svelte";

function focusColor(color: FocusColor): Command {
  return {
    id: `app.pane.focusColor.${color}`,
    title: `Focus border: ${color}`,
    category: "Panes",
    requirement: "any",
    keywords: ["focus", "border", "colour", "color", "pane"],
    available: () => true,
    run: () =>
      applyNamedFocusColor(color, chooseWindowFocusColor, (hex) => {
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
