<script lang="ts">
  import { tick } from "svelte";
  import {
    Check,
    Clipboard,
    ClipboardPaste,
    EyeOff,
    MessageSquare,
    Pencil,
    Radio,
    Search,
    Users,
    X,
  } from "lucide-svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { SearchAddon } from "@xterm/addon-search";
  import { SerializeAddon } from "@xterm/addon-serialize";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { WebglAddon } from "@xterm/addon-webgl";
  import "@xterm/xterm/css/xterm.css";
  import { api, sessionWindowId, withTokenQuery } from "../api/client";
  import {
    createSocket,
    WS_CONNECT_DEADLINE_MS,
    WS_PING_MS,
    WS_READ_DEADLINE_MS,
    WS_RECONNECT_BACKOFF_MIN_MS,
    WS_RECONNECT_BACKOFF_MAX_MS,
  } from "../api/transport";
  import { installWakeGapDetector } from "../wakeGap";
  import {
    isTauriDesktop,
    readClipboardText,
    readDroppedPaths,
    writeClipboardText,
  } from "../api/desktop";
  import { isOsFileDrag, shellEscapePaths } from "../state/fileDropGuard";
  import { resolveTerminalColors } from "../state/paneColor";
  import { openExternalUrl } from "../editor/external_links";
  import {
    chordFor,
    currentOS,
    shouldEscapeTerminal,
    type OS,
  } from "../state/shortcuts";
  import {
    allTerminalTabs,
    applyTerminalSessionMetadata,
    applyGlobalTerminalName,
    broadcastTerminalInput,
    crossWindowBroadcastMembers,
    closeTab,
    clearTerminalSession,
    ensureTerminalKeyboardProtocol,
    dismissTerminalEnvironmentPrompt,
    failTerminalMetadataRename,
    isTerminalMoving,
    registerTerminalCancelSink,
    registerTerminalCloseSink,
    registerTerminalInputSink,
    registerTerminalMetadataSink,
    registerTerminalPromptSink,
    removeExplicitlyClosedTerminalTab,
    renameTerminalTab,
    reproveRestoredPrompt,
    resolveTerminalMetadataRename,
    resolvePromptCancelled,
    setTerminalBroadcastEnabled,
    setTerminalBroadcastTarget,
    toggleTerminalGroupBroadcast,
    setTerminalActivity,
    setTerminalActivityPulsing,
    setTerminalQueueDepth,
    resolvePendingPrompt,
    failPendingPrompt,
    setTerminalSession,
    setTerminalSubmitAgent,
    tabFocusPulse,
    terminalBroadcastMemberIds,
    terminalEnvironmentPromptDismissed,
    terminalMetadataDraft,
    terminalStaleEnvironmentVariables,
    terminalTabGroup,
    terminalTabName,
    setTerminalMetadataDraft,
    type PaneSide,
    type TerminalTab as TerminalTabState,
  } from "../state/tabs.svelte";
  import {
    workspace,
    currentPreferences,
    effectiveHybridSurfaceTheme,
    fileOps,
    scheduleSessionSave,
    setTransientStatus,
    surfaceThemeOverride,
    ui,
  } from "../state/store.svelte";
  import { terminalWsPath } from "../terminal/session";
  import { windowModeAllowsSnapshot } from "../state/windowMode";
  import {
    readTerminalSnapshot,
    writeTerminalSnapshot,
    clearTerminalSnapshot,
    MAX_ONE_SNAPSHOT_BYTES,
    SNAPSHOT_SCROLLBACK_LINES,
    type TerminalSnapshot,
  } from "../terminal/snapshotCache";
  import {
    PtyWriteTracker,
    type PtyWriteOrigin,
    type TerminalByteWriter,
    routeXtermData,
    shouldForwardGeneratedTerminalInput,
    terminalMessageBytes,
  } from "../terminal/connection";
  import {
    handleGhosttyShiftEnter,
    handleTerminalMetaKey,
    installKeyboardProtocolHandlers,
  } from "../terminal/keymap";
  import {
    handleTerminalClipboardChord,
    isTerminalCopyChord,
    isTerminalPasteChord,
    terminalClipboardKeyHandlerResult,
  } from "../terminal/clipboardChord";
  import { isHostOwnedChord } from "../terminal/hostChord";
  import { installTerminalReportGuards } from "../terminal/xtermReports";
  import { MouseModeFilter } from "../terminal/mouseModeFilter";
  import { installShiftSelectionBypass } from "../terminal/selectionBypass";
  import {
    loadGhosttyKit,
    terminalBackendFromPrefs,
    type GhosttyKit,
    type TerminalBackend,
  } from "../terminal/backend";
  import {
    alignGhosttyRendererToXterm,
    clearGhosttyRecycledGrid,
    gateGhosttyScrollbarClicks,
    installGhosttyCustomGlyphs,
    installGhosttyOverlayScrollbar,
    measureXtermCellDimensions,
  } from "../terminal/ghosttyCompat";
  import { GhosttyViewportController } from "../terminal/ghosttyViewport";
  import { Osc52Bridge } from "../terminal/osc52Bridge";
  import {
    DEFAULT_SECRET_MASK_SUFFIXES,
    TerminalSecretMasker,
  } from "../terminal/secretMasking";
  import { ReplayMaskScanBatch } from "../terminal/replayMasking";
  import type { Terminal as GhosttyTerminal } from "ghostty-web";
  import {
    refreshTerminalRows as refreshTerminalRowsImpl,
    shouldUseWebglRenderer,
    webglRendererOverride,
  } from "../terminal/renderer";
  import {
    createTrailingFitScheduler,
    proposeGhosttyDimensions,
    runTerminalFit,
    type FitLike,
  } from "../terminal/resize";
  import {
    clampScrollbackMb,
    scrollbackLinesFromMb,
    SCROLLBACK_MB_DEFAULT,
  } from "../terminal/scrollback";
  import type { SubmitAgent } from "../terminal/submitMode";
  import { uiConfirm } from "../state/confirm.svelte";
  import { clampMenu } from "./menuClamp";
  import { portal } from "./portal";
  import {
    closeTabMenu,
    openTabMenu,
    tabMenu,
  } from "../state/tabMenu.svelte";
  import RichPrompt from "./RichPrompt.svelte";
  import BubbleOverlay from "./BubbleOverlay.svelte";
  import {
    isRichPromptVisible,
    toggleRichPromptForTab,
    hideRichPromptForTab,
  } from "../state/richPrompt.svelte";
  import { surveyFor } from "../state/survey.svelte";

  let {
    tab,
    paneId,
    side = "a",
    active,
    focused,
  }: {
    tab: TerminalTabState;
    paneId: string;
    side?: PaneSide;
    active: boolean;
    focused: boolean;
  } = $props();

  // A survey is modal over this terminal. Centralizing the guard keeps every
  // xterm refocus path from stealing keyboard ownership while the card is up;
  // once the survey clears, the same calls legitimately restore the terminal.
  function focusTerminal(): void {
    if (surveyFor(tab.id)) return;
    term?.focus();
  }

  type ServerFrame =
    | { type: "ready"; cols: number; rows: number; cwd?: string | null; cwd_rel?: string | null }
    | {
        type: "session";
        id: string;
        seq: number;
        /// This session incarnation's epoch. A restart reuses the id but bumps
        /// it (and resets `seq`), so a cached scrollback snapshot whose
        /// generation no longer matches is discarded and the server full-replays.
        generation: number;
        missed_bytes?: number;
        bytes_since_focus?: number;
        /// MESSAGE depth of the shared write queue at attach time, so every
        /// (re)attach re-syncs the badge (the tab field is never persisted).
        queue_depth?: number;
        /// The `prompt_id`s still in THIS session's write queue, FIFO order,
        /// one per tail-bearing message. Lets a reloaded SPA re-prove its
        /// restored pending Rich Prompt message is still queued at position
        /// `index+1` (vs the anonymous `queue_depth`, which may count pokes
        /// from other windows). Always present (`[]` when none).
        queued_prompt_ids?: string[];
        /// Spawn-derived submit identity. Omitted by old servers and for
        /// shells or unknown launch commands.
        submit_agent?: SubmitAgent;
        /// Authoritative live metadata and immutable spawn provenance. The
        /// fields are optional only for compatibility with an older server.
        name?: string;
        group?: string;
        spawn_name?: string | null;
        spawn_group?: string | null;
      }
    | { type: "renamed"; name: string; group: string }
    | { type: "rename_failed"; message: string }
    | { type: "activity"; bytes_since_focus: number }
    /// Queue-visibility frames (server: routes/terminal.rs). `queue` carries
    /// the absolute LOGICAL MESSAGE depth on every change, so a drained batch
    /// of N `cs terminal write` notifications arrives as one N -> 0 step, not
    /// N frames; `prompt-ack` answers THIS socket's tagged `prompt` frame
    /// (queued=false: queue full, nothing enqueued); `prompt-delivered` fires
    /// when a tagged message leaves the queue for the PTY. Only Rich Prompt
    /// messages carry a tag, and a Rich Prompt is always its own turn, so a
    /// batch emits no `prompt-delivered` at all. Non-owners ignore unknown
    /// ids and read depth.
    | { type: "queue"; depth: number }
    | { type: "prompt-ack"; id: string; queued: boolean; depth: number }
    | { type: "prompt-delivered"; id: string; depth: number }
    /// Ack for a `cancel-prompt` recall (inline on the requesting socket, like
    /// `prompt-ack`). `removed:true` = the still-queued message was pulled
    /// before the PTY (safe to recall + edit); `removed:false` = it raced a
    /// drain and already delivered. Depth (when it changed) arrives via the
    /// existing `queue` frame, not here.
    | { type: "prompt-cancelled"; id: string; removed: boolean }
    | { type: "cwd"; cwd?: string | null; cwd_rel?: string | null }
    | { type: "resize"; cols: number; rows: number }
    | { type: "resize_other"; cols: number; rows: number }
    | { type: "closed"; reason: CloseReason }
    | { type: "exit"; code?: number }
    | { type: "error"; message?: string; reason?: string };

  type CloseReason = "idle" | "workspace" | "shutdown" | "explicit" | "capped" | "error";

  let host: HTMLDivElement | undefined = $state();
  let searchInput: HTMLInputElement | undefined = $state();
  let term: Terminal | GhosttyTerminal | null = null;
  let fit: FitAddon | FitLike | null = null;
  let search: SearchAddon | null = null;
  let serialize: SerializeAddon | null = null;
  // Visual-only masking owner for this xterm instance. Null on ghostty and
  // disposed with the terminal; the enabled bit is session-scoped per tab.
  let secretMasker: TerminalSecretMasker | null = null;
  let secretMaskingEnabled = $state(false);
  // Last cols value the masker scanned at; the resize handler rescans only
  // when cols actually changed.
  let resizeScanCols = 0;
  // Scrollback line cap captured at construction time from the
  // persisted MB budget so xterm.js gets a stable number. Held on
  // the component so the "copy scrollback" actions serialize the same
  // window that's actually in memory.
  let scrollbackLines = scrollbackLinesFromMb(SCROLLBACK_MB_DEFAULT);
  let ws: WebSocket | null = null;
  let unregisterTerminalMetadataSink: (() => void) | null = null;
  // Liveness + reconnect for the PTY socket: the watcher kit (constants
  // shared from transport.ts so the two cannot drift) applied to the one SPA
  // socket that had neither half. The app-level ping keeps an inbound pong
  // flowing through the gateway's idle bridge; the read-deadline force-closes
  // a half-open zombie so onclose runs; onclose redials with capped backoff
  // through the existing session/since/generation reattach.
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectBackoffMs = WS_RECONNECT_BACKOFF_MIN_MS;
  // Scrollback snapshot resume state. `pendingSnapshot` is a cache hit
  // loaded at connect time, primed into the xterm on the attach prelude only
  // when the server confirms the same generation + no missed bytes; otherwise
  // discarded for a full replay. `receivedSeq` tracks the server byte cursor
  // (prelude `seq` + live bytes since) so a capture knows where to resume from.
  // `serverGeneration` is the live session epoch (null until the first prelude).
  let pendingSnapshot: TerminalSnapshot | null = null;
  let receivedSeq = 0;
  let serverGeneration: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let status = $state<"closed" | "connecting" | "connected" | "exited">("closed");
  let statusDetail = $state("");
  let missedBytes = $state(0);
  let sessionClosedReason = $state<CloseReason | null>(null);
  let findOpen = $state(false);
  let findQuery = $state("");
  let sawSessionControl = false;
  let pendingPromptSeed = "";
  let promptSeedSent = false;
  let terminalCwdAbs: string | null = $state(null);
  let terminalCwdVirtual: string | null = $state(null);
  let webglRendererActive = false;
  let webglContextLossRetries = 0;
  const ptyWrites = new PtyWriteTracker();
  const customTerminalColors = $derived(
    resolveTerminalColors(currentPreferences()?.terminal_colors),
  );
  const replayMaskScans = new ReplayMaskScanBatch();
  // The writer handed to ptyWrites. On xterm this is the terminal
  // itself (its write callback fires off xterm's own queue). On
  // ghostty it is a SYNCHRONOUS wrapper: ghostty-web parses inside
  // write() synchronously and only defers the optional callback to
  // requestAnimationFrame, which STALLS in a backgrounded or headless
  // page -- a stalled callback would wedge the tracker's replay-origin
  // suppression window open and silently eat every ESC-prefixed input
  // (mouse reports, Alt+keys) until the next frame. ghostty emits its
  // device replies synchronously during write(), so firing the tracker
  // callback immediately keeps the origin window correct.
  let termWriter: TerminalByteWriter | null = null;
  // Mouse-capture refusal (Settings: terminal.mouse_capture, default on).
  // Non-null ONLY when the setting was off at start(); with the setting on
  // the filter does not exist on the write path at all, keeping the default
  // byte-for-byte identical to an unfiltered terminal.
  let mouseFilter: MouseModeFilter | null = null;
  // Terminal backend (Settings: terminal.ghostty, default xterm.js).
  // Read once in start() under the same spawn-time-only contract as the
  // scrollback / mouse_capture settings above it. The ghostty backend
  // swaps the parser/renderer for Ghostty's WASM engine; xterm-only
  // addons (search, serialize, web-links, WebGL) and xterm-internal
  // hooks (OSC guards, keyboard-protocol tracking, Shift-selection
  // bypass) stay on the xterm branch.
  let backend = $state<TerminalBackend>("xterm");
  // OSC 52 clipboard observer, non-null ONLY on the ghostty backend:
  // ghostty-web's WASM parser swallows OSC 52 with no JS hook, so the
  // clipboard copy rides this byte observer instead of xterm's
  // registerOscHandler (see osc52Bridge.ts). The xterm backend keeps
  // installTerminalReportGuards.
  let osc52Bridge: Osc52Bridge | null = null;
  // Single owner of Chan-initiated Ghostty viewport mutations (PTY-write
  // reconciliation plus the calibrated macOS pixel-scroll path), non-null
  // ONLY on the ghostty backend and disposed with the terminal.
  let ghosttyViewport: GhosttyViewportController | null = null;
  // Removes the gate that keeps ghostty-web's overlay scrollbar from claiming
  // clicks on the content beneath it while it is invisible. Non-null ONLY on
  // the ghostty backend, and only while the gate is installed.
  let ghosttyScrollbarClickGate: (() => void) | null = null;
  let hostResumeTimers: ReturnType<typeof setTimeout>[] = [];
  let hostResumeListenerCleanup: (() => void) | null = null;
  // Wall-clock-gap sleep/wake detector (shared `installWakeGapDetector`). See
  // installHostResumeListeners for why focus/pageshow/visibilitychange miss a
  // macOS display/system sleep in WKWebView; the detector catches it off the
  // wall clock instead.
  let disposeWakeGap: (() => void) | null = null;
  const trailingFit = createTrailingFitScheduler(() => {
    runTerminalFit(fit, term, (detail) => {
      statusDetail = detail;
    });
  });
  // While output arrives at an unfocused terminal the unseen-output
  // dot pulses; this timer flips it solid once output has been quiet
  // for ACTIVITY_PULSE_QUIET_MS.
  let activityPulseTimer: ReturnType<typeof setTimeout> | null = null;
  const ACTIVITY_PULSE_QUIET_MS = 700;
  let lastSessionSave = 0;
  let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const menuOpen = $derived(tabMenu.openForTabId === tab.id);
  const menuPos = $derived.by(() => {
    const a = tabMenu.anchor;
    if (!a) return { x: 0, y: 0 };
    return { x: Math.round(a.left), y: Math.round(a.bottom + 4) };
  });
  // Self appears at the top of the broadcast target list with a
  // "self" marker. Checking the self row sets `broadcastEnabled`
  // (this tab joins the broadcast group); other rows route to
  // `setTerminalBroadcastTarget`. The self row is the only knob that
  // controls THIS tab's participation (no umbrella on/off button).
  // Broadcast is group-scoped: the picker only lists terminals in this
  // tab's group, so you can only ever target same-group peers.
  const broadcastTargets = $derived(
    allTerminalTabs()
      .filter((t) => terminalTabGroup(t) === terminalTabGroup(tab))
      .sort((a, b) => {
        if (a.id === tab.id) return -1;
        if (b.id === tab.id) return 1;
        return 0;
      }),
  );
  const selectedBroadcastTargets = $derived(new Set(terminalBroadcastMemberIds(tab)));
  // Same-group terminals in OTHER windows of this tenant. Listed below the
  // local rows under an "other windows" label; toggling one routes through
  // the server to its owning window (group-wide selection spans windows).
  const crossWindowMembers = $derived(crossWindowBroadcastMembers(tab));
  // "Select All" / "Deselect All" reflects the WHOLE group across windows:
  // every local row (self via broadcastEnabled, others via selection) AND
  // every cross-window member's own broadcast toggle.
  const allBroadcastTargetsSelected = $derived(
    broadcastTargets.length + crossWindowMembers.length > 0 &&
      broadcastTargets.every((target) =>
        target.id === tab.id ? tab.broadcastEnabled : selectedBroadcastTargets.has(target.id),
      ) &&
      crossWindowMembers.every((m) => m.broadcast),
  );
  const metadataDraft = $derived(terminalMetadataDraft(tab));
  const metadataPending = $derived(Boolean(tab.terminalMetadataPending));
  const staleEnvironmentVariables = $derived(terminalStaleEnvironmentVariables(tab));
  const showStaleEnvPrompt = $derived(
    staleEnvironmentVariables.length > 0 && !terminalEnvironmentPromptDismissed(tab),
  );

  function updateTerminalMetadataDraft(field: "name" | "group", value: string): void {
    const draft = terminalMetadataDraft(tab);
    setTerminalMetadataDraft(
      tab,
      field === "name" ? value : draft.name,
      field === "group" ? value : draft.group,
    );
  }

  function submitTerminalMetadata(): void {
    if (tab.terminalMetadataPending) return;
    const draft = terminalMetadataDraft(tab);
    const proposedName = draft.name.trim() || "Terminal";
    const proposedGroup = draft.group.trim() || "default";
    if (proposedName === terminalTabName(tab) && proposedGroup === terminalTabGroup(tab)) {
      return;
    }
    renameTerminalTab(tab, draft.name, draft.group);
  }

  function clearTerminalMetadataSink(): void {
    const unregister = unregisterTerminalMetadataSink;
    unregisterTerminalMetadataSink = null;
    unregister?.();
  }

  function installTerminalMetadataSink(sessionId: string): void {
    clearTerminalMetadataSink();
    unregisterTerminalMetadataSink = registerTerminalMetadataSink(sessionId, ({ name, group }) =>
      send({ type: "rename", name, group }),
    );
  }
  $effect(() => {
    if (!host || term) return;
    void tick().then(start);
    return teardown;
  });

  $effect(() => {
    const unregisterInput = registerTerminalInputSink(tab.id, (data) => sendInput(data));
    const unregisterClose = registerTerminalCloseSink(tab.id, closeTerminalForTab);
    // Rich Prompt bubble -> this session's WS `prompt` frame -> the server-side
    // write queue (NOT sendInput's raw keystroke path).
    const unregisterPrompt = registerTerminalPromptSink(tab.id, sendPrompt);
    // Rich Prompt recall (ArrowUp at doc-start while queued) -> `cancel-prompt`.
    const unregisterCancel = registerTerminalCancelSink(tab.id, sendCancelPrompt);
    return () => {
      unregisterInput();
      unregisterClose();
      unregisterPrompt();
      unregisterCancel();
    };
  });

  $effect(() => {
    if (!focused) return;
    // Read the global tab-focus pulse so this effect re-runs on
    // chord-driven tab switches (Cmd+Shift+[/], Ctrl+Alt+1..9).
    // Without this dep, switching FROM another tab IN to the terminal
    // via chord doesn't pull keyboard focus reliably: the editor's
    // contenteditable retains the DOM focus and the next keystroke
    // damages the doc.
    tabFocusPulse.value;
    // The pane gaining focus runs the same fit + repaint recovery the
    // blur / active-flip paths use so WKWebView redraws any rows left
    // stale by the visibility flip. It does NOT clear the shared
    // texture atlas (see refreshTerminalRenderer): a per-focus atlas
    // clear would garble the sibling panes when the user moves focus
    // around the grid.
    recoverTerminalRendererAfterHostResume();
    setTerminalActivity(tab, false);
    sendFocusState();
    queueMicrotask(() => {
      // The Rich Prompt bubble owns the keyboard when it is open over this
      // (active) terminal; don't yank focus back to xterm or it would steal the
      // caret from the bubble's editor.
      if (active && isRichPromptVisible(tab.id)) return;
      focusTerminal();
    });
  });

  // Hiding the Rich Prompt bubble hands keyboard focus + cursor back to this
  // terminal. The hide arrives by three paths (the tab menu's Hide entry,
  // Cmd+Shift+P, and the bubble's own Escape); watching the visibility STATE
  // covers all three uniformly instead of patching each call site. The
  // focus-pulse effect above only re-runs on a tab switch, so it does not
  // observe a same-tab show->hide flip - hence this dedicated transition
  // watcher. `richPromptWasVisible` is a plain (non-reactive) tracker so the
  // effect acts on the show->hide edge and not on every active/focused
  // re-render. Guarded on active + focused so a background pane never steals
  // focus when its (out-of-view) bubble is toggled.
  let richPromptWasVisible = false;
  $effect(() => {
    const visible = isRichPromptVisible(tab.id);
    if (richPromptWasVisible && !visible && active && focused) {
      queueMicrotask(focusTerminal);
    }
    richPromptWasVisible = visible;
  });

  // When focus moves AWAY from this terminal to another pane, the
  // pane losing focus can paint stale in the desktop app's WKWebView:
  // its WebGL renderer leaves the canvas half-updated and a single
  // refresh does not always correct it. So run the SAME recovery the
  // host-resume / active-flip paths use (fit + repaint + delayed
  // re-fits) on blur too. The size is unchanged on a focus switch, so
  // the fit is a dimensional no-op; the value is the deferred repaint
  // pass WebKit needs. That recovery does NOT clear the shared
  // texture atlas (a per-focus clear would corrupt sibling panes); it
  // only repaints.
  $effect(() => {
    if (focused) return;
    // Relinquish keyboard focus when this terminal stops being the active
    // tab, so a newly opened editor (e.g. `cs open {path}`) actually gets the
    // keystrokes instead of the xterm textarea keeping `document.activeElement`.
    term?.blur();
    recoverTerminalRendererAfterHostResume();
    sendFocusState();
  });

  // An idle terminal (visible in its pane but NOT focused, or a
  // tab just switched to in a non-active pane) renders garbled until
  // the user clicks or resizes it. The tab uses `visibility: hidden`
  // (not `display: none`) while inactive, so the host keeps layout
  // dimensions, but xterm.js / the WebGL renderer can paint at a stale
  // size (or skip painting) while hidden and there is nothing to force
  // a re-fit + repaint when the tab becomes ACTIVE without also
  // becoming focused. The focus effect (above) covers focus changes
  // and the ResizeObserver covers size changes, but a pure
  // visibility flip on a tab switch hits neither. React to `active`
  // here: when it flips true and the terminal is live, run the same
  // fit + repaint + delayed re-fit recovery used for a host resume, so
  // the terminal converges on its real dimensions and repaints clean.
  // `active` is read first so the effect tracks it;
  // the `term` gate skips the initial mount (start() already fits).
  $effect(() => {
    if (!active) return;
    if (!term) return;
    recoverTerminalRendererAfterHostResume();
  });

  // Track the resolved terminal body theme so xterm.js' canvas
  // palette follows the per-surface override.
  $effect(() => {
    effectiveHybridSurfaceTheme("terminal");
    customTerminalColors;
    applyTerminalTheme();
  });

  function effectiveTerminalTheme(): "dark" | "light" {
    return customTerminalColors?.contrast ?? effectiveHybridSurfaceTheme("terminal");
  }

  function terminalSurfaceThemeOverride(): "dark" | "light" | undefined {
    return customTerminalColors?.contrast ?? surfaceThemeOverride("terminal");
  }

  function terminalTheme() {
    // Read CSS variables from `host` so the terminal surface's
    // `data-theme` override resolves before xterm paints.
    const styles = getComputedStyle(host ?? document.documentElement);
    const bg =
      customTerminalColors?.background ??
      (styles.getPropertyValue("--bg").trim() || "#1c1c1e");
    const text =
      customTerminalColors?.foreground ??
      (styles.getPropertyValue("--text").trim() || "#ebebf0");
    const cursor =
      customTerminalColors?.cursor ??
      (styles.getPropertyValue("--link").trim() || "#58a6ff");
    const base = {
      background: bg,
      foreground: text,
      cursor,
      selectionBackground: "rgba(88, 166, 255, 0.35)",
    };
    const effective = effectiveTerminalTheme();
    if (effective === "light") {
      return {
        ...base,
        black: "#24292f",
        red: "#cf222e",
        green: "#1a7f37",
        yellow: "#8a6300",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#4b5563",
        brightBlack: "#57606a",
        brightRed: "#a40e26",
        brightGreen: "#116329",
        brightYellow: "#6f4e00",
        brightBlue: "#0550ae",
        brightMagenta: "#6639ba",
        brightCyan: "#0a6b73",
        brightWhite: "#6e7781",
      };
    }
    return {
      ...base,
      black: "#0c0c0d",
      red: "#ff6b6b",
      green: "#6cd07a",
      yellow: "#e3b341",
      blue: "#58a6ff",
      magenta: "#b07dff",
      cyan: "#5dd8d8",
      white: "#d8d8de",
      brightBlack: "#6c6c70",
      brightRed: "#ff8585",
      brightGreen: "#8be89a",
      brightYellow: "#f2d16b",
      brightBlue: "#7dbdff",
      brightMagenta: "#c8a6ff",
      brightCyan: "#7df0f0",
      brightWhite: "#ffffff",
    };
  }

  function terminalSecretMaskColor(): string {
    return effectiveTerminalTheme() === "light" ? "#57606a" : "#6c6c70";
  }

  // Agents print truecolor secondary text tuned for dark backgrounds
  // (#999999 hints and summaries, #b1b9f9 selections, #ffc107 warnings);
  // on the light theme those land below 3:1 against the white background
  // and the palette cannot reach truecolor. 4.5 (WCAG AA) has xterm
  // darken only under-contrast foregrounds; 1 is the identity, keeping
  // dark rendering untouched. xterm-only: ghostty-web has no equivalent
  // option.
  function terminalMinimumContrastRatio(): number {
    return effectiveTerminalTheme() === "light" ? 4.5 : 1;
  }

  function applyTerminalTheme(): void {
    if (!term) return;
    term.options.theme = terminalTheme();
    if (backend === "xterm") {
      (term as Terminal).options.minimumContrastRatio =
        terminalMinimumContrastRatio();
    }
    secretMasker?.setColor(terminalSecretMaskColor());
  }

  function refreshTerminalRows(): void {
    refreshTerminalRowsImpl(term);
  }

  // Repaint the visible rows; do NOT clear the texture atlas.
  // xterm.js's WebGL renderer shares ONE process-global TextureAtlas
  // across every terminal pane, so clearing it from the pane the user
  // just moved to would rebuild the atlas out from under the SIBLING
  // panes still on screen and garble their glyphs. The addon-webgl
  // 0.19 renderer rebuilds the atlas itself for color / DPR / font /
  // options changes, so the focus / blur / active-flip / wake
  // recovery only needs a row repaint: term.refresh() redraws from
  // the existing good atlas with no cross-pane fallout.
  function refreshTerminalRenderer(): void {
    if (!term) return;
    requestAnimationFrame(() => {
      if (!term) return;
      refreshTerminalRows();
    });
    void document.fonts?.ready.then(() => {
      if (!term) return;
      refreshTerminalRows();
    });
  }

  function recoverTerminalRendererAfterHostResume(): void {
    if (!term) return;
    clearHostResumeTimers();
    queueFit();
    refreshTerminalRenderer();
    for (const delay of [50, 250]) {
      const timer = setTimeout(() => {
        hostResumeTimers = hostResumeTimers.filter(
          (candidate) => candidate !== timer,
        );
        queueFit();
        refreshTerminalRenderer();
      }, delay);
      hostResumeTimers.push(timer);
    }
  }

  function clearHostResumeTimers(): void {
    for (const timer of hostResumeTimers) clearTimeout(timer);
    hostResumeTimers = [];
  }

  function installHostResumeListeners(): void {
    if (hostResumeListenerCleanup) return;
    const onHostResume = () => recoverTerminalRendererAfterHostResume();
    const onVisibility = () => {
      if (document.visibilityState === "visible") onHostResume();
    };
    window.addEventListener("focus", onHostResume);
    window.addEventListener("pageshow", onHostResume);
    document.addEventListener("visibilitychange", onVisibility);
    // macOS screensaver / display + system sleep does NOT fire focus
    // / pageshow / visibilitychange in the desktop app's WKWebView
    // (the window stays "visible" + focused through the sleep), so the
    // listeners above never fire on wake and the WebGL renderer stays
    // glitchy until the user RESIZES a window (ResizeObserver ->
    // queueFit -> recovery). The shared wall-clock detector catches the wake
    // directly (a coarse interval firing far later than scheduled means JS
    // timers froze while the machine slept); on wake it runs the renderer
    // recovery the resize path proves works AND recycles a frozen PTY socket.
    // One detector per terminal so EVERY pane recovers at once, matching
    // "resize any window clears ALL terminals". (Pure display-only sleep that
    // does not freeze timers is not caught here; verify in chan-desktop --
    // WebKit-only.)
    disposeWakeGap = installWakeGapDetector(() => {
      recoverTerminalRendererAfterHostResume();
      recyclePtySocketAfterWake();
    });
    hostResumeListenerCleanup = () => {
      window.removeEventListener("focus", onHostResume);
      window.removeEventListener("pageshow", onHostResume);
      document.removeEventListener("visibilitychange", onVisibility);
      disposeWakeGap?.();
      disposeWakeGap = null;
      hostResumeListenerCleanup = null;
    };
  }

  // A machine sleep freezes the PTY socket into a half-open zombie: readyState
  // stays OPEN but the far end (through the gateway proxy) was torn down, so no
  // onclose fires and typed keys are swallowed. On a detected wake, force a
  // reconnect via the existing resume path (sessionId/since/generation), which
  // replays only the missed bytes -- no scrollback loss. A socket that is not
  // OPEN is already reconnecting (or intentionally closed); leave it alone.
  function recyclePtySocketAfterWake(): void {
    // The control terminal is a single-shot local runner owned by the desktop
    // exit watcher; a wake redial would mint a fresh session whose tenant
    // default re-runs the devserver connect script.
    if (ui.terminalControl) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      void connect();
    }
  }

  // The live WebGL context can be lost long after mount (GPU reset,
  // display sleep, a DPR change when the window moves between Retina
  // and non-Retina displays, tab backgrounding). WKWebView /
  // WebKitGTK (chan-desktop) drop it far more readily than Chrome.
  // Disposing the renderer and staying on the DOM renderer for the
  // rest of the session would permanently re-introduce the
  // box-drawing gap, so instead recreate the renderer on loss,
  // bounded by a small retry budget so a genuinely dead GPU settles
  // on the DOM renderer rather than thrashing recreate.
  const WEBGL_MAX_CONTEXT_LOSS_RETRIES = 3;
  let attachReplayActive = false;
  let suppressAttachReplayGeneratedReplies = false;

  function enableWebglRenderer(): void {
    // xterm-backend only: the ghostty backend paints through its own
    // canvas renderer, and the WebglAddon needs xterm internals.
    if (!term || backend !== "xterm") return;
    // WebKitGTK (the Linux desktop webview) does not reliably composite the
    // WebGL render layer while the page is idle: a write (paste, keystroke
    // echo) is drawn into the GL canvas but not presented to screen until a
    // later event wakes the compositor, so typed/pasted text appears to lag
    // and the cursor desyncs until the next keypress flushes it. The DOM
    // renderer paints through normal DOM mutation and has no such layer, so
    // stay on it on the Linux desktop. macOS WKWebView and every browser
    // composite the WebGL layer fine, so this is scoped to the Linux desktop
    // webview ONLY (where box-drawing glyphs fall back to the system font's,
    // with the lineHeight gap the WebGL customGlyphs path otherwise fills).
    // The env-level WEBKIT_DISABLE_DMABUF_RENDERER fix in linux_gui_stack.rs
    // is about webview creation, not this per-layer present stall.
    if (
      !shouldUseWebglRenderer(
        isTauriDesktop(),
        currentOS(),
        webglRendererOverride(),
      )
    ) {
      return;
    }
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webglRendererActive = false;
        webgl.dispose();
        if (term && webglContextLossRetries < WEBGL_MAX_CONTEXT_LOSS_RETRIES) {
          webglContextLossRetries += 1;
          // One [chan] line per budget slot consumed, so a tester
          // watching the webview console (Cmd+Opt+I in chan-desktop)
          // sees each loss + how many recreate attempts remain.
          console.warn(
            `[chan] xterm.js WebGL context lost; recreating renderer (attempt ${webglContextLossRetries}/${WEBGL_MAX_CONTEXT_LOSS_RETRIES}).`,
          );
          // The lost context is not usable synchronously inside the
          // loss callback; recreate on the next frame.
          requestAnimationFrame(() => enableWebglRenderer());
        } else {
          console.warn(
            "[chan] xterm.js WebGL context lost; budget exhausted, staying on the DOM renderer.",
          );
        }
      });
      (term as Terminal).loadAddon(webgl);
      webglRendererActive = true;
      // Repaint so a recreated renderer redraws the visible rows and
      // clears any garbled glyphs left behind by the lost context.
      refreshTerminalRenderer();
    } catch (err) {
      // Tauri webviews effectively always have WebGL; surface the
      // failure for the rare regression case but don't break mount.
      console.warn(
        "[chan] xterm.js WebGL renderer unavailable; falling back to DOM:",
        err,
      );
    }
  }

  async function start(): Promise<void> {
    if (!host || term) return;
    const terminalPrefs = currentPreferences()?.terminal;
    const rendererFontSize = terminalPrefs?.font_size ?? 14;
    // Scrollback honors the Settings MB budget. Read once here so a
    // settings change after spawn doesn't reach through and resize
    // the existing xterm.js buffer; the hint copy under the slider
    // names this spawn-time-only contract.
    scrollbackLines = scrollbackLinesFromMb(
      clampScrollbackMb(terminalPrefs?.scrollback_mb),
    );
    // Mouse capture honors the Settings toggle under the same spawn-time
    // contract: read once here, so flipping the setting later affects only
    // newly opened terminals (the hint copy says so). Absent field (older
    // server) means true, today's behavior.
    mouseFilter = (terminalPrefs?.mouse_capture ?? true)
      ? null
      : new MouseModeFilter();
    // The persisted flag seeds each fresh tab. The menu/launcher toggle only
    // changes this component instance, so a respawn returns to the config.
    secretMaskingEnabled = terminalPrefs?.secret_masking ?? false;
    const secretMaskSuffixes =
      terminalPrefs?.secret_mask_suffixes ?? DEFAULT_SECRET_MASK_SUFFIXES;
    // Backend honors the Settings toggle under the same spawn-time
    // contract (read once here; flipping it affects only newly opened
    // terminals). Absent field (older server) means xterm.js. The
    // ghostty kit lazy-loads ~420KB of WASM + JS only on this branch;
    // a failed load falls back to xterm.js rather than breaking the
    // spawn (fail-open, matching the mouse filter's philosophy).
    backend = terminalBackendFromPrefs(terminalPrefs);
    let ghosttyKit: GhosttyKit | null = null;
    if (backend === "ghostty") {
      try {
        ghosttyKit = await loadGhosttyKit();
      } catch (err) {
        console.warn(
          "[chan] ghostty-web failed to load; falling back to xterm.js:",
          err,
        );
        backend = "xterm";
      }
      // The wasm fetch yields: a teardown (or a restart racing it) may
      // have disposed this component while the load was in flight.
      if (!host || term) return;
    }
    // lineHeight is 1.2 (not xterm.js's 1.0 default) so multi-row
    // ASCII glyphs (e.g. the Claude Code splash cube, figlet output,
    // nethack tiles) render with the row separation a user gets from
    // iTerm; the 1.0 default packs ascender glyphs against the next
    // row's descenders. Cursor is a non-blinking block, matching
    // iTerm's defaults.
    //
    // Font chain, per OS. A single cross-platform chain cannot express
    // this: macOS and Windows each have a native mono the user already
    // reads code in, and naming those faces ahead of everything else is
    // the whole point of `os-default`. Linux has no such face. Whatever
    // fontconfig installed first wins there, in practice DejaVu Sans
    // Mono, which is wider and squarer than SF Mono, so the same
    // session renders materially differently from the macOS one. The
    // bundled Source Code Pro leads the Linux arm instead, which makes
    // it deterministic across distros and closer in colour to SF Mono.
    // `ui-monospace` must sit BEHIND the bundled face there: ahead of
    // it, it resolves to the fontconfig monospace and the bundled face
    // never wins.
    const FONT_CHAIN_OS_DEFAULT: Record<OS, string> = {
      mac: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace',
      windows:
        '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
      linux:
        '"Source Code Pro", ui-monospace, "DejaVu Sans Mono", "Liberation Mono", monospace',
    };
    // Opting into Source Code Pro promotes the bundled face to the head
    // of the same per-OS chain; the tail stays as the fallback if the
    // woff2 has not decoded yet. Spawn-time-only, like the scrollback
    // contract: existing terminals keep their font until session
    // restart.
    const SOURCE_CODE_PRO = '"Source Code Pro"';
    const osChain = FONT_CHAIN_OS_DEFAULT[currentOS()];
    const fontPref = currentPreferences()?.terminal?.font ?? "os-default";
    const fontFamily =
      fontPref === "source-code-pro" && !osChain.startsWith(SOURCE_CODE_PRO)
        ? `${SOURCE_CODE_PRO}, ${osChain}`
        : osChain;
    // Reset the negotiated keyboard-protocol state ONLY on a fresh spawn
    // (no surviving session to reattach to). Reattaching to a long-lived
    // PTY keeps the protocol the program already announced, since a
    // running agent won't re-announce after the reconnect; resetting here
    // is what regressed Shift+Enter -> newline into a plain submit.
    const keyboardProtocol = ensureTerminalKeyboardProtocol(
      tab,
      !tab.terminalSessionId,
    );
    if (backend === "ghostty" && ghosttyKit) {
      // Ghostty backend: Ghostty's WASM VT parser + its own canvas
      // renderer (no xterm addons exist for it). Options are limited to
      // ghostty-web's ITerminalOptions -- no lineHeight (its renderer
      // uses its own metrics), no macOptionIsMeta / tabStopWidth.
      const terminalHost = host;
      const ghosttyTerm = new ghosttyKit.Terminal({
        allowTransparency: false,
        cursorBlink: false,
        cursorStyle: "block",
        fontFamily,
        fontSize: rendererFontSize,
        ghostty: ghosttyKit.ghostty,
        scrollback: scrollbackLines,
        // Ghostty's default 100ms smooth scroll keeps a private animation
        // target that scrollToBottom() (called on every write away from
        // the bottom) never syncs; a write interleaved with a gesture then
        // resumes toward the stale target. Zero makes every viewport move
        // synchronous, matching xterm.js, so the controller's write-side
        // restore is the final word.
        smoothScrollDuration: 0,
        theme: terminalTheme(),
      });
      term = ghosttyTerm;
      // Ghostty's auto-hiding scrollbar is painted onto the content without
      // clearing it (see installGhosttyOverlayScrollbar), so the columns under
      // it stay readable and there is no gutter to hold back. Reserving width
      // here could not help in any case: the overlay is anchored to the canvas,
      // not to the host, so a narrower grid just moves the content it covers.
      // This FitLike keeps upstream's measurement and clamp behavior over the
      // whole content box.
      fit = {
        fit() {
          const metrics = ghosttyTerm.renderer?.getMetrics();
          if (!metrics) return;
          const style = window.getComputedStyle(terminalHost);
          const proposed = proposeGhosttyDimensions(
            {
              width: terminalHost.clientWidth,
              height: terminalHost.clientHeight,
            },
            {
              top: Number.parseInt(style.getPropertyValue("padding-top")) || 0,
              right:
                Number.parseInt(style.getPropertyValue("padding-right")) || 0,
              bottom:
                Number.parseInt(style.getPropertyValue("padding-bottom")) || 0,
              left: Number.parseInt(style.getPropertyValue("padding-left")) || 0,
            },
            metrics,
          );
          if (
            !proposed ||
            (proposed.cols === ghosttyTerm.cols &&
              proposed.rows === ghosttyTerm.rows)
          ) {
            return;
          }
          ghosttyTerm.resize(proposed.cols, proposed.rows);
        },
      };
      // OSC 52 rides the byte observer: ghostty-web's WASM parser
      // swallows the sequence and exposes no registerOscHandler
      // equivalent (see osc52Bridge.ts). Applied in writePtyOutput.
      osc52Bridge = new Osc52Bridge();
      // The viewport controller owns PTY-write reconciliation and the
      // calibrated macOS pixel-scroll claim for this terminal instance.
      const viewport = new GhosttyViewportController(ghosttyTerm, {
        os: currentOS,
        hasMouseTracking: () => ghosttyTerm.hasMouseTracking(),
        isAlternateScreen: () =>
          ghosttyTerm.buffer.active === ghosttyTerm.buffer.alternate,
        cellHeight: () => ghosttyTerm.renderer?.getMetrics().height ?? 0,
      });
      ghosttyViewport = viewport;
      // Sync-callback writer for the origin tracker (see termWriter).
      termWriter = {
        write: (bytes, done) => {
          viewport.write(bytes);
          done?.();
        },
      };
      // Wheel reporting shim: ghostty-web's capture-phase viewport
      // scroller stopPropagation()s the wheel before its own
      // InputHandler can report it, so SGR wheel-over-TUI reporting
      // never fires upstream (clicks do work). See handleGhosttyWheel.
      term.attachCustomWheelEventHandler(handleGhosttyWheel);
    } else {
      term = new Terminal({
        // xterm gates registerDecoration (plus the markers / unicode
        // namespaces) behind this flag; the search addon's decorated
        // find (runFind) throws without it and the find bar matches
        // nothing.
        allowProposedApi: true,
        allowTransparency: false,
        cursorBlink: false,
        cursorStyle: "block",
        fontFamily,
        fontSize: rendererFontSize,
        lineHeight: 1.2,
        macOptionIsMeta: true,
        minimumContrastRatio: terminalMinimumContrastRatio(),
        scrollback: scrollbackLines,
        tabStopWidth: 8,
        theme: terminalTheme(),
      });
      installTerminalReportGuards(term);
      installKeyboardProtocolHandlers(term, keyboardProtocol, sendGeneratedTerminalInput);
      const xtermFit = new FitAddon();
      fit = xtermFit;
      search = new SearchAddon({ highlightLimit: 1000 });
      serialize = new SerializeAddon();
      term.loadAddon(xtermFit);
      term.loadAddon(search);
      term.loadAddon(serialize);
      // Route terminal link clicks through the editor's external-open
      // path: a new browser tab on web, the OS default browser under
      // chan-desktop's Tauri webview. The default WebLinksAddon handler
      // is window.open(_blank), which under WKWebView either no-ops or
      // opens inside the app shell, so links highlighted on hover but the
      // click never reached a real browser. openExternalUrl also gates on
      // the scheme (http/https/mailto/tel).
      term.loadAddon(
        new WebLinksAddon((_event, uri) => {
          void openExternalUrl(uri);
        }),
      );
      termWriter = term;
    }
    term.open(host);
    if (backend === "ghostty") {
      const ghosttyTerm = term as GhosttyTerminal;
      // open() created the WASM terminal, which may have come back holding a
      // disposed terminal's screen (see clearGhosttyRecycledGrid). Erase it
      // before the metrics alignment repaints and before any PTY byte lands.
      clearGhosttyRecycledGrid(ghosttyTerm);
      const renderer = ghosttyTerm.renderer;
      const targetCell = measureXtermCellDimensions(
        host,
        fontFamily,
        rendererFontSize,
        1.2,
      );
      if (
        !renderer ||
        !targetCell ||
        !alignGhosttyRendererToXterm(
          renderer,
          targetCell,
          ghosttyTerm.cols,
          ghosttyTerm.rows,
        )
      ) {
        console.warn(
          "[chan] ghostty-web renderer metrics unavailable; using its native font spacing.",
        );
      }
      if (renderer && !installGhosttyCustomGlyphs(renderer)) {
        console.warn(
          "[chan] ghostty-web text hook unavailable; using font-rendered box glyphs.",
        );
      }
      if (renderer && !installGhosttyOverlayScrollbar(renderer)) {
        console.warn(
          "[chan] ghostty-web scrollbar hooks unavailable; its overlay erases the last columns it covers.",
        );
      }
      ghosttyScrollbarClickGate = gateGhosttyScrollbarClicks(ghosttyTerm, host);
      if (!ghosttyScrollbarClickGate) {
        console.warn(
          "[chan] ghostty-web mousedown hook unavailable; its overlay scrollbar claims clicks while hidden.",
        );
      }
    }
    if (backend === "ghostty") {
      host.addEventListener("keydown", onGhosttyHostChord, true);
    }
    if (backend === "xterm") {
      secretMasker = new TerminalSecretMasker(
        term as Terminal,
        secretMaskSuffixes,
        terminalSecretMaskColor(),
        secretMaskingEnabled,
        () => {
          // The masker logged and disabled itself; sync the toggle state so
          // the menu label stays truthful, and tell the user visibly.
          secretMaskingEnabled = false;
          setTransientStatus(
            "Secret masking stopped working in this terminal",
          );
        },
      );
      // Hold Shift to force a native selection while a TUI holds mouse
      // tracking, on every platform (xterm.js ignores Shift on macOS).
      // Must run after open(): the SelectionService it wraps is created
      // there. Unneeded under ghostty: its SelectionManager starts a
      // selection on every drag regardless of mouse-tracking state.
      installShiftSelectionBypass(term as Terminal);
      // The WebGL renderer makes xterm.js's built-in customGlyphs path
      // fire: under the default DOM renderer, box-drawing +
      // block-element characters fall through to the system font which
      // (with lineHeight: 1.2) renders with vertical gaps between
      // cells. The WebglAddon draws pixel-perfect glyphs into the cell
      // rectangle including the line-height padding, so ASCII tables +
      // pixel-art mascots render gap-free.
      //
      // WebGL initialisation throws on contexts where the browser
      // declined to allocate a WebGL context (rare on chan-desktop's
      // WKWebView / WebView2, but possible inside headless test
      // harnesses or odd Linux GPU setups), and the live context can
      // later be LOST. enableWebglRenderer() handles both: try/catch on
      // init, then recreate-on-loss (bounded) before settling on the
      // DOM renderer. See the helper for the WKWebView rationale.
      enableWebglRenderer();
    } else if (!focused) {
      // ghostty-web's open() auto-focuses its textarea (xterm waits for
      // the `focused` check at the end of start()). Blur back so a
      // background pane's spawn can't steal keyboard focus.
      term.blur();
    }
    refreshTerminalRenderer();
    installHostResumeListeners();
    // The custom-key-handler contracts are INVERTED between the
    // backends: xterm skips the keystroke when the handler returns
    // FALSE, ghostty-web skips it when the handler returns TRUE.
    // handleTerminalKeyEvent uses xterm's semantics except for the native
    // paste result prepared for this inversion; wrap it for ghostty so "chan
    // consumed this chord" maps to ghostty's "handled" on both backends while
    // paste still reaches ghostty-web's native-paste early-return.
    if (backend === "ghostty") {
      term.attachCustomKeyEventHandler((e) => !handleTerminalKeyEvent(e));
    } else {
      term.attachCustomKeyEventHandler(handleTerminalKeyEvent);
    }
    term.onData(handleXtermData);
    resizeScanCols = term.cols;
    term.onResize(({ cols, rows }) => {
      send({ type: "resize", cols, rows });
      // The PTY notification goes first: a whole-buffer rescan must not
      // delay the resize reaching the shell. Only a cols change reflows
      // wrapped groups; a rows-only resize leaves every decoration correct
      // by marker tracking.
      if (cols !== resizeScanCols) {
        resizeScanCols = cols;
        secretMasker?.scanAll();
      }
    });
    resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(host);
    // Measure before dialing so a fresh PTY starts at the renderer's real
    // grid. A hidden or unsettled host can make the fitter decline or throw;
    // runTerminalFit absorbs that and the connection still uses the defaults.
    runTerminalFit(fit, term, (detail) => {
      statusDetail = detail;
    });
    // This xterm is brand-new and EMPTY, so the attach below carries no
    // byte cursor and the server replays the session's full ring. A
    // carried-over cursor would make the server skip everything the
    // PREVIOUS xterm had seen, and that buffer died with term.dispose().
    void connect();
    if (focused) queueMicrotask(focusTerminal);
  }

  function clearLiveness(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // Re-arm the read-deadline: ANY inbound frame (PTY bytes, a pong, a queue /
  // activity frame, even an old server's unknown-variant error) proves the
  // socket is alive. On expiry, force it closed so the onclose redial runs --
  // a half-open zombie never fires onclose on its own.
  function armDeadline(): void {
    // The control terminal is a local loopback single-shot runner owned by the
    // desktop exit watcher; it never heartbeats or read-deadline-force-closes.
    if (ui.terminalControl) return;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      try {
        ws?.close();
      } catch {
        // Already CLOSING/CLOSED; the pending onclose still drives the redial.
      }
    }, WS_READ_DEADLINE_MS);
  }

  // The dial's own deadline: a socket stuck in CONNECTING produces no frame
  // and no onclose, so armDeadline (armed only on open) never covers it.
  // Writes the SAME deadlineTimer slot -- onopen's armDeadline supersedes it,
  // clearLiveness clears it with the rest.
  function armConnectDeadline(): void {
    // The control terminal is a single-shot local runner with no deadline
    // force-close: without this guard the no-op armDeadline in onopen would
    // leave this connect-deadline armed and close the healthy control socket.
    if (ui.terminalControl) return;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      try {
        ws?.close();
      } catch {
        // Already CLOSING/CLOSED; the pending onclose still drives the redial.
      }
    }, WS_CONNECT_DEADLINE_MS);
  }

  async function connect(): Promise<void> {
    if (!term) return;
    // Single-dial guard: an explicit (re)connect -- mount, wake recycle, a
    // restart -- supersedes any scheduled backoff redial, so exactly one dial
    // path is ever in flight for this tab.
    cancelReconnect();
    // Resolve the per-tenant `Terminal-N` default name BEFORE opening the WS,
    // so the session spawns with its final name (the cross-window roster and
    // `cs term list` then show it, not the local placeholder). Only for a
    // fresh auto-named terminal; a reattach already has its name + session.
    // Clear the flag first so a concurrent reconnect cannot re-fetch.
    if (!tab.terminalSessionId && tab.pendingGlobalName) {
      tab.pendingGlobalName = false;
      await applyGlobalTerminalName(tab);
      if (!term) return; // torn down during the fetch
    }
    closeSocket();
    status = "connecting";
    statusDetail = "";
    missedBytes = 0;
    sessionClosedReason = null;
    const reattaching = Boolean(tab.terminalSessionId);
    const liveResumeSince =
      reattaching && sawSessionControl && serverGeneration !== null
        ? receivedSeq
        : undefined;
    const liveResumeGeneration =
      liveResumeSince !== undefined ? (serverGeneration ?? undefined) : undefined;
    sawSessionControl = false;
    pendingPromptSeed = reattaching ? "" : (tab.seedInput ?? "");
    promptSeedSent = false;
    // Try to resume from either this live xterm or a cached scrollback
    // snapshot. Snapshot resume is only for a reattach to a known session AND
    // when the cached geometry still matches the live xterm -- a serialized
    // screen written into a different width reflows wrong (absolute cursor +
    // hard-wrap baked at the old cols).
    // On a live socket reconnect, the xterm instance still contains the screen
    // it had before the drop, so resume from the in-memory cursor. On a remount
    // or reload the xterm is brand-new; then only a cached snapshot may carry a
    // cursor, because its ANSI content is primed alongside the cursor.
    pendingSnapshot = null;
    let resumeSince: number | undefined;
    let resumeGeneration: number | undefined;
    if (liveResumeSince !== undefined) {
      resumeSince = liveResumeSince;
      resumeGeneration = liveResumeGeneration;
    } else {
      receivedSeq = 0;
      serverGeneration = null;
    }
    // Snapshot priming is xterm-only: the cached ANSI is a SerializeAddon
    // dump and the ghostty backend never captures one (serialize stays
    // null there), so a reattach under ghostty lets the server ring
    // replay restore the screen instead.
    if (resumeSince === undefined && reattaching && tab.terminalSessionId && backend === "xterm") {
      const cached = readTerminalSnapshot(tab.terminalSessionId);
      if (cached && cached.cols === term.cols && cached.rows === term.rows) {
        pendingSnapshot = cached;
        resumeSince = cached.lastSeq;
        resumeGeneration = cached.generation;
      }
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = withTokenQuery(
      terminalWsPath({
        cols: term.cols,
        rows: term.rows,
        tabName: terminalTabName(tab),
        tabGroup: terminalTabGroup(tab),
        windowId: sessionWindowId(),
        paneId,
        side,
        tabId: tab.id,
        sessionId: tab.terminalSessionId,
        since: resumeSince,
        generation: resumeGeneration,
        cwd: reattaching ? undefined : tab.cwd,
        command: reattaching ? undefined : tab.spawnCommand,
        env: reattaching ? undefined : tab.spawnEnv,
      }),
    );
    ws = createSocket(`${proto}//${window.location.host}${path}`);
    ws.binaryType = "arraybuffer";
    armConnectDeadline();
    ws.onopen = () => {
      status = "connected";
      statusDetail = `${term?.cols ?? 0}x${term?.rows ?? 0}`;
      // This connection's heartbeat: the app-level ping (client
      // `{"type":"ping"}` answered `{"type":"pong"}`, the watcher socket's
      // vocabulary) plus the read-deadline it feeds. `send` carries the
      // OPEN-only guard.
      armDeadline();
      // The control terminal is a single-shot local runner; it does not send
      // the heartbeat ping.
      if (!ui.terminalControl) {
        pingTimer = setInterval(() => send({ type: "ping" }), WS_PING_MS);
      }
      if (term) send({ type: "resize", cols: term.cols, rows: term.rows });
      sendFocusState();
    };
    ws.onmessage = async (event) => {
      // Any inbound frame proves the socket is live -- refresh the deadline
      // first, before decoding.
      armDeadline();
      const bytes = await terminalMessageBytes(event.data);
      if (bytes) {
        writePtyOutput(bytes, attachPtyWriteOrigin());
        // Advance the server byte cursor only for LIVE output: replay chunks
        // (between the `session` and `ready` frames) reconstruct history up to
        // the prelude `seq` we already adopted, so counting them would double.
        if (!attachReplayActive) receivedSeq += bytes.length;
        recordOutputActivity();
        maybeSeedPrompt();
        return;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "ready") {
        attachReplayActive = false;
        replayMaskScans.ready();
        suppressAttachReplayGeneratedReplies = false;
        statusDetail = `${frame.cols}x${frame.rows}`;
        terminalCwdAbs = frame.cwd ?? null;
        terminalCwdVirtual = frame.cwd_rel ?? null;
        recoverTerminalRendererAfterHostResume();
      } else if (frame.type === "session") {
        // The session id this tab held before adopting frame.id below. A
        // frame.id that differs is a fresh shell replacing the reaped session,
        // not a same-id live resume.
        const priorId = tab.terminalSessionId;
        const duplicateReplay = reattaching && !sawSessionControl;
        attachReplayActive = true;
        replayMaskScans.begin(() => secretMasker?.scanAll());
        suppressAttachReplayGeneratedReplies = duplicateReplay;
        sawSessionControl = true;
        // A successful attach proves the session + path healthy: reset the
        // backoff ramp.
        reconnectBackoffMs = WS_RECONNECT_BACKOFF_MIN_MS;
        // Adopt the server's byte cursor + epoch for this incarnation. Prime the
        // cached snapshot ONLY when the server confirms the SAME generation and
        // no ring bytes were lost: then the replay chunks that follow are just
        // the delta past the cached cursor and append cleanly on top. On any
        // mismatch the server has already fallen back to a full replay, so drop
        // the stale snapshot and let those chunks repaint from scratch. Written
        // inside the replay window so xterm's device-report replies stay
        // suppressed (see attachPtyWriteOrigin / connection.ts).
        serverGeneration = frame.generation;
        receivedSeq = frame.seq;
        // A fresh shell replacing this tab's session (frame.id changed) starts
        // with the xterm still holding a dead TUI's negotiated input modes.
        // Reset mouse tracking (including the 1015 urxvt format) and exit the
        // alt-screen before any replay so that leftover state does not leak
        // into the new shell. A same-id live resume keeps the running
        // program's modes untouched (mirrors the keyboard-protocol reset above,
        // which fires only on a fresh spawn).
        if (frame.id !== priorId) {
          writeParsedPtyOutput(
            new TextEncoder().encode(
              "\x1b[?1000;1002;1003;1004;1006;1015l\x1b[?1049l",
            ),
            "replay",
          );
        }
        if (
          pendingSnapshot &&
          frame.generation === pendingSnapshot.generation &&
          (frame.missed_bytes ?? 0) === 0
        ) {
          if (mouseFilter) {
            // A SerializeAddon snapshot captured in mouse mode carries the
            // mouse-enable DECSETs; route it through the same filter as
            // live output so a restore can't re-enter capture.
            const filtered = mouseFilter.push(
              new TextEncoder().encode(pendingSnapshot.ansi),
            );
            if (filtered.length) writeParsedPtyOutput(filtered, "replay");
          } else {
            writeParsedPtyOutput(
              new TextEncoder().encode(pendingSnapshot.ansi),
              "replay",
            );
          }
        }
        pendingSnapshot = null;
        // A session prelude supersedes any unconfirmed proposal from the
        // prior connection. Unregister before adopting a replacement id so
        // the old session's pending proposal can be failed accurately.
        clearTerminalMetadataSink();
        setTerminalSession(tab, frame.id);
        installTerminalMetadataSink(frame.id);
        applyTerminalSessionMetadata(tab, {
          name: frame.name ?? terminalTabName(tab),
          group: frame.group ?? terminalTabGroup(tab),
          spawnName: frame.spawn_name ?? null,
          spawnGroup: frame.spawn_group ?? null,
        });
        // Replace, including with undefined, on every session frame. Restart
        // and reattach preludes are authoritative for the current PTY life.
        setTerminalSubmitAgent(tab, frame.submit_agent);
        setTerminalActivity(tab, !focused && (frame.bytes_since_focus ?? 0) > 0);
        // Re-sync the queue badge on every (re)attach: the depth is absolute
        // server truth, never persisted client-side.
        setTerminalQueueDepth(tab, frame.queue_depth ?? 0);
        // Re-prove a RESTORED pending Rich Prompt message against the server's
        // authoritative queue (reload contract): re-lock + re-show it
        // with its position if still queued, clear it if it already drained.
        // Mutates tab state from this event handler (not a $derived); the
        // bubble's own onMount/$effect re-shows it when the view exists.
        reproveRestoredPrompt(tab, frame.queued_prompt_ids ?? []);
        scheduleTerminalSessionSave();
        missedBytes = Math.max(0, Math.floor(frame.missed_bytes ?? 0));
        status = "connected";
        statusDetail = `session ${frame.id.slice(0, 8)}`;
        if (missedBytes > 0) {
          term?.writeln(`\r\nterminal replay missed ${missedBytes} bytes`);
        }
      } else if (frame.type === "renamed") {
        if (tab.terminalSessionId) {
          resolveTerminalMetadataRename(
            tab.terminalSessionId,
            frame.name,
            frame.group,
          );
          scheduleTerminalSessionSave();
        }
      } else if (frame.type === "rename_failed") {
        if (tab.terminalSessionId) {
          failTerminalMetadataRename(tab.terminalSessionId, frame.message);
        }
      } else if (frame.type === "resize" || frame.type === "resize_other") {
        if (!active && term && (term.cols !== frame.cols || term.rows !== frame.rows)) {
          term.resize(frame.cols, frame.rows);
        }
        statusDetail = `${frame.cols}x${frame.rows}`;
      } else if (frame.type === "cwd") {
        terminalCwdAbs = frame.cwd ?? null;
        terminalCwdVirtual = frame.cwd_rel ?? null;
      } else if (frame.type === "activity") {
        setTerminalActivity(tab, !focused && frame.bytes_since_focus > 0);
      } else if (frame.type === "queue") {
        setTerminalQueueDepth(tab, frame.depth);
      } else if (frame.type === "prompt-ack") {
        setTerminalQueueDepth(tab, frame.depth);
        // queued ack: depth == the message's 1-based position; rejected ack
        // (queue full, nothing enqueued) carries the unchanged depth.
        resolvePendingPrompt(tab, frame.id, frame.queued ? "queued" : "rejected", frame.depth);
      } else if (frame.type === "prompt-delivered") {
        setTerminalQueueDepth(tab, frame.depth);
        resolvePendingPrompt(tab, frame.id, "delivered", frame.depth);
      } else if (frame.type === "prompt-cancelled") {
        // Recall ack. removed:true → the bubble unlocks + keeps the draft to
        // edit/resubmit; removed:false → it raced a drain (already delivered),
        // the bubble surfaces "already sent". The `queue` frame (if any)
        // updates the badge separately. Stale/foreign ids no-op in the helper.
        resolvePromptCancelled(tab, frame.id, frame.removed);
      } else if (frame.type === "closed") {
        sessionClosedReason = frame.reason;
        status = "exited";
        statusDetail = `session ended (${frame.reason})`;
        // The session (and its write queue) is gone: zero the badge and
        // fail any in-flight prompt so the bubble unlocks with its text.
        setTerminalQueueDepth(tab, 0);
        failPendingPrompt(tab);
        // The cached scrollback snapshot is keyed by this now-dead session id;
        // drop it so a closed terminal does not hold cache budget (a future
        // session gets a fresh id, so it would never be reused anyway).
        if (tab.terminalSessionId) clearTerminalSnapshot(tab.terminalSessionId);
        clearTerminalMetadataSink();
        clearTerminalSession(tab);
        if (frame.reason === "explicit") {
          // The user (or another window / `cs terminal close`) deleted this
          // terminal. Under Option A the dead tab vanishes automatically; if
          // the window is left with no durable content, the save below then
          // deletes its blob (terminal-only windows are ephemeral). Only
          // `explicit` removes the tab -- `idle`/`shutdown`/`workspace`/`error`
          // keep it (reconnect safety), and `exit` keeps it behind the
          // "press Ctrl+D to read output" affordance below.
          removeExplicitlyClosedTerminalTab(tab.id);
          // Call the store save directly (not the throttled
          // scheduleTerminalSessionSave) so the blob delete still fires after
          // this component unmounts with the removed tab.
          scheduleSessionSave();
        } else {
          scheduleTerminalSessionSave();
          term?.writeln(`\r\nsession ended (${frame.reason})`);
        }
      } else if (frame.type === "exit") {
        status = "exited";
        // A session restored across a server restart has no reapable child,
        // so its exit frame carries no code.
        statusDetail = frame.code == null ? "exited" : `exit ${frame.code}`;
        setTerminalQueueDepth(tab, 0);
        failPendingPrompt(tab);
        clearTerminalMetadataSink();
        clearTerminalSession(tab);
        scheduleTerminalSessionSave();
        term?.writeln(
          frame.code == null
            ? "\r\nprocess exited; press Ctrl+D to close this tab"
            : `\r\nprocess exited (${frame.code}); press Ctrl+D to close this tab`,
        );
      } else if (frame.type === "error") {
        const detail = frame.message ?? frame.reason ?? "unknown error";
        // Version skew: a server without the terminal heartbeat answers the
        // app-level ping with an unknown-variant error every ping interval.
        // It proves liveness like any inbound frame (already counted above);
        // do not splat it into the terminal.
        if (!detail.includes("unknown variant `ping`")) {
          statusDetail = detail;
          term?.writeln(`\r\nterminal error: ${detail}`);
        }
      }
    };
    ws.onclose = () => {
      clearLiveness();
      clearTerminalMetadataSink();
      // Socket gone: any in-flight prompt can no longer observe its
      // delivery -- fail it (bubble unlocks, keeps text, labels honestly;
      // the message may still be queued server-side). The badge zeroes and
      // re-syncs from the session frame on reconnect.
      failPendingPrompt(tab);
      setTerminalQueueDepth(tab, 0);
      // A transient dial failure never strands a resumable session: the id
      // survives so an offline/sleep window can still reattach the persisted
      // remote session on reconnect. Only the server's explicit `closed` /
      // `exit` frames clear the session id.
      if (status !== "exited") status = "closed";
      // Heal: redial with capped backoff through the reattach path. An exited
      // session stays down (the server ended it; the tab shows its exit
      // affordance) and the control terminal is a single-shot local runner that
      // never redials; everything else -- the gateway idle cut, a tunnel
      // bounce, the read-deadline forcing a zombie closed, a failed dial --
      // redials.
      if (status === "exited" || ui.terminalControl) return;
      statusDetail = "reconnecting";
      const delay = reconnectBackoffMs;
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, WS_RECONNECT_BACKOFF_MAX_MS);
      cancelReconnect();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };
    ws.onerror = () => {
      // The paired onclose owns session-budget accounting and the redial.
      statusDetail = "connection failed";
    };
  }

  function recordOutputActivity(): void {
    // Output arriving at an UNFOCUSED terminal is unseen: show the
    // dot and PULSE it while chunks keep coming. A
    // focused terminal is being watched, so no dot / pulse. Re-arm a
    // quiet-timer on every chunk; when output stops (no chunk within the
    // quiet window) the dot stops pulsing and goes SOLID, still unseen,
    // until the user focuses the tab (setTerminalActivity(false) clears
    // both).
    if (focused) return;
    setTerminalActivity(tab, true);
    setTerminalActivityPulsing(tab, true);
    if (activityPulseTimer) clearTimeout(activityPulseTimer);
    activityPulseTimer = setTimeout(() => {
      activityPulseTimer = null;
      setTerminalActivityPulsing(tab, false);
    }, ACTIVITY_PULSE_QUIET_MS);
  }

  function sendFocusState(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    send({ type: "focus", focused });
  }

  function maybeSeedPrompt(): void {
    if (!pendingPromptSeed || promptSeedSent) return;
    promptSeedSent = true;
    const seed = ` ${pendingPromptSeed}\x01`;
    tab.seedInput = undefined;
    setTimeout(() => {
      sendInput(seed);
      focusTerminal();
      scheduleTerminalSessionSave();
    }, 150);
  }

  function scheduleTerminalSessionSave(): void {
    const now = Date.now();
    const elapsed = now - lastSessionSave;
    if (elapsed >= 1000) {
      lastSessionSave = now;
      scheduleSessionSave();
      return;
    }
    if (sessionSaveTimer) return;
    sessionSaveTimer = setTimeout(() => {
      sessionSaveTimer = null;
      lastSessionSave = Date.now();
      scheduleSessionSave();
    }, 1000 - elapsed);
  }

  // Returns whether the frame went out (the WS was open). Callers that need to
  // retry a not-yet-connected terminal (the team lead bootstrap) read this.
  function send(frame: unknown): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  // Sync this terminal's broadcast toggle to the server whenever it changes
  // and on every (re)connect (the `status` dep re-fires the effect when the
  // socket comes up). The server uses it to gate the cross-window input fan
  // on the receiver's own toggle and to surface the state in the roster other
  // windows read. Reads `tab.broadcastEnabled` + `status` so Svelte re-runs
  // this on either change.
  $effect(() => {
    const on = tab.broadcastEnabled;
    if (status === "connected") {
      send({ type: "set-broadcast", on });
    }
  });

  // A side move keeps this component and PTY socket mounted. Update the
  // server's best-effort layout attachment without forcing a reconnect.
  $effect(() => {
    const currentPaneId = paneId;
    const currentSide = side;
    const currentTabId = tab.id;
    if (status === "connected") {
      send({
        type: "placement",
        pane_id: currentPaneId,
        side: currentSide,
        tab_id: currentTabId,
      });
    }
  });

  function sendInput(data: string): void {
    send({ type: "input", data });
  }

  function sendGeneratedTerminalInput(data: string): void {
    if (!shouldForwardGeneratedTerminalInput(ptyWrites)) return;
    sendInput(data);
  }

  /// Capture a bounded SerializeAddon snapshot of the current screen +
  /// scrollback into localStorage so the NEXT reload restores it instantly and
  /// the server only streams the delta past `receivedSeq`. Keyed by the
  /// server session id + its generation; a capture over the per-snapshot byte
  /// budget is dropped (the reattach falls back to a full replay) rather than
  /// evicting other terminals. Synchronous, for the pagehide/unload path.
  function captureSnapshot(): void {
    // A control terminal never persists scrollback: it carries the
    // CHAN_DEVSERVER_TOKEN= marker the desktop re-scrapes. The rule lives
    // in windowModeAllowsSnapshot so it is unit-testable without a mount.
    if (!windowModeAllowsSnapshot({ terminalControl: ui.terminalControl })) return;
    const sessionId = tab.terminalSessionId;
    if (!term || !serialize || !sessionId || serverGeneration === null) return;
    // Never throw out of a pagehide/beforeunload handler: this fires globally
    // (any navigation/unload, including unrelated downloads), so a serialize on
    // a mid-teardown xterm must degrade to "no snapshot", not an uncaught error.
    try {
      const lines = Math.min(scrollbackLines, SNAPSHOT_SCROLLBACK_LINES);
      const ansi = serialize.serialize({ scrollback: lines });
      if (!ansi || ansi.length > MAX_ONE_SNAPSHOT_BYTES) return;
      writeTerminalSnapshot(sessionId, {
        ansi,
        generation: serverGeneration,
        lastSeq: receivedSeq,
        cols: term.cols,
        rows: term.rows,
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.warn("[chan] terminal snapshot capture failed", e);
    }
  }

  // Persist a scrollback snapshot when the page is hidden/reloaded so the
  // reattach after the reload resumes from it. pagehide is the
  // mobile-safe variant; beforeunload covers desktop reloads. Synchronous --
  // async work in these handlers is unreliable.
  $effect(() => {
    const onHide = () => captureSnapshot();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  });

  // A control terminal never snapshots (guard above); also remove anything a
  // pre-guard build persisted for this session, on attach and on teardown.
  // Sessions a control window never reopens are covered by the load-time
  // sweep in pruneTerminalSnapshots.
  $effect(() => {
    const sessionId = tab.terminalSessionId;
    if (!ui.terminalControl || !sessionId) return;
    clearTerminalSnapshot(sessionId);
    return () => clearTerminalSnapshot(sessionId);
  });

  /// Rich Prompt + team-lead-identity submit path: send `data` over the existing
  /// terminal WS as a `prompt` frame so the server ENQUEUES it into this
  /// session's write queue (shared FIFO with `cs terminal write`) and applies
  /// the submit encoding when the agent is idle. Deliberately NOT `sendInput`
  /// (the raw keystroke path bypasses the queue). Returns whether the WS was
  /// open so the orchestrator can retry a freshly-spawned lead. `agent` picks
  /// the encoding (claude CSI, codex/opencode bracketed paste + CR, gemini
  /// split CR); omitted defaults to claude server-side. A Rich Prompt is its
  /// own agent turn: the notification batcher never folds it into a batch.
  /// `id` tags the message for prompt-ack / prompt-delivered tracking; omitted
  /// = fire-and-forget (the orchestrator's lead-identity prompt stays so).
  function sendPrompt(data: string, agent?: string, id?: string): boolean {
    return send({ type: "prompt", data, ...(agent ? { agent } : {}), ...(id ? { id } : {}) });
  }

  /// Rich Prompt recall: ask the server to pull a still-queued message out of
  /// this session's write queue by its `prompt_id`. The server replies with a
  /// `prompt-cancelled` ack (removed: true|false). Returns whether the WS was
  /// open.
  function sendCancelPrompt(id: string): boolean {
    return send({ type: "cancel-prompt", id });
  }

  // Rich Prompt: the right-click "Show/Hide Rich Prompt" entry mirrors the
  // `terminal.richPrompt` chord (App.svelte onWindowKey); the label comes
  // from the shortcut store so menu and keymap can't drift.
  const richPromptChord = chordFor("terminal.richPrompt") ?? "";
  function toggleRichPromptFromMenu(): void {
    closeTabMenu();
    toggleRichPromptForTab(tab.id);
  }

  function attachPtyWriteOrigin(): PtyWriteOrigin {
    return attachReplayActive && suppressAttachReplayGeneratedReplies ? "replay" : "live";
  }

  function writePtyOutput(bytes: Uint8Array, origin: PtyWriteOrigin = "live"): void {
    if (!term || !termWriter) return;
    // The mouse-capture refusal filters HERE, not at the ws.onmessage
    // callsite: receivedSeq must keep counting ORIGINAL frame bytes so the
    // server ring cursor / missed_bytes math never sees filtered lengths.
    if (mouseFilter) {
      bytes = mouseFilter.push(bytes);
      if (bytes.length === 0) return;
    }
    writeParsedPtyOutput(bytes, origin);
  }

  function writeParsedPtyOutput(
    bytes: Uint8Array,
    origin: PtyWriteOrigin,
  ): void {
    if (!term || !termWriter) return;
    // Ghostty backend only: observe (never alter) the stream for OSC 52
    // clipboard copies -- the WASM parser swallows them with no JS hook.
    osc52Bridge?.push(bytes);
    const masker = secretMasker;
    const completeMaskScan = replayMaskScans.track(
      attachReplayActive,
      () => masker?.captureWrite() ?? null,
      (snapshot) => masker?.scanWrite(snapshot),
    );
    // Keep the existing writer + origin ordering. Replay callbacks only drain
    // the batch; live callbacks still run their captured per-write scan.
    ptyWrites.write(termWriter, bytes, origin, completeMaskScan);
  }

  /// OS file dropped on this terminal: type the dropped files' absolute
  /// paths at the cursor, shell-escaped and space-separated (macOS
  /// Terminal behavior). The paths come from the desktop
  /// `read_dropped_paths` IPC -- the DOM File API never exposes OS
  /// paths -- so this is desktop-only by construction: in a plain
  /// browser (or a window kind whose ACL refuses the IPC)
  /// readDroppedPaths() resolves to [] and the drop is a silent no-op.
  /// preventDefault always: with the handler owning the drop, the
  /// webview must never fall through to its default drop-navigation.
  async function onTerminalFileDrop(e: DragEvent): Promise<void> {
    if (!isOsFileDrag(e)) return;
    e.preventDefault();
    const paths = await readDroppedPaths();
    const typed = shellEscapePaths(paths);
    if (typed) sendUserInput(typed);
  }

  function sendUserInput(data: string): void {
    sendInput(data);
    broadcastTerminalInput(tab, data);
    // Cross-window broadcast: same-group members in OTHER windows live in the
    // shared terminal registry and are unreachable from this window's SPA, so
    // the server fans the input to them. Same-window members are covered by
    // `broadcastTerminalInput` above.
    if (tab.broadcastEnabled) send({ type: "broadcast-input", data });
  }

  function handleXtermData(data: string): void {
    routeXtermData(data, ptyWrites, sendInput, sendUserInput);
  }

  /// Let unclaimed macOS Command chords reach the native host. ghostty-web
  /// handles keydown in the bubble phase and suppresses every encoded key, so
  /// this capture listener stops its handler without preventing the default
  /// WKWebView needs to hand the chord to AppKit.
  function onGhosttyHostChord(e: KeyboardEvent): void {
    const claimedByChan =
      shouldEscapeTerminal(e) ||
      isTerminalCopyChord(e, currentOS()) ||
      isTerminalPasteChord(e, currentOS());
    if (
      isHostOwnedChord(e, {
        os: currentOS(),
        claimedByChan,
      })
    ) {
      e.stopPropagation();
    }
  }

  /// Ghostty-backend wheel reporting. ghostty-web registers its
  /// viewport scroller capture-phase with an unconditional
  /// stopPropagation(), so its InputHandler's wheel reporter (SGR
  /// 64/65) never sees the event; the custom-wheel hook runs before
  /// the scroller and true claims the event. With mouse tracking
  /// active, encode the report through the same sendInput path an
  /// xterm report takes (terminal-generated, no broadcast fan-out) and
  /// claim the event. Without tracking, the viewport controller claims
  /// only the calibrated macOS pixel-mode primary-buffer case; every
  /// other event declines so ghostty keeps its native local scroll /
  /// alt-screen arrow behavior. Coordinates come from
  /// the canvas rect / live grid size (SGR coords are 1-based cells).
  function handleGhosttyWheel(e: WheelEvent): boolean {
    const t = backend === "ghostty" ? (term as GhosttyTerminal | null) : null;
    if (!t) return false;
    if (!t.hasMouseTracking()) {
      return ghosttyViewport?.handleWheel(e) ?? false;
    }
    const canvas = e.target as HTMLElement | null;
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return false;
    const cellW = rect.width / t.cols;
    const cellH = rect.height / t.rows;
    if (!(cellW > 0) || !(cellH > 0)) return false;
    const col = Math.min(t.cols, Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1));
    const row = Math.min(t.rows, Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1));
    // Modifier bits mirror xterm/ghostty-web: shift 4, alt 8, ctrl 16.
    const mods = (e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0);
    // Wheel reports are press-only (xterm repeats the press per notch);
    // 64 = up, 65 = down. SGR encoding when mode 1006 is set (and by
    // default, mirroring ghostty-web's hasSgrMouseMode fallback);
    // legacy X10 otherwise.
    const button = (e.deltaY < 0 ? 64 : 65) + mods;
    if (t.getMode(1006, false)) {
      sendInput(`\x1b[<${button};${col};${row}M`);
    } else {
      const ch = (v: number) => String.fromCharCode(Math.min(v + 32, 255));
      sendInput(`\x1b[M${ch(button)}${ch(col)}${ch(row)}`);
    }
    return true;
  }

  function queueFit(): void {
    requestAnimationFrame(() => {
      runTerminalFit(fit, term, (detail) => {
        statusDetail = detail;
      });
    });
    // Trailing-edge fit. ResizeObserver sometimes misses or swallows
    // the FINAL resize event of a drag gesture (a browser quirk: the
    // observer batches and can collapse intermediate sizes when the
    // host element transitions through layout-thrashing states like
    // `display: none` ↔ visible on tab switch). Without a
    // trailing-edge fit, the terminal stays at the size from
    // the FIRST observed resize tick instead of the FINAL pane
    // width. The rAF above handles the leading edge; the
    // debounced trailing fit below converges on the steady-
    // state size 120ms after the last observed change. Idempotent
    // when the size hasn't drifted: `fit.fit` short-circuits +
    // `term.resize` no-ops on identical cols/rows so no
    // spurious SIGWINCH lands on the PTY.
    trailingFit.schedule();
  }

  function closeSocket(): void {
    attachReplayActive = false;
    suppressAttachReplayGeneratedReplies = false;
    clearTerminalMetadataSink();
    // Intentional teardown: stop the heartbeat and any scheduled redial (the
    // handlers are detached below, so no onclose will re-arm them).
    clearLiveness();
    cancelReconnect();
    const s = ws;
    ws = null;
    if (!s) return;
    s.onopen = null;
    s.onclose = null;
    s.onerror = null;
    s.onmessage = null;
    try {
      s.close();
    } catch {
      // Already closed.
    }
  }

  function teardown(): void {
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    trailingFit.clear();
    clearHostResumeTimers();
    hostResumeListenerCleanup?.();
    if (activityPulseTimer) {
      clearTimeout(activityPulseTimer);
      activityPulseTimer = null;
    }
    closeSocket();
    replayMaskScans.reset();
    resizeObserver?.disconnect();
    resizeObserver = null;
    host?.removeEventListener("keydown", onGhosttyHostChord, true);
    ghosttyScrollbarClickGate?.();
    ghosttyScrollbarClickGate = null;
    secretMasker?.dispose();
    secretMasker = null;
    term?.dispose();
    term = null;
    termWriter = null;
    ptyWrites.reset();
    mouseFilter = null;
    osc52Bridge = null;
    ghosttyViewport = null;
    backend = "xterm";
    webglRendererActive = false;
    fit = null;
    search = null;
    serialize = null;
  }

  async function restart(): Promise<void> {
    closeTabMenu();
    if (tab.terminalSessionId) {
      const confirmed = await uiConfirm({
        title: "Restart terminal?",
        message:
          "The shell in this terminal will be killed and a fresh one started in its place. Any running command will be terminated.",
        confirmLabel: "Restart",
        destructive: true,
      });
      if (!confirmed) return;
    }
    if (tab.controlledTerminal && tab.terminalSessionId) {
      try {
        await api.restartTerminal(tab.terminalSessionId, {
          name: terminalTabName(tab),
          group: terminalTabGroup(tab),
          window_id: sessionWindowId(),
        });
        // A controlled restart reuses the session id but kills the old
        // shell and spawns a fresh one, so the negotiated keyboard
        // protocol no longer applies: reset it in place (same object the
        // installed parser handlers + key handler hold) so a fresh plain
        // shell doesn't inherit the killed agent's modifyOtherKeys. An
        // agent respawn simply re-announces on startup.
        ensureTerminalKeyboardProtocol(tab, true);
        status = "connecting";
        statusDetail = "restart requested";
      } catch (err) {
        statusDetail = `restart failed: ${(err as Error).message}`;
      }
      return;
    }
    explicitCloseSession();
    teardown();
    void tick().then(start);
  }

  function explicitCloseSession(): void {
    if (tab.terminalSessionId) {
      send({ type: "close" });
      clearTerminalMetadataSink();
      clearTerminalSession(tab);
      scheduleTerminalSessionSave();
    }
  }

  function closeTerminalForTab(): boolean {
    // A session-preserving cross-window MOVE removes the tab from THIS window
    // but the PTY must survive (it lives in the shared `/terminal` registry and
    // the target window re-attaches to it by id). So skip the WS `close` frame
    // that would kill the shell; just clear the local session binding so this
    // window's WS doesn't reconnect during teardown. Window-local cleanup
    // (Rich Prompt draft, bubble entry) below still runs - the tab is gone here.
    if (isTerminalMoving(tab.id)) {
      clearTerminalMetadataSink();
      clearTerminalSession(tab);
    } else {
      explicitCloseSession();
    }
    // Discard this terminal's Rich Prompt draft folder (draft.md + any pasted
    // media) so nothing leaks in Drafts: the bubble's draft is tied to
    // the terminal lifecycle. Best-effort + fire-and-forget; the tab is going
    // away regardless.
    if (tab.richPromptDraftPath) {
      void api.discardDraft(tab.richPromptDraftPath);
    }
    // Drop this terminal's per-terminal bubble-visibility entry so it does not
    // linger in the keyed map after the tab is gone.
    hideRichPromptForTab(tab.id);
    return true;
  }

  /// Scrollback text for the copy actions. The xterm backend serializes
  /// through the SerializeAddon (ANSI styling preserved). The ghostty
  /// backend has no serialize addon, so walk its WASM buffer and join
  /// the translated lines -- plain text, styling lost.
  function scrollbackText(): string {
    if (backend === "ghostty") {
      const buf = (term as GhosttyTerminal | null)?.buffer.active;
      if (!buf) return "";
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? "");
      }
      return lines.join("\n").trimEnd();
    }
    return serialize?.serialize({ scrollback: scrollbackLines }) ?? "";
  }

  async function copyScrollback(): Promise<void> {
    closeTabMenu();
    const text = scrollbackText();
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    focusTerminal();
  }

  async function copySelectionOrScrollback(): Promise<void> {
    closeTabMenu();
    const text = term?.getSelection() || scrollbackText();
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    focusTerminal();
  }

  function toggleSecretMasking(): void {
    closeTabMenu();
    if (backend !== "xterm") {
      setTransientStatus("Secret masking unavailable on ghostty backend");
      focusTerminal();
      return;
    }
    secretMaskingEnabled = !secretMaskingEnabled;
    secretMasker?.setEnabled(secretMaskingEnabled);
    setTransientStatus(
      `Secret masking ${secretMaskingEnabled ? "enabled" : "disabled"} for this terminal`,
    );
    focusTerminal();
  }

  // The right-click menu's "Paste" entry. A menu click is NOT an OS paste
  // gesture, so unlike Cmd+V (which rides xterm's native `paste` event) it must
  // read the clipboard programmatically. `readClipboardText` does that natively
  // in Rust under chan-desktop so it bypasses WKWebView's DOM-paste "Paste"
  // button; on web it falls back to the gesture-permitted navigator.clipboard.
  // Routing through `term.paste` keeps the menu path bracketed, matching Cmd+V.
  async function pasteClipboard(): Promise<void> {
    closeTabMenu();
    const text = await readClipboardText();
    if (text) term?.paste(text);
    focusTerminal();
  }

  // Keyboard copy (Cmd+C / Ctrl+Shift+C) copies the CURRENT SELECTION only.
  // A bare copy chord must never dump the whole scrollback - that is the
  // explicit "Copy Scrollback" menu action - so an empty selection is a
  // no-op, matching every native terminal. The menu's "Copy" stays
  // selection-or-scrollback because an explicit click wants a result.
  async function copySelectionToClipboard(): Promise<void> {
    const text = term?.getSelection() ?? "";
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    focusTerminal();
  }

  function openFind(): void {
    closeTabMenu();
    // The find bar runs on xterm's SearchAddon; there is no ghostty-web
    // search addon, so under the ghostty backend the bar stays closed
    // (the right-click menu entry is hidden too).
    if (backend !== "xterm") return;
    findOpen = true;
    void tick().then(() => searchInput?.focus());
  }

  /// New file OR directory at the terminal's CWD, the unified path prompt
  /// the file browser uses. The launcher's "New file or directory ($CWD)"
  /// command reaches this through the chan:command listener below.
  function openNewFsEntry(): void {
    const cwd = terminalCwdRel();
    if (cwd === null) return terminalCwdUnavailable();
    void fileOps.createFileOrDir(cwd);
  }

  /// Close, an explicit menu entry. `force: true` matches the chord
  /// path (`closeExitedTabFromKey`); the dirty-prompt path lives on
  /// the file editor, not here.
  function closeFromMenu(): void {
    closeTabMenu();
    void closeTab(paneId, tab.id);
  }

  function requestTerminalCwd(): void {
    send({ type: "cwd" });
  }

  function terminalCwdRel(): string | null {
    if (terminalCwdVirtual !== null) return terminalCwdVirtual;
    const abs = terminalCwdAbs;
    const root = workspace.info?.root;
    if (!abs || !root) return null;
    const normAbs = abs.replace(/\\/g, "/").replace(/\/+$/, "");
    const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normAbs === normRoot) return "";
    const prefix = `${normRoot}/`;
    if (!normAbs.startsWith(prefix)) return null;
    return normAbs.slice(prefix.length);
  }

  function terminalCwdUnavailable(): void {
    closeTabMenu();
    requestTerminalCwd();
    ui.status = "PTY did not report CWD";
    // Persistent so the pill gets a dismiss control; a null statusKind
    // is neither dismissable nor auto-cleared and would stick forever.
    ui.statusKind = "persistent";
    focusTerminal();
  }

  /// The path "Copy path to $CWD" puts on the clipboard: the shell's real
  /// working directory, so prefer the absolute path the PTY reports. Fall
  /// back to the workspace-relative path only for a virtual cwd that has no
  /// absolute form. `newFsEntry` still uses terminalCwdRel(), which the
  /// workspace file API needs rooted.
  function terminalCwdForCopy(): string | null {
    if (terminalCwdAbs) return terminalCwdAbs;
    return terminalCwdRel();
  }

  async function copyTerminalCwd(): Promise<void> {
    const cwd = terminalCwdForCopy();
    if (cwd === null) return terminalCwdUnavailable();
    closeTabMenu();
    // The launcher dispatches this while its overlay is dismissing, so the
    // document can momentarily lack focus and gesture, which makes a bare
    // navigator.clipboard.writeText() reject silently under the caller's
    // `void`. writeClipboardText writes natively on desktop (no gesture),
    // and focusing the terminal first gives the web fallback a focused
    // document.
    focusTerminal();
    await writeClipboardText(cwd);
  }

  // The command launcher runs at the app root, but a terminal's live $CWD
  // and session lifecycle live in this component, so the launcher's
  // live-PTY terminal actions arrive as chan:command events the focused
  // terminal handles. Only the active tab of the focused pane responds, so
  // the launcher's active-surface gate and the acting terminal agree.
  //
  // The find family rides the same bus: on desktop the key bridge claims
  // Mod+F/Mod+G before the webview sees the keydown and fires
  // app.find.open / app.find.next as chan:command events. App.svelte
  // serves those for file tabs only, so the focused terminal must serve
  // itself here or the chord is dead on a terminal pane.
  $effect(() => {
    const onLauncherCommand = (e: Event) => {
      if (!active || !focused) return;
      const name = (e as CustomEvent).detail?.name;
      if (name === "app.terminal.restart") void restart();
      else if (name === "app.terminal.copyCwd") void copyTerminalCwd();
      else if (name === "app.terminal.newFsEntry") openNewFsEntry();
      else if (name === "app.terminal.secretMasking.toggle") toggleSecretMasking();
      else if (name === "app.find.open") openFind();
      else if (name === "app.find.next" && findOpen) runFind(true);
      else if (name === "app.find.prev" && findOpen) runFind(false);
    };
    window.addEventListener("chan:command", onLauncherCommand);
    return () => window.removeEventListener("chan:command", onLauncherCommand);
  });

  // The Team Work bubble composer is gone. Team Work is the Cmd+P dialog +
  // orchestrator spawn/load; the lead is a NORMAL terminal whose identity
  // prompt the orchestrator auto-delivers through the write queue (the same
  // prompt-frame path every terminal uses). Per-terminal text input is the
  // universal Rich Prompt (Cmd+Shift+P) - see RichPrompt.svelte / sendPrompt.

  function runFind(next: boolean): void {
    if (!findQuery.trim()) {
      search?.clearDecorations();
      return;
    }
    const opts = {
      decorations: {
        matchBackground: "#7c5cff",
        matchOverviewRuler: "#7c5cff",
        activeMatchBackground: "#58a6ff",
        activeMatchColorOverviewRuler: "#58a6ff",
      },
    };
    if (next) search?.findNext(findQuery, opts);
    else search?.findPrevious(findQuery, opts);
  }

  function onFindKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      findOpen = false;
      search?.clearDecorations();
      focusTerminal();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runFind(!e.shiftKey);
    }
  }

  function isCloseExitedTabKey(e: KeyboardEvent): boolean {
    return (
      e.type === "keydown" &&
      status === "exited" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.toLowerCase() === "d"
    );
  }

  function closeExitedTabFromKey(e: KeyboardEvent): boolean {
    if (!isCloseExitedTabKey(e)) return false;
    e.preventDefault();
    void closeTab(paneId, tab.id, { force: true });
    return true;
  }

  function handleTerminalKeyEvent(e: KeyboardEvent): boolean {
    if (closeExitedTabFromKey(e)) return false;
    // Copy/paste chords act on the xterm selection / system clipboard, not
    // the PTY. Resolve them here (the custom handler runs before xterm
    // processes the key) so no bytes reach the shell and Ctrl+Shift+C does not
    // raise SIGINT. `false` tells xterm to skip the keystroke. Paste leaves the
    // browser's native event to each backend's own `paste` listener; Ghostty's
    // pre-inversion result is true so its wrapper also passes the key through
    // without suppressing that native event.
    if (
      handleTerminalClipboardChord(e, {
        os: currentOS(),
        copySelection: () => void copySelectionToClipboard(),
      })
    ) {
      return terminalClipboardKeyHandlerResult(e, currentOS(), backend);
    }
    // Chord-escape registry. When the incoming event matches a shortcut
    // flagged `escapeTerminal: true` in shortcuts.ts, return false so xterm
    // does not consume the keystroke.
    if (shouldEscapeTerminal(e)) return false;
    // ghostty-web currently collapses Shift+Enter to plain Enter. Preserve
    // chan's LF fallback while its remaining keys stay on Ghostty's encoder.
    if (backend === "ghostty") {
      return handleGhosttyShiftEnter(e, sendUserInput);
    }
    return handleTerminalMetaKey(e, sendUserInput, tab.keyboardProtocol);
  }

  function onShellKeydown(e: KeyboardEvent): void {
    if (closeExitedTabFromKey(e)) {
      return;
    }
    // Team-work entry points are Cmd+P (native), Cmd+Alt+P (web Mac), and
    // `Mod+. p` (Hybrid Nav) - nothing terminal-local here. The only chord
    // this handler owns is `terminal.find` (registry entry in shortcuts.ts):
    // the terminal-local find bar, accepting both Cmd and Ctrl forms.
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "f"
    ) {
      e.preventDefault();
      openFind();
    }
  }

  function onMenuKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeTabMenu();
    }
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (!menuOpen) return;
    const t = e.target as Element | null;
    if (!t) return;
    if (t.closest(".terminal-tab-menu-bubble")) return;
    if (t.closest(".tab")) return;
    closeTabMenu();
  }

  function toggleAllBroadcastTargets(): void {
    // Group-wide: spans local tabs AND same-group terminals in other windows.
    toggleTerminalGroupBroadcast(tab);
  }

  function onTerminalContextMenu(e: MouseEvent): void {
    e.preventDefault();
    requestTerminalCwd();
    openTabMenu(
      tab.id,
      {
        left: e.clientX,
        top: e.clientY,
        right: e.clientX,
        bottom: e.clientY,
      },
      "body",
    );
  }
