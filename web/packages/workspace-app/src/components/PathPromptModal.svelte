<script lang="ts">
  // Path-input modal for create / move / rename. Adds directory
  // autocomplete (from the loaded tree), live status row showing
  // what the typed path will do (move to existing directory, create a
  // new directory, overwrite, etc.), and pre-flight validation that
  // mirrors what chan-workspace will accept. Driven by pathPromptState
  // in the store; resolves the same Promise<string|null> shape as
  // uiPrompt.

  import { tick } from "svelte";
  import {
    loadTreeDir,
    pathPromptState,
    resolvePathPrompt,
    tree,
  } from "../state/store.svelte";
  import {
    DEFAULT_NEW_FILENAME_STEM,
    appendDefaultMd,
    preserveExtension,
    proposeDefaultFilename,
    validatePath,
  } from "../state/pathValidate";
  import { longestCommonPrefix } from "../state/lcp";
  import { GRAPH_LINK_PREFIX, parseGraphLink } from "../state/tabs.svelte";
  import type { PathPromptMode } from "../state/store.svelte";
  import ModalShell from "./ModalShell.svelte";

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state();
  /// Highlighted suggestion index. -1 means "no suggestion focused";
  /// Tab / ↓ moves into the list, ↑ moves back up to -1 so the
  /// raw input is what Enter submits. We don't auto-select the
  /// first match because that would disagree with the user's
  /// in-progress input on the very first keystroke.
  let highlightIdx = $state(-1);

  // Sync local state on every (re)open.
  $effect(() => {
    if (pathPromptState.open) {
      value = pathPromptState.defaultValue;
      highlightIdx = -1;
      void tick().then(() => {
        inputEl?.focus();
        if (
          pathPromptState.kind === "file" &&
          pathPromptState.mode === "create" &&
          pathPromptState.defaultValue.endsWith(`${DEFAULT_NEW_FILENAME_STEM}.md`)
        ) {
          // Select the whole filename (stem + `.md`), not just the
          // stem, so typing a name that includes the extension
          // replaces both rather than producing `foo.md.md`. The
          // directory prefix stays unselected so Tab-completed parents
          // survive a one-keystroke replace.
          const stemStart = pathPromptState.defaultValue.lastIndexOf("/") + 1;
          inputEl?.setSelectionRange(
            stemStart,
            pathPromptState.defaultValue.length,
          );
        } else if (
          pathPromptState.kind === "folder" &&
          pathPromptState.mode === "create"
        ) {
          // New Directory dialog opens with the pre-populated parent
          // path and the cursor at the end. The user types the new
          // directory NAME there; selecting the whole path would
          // force them to delete-all or arrow past the selection
          // first, so cursor-at-end matches the "ready to type"
          // mental model.
          const end = pathPromptState.defaultValue.length;
          inputEl?.setSelectionRange(end, end);
        } else if (
          pathPromptState.kind === "either" &&
          pathPromptState.mode === "create"
        ) {
          // Unified "New File or Directory" dialog. Open with the
          // cursor at end so typing a name appends to the parent
          // path. This matches the folder-flow mental model since the
          // user decides file-vs-dir from the trailing slash.
          const end = pathPromptState.defaultValue.length;
          inputEl?.setSelectionRange(end, end);
        } else {
          inputEl?.select();
        }
      });
    }
  });

  /// Effective path + the suffix we tacked on for the user (if
  /// any). We resolve the extension here so the status row can
  /// preview both the create-time `.md` auto-append and the
  /// rename-time extension preservation in italic - same visual
  /// language for both, which keeps the user from being surprised
  /// by store-side rewrites.
  /// When `kind === "either"`, the modal detects file vs directory
  /// from the trailing slash: `foo/bar/` → directory (no `.md`
  /// append); `foo/bar` → file (`.md` append on create). Mirrors the
  /// FB selection menu's "New File or Directory" entry; the helper is
  /// also exposed below as `detectedEitherKind` so the placeholder /
  /// status row can label the operation correctly.
  function isEitherDir(trimmed: string): boolean {
    return trimmed.endsWith("/");
  }
  const detectedEitherKind = $derived.by<"file" | "folder" | null>(() => {
    if (pathPromptState.kind !== "either") return null;
    return isEitherDir(value.trim()) ? "folder" : "file";
  });
  /// Effective kind: explicit `"file"` / `"folder"` from the
  /// state, or the trailing-slash detection from `either`.
  /// Used to gate the extension-append + the placeholder text.
  const effectiveKind = $derived.by<"file" | "folder">(() => {
    if (pathPromptState.kind === "either") {
      return detectedEitherKind ?? "file";
    }
    return pathPromptState.kind;
  });
  const resolved = $derived.by<{ path: string; autoSuffix: string }>(() => {
    const trimmed = value.trim();
    if (trimmed === "") return { path: "", autoSuffix: "" };
    if (effectiveKind !== "file") {
      return { path: trimmed, autoSuffix: "" };
    }
    let out = trimmed;
    if (pathPromptState.mode === "create") {
      out = appendDefaultMd(trimmed);
    } else if (pathPromptState.mode === "move" && pathPromptState.sourcePath) {
      out = preserveExtension(pathPromptState.sourcePath, trimmed);
    }
    const autoSuffix =
      out.length > trimmed.length && out.startsWith(trimmed)
        ? out.slice(trimmed.length)
        : "";
    return { path: out, autoSuffix };
  });
  const effectiveValue = $derived(resolved.path);
  const autoSuffix = $derived(resolved.autoSuffix);
  /// Effective value without a trailing slash. The submitted value
  /// (`effectiveValue`) keeps the slash for a directory because the
  /// store dispatches on `endsWith("/")` (the `either` flow) and the
  /// folder API takes the path verbatim. But every workspace-relative
  /// computation here (existing-entry lookup, missing-ancestor walk,
  /// per-segment render) needs the bare path: tree entries carry no
  /// trailing slash, and a trailing `/` would otherwise split into a
  /// stray empty segment.
  const normalizedPath = $derived(effectiveValue.replace(/\/+$/, ""));

  /// Validation result for the current input. Empty input still
  /// validates so the placeholder modal isn't immediately red.
  ///
  /// Validate against the RAW input rather than the effective
  /// value: otherwise a trailing-slash input like `a/b/` would
  /// become `a/b/.md` via appendDefaultMd and quietly pass the
  /// "ends with /" check, letting the user submit a bare `.md`
  /// file. Validating raw catches the ill-formed input upstream
  /// of any auto-resolution. We also re-validate the resolved
  /// path as a defensive backstop in case auto-resolution ever
  /// produces something the raw input wouldn't have.
  /// Open-mode graph-link detection. A `chan://graph?...` target rides to
  /// the server verbatim, so path validation (which rejects `:` and `?`)
  /// must not see it; parseGraphLink is the judge instead.
  const openGraphLink = $derived(
    pathPromptState.mode === "open" && value.trim().startsWith(GRAPH_LINK_PREFIX),
  );

  const validation = $derived.by(() => {
    const trimmed = value.trim();
    if (trimmed === "") return { ok: true as const };
    if (openGraphLink) {
      return parseGraphLink(trimmed)
        ? { ok: true as const }
        : { ok: false as const, reason: "not a valid chan://graph link" };
    }
    // A directory target may legitimately end in `/` (the "New File
    // or Directory" caption invites it, and an explicit New Directory
    // dialog produces it once the user types `name/`). Only allow the
    // trailing slash through when we've resolved the kind to a folder;
    // file create / move / rename still reject it with a name hint.
    const allowTrailingSlash = effectiveKind === "folder";
    const rawCheck = validatePath(trimmed, {
      allowAbsolute: pathPromptState.allowAbsolute,
      allowTrailingSlash,
    });
    if (!rawCheck.ok) return rawCheck;
    if (effectiveValue && effectiveValue !== trimmed) {
      const effCheck = validatePath(effectiveValue, {
        allowAbsolute: pathPromptState.allowAbsolute,
        allowTrailingSlash,
      });
      if (!effCheck.ok) return effCheck;
    }
    // Caller-supplied validator (e.g. "must be editable text") runs
    // last against the effective path so the user sees a precise
    // reason inline instead of submitting and getting an error
    // toast after the dialog closes.
    const v = pathPromptState.validate;
    if (v && effectiveValue) {
      const reason = v(effectiveValue);
      if (reason) return { ok: false as const, reason };
    }
    return { ok: true as const };
  });

  /// Directory index from the loaded tree. Built once per tree change
  /// and reused for both autocomplete and the parent-exists check.
  const folderSet = $derived.by(() => {
    const s = new Set<string>();
    for (const e of tree.entries) {
      if (e.is_dir) s.add(e.path);
    }
    return s;
  });

  /// Map of every entry by exact path. Workspaces the overwrite check
  /// (existing file at the target) and the kind-mismatch check
  /// (typed `foo/` but `foo` is a file, not a directory).
  const entryByPath = $derived(new Map(tree.entries.map((e) => [e.path, e])));

  /// Tagged suggestion. `dir` is the existing autocomplete from the
  /// loaded tree; `new-file` is the placeholder filename the prompt
  /// offers in new-file create mode after the user Tab-completes a
  /// directory, so they can Tab/Enter to land on `<dir>/untitled.md`
  /// without thinking up a name first.
  type Suggestion =
    | { kind: "dir"; path: string }
    | { kind: "new-file"; path: string };

  /// Suggestions: directories whose path starts with whatever the
  /// user has typed, minus the source path of an in-flight rename
  /// (no point suggesting "move into yourself"). Capped so we
  /// never paint a thousand-row dropdown on a fresh workspace that
  /// has only directories yet. The placeholder filename suggestion
  /// (`new-file` kind) is appended at the end so it always sits
  /// below the directory list and isn't subject to the cap.
  const SUGGESTION_LIMIT = 8;
  const suggestions = $derived.by<Suggestion[]>(() => {
    const q = value.trim();
    if (q === "") return [];
    const src = pathPromptState.sourcePath;
    const out: Suggestion[] = [];
    for (const dir of folderSet) {
      if (!dir.startsWith(q)) continue;
      if (dir === q) continue; // exact match already typed; skip
      if (src && (dir === src || dir.startsWith(`${src}/`))) continue;
      out.push({ kind: "dir", path: dir });
      if (out.length >= SUGGESTION_LIMIT) break;
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    // New-file create mode: once the user has completed a directory
    // (value ends in `/`) or is at the workspace root (value === ""
    // doesn't trigger because the suggestions list is empty there),
    // surface a placeholder so Tab/Enter lands them on
    // `<dir>/untitled.md` with the stem pre-selected.
    if (
      pathPromptState.kind === "file" &&
      pathPromptState.mode === "create" &&
      q.endsWith("/")
    ) {
      const proposed = proposeDefaultFilename(q);
      // Skip when an entry at this exact path already exists; the
      // overwrite/kind-mismatch status row already handles that.
      if (!entryByPath.has(proposed)) {
        out.push({ kind: "new-file", path: proposed });
      }
    }
    return out;
  });
  /// Subset of `suggestions` that participates in LCP-extension.
  /// The placeholder filename is excluded because its path is a
  /// proposed name, not a fact about the workspace - folding it into
  /// the LCP would push the user's typed value past the directory
  /// boundary on the first Tab.
  const dirSuggestions = $derived(
    suggestions.filter((s) => s.kind === "dir").map((s) => s.path),
  );

  /// Progressive directory autocomplete. `tree.entries` is loaded
  /// lazily: `refreshTree` fetches only the workspace root, and each
  /// directory's children land in the tree on first File-Browser
  /// expand. So a dialog opened WITHOUT having browsed to the target
  /// (e.g. save-from-draft, where the user came straight from editing a
  /// draft) has no entries for deep paths and the suggestion list stays
  /// empty even though the directories exist. This effect walks the
  /// ancestor chain of whatever the user has typed and loads the
  /// children of any directory that is known to exist but not loaded
  /// yet, so the next path segment can be suggested. We gate on
  /// `folderSet.has` (only load directories already known to exist), so
  /// a mistyped segment can never trigger a 404; loading one level
  /// reveals the next via `folderSet`, and this effect re-runs (it
  /// reads `folderSet`) until the deepest known ancestor is loaded.
  $effect(() => {
    if (!pathPromptState.open) return;
    const q = value.trim();
    const slash = q.lastIndexOf("/");
    if (slash <= 0) return;
    let acc = "";
    for (const seg of q.slice(0, slash).split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      // A directory that failed to list is neither loaded nor loading, so
      // without the recorded error this guard would be false again on the
      // next run and would re-arm the request at once. A failed load is a
      // state: it waits for something that could change the answer, which is
      // `clearTreeDirError` (the File Tree's collapse) or a `refreshTree`,
      // which replaces the whole record.
      if (
        folderSet.has(acc) &&
        !tree.loadedDirs[acc] &&
        !tree.loadingDirs[acc] &&
        !(acc in tree.dirErrors)
      ) {
        // loadTreeDir records the failure in tree.dirErrors and rethrows.
        // The status row below reads that record, so the rejection has a
        // reader and does not need to reach the window as an unhandled one.
        void loadTreeDir(acc).catch(() => {});
      }
    }
  });

  /// Walk every ancestor of `path` and return the ones that don't
  /// exist as directories yet. Used so the status row can announce both
  /// the implicit ancestors AND the target instead of mentioning
  /// only the immediate parent (which used to hide multi-segment
  /// chains like `a/b/c/d` from the user).
  function missingAncestors(path: string): string[] {
    if (path.startsWith("/")) return [];
    const segs = path.split("/");
    segs.pop(); // drop basename; we want the ancestor chain
    if (segs.length === 0) return [];
    const out: string[] = [];
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!folderSet.has(acc)) out.push(acc);
    }
    return out;
  }

  /// Status hint for the action row underneath the input. The
  /// "creates" branch carries both the missing ancestors AND the
  /// target so the row can surface, e.g., "creates directories foo/,
  /// foo/bar/" for a `foo/bar` directory when neither exists yet,
  /// rather than only mentioning the implicit parent.
  type Status =
    | { kind: "empty" }
    | { kind: "invalid"; reason: string }
    /// An ancestor directory that could not be listed. The checks below read
    /// the tree, so this says the listing failed rather than reasoning from a
    /// tree that is missing a level.
    | { kind: "dir-unreadable"; path: string; reason: string }
    | { kind: "kind-mismatch"; reason: string }
    | { kind: "no-op" }
    | { kind: "overwrites"; path: string; isFolder: boolean }
    /// Open mode over an existing entry: the normal case, no creation.
    | { kind: "opens"; path: string; isFolder: boolean }
    /// Open mode over a valid `chan://graph?...` link.
    | { kind: "opens-graph" }
    | {
        kind: "creates";
        /// Ancestor directories that need to be created. Empty when
        /// the parent already exists.
        newAncestors: string[];
        /// The new file or directory at the typed path.
        target: { path: string; isFolder: boolean };
        mode: PathPromptMode;
      };

  /// The shallowest ancestor of `path` whose listing failed, or null. The
  /// load effect skips a directory with a recorded failure, so this is what
  /// the user is waiting on rather than a load still in flight.
  function unreadableAncestor(path: string): string | null {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return null;
    let acc = "";
    for (const seg of path.slice(0, slash).split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (acc in tree.dirErrors) return acc;
    }
    return null;
  }

  const status = $derived.by<Status>(() => {
    // Use the bare (no trailing slash) path for all workspace-relative
    // reasoning; the submit value with the slash lives in
    // `effectiveValue` and is what `ok()` sends.
    const path = normalizedPath;
    if (path === "") return { kind: "empty" };
    if (!validation.ok) return { kind: "invalid", reason: validation.reason };
    if (openGraphLink) return { kind: "opens-graph" };

    const unreadable = unreadableAncestor(path);
    if (unreadable) {
      return {
        kind: "dir-unreadable",
        path: unreadable,
        reason: tree.dirErrors[unreadable] ?? "cannot be listed",
      };
    }

    // Existing entry at the exact typed path: file overwrite (move)
    // or kind-mismatch. Directory overwrite is also a mismatch because
    // chan-workspace refuses to replace directory targets.
    const targetEntry = entryByPath.get(path);
    const wantDir = effectiveKind === "folder";

    // Open mode never treats an existing entry as an error: an existing
    // directory opens the file browser, an existing file opens the
    // editor (the server's content sniff has the final word on binary).
    // A path the tree doesn't know gets the ruling-6 disclosure: the
    // server creates it empty and opens it, full `cs open` parity.
    if (pathPromptState.mode === "open") {
      if (targetEntry) {
        return { kind: "opens", path, isFolder: targetEntry.is_dir };
      }
      return {
        kind: "creates",
        newAncestors: missingAncestors(path),
        target: { path, isFolder: wantDir },
        mode: pathPromptState.mode,
      };
    }
    if (targetEntry) {
      if (targetEntry.is_dir !== wantDir) {
        const have = targetEntry.is_dir ? "directory" : "file";
        const want = wantDir ? "directory" : "file";
        const verb =
          pathPromptState.mode === "move"
            ? "rename onto"
            : pathPromptState.mode === "attach"
              ? "attach a watcher to"
              : "create";
        return {
          kind: "kind-mismatch",
          reason: `'${path}' is an existing ${have}, can't ${verb} a ${want}`,
        };
      }
      if (pathPromptState.mode === "move") {
        if (pathPromptState.sourcePath === path) {
          return { kind: "no-op" };
        }
        if (targetEntry.is_dir) {
          return {
            kind: "kind-mismatch",
            reason: `'${path}' is an existing directory; choose a new path`,
          };
        }
        return { kind: "overwrites", path, isFolder: wantDir };
      }
      if (pathPromptState.mode === "attach") {
        // Attaching a watcher to a directory that already exists is
        // the common case; no overwrite warning, no ancestor
        // preamble, just confirm the target.
        return {
          kind: "creates",
          newAncestors: [],
          target: { path, isFolder: wantDir },
          mode: pathPromptState.mode,
        };
      }
      // Create mode + existing target = error.
      return {
        kind: "kind-mismatch",
        reason: `'${path}' already exists`,
      };
    }

    // Absolute paths bypass the workspace-side tree view entirely
    // (tree.entries only carries workspace-relative
    // paths), so we can't tell from the SPA whether the path
    // exists on disk. Show the attach intent without manufacturing
    // a "creates ancestors a/, b/, c/" preamble that wouldn't
    // match anything chan-workspace ever sees. The backend creates
    // the watcher dir silently if missing.
    const newAncestors =
      pathPromptState.mode === "attach" && path.startsWith("/")
        ? []
        : missingAncestors(path);
    return {
      kind: "creates",
      newAncestors,
      target: { path, isFolder: wantDir },
      mode: pathPromptState.mode,
    };
  });

  const submitDisabled = $derived(
    status.kind === "empty" ||
      status.kind === "invalid" ||
      status.kind === "kind-mismatch" ||
      status.kind === "no-op",
  );

  /// Per-segment breakdown for the colored path render. Existing
  /// directories render in muted grey, segments that need to be created
  /// render in mint-green. When we auto-resolved an extension (the
  /// `.md` for a new file or the preserved extension on rename),
  /// that suffix is split into its own `auto` chunk so the template
  /// can italicize it and signal that the user didn't type it.
  function pathSegments(
    s: Extract<Status, { kind: "creates" }>,
  ): Array<{ text: string; isNew: boolean; auto?: boolean }> {
    const parts = s.target.path.startsWith("/")
      ? s.target.path.slice(1).split("/")
      : s.target.path.split("/");
    const out: Array<{ text: string; isNew: boolean; auto?: boolean }> = [];
    let acc = "";
    if (s.target.path.startsWith("/")) {
      out.push({ text: "/", isNew: false });
    }
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      out.push({ text: `${parts[i]}/`, isNew: !folderSet.has(acc) });
    }
    // Final segment: in attach mode it may point at an existing
    // directory (then we don't want the mint-green "new" colour;
    // it lies about what's happening). In create / move modes the
    // existing-target path bails out earlier via `overwrites` /
    // `kind-mismatch`, so the final segment always renders as new
    // there. Add the trailing `/` for directories.
    const tail = parts[parts.length - 1];
    const tailIsExisting =
      s.mode === "attach" && entryByPath.has(s.target.path) && s.target.isFolder;
    if (autoSuffix && tail.endsWith(autoSuffix)) {
      // Show the user-typed stem as the "new" piece, then the
      // auto-resolved suffix as its own italicized chunk.
      const stem = tail.slice(0, -autoSuffix.length);
      if (stem) out.push({ text: stem, isNew: !tailIsExisting });
      out.push({ text: autoSuffix, isNew: !tailIsExisting, auto: true });
    } else {
      out.push({
        text: s.target.isFolder ? `${tail}/` : tail,
        isNew: !tailIsExisting,
      });
    }
    return out;
  }

  function ok(): void {
    if (submitDisabled) return;
    // Submit the effective value so the receiver sees the resolved
    // path (e.g. with the auto-appended `.md`) rather than having
    // to apply the same rule again. The store-side appendDefaultMd
    // remains as a defensive layer (idempotent).
    resolvePathPrompt(effectiveValue);
  }
  function cancel(): void {
    resolvePathPrompt(null);
  }

  function applySuggestion(s: Suggestion): void {
    if (s.kind === "dir") {
      // Append `/` so the user's next keystroke extends the path
      // *into* the chosen directory rather than rewriting its name.
      // Validation rejects a path that ends in `/` (so Enter on the
      // bare "Recipes/" doesn't submit and create a stray .md),
      // which makes the trailing slash a free affordance: visible
      // cue + a submit guard.
      value = `${s.path}/`;
      highlightIdx = -1;
      queueMicrotask(() => inputEl?.focus());
      return;
    }
    // new-file placeholder: drop in the proposed path and pre-
    // select the stem so the user's next keystroke replaces
    // `untitled` rather than landing after it. Enter from this
    // state submits the path as-is.
    value = s.path;
    highlightIdx = -1;
    const stemStart = s.path.lastIndexOf("/") + 1;
    const dotIdx = s.path.lastIndexOf(".");
    const stemEnd =
      dotIdx > stemStart ? dotIdx : stemStart + DEFAULT_NEW_FILENAME_STEM.length;
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.setSelectionRange(stemStart, stemEnd);
    });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < suggestions.length) {
        applySuggestion(suggestions[highlightIdx]);
        return;
      }
      ok();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab" && suggestions.length > 0) {
      // Tab-complete:
      //   1. If a suggestion is already highlighted, Tab accepts
      //      that one. This keeps Tab as the primary completer per
      //      the shell convention "arrow down to pick, Tab to
      //      accept" so users don't have to switch to Enter just
      //      to lock in a choice.
      //   2. Single match → accept directly. Same one-Tab fast
      //      path the dir-only flow used before adding the new-
      //      file placeholder.
      //   3. Otherwise extend the input to the longest common
      //      prefix of the directory suggestions (the placeholder
      //      filename is excluded from LCP - it's a proposal, not
      //      a fact about the workspace). Shift+Tab cycles backwards
      //      from the bottom.
      e.preventDefault();
      if (
        !e.shiftKey &&
        highlightIdx >= 0 &&
        highlightIdx < suggestions.length
      ) {
        applySuggestion(suggestions[highlightIdx]);
        return;
      }
      if (!e.shiftKey && suggestions.length === 1) {
        applySuggestion(suggestions[0]!);
        return;
      }
      const typed = value;
      const lcp = longestCommonPrefix(dirSuggestions);
      if (!e.shiftKey && lcp.length > typed.length) {
        value = lcp;
        highlightIdx = -1;
        return;
      }
      if (e.shiftKey) {
        highlightIdx = highlightIdx <= -1 ? suggestions.length - 1 : highlightIdx - 1;
      } else {
        highlightIdx = highlightIdx >= suggestions.length - 1 ? -1 : highlightIdx + 1;
      }
    } else if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      highlightIdx = Math.min(highlightIdx + 1, suggestions.length - 1);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      highlightIdx = Math.max(highlightIdx - 1, -1);
    }
  }
