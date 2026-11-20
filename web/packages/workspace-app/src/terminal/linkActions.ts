import { api, sessionWindowId } from "../api/client";
import { ApiError, errorText } from "../api/errors";
import { filesContext, wirePathFromAbsolute } from "../state/fileContext.svelte";
import { setTransientStatus } from "../state/store.svelte";
import { openBrowserInActivePane, openInActivePane } from "../state/tabs.svelte";
import { windowCaps } from "../state/windowCaps";

// The terminal link menu's "Open in editor", by what the window can open.
// A workspace window opens through `POST /api/open` in its must-exist mode:
// `cs open` semantics (a directory opens the file browser, text the editor, a
// path outside the workspace routes to the window that serves it) except
// that a missing file is refused, not created. A standalone terminal window
// mounts no `/api/open`; one that browses the server's files opens the path
// through its own file surface, after the same existence check. A window
// with no files opens nothing.

const NOT_FOUND = "not found";

/// Why this window cannot open a file link at all, or null when it can.
export function editorRefusalForWindow(): string | null {
  return windowCaps.workspace || windowCaps.files ? null : "this window opens no files";
}

/// Open the absolute `path` in this window as `cs open` would, refusing a
/// missing one. Resolves to the reason it was refused, or null once the open
/// is on its way.
export async function openTerminalFileInEditor(path: string): Promise<string | null> {
  const refusal = editorRefusalForWindow();
  if (refusal) return refusal;
  if (windowCaps.workspace) {
    try {
      const result = await api.open({ window_id: sessionWindowId(), target: path, must_exist: true });
      if (result.window !== undefined) setTransientStatus(result.message);
      return null;
    } catch (err) {
      return err instanceof ApiError && err.status === 404 ? NOT_FOUND : errorText(err);
    }
  }
  const context = filesContext.current;
  const wire = context ? wirePathFromAbsolute(context, path.replace(/\\/g, "/")) : null;
  if (wire === null) return "outside the files this window opens";
  if (wire === "") {
    openBrowserInActivePane({ select: "" });
    return null;
  }
  const slash = wire.lastIndexOf("/");
  const parent = slash < 0 ? "" : wire.slice(0, slash);
  const name = wire.slice(slash + 1);
  let entries;
  try {
    entries = await api.list(parent);
  } catch (err) {
    return err instanceof ApiError && err.status === 404 ? NOT_FOUND : errorText(err);
  }
  const entry = entries.find((candidate) => candidate.path.split("/").pop() === name);
  if (!entry) return NOT_FOUND;
  if (entry.is_dir) openBrowserInActivePane({ select: wire });
  else await openInActivePane(wire);
  return null;
}

let hostName: Promise<string | null> | null = null;

/// The host name of the machine the terminal runs on, read once from the
/// server's identity; null when the server does not say. A failed read is
/// asked again at the next link.
export function serverHostName(): Promise<string | null> {
  hostName ??= api.metricsIdentity().then(
    (view) => view.identity.hostname ?? null,
    () => {
      hostName = null;
      return null;
    },
  );
  return hostName;
}
