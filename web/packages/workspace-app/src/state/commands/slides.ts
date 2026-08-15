// New slide deck command (Apps category): creates a slides-seeded draft
// through the create-draft endpoint's `kind` body and opens it in the
// active pane, mirroring New diagram (createDiagramAndOpen). The seed's
// `chan: kind: slides` frontmatter routes the editor straight into the
// slides layout, and the caret lands at the end of the seed's "# Slide 1"
// heading so the deck is ready to type. Availability follows the
// workspace gate. See state/commands.ts for the Command shape and the
// workspaceOnly helper.

import { registerCommands, onSurface, workspaceOnly } from "../commands";
import { api } from "../../api/client";
import { firstSlideHeadingCaret } from "../../editor/slides";
import { editorCommandsFor } from "../mountedEditors";
import { noteDraftCreated, setTransientStatus } from "../store.svelte";
import {
  activeFileTab,
  activeTabInPane,
  issueCaretCommand,
  layout,
  openInActivePane,
} from "../tabs.svelte";

/// Land the caret at the end of the fresh deck's first heading line,
/// computed from the loaded document (never a hard-coded offset). Without
/// an explicit caret request the open falls back to the editor's
/// document-start default, which parks the caret inside the frontmatter
/// block, and the post-load saved-caret restore can land a stale per-path
/// offset when a deleted draft's untitled-N name is reused. Runs after
/// openInActivePane resolves so this command is the last caret intent and
/// wins over that restore.
function landCaretAtFirstHeading(path: string): void {
  const node = layout.nodes[layout.activePaneId];
  if (!node || node.kind !== "leaf") return;
  const tab = activeTabInPane(node);
  if (!tab || tab.kind !== "file" || tab.path !== path) return;
  const at = firstSlideHeadingCaret(tab.content);
  if (at === null) return;
  issueCaretCommand(tab, at, at);
}

/// Create a slides-seeded draft (a real, promotable draft) and open it
/// in the active pane with the caret at the end of "# Slide 1". Mirrors
/// createDiagramAndOpen: surface it in the tree and refresh
/// graph/workspace before opening. Exported so App.svelte's runCommand
/// can route the `app.slides.new` dispatch (pane hamburger Apps rows,
/// host bridge) through the same handler.
export async function createSlidesAndOpen(): Promise<void> {
  try {
    const { path } = await api.createDraft("slides");
    await noteDraftCreated(path);
    await openInActivePane(path);
    landCaretAtFirstHeading(path);
  } catch (err) {
    console.warn("[chan] createSlides failed", err);
    setTransientStatus(`New slide deck failed: ${(err as Error).message}`);
  }
}

registerCommands([
  {
    id: "app.slides.new",
    title: "New slide deck",
    category: "Apps",
    // Deck creation drafts through the workspace tenant, like New draft.
    requirement: "workspace",
    keywords: ["slides", "presentation", "deck", "present"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => {
      void createSlidesAndOpen();
    },
  },
  // The deck's two chords, rebindable. The run reaches the mounted
  // editor through the EditorCommands seam (the actions close over
  // FileEditorTab state); the members themselves no-op on a non-deck
  // buffer, mirroring the capture handler's slidesSpec gate. Chorded
  // dispatch routes through App.svelte's override path; the built-in
  // defaults stay claimed by FileEditorTab's capture handler.
  {
    id: "app.slides.preview",
    title: "Preview slide deck",
    category: "Editor",
    requirement: "files",
    keywords: ["slides", "preview", "deck", "presentation"],
    available: (ctx) => onSurface(ctx, "file"),
    run: () => {
      const tab = activeFileTab();
      if (tab) editorCommandsFor(tab.id)?.previewSlides();
    },
  },
  {
    id: "app.slides.present",
    title: "Present slide deck fullscreen",
    category: "Editor",
    requirement: "files",
    keywords: ["slides", "present", "deck", "fullscreen", "play"],
    available: (ctx) => onSurface(ctx, "file"),
    run: () => {
      const tab = activeFileTab();
      if (tab) editorCommandsFor(tab.id)?.playSlides();
    },
  },
]);
