// Per-surface launcher capabilities, read once at boot from the index <meta>
// tags the server injects.
//
// The server emits `<meta name="chan-launcher-surface">` with one of three
// values, which splits into three independent capabilities the launcher gates
// on. The three surfaces are the only valid combos (illegal combos are
// unrepresentable):
//
//   desktop    a loopback with a desktop window bridge: full registry mutation
//              and native focus/hide/connect ops.
//   devserver  a bridgeless local loopback (the browser-leader surface): full
//              registry mutation, but windows are self-managed client-side
//              (window.open + the leader story) instead of a native bridge.
//   readonly   the tunnel-trust gateway surface: a grantee can't be told from
//              the owner, so the server 403s registry mutation and the SPA hides
//              the mutation controls behind a "manage elsewhere" hint.

export type LauncherSurface = "desktop" | "devserver" | "readonly";

export interface Capabilities {
  /** Registry mutation (add / on-off / remove workspaces + devservers). */
  canMutateRegistry: boolean;
  /** A desktop window bridge is attached (native focus / hide / connect). */
  hasDesktopBridge: boolean;
  /** Windows are managed client-side via window.open (the leader story), not a
   * native bridge. */
  selfManagedWindows: boolean;
}

/** The 3-row capability table. Exactly the three surfaces map to the three
 * valid capability combos. */
export function capabilitiesFor(surface: LauncherSurface): Capabilities {
  return {
    canMutateRegistry: surface !== "readonly",
    hasDesktopBridge: surface === "desktop",
    selfManagedWindows: surface === "devserver",
  };
}

/** Resolve the injected surface descriptor. Unknown or absent values default
 * to desktop, today's mutable-loopback default. */
export function parseSurface(surfaceMeta: string | null): LauncherSurface {
  if (surfaceMeta === "desktop" || surfaceMeta === "devserver" || surfaceMeta === "readonly") {
    return surfaceMeta;
  }
  return "desktop";
}

function readSurface(): LauncherSurface {
  if (typeof document === "undefined") return "desktop";
  const meta =
    document.querySelector('meta[name="chan-launcher-surface"]')?.getAttribute("content") ?? null;
  return parseSurface(meta);
}

export const surface: LauncherSurface = readSurface();

const caps = capabilitiesFor(surface);
export const canMutateRegistry = caps.canMutateRegistry;
export const hasDesktopBridge = caps.hasDesktopBridge;
export const selfManagedWindows = caps.selfManagedWindows;

/** The readonly (tunnel-trust) surface. Equivalent to `!canMutateRegistry`;
 * registry-mutation controls gate on this. */
export const readOnly = surface === "readonly";

// The launcher host's OS family, injected by the server as a <meta> tag so the
// LOCAL machine card shows the same OS icon as a remote devserver does. One of
// `macos | windows | linux | other`, or "" when the tag is absent (no icon).
export const hostOs =
  typeof document === "undefined"
    ? ""
    : (document
        .querySelector('meta[name="chan-launcher-host-os"]')
        ?.getAttribute("content") ?? "");
