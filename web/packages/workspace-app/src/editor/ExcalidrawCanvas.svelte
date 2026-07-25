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
  import { onDestroy, onMount } from "svelte";
  import type {
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
  };
  let { content, dark, active = true, onSceneChange, session = null }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let root: import("react-dom/client").Root | null = null;
  let react: typeof import("react") | null = null;
  let ex: typeof import("@excalidraw/excalidraw") | null = null;
  let api: ExcalidrawImperativeAPI | null = null;
  /// Reactive mirror of "the imperative API exists", so the session
  /// bind effect re-runs once the async chunk delivers it.
  let apiReady = $state(false);

  // Last scene JSON we know the buffer holds. Distinguishes our own
  // serialized output from an external buffer write (reload, 409
  // resolution, sibling-pane mirror) so we neither reparse bytes we just
  // emitted nor dirty the tab on a write we did not make. Mirrors
  // CsvTable's lastSerialized guard. Captures the initial buffer on
  // purpose; the effects below track later content changes.
  // svelte-ignore state_referenced_locally
  let lastSerialized = content;

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
  /// Cleaned appState from the latest serialize, plus the JSON of the
  /// appState the authority is known to hold (from our last push OR any
  /// adopted snapshot/update). Only a divergence from that baseline
  /// rides a push: adopting an incoming appState must move the baseline
  /// too, or the echo would re-push forever between two live canvases.
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

  /// Fold authority content into the canvas. The local side of the
  /// reconcile includes deleted elements: a local tombstone must beat a
  /// slower remote update of the same element or a delete could
  /// resurrect during the push round-trip. The transaction never enters
  /// local undo (CaptureUpdateAction.NEVER).
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
    api.updateScene({
      elements: reconciled,
      ...(appState !== undefined ? { appState } : {}),
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
    if (appState !== undefined) {
      // Any adopted appState is the new authority baseline; only later
      // local divergence should ride a push.
      lastAuthorityAppStateJson = JSON.stringify(appState);
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
    noteVersions(lastBroadcast, deltas);
    for (const k of Object.keys(newFiles)) knownFiles.add(k);
    if (appState !== undefined) lastAuthorityAppStateJson = cleanedAppStateJson;
    session.pushScene(
      deltas as WireElement[],
      appState,
      hasFiles ? newFiles : undefined,
    );
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

  function flushSerialize(): void {
    serializeTimer = null;
    if (!api || !ex) return;
    const json = ex.serializeAsJSON(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
      "local",
    );
    if (session) {
      // The serialized envelope already carries the cleaned appState
      // (the exact object the classic save would persist); reuse it as
      // the push payload instead of re-cleaning by hand.
      try {
        const parsed = JSON.parse(json) as { appState?: WireAppState };
        cleanedAppState = parsed.appState ?? {};
        cleanedAppStateJson = JSON.stringify(cleanedAppState);
      } catch {
        // The buffer mirror below still runs; deltas push without
        // appState.
      }
      pushDeltas();
    }
    if (json === lastSerialized) return;
    lastSerialized = json;
    onSceneChange(json);
  }

  // withInitial mounts the scene on the first render; a themed re-render
  // omits it (excalidraw consumes initialData once, so re-passing would
  // be ignored anyway) to keep the drawn scene.
  function renderExcalidraw(withInitial: boolean): void {
    if (!root || !react || !ex) return;
    root.render(
      react.createElement(ex.Excalidraw, {
        ...(withInitial ? { initialData: parseScene(content) } : {}),
        theme: dark ? "dark" : "light",
        excalidrawAPI: (a: ExcalidrawImperativeAPI) => {
          api = a;
          apiReady = true;
        },
        onChange: scheduleSerialize,
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
    renderExcalidraw(true);
  });

  // Theme follows the app surface. The theme prop is controlled, so a
  // re-render (not updateScene) is what re-themes; the React root is
  // reused and the scene survives. Reads dark only, so an external
  // content change does not trigger a re-render here.
  $effect(() => {
    void dark;
    if (root) renderExcalidraw(false);
  });

  // External buffer change (reload, 409 resolution, sibling mirror):
  // load the new scene into the live board. Skipped for our own writes
  // via lastSerialized. Reads content only.
  $effect(() => {
    const c = content;
    if (c === lastSerialized) return;
    lastSerialized = c;
    if (!api) return;
    const scene = parseScene(c);
    api.updateScene({ elements: scene?.elements ?? [] });
    const files = scene?.files;
    if (files) api.addFiles(Object.values(files));
  });

  /// Move keyboard focus into the board, the canvas analogue of the
  /// editor caret-grab on tab activation.
  export function focusCanvas(): void {
    host?.focus();
  }

  onDestroy(() => {
    if (serializeTimer !== null) clearTimeout(serializeTimer);
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
