// Window capabilities: what this window can do, from the `?kind=` URL
// marker and the serving tenant's own advertisement.
//
// The SPA is one bundle for every window. `?kind=` says which window family
// opened it (set by the desktop shell / launcher), and the tenant that served
// the shell says whether it mounted a filesystem surface
// (`<meta name="chan-files">`) and a per-library draft store
// (`<meta name="chan-drafts">`). This leaf module projects those onto the
// capability set the rest of the app gates on, so a guard names the
// capability it actually protects instead of re-deriving mode strings:
//
//   mode       workspace  files      drafts        terminal  terminalOnly  control
//   ---------  ---------  ---------  ------------  --------  ------------  -------
//   workspace  yes        yes        yes           yes       no            no
//   terminal   no         tenant     tenant+files  yes       when no files no
//   control    no         no         no            yes       yes           yes
//
// A standalone terminal window is the whole point of the `tenant` cell: the
// same window that holds shells also browses and edits the server's
// filesystem, with no workspace behind it -- but only where the tenant could
// mount that surface (a host with no usable home directory serves terminals
// alone, and then the window is exactly the terminal window it always was).
//
// A control terminal never gets it: it is the singleton window running a
// devserver's connect script, and one PTY is all it is for.
//
// `terminalOnly` therefore means "terminals and nothing else" (the
// close-when-empty rule, the Control chrome rules, the narrow command set),
// which a files-capable standalone window is not.

export type WindowMode = "workspace" | "terminal" | "control";

export interface WindowCaps {
  readonly workspace: boolean;
  readonly files: boolean;
  /// Whether this window can create and manage drafts: always in a
  /// workspace window (drafts ride the workspace tenant), and in a
  /// standalone window only when the tenant advertised its per-library
  /// draft store. A separate bit from `files` because the store can fail
  /// to construct while the file surface works.
  readonly drafts: boolean;
  readonly terminal: boolean;
}

/// Project a raw `?kind=` value onto the window mode. Pure so tests drive
/// the whole table without a location stub.
///
/// No marker at all is a workspace window: the launcher omits `?kind=` for
/// workspace rows, so absence is that window's spelling. A marker this build
/// does not know is the opposite case -- a URL from some other build -- and
/// falls to the NARROWEST mode, because booting the workspace SPA against a
/// tenant that serves no workspace fails on its first fetch.
export function windowModeFromKind(kind: string | null): WindowMode {
  switch (kind) {
    case null:
    case "":
      return "workspace";
    case "control":
      return "control";
    default:
      return "terminal";
  }
}

/// The capability set of a window mode; see the module table. `tenantFiles`
/// and `tenantDrafts` are the serving tenant's answers, and are consulted
/// for a standalone terminal window only: a workspace window's file surface
/// and drafts are its workspace's, and a control terminal deliberately has
/// neither. Drafts are additionally ANDed with files because a draft is
/// edited over the file surface; a drafts tag without the files tag would
/// advertise an unusable capability.
export function capsForMode(
  mode: WindowMode,
  tenantFiles: boolean,
  tenantDrafts: boolean,
): WindowCaps {
  switch (mode) {
    case "workspace":
      return { workspace: true, files: true, drafts: true, terminal: true };
    case "terminal":
      return {
        workspace: false,
        files: tenantFiles,
        drafts: tenantFiles && tenantDrafts,
        terminal: true,
      };
    case "control":
      return { workspace: false, files: false, drafts: false, terminal: true };
  }
}

function currentKind(): string | null {
  try {
    return new URLSearchParams(location.search).get("kind");
  } catch {
    return null;
  }
}

/// Whether the tenant that served this shell mounted a filesystem surface.
/// Read from the meta tag chan-server injects, so the answer is in the
/// document before any module runs -- no probe, no boot race.
export function tenantServesFiles(): boolean {
  try {
    return document.querySelector('meta[name="chan-files"]') !== null;
  } catch {
    return false;
  }
}

/// Whether the tenant that served this shell mounted the per-library
/// draft store. Same channel and same timing discipline as
/// `tenantServesFiles`.
export function tenantServesDrafts(): boolean {
  try {
    return document.querySelector('meta[name="chan-drafts"]') !== null;
  } catch {
    return false;
  }
}

/// This window's mode, read once at module load so it is stable before any
/// component mounts (same discipline as the terminal-only flags).
export const windowMode: WindowMode = windowModeFromKind(currentKind());

/// This window's capabilities, fixed for the page's lifetime -- frozen, so a
/// runtime downgrade cannot half-apply here: components read these fields from
/// plain (non-reactive) markup, and a mutation would change what guards decide
/// without changing what is rendered.
export const windowCaps: WindowCaps = Object.freeze(
  capsForMode(windowMode, tenantServesFiles(), tenantServesDrafts()),
);
