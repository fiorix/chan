<script module lang="ts">
  // Pure version-map bookkeeping for the live-session binding, exported
  // so the loop-safety pins can drive it directly. An element is a
  // pending local delta iff its canvas version differs from the last
  // version this client broadcast OR applied from the authority: noting
  // remote applies here is what keeps a remote-won element from ever
  // re-pushing.
  export function sceneDeltas(
    elements: readonly Record<string, unknown>[],
    lastBroadcast: ReadonlyMap<string, number>,
  ): Record<string, unknown>[] {
    return elements.filter((el) => {
      const id = el.id;
      if (typeof id !== "string") return false;
      return lastBroadcast.get(id) !== (typeof el.version === "number" ? el.version : 0);
    });
  }

  export function noteVersions(
    lastBroadcast: Map<string, number>,
    elements: readonly Record<string, unknown>[],
  ): void {
    for (const el of elements) {
      const id = el.id;
      if (typeof id !== "string") continue;
      lastBroadcast.set(id, typeof el.version === "number" ? el.version : 0);
    }
  }

  /// JSON text of `value` with every object's keys sorted, so two appStates
  /// holding the same keys and values give one text whatever order each was
  /// built in: the authority's frames sort an object's keys, and the board
  /// keeps the library's order.
  export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    );
  }
</script>

