/// A theme switch on a live ghostty terminal.
///
/// WHY: ghostty-web takes its colors once, in `open()`: it turns the theme
/// into the core's config and hands the renderer a copy, and assigning
/// `options.theme` later only logs that theme changes after open are not
/// supported. chan's binding can take new colors in the live core
/// (`VtTerminal.setColors`), and the renderer's `setTheme` swaps the
/// colors it fills rows, the cursor and the selection with. Together they
/// repaint the terminal on its next frame without rebuilding it, so the
/// session, the screen and scrollback, the selection, the scroll position
/// and focus stay as they were.

import type { ITheme, Terminal } from "ghostty-web";
import { VtTerminal, type VtTerminalConfig } from "./ghosttyVt";

/// The widget's private builder of the core's config from
/// `options.theme`, the one `open()` and `reset()` call, so a switch
/// converts each color exactly as a newly opened terminal would.
type ConfigBuilder = { buildWasmConfig?: () => VtTerminalConfig | undefined };

/// Switches `term` to `theme`. False when the terminal is not open or the
/// pinned widget lacks a hook the switch needs; the theme is then still
/// what `open()` and `reset()` will use.
export function applyGhosttyTheme(term: Terminal, theme: ITheme): boolean {
  holdTheme(term.options, theme);
  // ghostty-web types its core as its own class; chan's binding is not one.
  const core: unknown = term.wasmTerm;
  const renderer = term.renderer;
  const build = (term as unknown as ConfigBuilder).buildWasmConfig;
  if (!(core instanceof VtTerminal) || !renderer || typeof build !== "function") return false;
  core.setColors(build.call(term));
  renderer.setTheme(theme);
  return true;
}

/// Makes the theme object the widget holds equal to `theme`. Assigning
/// `options.theme` goes through the widget's option proxy, which only
/// warns once the terminal is open; rewriting the object it holds keeps
/// what `reset()` rebuilds the core from current without that warning.
function holdTheme(options: { theme: ITheme }, theme: ITheme): void {
  const held = options.theme as Record<string, unknown> | undefined;
  if (!held) {
    options.theme = { ...theme };
    return;
  }
  for (const key of Object.keys(held)) {
    if (!(key in theme)) delete held[key];
  }
  Object.assign(held, theme);
}