</script>

<svelte:window onkeydown={onMenuKeydown} onpointerdown={onDocPointerDown} />

<div
  class="terminal-tab"
  class:active
  data-theme={terminalSurfaceThemeOverride()}
  style:--terminal-background={customTerminalColors?.background}
  data-terminal-tab-id={tab.id}
  role="tabpanel"
  aria-hidden={!active}
  onkeydown={onShellKeydown}
  oncontextmenu={onTerminalContextMenu}
>
  {#if menuOpen}
    <div
      class="terminal-tab-menu-bubble"
      role="menu"
      tabindex="-1"
      aria-label="terminal tab menu"
      use:portal
      use:clampMenu={menuPos}
      onmousedown={(e) => e.stopPropagation()}
    >
      {#if tabMenu.source === "body"}
        <!-- Body-context terminal menu (right-click in the terminal
             body): Find + Copy (selection or scrollback) + Paste + Copy
             Scrollback. Name / Group / broadcast / MCP / spawn config
             lives on the tab-name menu. -->
        <div class="action-list">
          <div class="terminal-backend-label" data-terminal-backend={backend}>
            <span>Terminal engine</span>
            <span class="terminal-backend-value">{backend}</span>
          </div>
          <button class="mbtn" onclick={toggleSecretMasking}>
            <span class="mbtn-icon">
              <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">
              {backend === "xterm"
                ? `Secret masking: ${secretMaskingEnabled ? "on" : "off"}`
                : "Secret masking unavailable"}
            </span>
            <span class="mbtn-chord"></span>
          </button>
          <div class="msep" role="separator"></div>
          {#if backend === "xterm"}
            <!-- Find rides xterm's SearchAddon; no ghostty-web equivalent. -->
            <button class="mbtn" onclick={openFind}>
              <span class="mbtn-icon">
                <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span class="mbtn-label">Find</span>
              <span class="mbtn-chord">{chordFor("app.find.open") ?? ""}</span>
            </button>
          {/if}
          <button class="mbtn" onclick={copySelectionOrScrollback}>
            <span class="mbtn-icon">
              <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Copy</span>
            <span class="mbtn-chord">{chordFor("terminal.copy") ?? ""}</span>
          </button>
          <button class="mbtn" onclick={pasteClipboard}>
            <span class="mbtn-icon">
              <ClipboardPaste size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Paste</span>
            <span class="mbtn-chord">{chordFor("terminal.paste") ?? ""}</span>
          </button>
          <button class="mbtn" onclick={copyScrollback}>
            <span class="mbtn-icon">
              <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Copy Scrollback</span>
            <span class="mbtn-chord"></span>
          </button>
          <!-- Rich Prompt drafts into the workspace drafts dir; not
               available in a terminal-only window. -->
          {#if !ui.terminalOnly}
            <button class="mbtn" onclick={toggleRichPromptFromMenu}>
              <span class="mbtn-icon">
                <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span class="mbtn-label">
                {isRichPromptVisible(tab.id) ? "Hide Rich Prompt" : "Show Rich Prompt"}
              </span>
              <span class="mbtn-chord">{richPromptChord}</span>
            </button>
          {/if}
        </div>
      {:else}
      <label class="rename-row">
        <span class="rename-label">
          <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Name</span>
        </span>
        <input
          class="rename-input"
          value={metadataDraft.name}
          spellcheck="false"
          disabled={metadataPending}
          oninput={(e) =>
            updateTerminalMetadataDraft(
              "name",
              (e.currentTarget as HTMLInputElement).value,
            )}
          onblur={submitTerminalMetadata}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <label class="rename-row">
        <span class="rename-label">
          <Users size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Group</span>
        </span>
        <input
          class="rename-input"
          value={metadataDraft.group}
          spellcheck="false"
          placeholder="default"
          disabled={metadataPending}
          oninput={(e) =>
            updateTerminalMetadataDraft(
              "group",
              (e.currentTarget as HTMLInputElement).value,
            )}
          onblur={submitTerminalMetadata}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      {#if tab.terminalMetadataError}
        <div class="metadata-error-row" role="alert">
          {tab.terminalMetadataError}
        </div>
      {/if}
      <!-- Status reads "connected: <detail>" (colon, not em dash). -->
      <div class="terminal-status-row">
        <span class:connected={status === "connected"} class="terminal-status">
          {status}{statusDetail ? `: ${statusDetail}` : ""}
        </span>
        {#if missedBytes > 0}
          <span class="session-note">missed {missedBytes} bytes</span>
        {/if}
        {#if staleEnvironmentVariables.length > 0}
          <span class="session-note">stale env</span>
        {/if}
      </div>
      {#if showStaleEnvPrompt}
        <div class="env-stale-row">
          <span>
            {staleEnvironmentVariables.join(" and ")}
            {staleEnvironmentVariables.length === 1 ? "still reflects" : "still reflect"}
            this shell's spawn metadata. Restart to update the environment.
          </span>
          <button type="button" onclick={() => void restart()}>Restart now</button>
          <button type="button" onclick={() => dismissTerminalEnvironmentPrompt(tab)}>Later</button>
        </div>
      {/if}
      <!-- Terminal tab menu. Header rows stay above the broadcast
           controls; command-discovery actions live in the launcher. -->
      <div class="action-list">
        <!-- Per-tab broadcast selector, at the top of the menu right
             after the Group row. There is no umbrella "Broadcast
             Input On/Off" rocker; the per-row checkboxes are the only
             controls. Self appears at the top of the list with a "self"
             marker. -->
        <div class="broadcast-section-label">
          <span class="mbtn-icon">
            <Radio size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span>broadcast input on/off</span>
        </div>
        <button class="mbtn" onclick={toggleAllBroadcastTargets}>
          <span class="mbtn-icon"></span>
          <span class="mbtn-label">
            {allBroadcastTargetsSelected ? "Deselect All" : "Select All"}
          </span>
          <span class="mbtn-chord"
            >{chordFor("app.terminal.broadcastToggle") ?? ""}</span
          >
        </button>
        {#each broadcastTargets as target (target.id)}
          {@const isSelf = target.id === tab.id}
          {@const isChecked = isSelf
            ? tab.broadcastEnabled
            : selectedBroadcastTargets.has(target.id)}
          <label class="target-row">
            <span class="target-check">
              <input
                type="checkbox"
                checked={isChecked}
                onchange={(e) => {
                  const next = (e.currentTarget as HTMLInputElement).checked;
                  if (isSelf) {
                    setTerminalBroadcastEnabled(tab, next);
                  } else {
                    setTerminalBroadcastTarget(tab, target.id, next);
                  }
                }}
              />
              {#if isChecked}
                <Check size={13} strokeWidth={2} aria-hidden="true" />
              {/if}
            </span>
            <span class="target-name">
              {terminalTabName(target)}
              {#if isSelf}
                <span class="target-self">(self)</span>
              {/if}
            </span>
          </label>
        {/each}
        {#if crossWindowMembers.length > 0}
          <!-- Same-group terminals in OTHER windows. Toggling one routes
               through the server to its owning window, which flips its tab
               (re-syncs the flag + lights its sign). Group-wide selection
               spans windows; the checkbox reflects the member's own toggle
               from the roster, updated reactively after the round-trip. -->
          <div class="broadcast-other-windows-label">other windows</div>
          {#each crossWindowMembers as member (member.id)}
            <label class="target-row">
              <span class="target-check">
                <input
                  type="checkbox"
                  checked={member.broadcast}
                  onchange={(e) =>
                    void api.setTerminalSessionBroadcast(
                      member.id,
                      (e.currentTarget as HTMLInputElement).checked,
                    )}
                />
                {#if member.broadcast}
                  <Check size={13} strokeWidth={2} aria-hidden="true" />
                {/if}
              </span>
              <span class="target-name">
                {member.tab_name ?? "terminal"}
              </span>
            </label>
          {/each}
        {/if}
        <div class="msep" role="separator"></div>
        <button class="mbtn" onclick={closeFromMenu}>
          <span class="mbtn-icon">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Close</span>
          <span class="mbtn-chord">{chordFor("app.tab.close") ?? ""}</span>
        </button>
      </div>
      {/if}
    </div>
  {/if}
  {#if findOpen}
    <div class="terminal-find" role="search" aria-label="find in terminal">
      <input
        bind:this={searchInput}
        class="find"
        value={findQuery}
        placeholder="find"
        spellcheck="false"
        oninput={(e) => {
          findQuery = (e.currentTarget as HTMLInputElement).value;
          runFind(true);
        }}
        onkeydown={onFindKeydown}
      />
    </div>
  {/if}
  <!-- data-file-drop-zone exempts the terminal from the global drop
       guard's not-allowed cursor; onTerminalFileDrop owns the drop
       (path-print on desktop, silent no-op in a plain browser). The
       div is xterm's mount, not an interactive control -- xterm
       manages its own accessibility tree inside. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="terminal-host"
    data-file-drop-zone
    ondrop={onTerminalFileDrop}
    bind:this={host}
  ></div>
  <!-- Rich Prompt bubble floats over this terminal's bottom (the
       .terminal-tab is the position:absolute context). PER-TERMINAL: mounts
       when THIS terminal's bubble is toggled on, so each terminal shows its
       own bubble (not a window-global one). Deliberately NOT gated on
       `active`: like the terminal body, the bubble stays mounted across tab
       switches (the root's visibility flip hides it) so the composer's
       editor keeps its caret, selection, and undo state. `focused` gates
       the editor's autofocus/refocus so a hidden terminal's bubble never
       steals the keyboard. Toggled by Cmd+Shift+P / the right-click menu. -->
  {#if isRichPromptVisible(tab.id)}
    <RichPrompt {tab} {focused} />
  {/if}
  <!-- Per-terminal survey overlay: a survey raised on THIS terminal
       (`cs terminal survey --tab-name`) renders anchored over it, keyed by
       tab.id, independent of other terminals. It stays mounted across tab
       switches to preserve the original return-focus target, while `shown`
       keeps a background survey inert until its tab is selected. The
       window-wide fallback lives at the App root (App.svelte
       <BubbleOverlay />). -->
  <BubbleOverlay tabId={tab.id} shown={active} restoreFocus={focusTerminal} />
</div>

<style>
  .terminal-tab {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--terminal-background, var(--bg));
    color: var(--text);
    visibility: hidden;
    pointer-events: none;
  }
  .terminal-tab.active {
    visibility: visible;
    pointer-events: auto;
  }
  :global(.terminal-secret-mask) {
    border-radius: 2px;
    pointer-events: none;
  }
  .terminal-find {
    position: absolute;
    top: 8px;
    right: 10px;
    z-index: 2;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
    padding: 5px;
  }
  .session-note {
    color: var(--warn-text);
    font-size: 12px;
    white-space: nowrap;
  }
  .find {
    width: min(220px, 28vw);
    min-width: 96px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 7px;
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .find:focus {
    border-color: var(--link);
  }
  .terminal-host {
    flex: 1;
    min-height: 0;
    padding: 8px;
    background: var(--terminal-background, var(--bg));
    overflow: hidden;
  }
  .terminal-host :global(.xterm) {
    height: 100%;
  }
  .terminal-host :global(.xterm-viewport) {
    background-color: var(--terminal-background, var(--bg));
    scrollbar-color: var(--separator) var(--terminal-background, var(--bg));
  }
  .terminal-tab-menu-bubble {
    position: fixed;
    z-index: 25500;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    padding: 6px;
    min-width: 260px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    color: var(--text);
    font-size: 13px;
    transform-origin: top left;
    animation: bubble-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .terminal-tab-menu-bubble:hover {
    transform: scale(1.015);
  }
  @keyframes bubble-pop {
    0% { opacity: 0; transform: scale(0.92); }
    100% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .terminal-tab-menu-bubble {
      animation: none;
      transition: none;
    }
    .terminal-tab-menu-bubble:hover {
      transform: none;
    }
  }
  .rename-row {
    display: grid;
    grid-template-columns: auto minmax(120px, 1fr);
    align-items: center;
    gap: 10px;
    padding: 6px 4px 8px;
    border-bottom: 1px solid var(--separator);
  }
  .rename-label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-secondary);
    min-width: 0;
  }
  .rename-input {
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 7px;
    font: inherit;
    outline: none;
  }
  .rename-input:focus {
    border-color: var(--link);
  }
  .rename-input:disabled {
    cursor: wait;
    opacity: 0.65;
  }
  .metadata-error-row {
    margin: 2px 8px 4px;
    color: var(--danger, #ef4444);
    font-size: 12px;
    line-height: 1.35;
  }
  .terminal-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px 4px;
    min-width: 0;
  }
  .terminal-status {
    color: var(--text-secondary);
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .terminal-status.connected {
    color: var(--accent);
  }
  .env-stale-row {
    margin: 2px 8px 6px;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.35;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 6px;
    align-items: center;
  }
  .env-stale-row button {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    padding: 3px 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .env-stale-row button:hover {
    border-color: var(--btn-hover);
  }
  .action-list {
    display: flex;
    flex-direction: column;
    padding-top: 4px;
  }
  .mbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    text-align: left;
    transform-origin: left center;
    transition:
      background 80ms ease,
      color 80ms ease,
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .mbtn:hover {
    background: var(--hover-bg);
  }
  .mbtn:hover:not(:disabled) {
    transform: scale(1.02);
  }
  .mbtn:disabled {
    color: var(--text-secondary);
    cursor: not-allowed;
    opacity: 0.58;
  }
  .mbtn:disabled:hover {
    background: none;
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .mbtn {
      transition: background 80ms ease, color 80ms ease;
    }
    .mbtn:hover {
      transform: none;
    }
  }
  .mbtn-icon {
    width: 18px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .mbtn-label,
  .target-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mbtn-chord {
    margin-left: 1.5rem;
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
  }
  .msep {
    height: 1px;
    background: var(--separator, var(--border));
    margin: 4px 2px;
  }
  /* Section label above the broadcast row list. Same icon row +
     secondary text shape as other menu sections; the label is
     informational, not interactive. */
  .broadcast-section-label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 4px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  .broadcast-section-label .mbtn-icon {
    color: var(--text-secondary);
  }
  .terminal-backend-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 8px 6px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .terminal-backend-value {
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .target-self {
    margin-left: 4px;
    color: var(--text-secondary);
    font-size: 11px;
    font-style: italic;
  }
  .target-row {
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 4px;
    padding: 6px 8px;
    cursor: pointer;
  }
  .target-row:hover {
    background: var(--hover-bg);
  }
  .broadcast-other-windows-label {
    padding: 4px 8px 2px 34px;
    color: var(--text-secondary);
    font-size: 11px;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  .target-check {
    position: relative;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .target-check input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .target-check {
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    background: var(--bg);
  }
  @media (max-width: 640px) {
    .terminal-find { right: 6px; }
    .find {
      width: 112px;
    }
  }
</style>
