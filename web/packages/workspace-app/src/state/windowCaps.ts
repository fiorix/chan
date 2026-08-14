// Window capabilities, derived once from the `?kind=` URL marker.
//
// The SPA is one bundle for every window; `?kind=` is the only mode signal
// (set by the desktop shell / launcher when it opens the window; there is no
// server bootstrap marker). This leaf module projects that marker onto the
// capability set the rest of the app gates on, so a guard names the
// capability it actually protects instead of re-deriving mode strings:
//
//   mode       workspace  files  terminal  terminalOnly  control
//   ---------  ---------  -----  --------  ------------  -------
//   workspace  yes        yes    yes       no            no
//   terminal   no         no     yes       yes           no
//   control    no         no     yes       yes           yes
//   files      no         yes    yes       no            no
//
// `terminalOnly` keeps its existing meaning (close-on-last-terminal, the
// Control chrome rules) and is deliberately NOT set for a Files window: a
// Files window outlives its terminals. An unknown kind falls back to the
// workspace mode, matching the historical fall-through.

export type WindowMode = "workspace" | "terminal" | "control" | "files";

export interface WindowCaps {
  workspace: boolean;
  files: boolean;
  terminal: boolean;
}

/// Project a raw `?kind=` value onto the window mode. Pure so tests drive
/// the whole table without a location stub.
export function windowModeFromKind(kind: string | null): WindowMode {
  switch (kind) {
    case "terminal":
      return "terminal";
    case "control":
      return "control";
    case "files":
      return "files";
    default:
      return "workspace";
  }
}

/// The capability set of a window mode; see the module table.
export function capsForMode(mode: WindowMode): WindowCaps {
  switch (mode) {
    case "workspace":
      return { workspace: true, files: true, terminal: true };
    case "terminal":
    case "control":
      return { workspace: false, files: false, terminal: true };
    case "files":
      return { workspace: false, files: true, terminal: true };
  }
}

function currentKind(): string | null {
  try {
    return new URLSearchParams(location.search).get("kind");
  } catch {
    return null;
  }
}

/// This window's mode, read once at module load so it is stable before any
/// component mounts (same discipline as the terminal-only flags).
export const windowMode: WindowMode = windowModeFromKind(currentKind());

/// This window's capabilities, fixed for the page's lifetime.
export const windowCaps: WindowCaps = capsForMode(windowMode);