</script>

{#if pathPromptState.open}
  <ModalShell labelledby="path-prompt-title" onClose={cancel} minWidth="420px" gap="0.55rem">
    <div id="path-prompt-title" class="title">{pathPromptState.title}</div>
    {#if pathPromptState.notice}
      <div class="notice">{pathPromptState.notice}</div>
    {/if}
    <input
      bind:this={inputEl}
      bind:value
      onkeydown={onKey}
      spellcheck="false"
      autocomplete="off"
      placeholder={pathPromptState.kind === "folder"
        ? "directory/path"
        : pathPromptState.kind === "either"
          ? "file/path or directory/path/"
          : "file/path"}
    />

    {#if suggestions.length > 0}
      <ul class="suggestions" role="listbox">
        {#each suggestions as s, i (s.path + s.kind)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            role="option"
            aria-selected={i === highlightIdx}
            class:active={i === highlightIdx}
            class:placeholder={s.kind === "new-file"}
            onmousedown={(e) => {
              e.preventDefault();
              applySuggestion(s);
            }}
            onmouseenter={() => (highlightIdx = i)}
          >{#if s.kind === "dir"}{s.path}/{:else}{s.path}
            <span class="placeholder-hint">(new file - Tab to accept)</span>
          {/if}</li>
        {/each}
      </ul>
    {/if}

    <div
      class="status"
      class:err={status.kind === "invalid" || status.kind === "kind-mismatch"}
      class:warn={status.kind === "dir-unreadable" ||
        status.kind === "overwrites" ||
        (status.kind === "creates" && status.newAncestors.length > 0)}
    >
      {#if status.kind === "empty"}
        <span class="muted">type a path</span>
      {:else if status.kind === "invalid"}
        ✗ {status.reason}
      {:else if status.kind === "kind-mismatch"}
        ✗ {status.reason}
      {:else if status.kind === "dir-unreadable"}
        ⚠ cannot list <span class="mono">{status.path}</span>: {status.reason}
      {:else if status.kind === "overwrites"}
        ⚠ overwrites existing {status.isFolder ? "directory" : "file"}
        <span class="mono">{status.path}{status.isFolder ? "/" : ""}</span>
      {:else if status.kind === "no-op"}
        <span class="muted">unchanged</span>
      {:else if status.kind === "opens-graph"}
        → opens graph link
      {:else if status.kind === "opens"}
        → opens {status.isFolder ? "directory " : ""}<span class="mono"
          >{status.path}{status.isFolder ? "/" : ""}</span
        >
      {:else}
        {@const segs = pathSegments(status)}
        {@const arrow = status.newAncestors.length > 0 ? "⚠" : "→"}
        {arrow}
        {#if status.mode === "move"}
          moves to
        {:else if status.mode === "attach"}
          attach watcher to
        {:else if status.mode === "open"}
          creates and opens
        {:else}
          new {status.target.isFolder ? "directory" : "file"}
        {/if}
        <span class="mono path-render">
          {#each segs as seg, i (i)}
            <span
              class="seg"
              class:isnew={seg.isNew}
              class:auto={seg.auto}
              title={seg.auto ? "added automatically (no extension typed)" : undefined}
            >{seg.text}</span>
          {/each}
        </span>
      {/if}
    </div>

    <div class="actions">
      <button class="cancel" onclick={cancel}>Cancel</button>
      <button class="ok" onclick={ok} disabled={submitDisabled}>OK</button>
    </div>
  </ModalShell>
{/if}

<style>
  .title {
    font-size: 15px;
    color: var(--text-secondary);
  }
  /* Informational line above the input (e.g. the save-from-draft
     "the whole draft directory is saved as a directory" notice). It
     is non-blocking context, so it reads as a muted info hue rather
     than the red error / amber warn the status row uses. */
  .notice {
    font-size: 12px;
    line-height: 1.4;
    color: var(--info-text, var(--text-secondary));
  }
  input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    font: inherit;
    outline: none;
  }
  input:focus { border-color: var(--link); }
  .suggestions {
    margin: 0;
    padding: 2px 0;
    list-style: none;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
  }
  .suggestions li {
    padding: 4px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .suggestions li.active,
  .suggestions li:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  /* Placeholder filename row sits visually adjacent to the directory
     suggestions but reads as a proposal rather than a real file:
     muted italic text, a light separator above it, and an inline
     hint that points the user at Tab. */
  .suggestions li.placeholder {
    font-style: italic;
    color: var(--text-secondary);
    border-top: 1px dashed var(--border);
  }
  .suggestions li.placeholder.active,
  .suggestions li.placeholder:hover {
    color: var(--text);
  }
  .suggestions li .placeholder-hint {
    font-style: normal;
    color: var(--text-secondary);
    font-size: 11px;
    margin-left: 6px;
    opacity: 0.8;
  }
  .status {
    font-size: 13px;
    color: var(--text-secondary);
    min-height: 1.4em;
  }
  .status.err { color: var(--danger, #d33); }
  .status.warn { color: var(--warn-text); }
  .status .muted { opacity: 0.7; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  /* Per-segment path render: existing path bits stay muted so they
     read as "context", and the to-be-created bits get the lighter
     mint-green (--info-text) so the new portion catches the eye
     without shouting. Keeping the new segments at normal weight -      the color does the work. */
  .path-render .seg { color: var(--text-secondary); }
  .path-render .seg.isnew { color: var(--info-text); }
  /* Auto-appended chunks (currently just the `.md` we add to a
     new file with no extension) render italic + faded so the user
     can tell that bit wasn't typed by them. Same green hue so it
     still reads as "this segment is new". */
  .path-render .seg.auto { font-style: italic; opacity: 0.75; }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.3rem 0.75rem;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .actions button:hover:not(:disabled) { border-color: var(--btn-hover); }
  .actions button:disabled { opacity: 0.6; cursor: default; }
  .actions .ok {
    background: var(--link);
    border-color: var(--link);
    color: #fff;
  }
  .actions .ok:disabled { background: var(--btn-bg); color: var(--text-secondary); }
</style>
