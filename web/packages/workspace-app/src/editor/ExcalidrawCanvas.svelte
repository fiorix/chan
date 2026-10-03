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

  /// A parsed scene's elements with each element after the first of a
  /// repeated id under an id of its own: the repeated id, a dash and the
  /// element's place among its repeats, counted on past any id the scene
  /// holds. It is a function of the scene alone, so every seed of one buffer
  /// puts the same ids on the board, in every window. The library's restore
  /// gives such an element a random id at each call, and the authority keeps
  /// the first element of a repeated id only, so a board seeded twice would
  /// offer its session one element under two ids and the file would gain a
  /// copy. The first element keeps the id, as it does at the authority.
  export function distinctIds<T>(elements: readonly T[]): readonly T[] {
    const idOf = (el: T): string | null => {
      const id = (el as { id?: unknown } | null)?.id;
      return typeof id === "string" ? id : null;
    };
    const held = new Set<string>();
    let repeated = false;
    for (const el of elements) {
      const id = idOf(el);
      if (id === null) continue;
      if (held.has(id)) repeated = true;
      held.add(id);
    }
    if (!repeated) return elements;
    const seen = new Set<string>();
    const places = new Map<string, number>();
    return elements.map((el) => {
      const id = idOf(el);
      if (id === null) return el;
      if (!seen.has(id)) {
        seen.add(id);
        return el;
      }
      let place = places.get(id) ?? 1;
      let derived: string;
      do {
        place += 1;
        derived = `${id}-${place}`;
      } while (held.has(derived));
      places.set(id, place);
      held.add(derived);
      return { ...el, id: derived };
    });
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
  let failureBoundary: unknown = null;
  let libraryFailed = $state(false);
  /// Set by the board's first seed and never cleared. The library is past
  /// its init then, whose apply replaces every element put on the board
  /// before it, so the session binds from here on and its replay stays on
  /// the board. A later reseed keeps the binding it has and replays nothing
  /// over the buffer it put there, which could bring back an element that
  /// buffer deleted.
  let seededOnce = $state(false);

  // The scene the board and the buffer last agreed on: nothing until the
  // board is seeded, then the library's serialization of each seed and of
  // each change published since. Distinguishes our own serialized output
  // from an external buffer write (reload, 409 resolution, sibling-pane
  // mirror) so we neither reparse bytes we just emitted nor dirty the tab on
  // a write we did not make. Mirrors CsvTable's lastSerialized guard.
  let lastSerialized: string | null = null;

  // The image elements of the scene `lastSerialized` holds, by id, as copies,
  // since the library changes an element in place. `decodeMarks` reads them.
  let baselineImages = new Map<string, Record<string, unknown>>();

  // The appState the canvas has handed to the board and the library does
  // not show yet. `updateScene` shows an appState only at the library's next
  // render, so every serialization, the baseline's and the flush's alike,
  // lays this over what the library reports. A key leaves it once the
  // library shows another value for it than `shownAtHand` holds, which is
  // what the library showed when the key was handed: the handed value by
  // then, or one the user picked after it. A change the library reports
  // before that, as a click's or a key's own render does, leaves the key
  // here. It holds what came out of the serializer, so it names no key.
  let handedAppState: Record<string, unknown> | null = null;
  let shownAtHand: Record<string, unknown> | null = null;

  // Seeded: the library, past its own init (whose apply replaces every
  // element set before it), holds the whole buffer of a finished load as
  // its init would restore it: the elements, the files, and the appState
  // its serializer keeps; a file whose id the board already holds keeps its
  // bytes. `lastSerialized` holds the library's serialization of it. Only a
  // seeded board publishes, and the serialization a seed takes is the
  // baseline rather than an edit, so a board nobody drew on writes nothing:
  // neither the empty or partial scene of a load in flight nor the library's
  // rewrite of a file it did not write (its indentation, its `source`, the
  // fields it restores), nor its mark on an image whose file fails to decode,
  // which it sets after the load and which joins the baseline unpublished.
  // Set by `seed`; cleared when a load starts or the buffer
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
  /// Ids of the images whose copy at that version carries no decode mark of
  /// the library's. An entry is read only beside its version.
  const unmarkedAtAuthority = new Set<string>();
  /// File ids the authority already knows (pushed by us or fanned in).
  const knownFiles = new Set<string>();
  /// Cleaned appState from the latest serialize or adopt with its canonical
  /// JSON, plus the canonical JSON of the appState the authority is known to
  /// hold or the session holds as this window's claim (from our last offer OR
  /// any adopted snapshot/update, taken as the serializer keeps it). Only a
  /// divergence from that baseline rides a push: adopting an incoming
  /// appState must move the baseline too, or the echo would re-push forever
  /// between two live canvases.
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

  /// Keep `appState` as handed to the board, with what the library shows for
  /// each of its keys now. Called before the `updateScene` that hands it. A
  /// key the library already shows as handed has nothing to wait for, and a
  /// key handed again keeps what the library showed the first time.
  function hand(a: ExcalidrawImperativeAPI, appState: Record<string, unknown>): void {
    const shown = a.getAppState() as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(appState)) {
      if (handedAppState && key in handedAppState) {
        handedAppState[key] = value;
      } else if (canonicalJson(shown[key]) !== canonicalJson(value)) {
        (handedAppState ??= {})[key] = value;
        (shownAtHand ??= {})[key] = shown[key];
      }
    }
  }

  /// Drop each handed key the library now shows another value for than it
  /// showed when the key was handed.
  function dropShownAppState(a: ExcalidrawImperativeAPI): void {
    if (!handedAppState || !shownAtHand) return;
    const shown = a.getAppState() as unknown as Record<string, unknown>;
    for (const key of Object.keys(handedAppState)) {
      if (canonicalJson(shown[key]) === canonicalJson(shownAtHand[key])) continue;
      delete handedAppState[key];
      delete shownAtHand[key];
    }
    if (Object.keys(handedAppState).length === 0) handedAppState = shownAtHand = null;
  }

  function allElements(): Record<string, unknown>[] {
    if (!api) return [];
    return api.getSceneElementsIncludingDeleted() as unknown as Record<string, unknown>[];
  }

  /// Record `elements` as the authority's: the version of each, and whether
  /// an image's copy carries the library's decode mark.
  function noteAuthority(elements: readonly Record<string, unknown>[]): void {
    noteVersions(lastBroadcast, elements);
    for (const el of elements) {
      if (typeof el.id !== "string") continue;
      if (el.type === "image" && el.status !== "error") unmarkedAtAuthority.add(el.id);
      else unmarkedAtAuthority.delete(el.id);
    }
  }

  /// The board's elements a push offers: each whose version differs from the
  /// authority's, but for an image that differs from the authority's copy by
  /// the library's decode mark alone. The library sets that mark by itself on
  /// every image of a file that fails to decode, a deleted image too, in a
  /// copy one version on, and its reconcile keeps that copy against the
  /// authority's older one. The test reads what the authority holds, so it
  /// stands through every adopt: the image is offered with the user's next
  /// change to it, and whole while the authority does not hold the copy the
  /// mark was set on.
  function pendingDeltas(): Record<string, unknown>[] {
    return sceneDeltas(allElements(), lastBroadcast).filter((el) => {
      const id = el.id as string;
      return !(
        el.type === "image" &&
        el.status === "error" &&
        unmarkedAtAuthority.has(id) &&
        lastBroadcast.get(id) === Number(el.version) - 1
      );
    });
  }

  /// What the library keeps of `appState` when it restores a scene holding
  /// it and serializes that scene: the grid and the background, each at the
  /// library's default where `appState` lacks it, and the grid's size and step
  /// also at the default where they are not finite numbers, then rounded and
  /// clamped to 1..100. The seed takes the same of a buffer's.
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
    if (kept !== undefined) hand(api, kept);
    api.updateScene({
      elements: reconciled,
      ...(kept !== undefined ? { appState: kept } : {}),
      captureUpdate: ex.CaptureUpdateAction.NEVER,
    } as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]);
    // Equal canvas/broadcast versions afterwards mean the remote value
    // won (never re-push it); a surviving newer local element stays
    // unequal and pushes through the normal delta path, which leaves out a
    // copy that is newer by the library's decode mark alone.
    noteAuthority(elements);
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
      // library's next render, so until the library shows it every
      // serialization lays it over the board's earlier one, as for a seed,
      // and it is what the next push offers: a push made before that, from a
      // timer, a close or the session right after this frame, sends nothing
      // older over it.
      cleanedAppState = kept;
      cleanedAppStateJson = lastAuthorityAppStateJson = canonicalJson(kept);
    }
  }

  /// Hand pending local deltas to the session: the elements `pendingDeltas`
  /// answers, file entries the authority has not seen, and the cleaned
  /// appState when it changed. A board that has not taken its first seed
  /// holds what the library's handover or init put there, none of it the
  /// user's, so it offers nothing, as it binds nothing.
  function pushDeltas(): void {
    if (!api || !session || !seededOnce) return;
    const deltas = pendingDeltas();
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
    // The session keeps an offered appState as this window's claim whether
    // or not it took the push, and offers it again itself after a reattach,
    // so the baseline moves at the offer: the board keeps no second copy to
    // offer, and its next change is compared with what the session holds.
    if (appState !== undefined) lastAuthorityAppStateJson = cleanedAppStateJson;
    // What follows records "the authority has this", so it runs only when
    // the session took the push. A refused one leaves the elements and the
    // files unmarked for the next flush; marking them first is how a shape
    // drawn while the channel was down was never pushed again. A snapshot
    // adopted before that flush marks what it holds, so after a reattach the
    // elements and files the snapshot lacks are offered.
    if (!taken) return;
    noteAuthority(deltas);
    for (const k of Object.keys(newFiles)) knownFiles.add(k);
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
      return pendingDeltas().length > 0;
    },
    flushPendingLocal() {
      pushDeltas();
    },
    forgetBroadcast(elements, files) {
      // The push was claimed and then discarded, with its socket or at the
      // next socket's first snapshot, and whether the authority read it is not
      // known. Dropping each mark offers its part again unless the snapshot
      // adopted next marks it: the elements in `pendingDeltas`, the files in
      // the `newFiles` scan.
      for (const el of elements) {
        const id = (el as { id?: unknown }).id;
        if (typeof id === "string") lastBroadcast.delete(id);
      }
      if (files !== undefined) {
        for (const k of Object.keys(files)) knownFiles.delete(k);
      }
    },
  };

  // Bind the session once the board has taken its first seed, and bind again
  // whenever the session prop changes: when the session is replaced, and when
  // the prop goes through null and back, as at a reload. bindCanvas replays
  // the session's scene, where every frame that came before the bind waits.
  // The replay reads the roster and the tab, and a change of either needs no
  // replay (the roster hook repaints the names, and a push reads the tab when
  // it is made), so the call is untracked and the bind depends on the prop
  // and the latch alone. A first seed at the library's change runs in the
  // library's task and this effect in the microtask after it; one the content
  // effect makes, when a load ends after the init, is followed by this effect
  // in a later pass of the same flush. No socket frame lands between the two.
  $effect(() => {
    const s = session;
    if (!s || !seededOnce) return;
    untrack(() => s.bindCanvas(binding));
    return () => s.unbindCanvas(binding);
  });

  /// The buffer as a scene for the library's restore, at its init and at
  /// every seed, with the ids `distinctIds` gives its elements.
  function parseScene(json: string): ExcalidrawInitialDataState | null {
    if (!json.trim()) return null;
    try {
      const scene = JSON.parse(json) as ExcalidrawInitialDataState | null;
      return Array.isArray(scene?.elements)
        ? { ...scene, elements: distinctIds(scene.elements) }
        : scene;
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

  type SceneElements = ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>;

  function serializeScene(
    a: ExcalidrawImperativeAPI,
    e: typeof import("@excalidraw/excalidraw"),
    elements: SceneElements = a.getSceneElements(),
  ): string {
    return e.serializeAsJSON(
      elements,
      { ...a.getAppState(), ...(handedAppState ?? {}) },
      a.getFiles(),
      "local",
    );
  }

  /// Take `json`, the board's serialization, as the scene the board and the
  /// buffer agree on.
  function setBaseline(a: ExcalidrawImperativeAPI, json: string): void {
    lastSerialized = json;
    baselineImages = new Map();
    for (const element of a.getSceneElements()) {
      if (element.type === "image") baselineImages.set(element.id, { ...element });
    }
  }

  /// The images the library has marked since the baseline as failing to
  /// decode, when `json` differs from the baseline by those marks alone, and
  /// null when it differs by anything else or by nothing. The library sets
  /// the mark by itself after a load, in a copy of the image whose version
  /// is one past the baseline's, so such a scene is no edit of the user's.
  function decodeMarks(
    a: ExcalidrawImperativeAPI,
    e: typeof import("@excalidraw/excalidraw"),
    json: string,
  ): Record<string, unknown>[] | null {
    if (json === lastSerialized) return null;
    const marks: Record<string, unknown>[] = [];
    const unmarked = a.getSceneElements().map((element) => {
      const before = baselineImages.get(element.id);
      if (
        element.type !== "image" ||
        element.status !== "error" ||
        !before ||
        before.status === "error" ||
        element.version !== Number(before.version) + 1
      ) {
        return element;
      }
      marks.push(element as unknown as Record<string, unknown>);
      return before as unknown as typeof element;
    });
    if (marks.length === 0) return null;
    return serializeScene(a, e, unmarked) === lastSerialized ? marks : null;
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
      appState: Record<string, unknown>;
    };
    hand(api, appState);
    api.updateScene({
      elements: scene.elements,
      appState,
      captureUpdate: ex.CaptureUpdateAction.NEVER,
    } as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]);
    const files = Object.values(scene.files);
    if (files.length > 0) api.addFiles(files);
    setBaseline(api, serializeScene(api, ex));
    seeded = true;
    seededOnce = true;
  }

  /// Every change the library reports. The first comes from its init, and
  /// none comes before it, so it is where a board whose buffer was loaded
  /// before the init finished is seeded. A change normally follows the render
  /// that shows what was handed before it, so what the library now shows is
  /// dropped first; a click's or a key's own render can report a change
  /// before that render, and what it does not show yet stays handed. A seed
  /// here hands its own after the drop.
  function onLibraryChange(): void {
    if (api) dropShownAppState(api);
    seed();
    scheduleSerialize();
  }

  function flushSerialize(): void {
    serializeTimer = null;
    if (!api || !ex) return;
    const json = serializeScene(api, ex);
    // A scene that differs from the baseline only by the library's marks on
    // images that failed to decode is no edit: it joins the baseline below
    // with nothing published. The push leaves such a mark out by its own
    // test, against what the authority holds.
    const marks = seeded ? decodeMarks(api, ex, json) : null;
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
    setBaseline(api, json);
    if (marks) return;
    onSceneChange(json);
    // A peer's edit reaches the buffer only here, and no push-ok follows
    // it. The session knows what of this board's the authority has not
    // taken: the elements, and the appState it holds as a claim.
    session?.bufferMirrored();
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
  function onLibraryFailure(): void {
    api = null;
    seeded = false;
    if (serializeTimer !== null) clearTimeout(serializeTimer);
    serializeTimer = null;
    libraryFailed = true;
  }

  function renderExcalidraw(): void {
    if (!root || !react || !ex || !failureBoundary || libraryFailed) return;
    root.render(
      react.createElement(failureBoundary, null, react.createElement(ex.Excalidraw, {
        ...(api ? {} : { initialData: parseScene(untrack(() => content)) }),
        theme: dark ? "dark" : "light",
        viewModeEnabled: readonly,
        excalidrawAPI: (a: ExcalidrawImperativeAPI) => {
          api = a;
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
      })),
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
    // Keep one boundary type for the root's lifetime, so a theme change
    // updates the existing board instead of remounting it.
    const DrawingBoundary = class extends r.Component<{ children: unknown }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      componentDidCatch(): void {
        onLibraryFailure();
      }
      render(): unknown {
        return this.state.failed ? null : this.props.children;
      }
    };
    failureBoundary = DrawingBoundary;
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

  /// Lay a recovery entry's scene over a live session's board as a local
  /// change, and answer whether it did: false means this is no such board,
  /// and the caller restores through the buffer, which reseeds the board.
  ///
  /// A live board holds its authority's scene, which a peer may have changed
  /// since the entry was written, so the entry is not put in its place. What
  /// it holds beyond that scene is taken: an element whose id the board
  /// lacks, or holds at a lower version, tombstones counted, and the files
  /// the board lacks. Each such element differs from what the authority is
  /// known to hold, so the flush below offers it. An element the board holds
  /// at the same or a higher version stays the board's, a peer's delete among
  /// them, and so does an element the entry lacks: the entry carries no
  /// tombstone, so one its user deleted cannot be told from one a peer added.
  /// The entry's appState is not taken: an appState is one value with no
  /// version, so the entry's cannot be told from an older one than the
  /// authority's.
  export function restoreOverScene(json: string): boolean {
    if (!api || !ex || !session || !seeded) return false;
    const scene = ex.restore(parseScene(json), null, null, { repairBindings: true });
    const held = new Map(api.getSceneElementsIncludingDeleted().map((el) => [el.id, el.version] as const));
    const beyond = scene.elements.filter((el) => (held.get(el.id) ?? -1) < el.version);
    api.updateScene({
      elements: ex.reconcileElements(
        api.getSceneElementsIncludingDeleted(),
        beyond as unknown as Parameters<typeof ex.reconcileElements>[1],
        api.getAppState(),
      ),
      captureUpdate: ex.CaptureUpdateAction.NEVER,
    } as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]);
    const files = Object.values(scene.files);
    if (files.length > 0) api.addFiles(files);
    if (serializeTimer !== null) clearTimeout(serializeTimer);
    flushSerialize();
    return true;
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
  {#if libraryFailed}
    <div class="excalidraw-failure" role="alert">The drawing library failed. Changes drawn since the board last paused may be lost. Switch to Source and back, or close and reopen the tab to reload the drawing.</div>
  {/if}
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
  .excalidraw-failure {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: grid;
    place-items: center;
    padding: 2rem;
    text-align: center;
    background: var(--bg);
    color: var(--text);
  }
</style>