<script lang="ts">
  // The SPA's one React island: an interactive Excalidraw board mounted
  // inside a Svelte file tab. createRoot ONCE in onMount; every later
  // Svelte-side change goes through the imperative API or a themed
  // re-render, never a root re-creation (the svelte-excalidraw demo's
  // bug). react, react-dom, and @excalidraw/excalidraw are dynamic
  // imports so the eager editor bundle never pulls React; this module is
  // itself reached only via a dynamic import from FileEditorTab, so the
  // static index.css import rides its async chunk instead of the eager
  // CSS. See ../editor/ExcalidrawCanvas source-pin test.
  import { onDestroy, onMount, untrack } from "svelte";
  import type {
    AppState,
    ExcalidrawImperativeAPI,
    ExcalidrawInitialDataState,
  } from "@excalidraw/excalidraw/types";
  import { configureExcalidrawAssets } from "./excalidrawAssets";
  import { peerColorIdx, resolvePeerName } from "./collab/remoteCursors";
  import type {
    SceneCanvasBinding,
    SceneSession,
    WireAppState,
    WireElement,
    WireFiles,
  } from "../state/sceneSync.svelte";
  import "@excalidraw/excalidraw/index.css";

  type Props = {
    /// The FileTab content buffer: a serialized .excalidraw scene ("" =
    /// a fresh, empty board).
    content: string;
    dark: boolean;
    /// True only when this canvas tab is the pane's active, front-facing
    /// tab. Drives the offscreen hide below. Defaults true so standalone
    /// mounts (tests, any non-keep-alive host) render visible.
    active?: boolean;
    /// The board changed. The host serializes into the tab buffer, which
    /// the existing autosave path persists.
    onSceneChange: (json: string) => void;
    /// Live scene session for this tab, if any; absent renders a solo
    /// board with every collab path inert.
    session?: SceneSession | null;
    /// The tab is read only: read mode, or a file with no user-write bit.
    /// The board renders in view mode, which is what keeps it from
    /// producing changes a live session refuses and the disk will not take.
    readonly?: boolean;
    /// The tab's load is finished: the buffer holds the file, not the emptied
    /// or partial buffer of a read in flight. Defaults true so standalone
    /// mounts (tests, a host that never loads) behave as a loaded tab.
    loaded?: boolean;
  };
  let {
    content,
    dark,
    active = true,
    onSceneChange,
    session = null,
    readonly = false,
    loaded = true,
  }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let root: import("react-dom/client").Root | null = null;
  let react: typeof import("react") | null = null;
  let ex: typeof import("@excalidraw/excalidraw") | null = null;
  let api: ExcalidrawImperativeAPI | null = null;
  /// Reactive mirror of "the imperative API exists", so the session
  /// bind effect re-runs once the async chunk delivers it.
  let apiReady = $state(false);

  // The scene the board and the buffer last agreed on: nothing until the
  // board is seeded, then the library's serialization of each seed and of
  // each change published since. Distinguishes our own serialized output
  // from an external buffer write (reload, 409 resolution, sibling-pane
  // mirror) so we neither reparse bytes we just emitted nor dirty the tab on
  // a write we did not make. Mirrors CsvTable's lastSerialized guard.
  let lastSerialized: string | null = null;

  // The appState the canvas has handed to the board and the library does
  // not show yet. `updateScene` shows an appState only at the library's next
  // render, so every serialization, the baseline's and the flush's alike,
  // lays this over what the library reports; the library's next reported
  // change follows that render and drops it. It holds what came out of the
  // serializer, so it names no key.
  let handedAppState: Partial<AppState> | null = null;

  // Seeded: the library, past its own init (whose apply replaces every
  // element set before it), holds the whole buffer of a finished load as
  // its init would restore it: the elements, the files, and the appState
  // its serializer keeps; a file whose id the board already holds keeps its
  // bytes. `lastSerialized` holds the library's serialization of it. Only a
  // seeded board publishes, and the serialization a seed takes is the
  // baseline rather than an edit, so a board nobody drew on writes nothing:
  // neither the empty or partial scene of a load in flight nor the library's
  // rewrite of a file it did not write (its indentation, its `source`, the
  // fields it restores). The one exception is an image whose file fails to
  // decode: the library marks it after the load, and that change is
  // published. Set by `seed`; cleared when a load starts or the buffer
  // changes without the board (a reload, a conflict's resolution, a sibling
  // pane's mirror).
  let seeded = false;

  // Serialization is debounced: excalidraw's onChange fires per pointer
  // event, and serializing the whole scene on each would jank a drag.
  // serializeAsJSON("local") keeps only elements plus a few persistent
  // appState keys (grid, background), so pan / zoom / selection / theme
  // churn produce an identical string and never dirty the buffer. The
  // same debounce paces the live-session delta pushes.
  let serializeTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- live scene session binding ------------------------------------

  /// Last element version broadcast to (or applied from) the authority.
  const lastBroadcast = new Map<string, number>();
  /// File ids the authority already knows (pushed by us or fanned in).
  const knownFiles = new Set<string>();
  /// Cleaned appState from the latest serialize or adopt with its canonical
  /// JSON, plus the canonical JSON of the appState the authority is known to
  /// hold (from our last push OR any adopted snapshot/update, taken as the
  /// serializer keeps it). Only a divergence from that baseline rides a
  /// push: adopting an incoming appState must move the baseline too, or the
  /// echo would re-push forever between two live canvases.
  let cleanedAppState: WireAppState = {};
  let cleanedAppStateJson = "";
  let lastAuthorityAppStateJson = "";

  /// Literal colors for the collaborator layer, resolved from the shared
  /// --peer-c0..7 vars so canvas pointers match editor carets; the
  /// literals are the light-theme palette, covering detached test DOMs
  /// and scopes where the vars do not resolve.
  const PEER_COLOR_FALLBACKS = [
    "#1a6fd4",
    "#c62f2f",
    "#1e8a44",
    "#8a3fd1",
    "#b26305",
    "#0f8390",
    "#c22a6e",
    "#59626e",
  ];
  function peerColor(windowId: string): { background: string; stroke: string } {
    const i = peerColorIdx(windowId);
    let v = "";
    try {
      v = getComputedStyle(document.documentElement)
        .getPropertyValue(`--peer-c${i}`)
        .trim();
    } catch {
      // Detached DOM (tests): fall through to the literal palette.
    }
    const c = v || PEER_COLOR_FALLBACKS[i % PEER_COLOR_FALLBACKS.length]!;
    return { background: c, stroke: c };
  }

  function allElements(): Record<string, unknown>[] {
    if (!api) return [];
    return api.getSceneElementsIncludingDeleted() as unknown as Record<string, unknown>[];
  }

  /// What the library keeps of `appState` when it restores a scene holding
  /// it and serializes that scene: the grid and the background, each at the
  /// library's default where `appState` lacks it. The seed takes the same of
  /// a buffer's.
  function keptAppState(
    e: typeof import("@excalidraw/excalidraw"),
    appState: WireAppState,
  ): WireAppState {
    const restored = e.restore({ appState } as Parameters<typeof e.restore>[0], null, null).appState;
    return (JSON.parse(e.serializeAsJSON([], restored, {}, "local")) as { appState: WireAppState })
      .appState;
  }

  /// Fold authority content into the canvas. The local side of the
  /// reconcile includes deleted elements: a local tombstone must beat a
  /// slower remote update of the same element or a delete could
  /// resurrect during the push round-trip. The transaction never enters
  /// local undo (CaptureUpdateAction.NEVER).
  ///
  /// Of an adopted appState only what the serializer keeps is handed to the
  /// board and recorded, as the seed hands a buffer's: a file's key the
  /// serializer drops, a view key among them, never reaches the board, and a
  /// key the file leaves out is the library's default on both sides of the
  /// comparison, so an appState nobody changed on the board is not pushed.
  function applyRemote(
    elements: WireElement[],
    appState: WireAppState | undefined,
    files: WireFiles | undefined,
  ): void {
    if (!api || !ex) return;
    const reconciled = ex.reconcileElements(
      api.getSceneElementsIncludingDeleted(),
      elements as unknown as Parameters<typeof ex.reconcileElements>[1],
      api.getAppState(),
    );
    const kept = appState !== undefined ? keptAppState(ex, appState) : undefined;
    api.updateScene({
      elements: reconciled,
      ...(kept !== undefined ? { appState: kept } : {}),
      captureUpdate: ex.CaptureUpdateAction.NEVER,
    } as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]);
    // Equal canvas/broadcast versions afterwards mean the remote value
    // won (never re-push it); a surviving newer local element stays
    // unequal and pushes through the normal delta path.
    noteVersions(lastBroadcast, elements);
    if (files !== undefined) {
      const list = Object.values(files);
      if (list.length > 0) {
        api.addFiles(list as unknown as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
      }
      for (const k of Object.keys(files)) knownFiles.add(k);
    }
    if (kept !== undefined) {
      // Any adopted appState is the new authority baseline; only later
      // local divergence should ride a push. The board shows it only at the
      // library's next render, so until then every serialization lays it
      // over the board's earlier one, as for a seed, and it is what the next
      // push offers: a push made first, from a timer, a close or the session
      // right after this frame, then sends nothing older over it.
      handedAppState = { ...(handedAppState ?? {}), ...kept };
      cleanedAppState = kept;
      cleanedAppStateJson = lastAuthorityAppStateJson = canonicalJson(kept);
    }
  }

  /// Hand pending local deltas to the session: elements whose canvas
  /// version moved past the broadcast map, file entries the authority
  /// has not seen, and the cleaned appState when it changed.
  function pushDeltas(): void {
    if (!api || !session) return;
    const deltas = sceneDeltas(allElements(), lastBroadcast);
    const newFiles: WireFiles = {};
    for (const [k, v] of Object.entries(api.getFiles())) {
      if (!knownFiles.has(k)) newFiles[k] = v as WireFiles[string];
    }
    const appState =
      cleanedAppStateJson !== "" && cleanedAppStateJson !== lastAuthorityAppStateJson
        ? cleanedAppState
        : undefined;
    const hasFiles = Object.keys(newFiles).length > 0;
    if (deltas.length === 0 && appState === undefined && !hasFiles) return;
    const taken = session.pushScene(
      deltas as WireElement[],
      appState,
      hasFiles ? newFiles : undefined,
    );
    // Everything below records "the authority has this", so it runs only
    // when the session took the push. A dropped one leaves the deltas,
    // the new files and the appState pending, and the next flush sends
    // them; marking them first is how a shape drawn while the channel was
    // down was never pushed again.
    if (!taken) return;
    noteVersions(lastBroadcast, deltas);
    for (const k of Object.keys(newFiles)) knownFiles.add(k);
    if (appState !== undefined) lastAuthorityAppStateJson = cleanedAppStateJson;
  }

  const binding: SceneCanvasBinding = {
    applySnapshot(elements, appState, files) {
      applyRemote(elements, appState, files);
    },
    applyUpdate(f) {
      applyRemote(f.elements, f.appState, f.files);
    },
    collaboratorsChanged() {
      if (!api || !session) return;
      const collaborators = new Map<string, Record<string, unknown>>();
      for (const [id, c] of session.peerCursorSnapshot()) {
        collaborators.set(String(id), {
          username: resolvePeerName(c.w),
          color: peerColor(c.w),
          pointer: { x: c.x, y: c.y, tool: "pointer" },
          ...(c.selected !== undefined
            ? {
                selectedElementIds: Object.fromEntries(
                  c.selected.map((s) => [s, true] as const),
                ),
              }
            : {}),
        });
      }
      api.updateScene({
        collaborators,
      } as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]);
    },
    hasPendingLocal() {
      if (!api) return false;
      return sceneDeltas(allElements(), lastBroadcast).length > 0;
    },
    flushPendingLocal() {
      pushDeltas();
    },
    forgetBroadcast(elements, appState, files) {
      // The push was claimed and then discarded, so the authority never took
      // any of it. Dropping each mark is what puts its part back in the next
      // flush: the elements in `sceneDeltas`, the files in the `newFiles`
      // scan, the appState in the baseline comparison.
      for (const el of elements) {
        const id = (el as { id?: unknown }).id;
        if (typeof id === "string") lastBroadcast.delete(id);
      }
      if (files !== undefined) {
        for (const k of Object.keys(files)) knownFiles.delete(k);
      }
      if (appState !== undefined) {
        // The appState rides a push as a whole value rather than a delta, so
        // clearing the baseline offers the latest flush's or adopt's
        // appState again. At worst that is one redundant push of a value the
        // authority has; a snapshot adopted before that push replaces it.
        lastAuthorityAppStateJson = "";
      }
    },
  };

  // Bind the session once the imperative API exists; rebind when the
  // session is replaced. bindCanvas replays the authority snapshot into
  // a late-mounting canvas.
  $effect(() => {
    const s = session;
    if (!s || !apiReady) return;
    s.bindCanvas(binding);
    return () => s.unbindCanvas(binding);
  });

  function parseScene(json: string): ExcalidrawInitialDataState | null {
    if (!json.trim()) return null;
    try {
      return JSON.parse(json) as ExcalidrawInitialDataState;
    } catch {
      // A corrupt scene (a hand-edited source-mode typo the save gate
      // somehow let through) opens as an empty board rather than throwing.
      return null;
    }
  }

  function scheduleSerialize(): void {
    if (serializeTimer !== null) clearTimeout(serializeTimer);
    serializeTimer = setTimeout(flushSerialize, 200);
  }

  function serializeScene(
    a: ExcalidrawImperativeAPI,
    e: typeof import("@excalidraw/excalidraw"),
  ): string {
    return e.serializeAsJSON(
      a.getSceneElements(),
      { ...a.getAppState(), ...(handedAppState ?? {}) },
      a.getFiles(),
      "local",
    );
  }

  /// Put the buffer of a finished load on the board, restored as the
  /// library's init restores a scene, and adopt the library's serialization
  /// of it as the baseline, in one synchronous run, so no stroke can land
  /// between the two; a stroke begun before it is replaced. The board may
  /// hold anything before this: what it was built from decides nothing. The
  /// library must be past its init: it reports `isLoading` until then, and
  /// the init's apply would replace whatever this put there.
  ///
  /// Of the restored appState, only what the library's serializer keeps is
  /// applied (the grid and the background), so the board's zoom, scroll,
  /// selection, theme and view mode stay as they are. `updateScene` replaces
  /// the elements at once and shows its appState only at the library's next
  /// render, so that appState is kept as handed until then. `addFiles` adds
  /// the scene's files whose ids the board does not hold.
  function seed(): void {
    if (seeded || !loaded || !api || !ex) return;
    if (api.getAppState().isLoading) return;
    const scene = ex.restore(parseScene(content), null, null, { repairBindings: true });
    // The serializer's appState is a function of the appState alone.
    const { appState } = JSON.parse(ex.serializeAsJSON([], scene.appState, {}, "local")) as {
      appState: Partial<AppState>;
    };
    api.updateScene({
      elements: scene.elements,
      appState,
      captureUpdate: ex.CaptureUpdateAction.NEVER,
    } as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]);
    handedAppState = { ...(handedAppState ?? {}), ...appState };
    const files = Object.values(scene.files);
    if (files.length > 0) api.addFiles(files);
    lastSerialized = serializeScene(api, ex);
    seeded = true;
  }

  /// Every change the library reports. The first comes from its init, and
  /// none comes before it, so it is where a board whose buffer was loaded
  /// before the init finished is seeded. A change follows the render that
  /// shows what was handed before it, so that is dropped first; a seed here
  /// hands its own after the drop, and it lasts until the next change.
  function onLibraryChange(): void {
    handedAppState = null;
    seed();
    scheduleSerialize();
  }

  function flushSerialize(): void {
    serializeTimer = null;
    if (!api || !ex) return;
    const json = serializeScene(api, ex);
    if (session) {
      // The serialized envelope already carries the cleaned appState
      // (the exact object the classic save would persist); reuse it as
      // the push payload instead of re-cleaning by hand.
      try {
        const parsed = JSON.parse(json) as { appState?: WireAppState };
        cleanedAppState = parsed.appState ?? {};
        cleanedAppStateJson = canonicalJson(cleanedAppState);
      } catch {
        // The buffer mirror below still runs; deltas push without
        // appState.
      }
      pushDeltas();
    }
    // An unseeded board, or one whose tab is loading, holds no drawing of
    // the user's to publish.
    if (!seeded || !loaded) return;
    if (json === lastSerialized) return;
    lastSerialized = json;
    onSceneChange(json);
    // A peer's edit reaches the buffer only here, and no push-ok follows
    // it. The session knows what of the elements is still this board's; an
    // appState the authority has not taken is known only here.
    if (session && cleanedAppStateJson === lastAuthorityAppStateJson) session.bufferMirrored();
  }

  // The library's App reads its initial data once, when it mounts, from the
  // props of the render in effect then. Its constructor hands the API over
  // before the mount and that read, but in the same synchronous React
  // commit, so no code of the canvas runs between them: once the API is set,
  // the App has read its initial data. Every render until then carries the
  // buffer as it is at that render, so the App is built from the buffer
  // whichever render it mounts with; a render after it passes none, which
  // the App would ignore. The buffer is read untracked, so the render effect
  // below does not re-render when it changes.
  function renderExcalidraw(): void {
    if (!root || !react || !ex) return;
    root.render(
      react.createElement(ex.Excalidraw, {
        ...(api ? {} : { initialData: parseScene(untrack(() => content)) }),
        theme: dark ? "dark" : "light",
        viewModeEnabled: readonly,
        excalidrawAPI: (a: ExcalidrawImperativeAPI) => {
          api = a;
          apiReady = true;
          // The library reports its loading state when it hands the API over,
          // so on the library this returns; it seeds a board whose library is
          // past its init when the API arrives.
          seed();
        },
        onChange: onLibraryChange,
        onPointerUpdate: (p: {
          pointer: { x: number; y: number; tool: string };
        }) => {
          if (!session || !api) return;
          const sel = api.getAppState().selectedElementIds;
          const ids = Object.keys(sel).filter((k) => sel[k]);
          session.sendCursor(
            p.pointer.x,
            p.pointer.y,
            p.pointer.tool,
            ids.length > 0 ? ids : undefined,
          );
        },
      }),
    );
  }

  onMount(async () => {
    // Set the asset path before the package loads so the font registry
    // resolves label fonts from the self-hosted bundle, not the CDN.
    configureExcalidrawAssets();
    const [reactDom, r, e] = await Promise.all([
      import("react-dom/client"),
      import("react"),
      import("@excalidraw/excalidraw"),
    ]);
    if (!host) return; // tab closed while the chunk loaded
    react = r;
    ex = e;
    root = reactDom.createRoot(host);
    renderExcalidraw();
  });

  // Theme follows the app surface and view mode follows the tab, which is
  // read only while it loads. Both props are controlled, so a re-render (not
  // updateScene) is what applies them; the React root is reused and the
  // scene survives. Reads dark and readonly only, so an external content
  // change does not trigger a re-render here.
  $effect(() => {
    void dark;
    void readonly;
    if (root) renderExcalidraw();
  });

  // The tab's buffer or its load changed. A load in flight unseeds the board
  // and leaves the drawing on screen (the board is in view mode while its
  // tab loads); a finished load, or a buffer change the board did not make
  // (a reload, a 409 resolution, a sibling pane's mirror), seeds it again.
  // Our own serializations come back as the buffer and are skipped.
  $effect(() => {
    const c = content;
    if (!loaded) {
      seeded = false;
      return;
    }
    if (seeded && c === lastSerialized) return;
    seeded = false;
    seed();
  });

  /// Move keyboard focus into the board, the canvas analogue of the
  /// editor caret-grab on tab activation.
  export function focusCanvas(): void {
    host?.focus();
  }

  export function flushPendingEdits(): void {
    if (serializeTimer === null) return;
    clearTimeout(serializeTimer);
    flushSerialize();
  }

  onDestroy(() => {
    flushPendingEdits();
    root?.unmount();
    root = null;
    api = null;
  });
</script>

<div class="excalidraw-shell" class:offscreen={!active}>
  <div class="excalidraw-host" bind:this={host} tabindex="-1"></div>
</div>

<style>
  .excalidraw-shell {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }
  :global(.chan-page-capped) .excalidraw-shell {
    background: var(--page-shade);
  }
  /* WKWebView leaks the composited Excalidraw zoom/undo Island (the
     .layer-ui__wrapper__footer, a plain absolute z-index-4 layer inside
     the React root with no portal, position:fixed, or visibility override)
     through an ancestor's visibility:hidden, so an inactive board keeps
     painting its footer over the active tab. Canvas tabs hold no CodeMirror
     or xterm, so the keep-alive contract's pre-layout reason does not apply
     here; display:none is safe and Excalidraw re-measures on unhide. Do not
     generalize this to editor/terminal tabs. */
  .excalidraw-shell.offscreen {
    display: none;
  }
  .excalidraw-host {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: min(100%, var(--chan-page-max-width, 100%));
    transform: translateX(-50%);
    background: var(--bg);
    outline: none;
    overflow: hidden;
  }
</style>
