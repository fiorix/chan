// Pure per-path action applicability shared by the inspector
// (FileInfoBody) and the file browser context menu (FileTree).
// One policy, two renderers: each surface maps the returned action
// identifiers to its own handlers and labels, so applicability can
// never drift between the inspector pill/dropdown and the right-click
// menu. Destructive and path-mutation rows (Copy Path, Rename / Move,
// Delete) are NOT actions in this model; they belong to FileTree's
// separate policy and confirmation flow, and this module never emits
// them.

import type { TreeEntry } from "../api/types";
import { isAudio, isImage, isMarkdown, isPdf, isVideo } from "./fileTypes";
import { classifyFile, isOpenableTextKind } from "./kinds";

/// Non-destructive action identifiers, in the canonical order surfaces
/// present them. `main` is always the first applicable action for the
/// category; `secondary` keeps the dropdown / menu order.
export type FileActionId =
  /// Open the file in the editor, or enter the directory in a file
  /// browser (the inspector's directory "Open" routes the same way).
  | "open"
  /// Reveal the entry in a file browser (inspector: "Show file";
  /// tree: "Open in File Browser").
  | "showFile"
  /// View an image (zoom), video, audio, or PDF in its viewer.
  | "viewMedia"
  | "download"
  | "upload"
  | "newTerminal"
  | "exportPdf"
  | "graphFromHere";

/// Facts about the path the policy reads. Callers that hold a tree
/// entry pass its server-projected content kind so an odd-suffix
/// plaintext file classifies as editable (matching the tree's
/// double-click, which peeks content); callers without one fall back
/// to path classification.
export type FileActionFacts = {
  path: string;
  isDir: boolean;
  serverKind?: TreeEntry["kind"];
  /// The drafts directory itself or a draft file under it: uncommitted
  /// scratch space where only a terminal action is meaningful.
  isDraft: boolean;
};

/// Handler availability on the calling surface. An action whose
/// handler the surface cannot bind drops out of the result instead of
/// rendering a dead row.
export type FileActionCapabilities = {
  /// Host can open a file in the editor (inspector onOpen). Directory
  /// open is always available on both surfaces and ignores this flag.
  open?: boolean;
  /// Host can reveal the entry in a file browser (inspector onReveal).
  reveal?: boolean;
  /// Host can graph from the entry (inspector onSetAsScope; the tree
  /// always can).
  graph?: boolean;
  /// Uploads allowed on this surface (inspector allowUpload).
  upload?: boolean;
};

export type FileActionSet = {
  main: FileActionId;
  secondary: FileActionId[];
};

/// Media kind for label selection, or null for non-media. Images and
/// PDFs share the wire `media` kind; video and audio arrive as
/// sniffed `binary`, so all four discriminate by path.
export type FileMediaKind = "image" | "pdf" | "video" | "audio";

export function fileMediaKind(path: string): FileMediaKind | null {
  if (isImage(path)) return "image";
  if (isPdf(path)) return "pdf";
  if (isVideo(path)) return "video";
  if (isAudio(path)) return "audio";
  return null;
}

/// The applicable non-destructive actions for a path, main first.
/// Category rules:
///   - draft: only a terminal action (scratch space).
///   - directory: open, then upload / download / terminal / graph.
///   - media: view, then download / terminal / graph.
///   - editable text (markdown, diagrams, slide decks, source):
///     open or show or download, then download / terminal /
///     export-to-PDF (markdown only) / graph.
///   - binary (including symlinks): download, then graph.
/// `main` never repeats inside `secondary`.
export function classifyFileActions(
  facts: FileActionFacts,
  caps: FileActionCapabilities,
): FileActionSet {
  if (facts.isDraft) {
    return { main: "newTerminal", secondary: [] };
  }

  const graph: FileActionId[] = caps.graph ? ["graphFromHere"] : [];

  if (facts.isDir) {
    const secondary: FileActionId[] = [];
    if (caps.upload) secondary.push("upload");
    secondary.push("download", "newTerminal", ...graph);
    return { main: "open", secondary };
  }

  if (fileMediaKind(facts.path) !== null) {
    return {
      main: "viewMedia",
      secondary: ["download", "newTerminal", ...graph],
    };
  }

  if (isOpenableTextKind(classifyFile(facts.path, facts.serverKind))) {
    let main: FileActionId;
    if (caps.open) main = "open";
    else if (caps.reveal) main = "showFile";
    else main = "download";
    const secondary: FileActionId[] = [];
    if (caps.open && caps.reveal) secondary.push("showFile");
    secondary.push("download", "newTerminal");
    if (isMarkdown(facts.path)) secondary.push("exportPdf");
    secondary.push(...graph);
    return { main, secondary: secondary.filter((id) => id !== main) };
  }

  return { main: "download", secondary: [...graph] };
}
