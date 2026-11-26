<script lang="ts">
  import { clientDetached } from "../api/clientSession";
  import { tick, untrack } from "svelte";
  import {
    Check,
    Clipboard,
    ClipboardPaste,
    Command as CommandIcon,
    ExternalLink,
    FileText,
    Link as LinkIcon,
    Pencil,
    Radio,
    Search,
    Settings2,
    Users,
    X,
  } from "@lucide/svelte";
  import { api, sessionWindowId, windowLibraryId, withTokenQuery } from "../api/client";
  import {
    createSocket,
    probeDeadlineMs,
    WS_CONNECT_DEADLINE_MS,
    WS_PING_MS,
    WS_PROBE_DEADLINE_MAX_MS,
    WS_READ_DEADLINE_MS,
    WS_RECONNECT_BACKOFF_MIN_MS,
    WS_RECONNECT_BACKOFF_MAX_MS,
  } from "../api/transport";
  import { installWakeGapDetector } from "../wakeGap";
  import {
    isTauriDesktop,
    readClipboardText,
    readDroppedPaths,
    reloadWindow,
    writeClipboardText,
    writePrimarySelection,
  } from "../api/desktop";
  import { isOsFileDrag, shellEscapePaths } from "../state/fileDropGuard";
  import { resolveTerminalColors } from "../state/paneColor";
  import {
    chordFor,
    consumeKey,
    currentOS,
    eventMatchesShortcut,
    resolvedEventKey,
    shortcutLabel,
    shouldEscapeTerminal,
  } from "../state/shortcuts";
  import { commandContext, commandState, commandTitle, type CommandContext } from "../state/commands";
  // The menus name their rows through the catalog, which this fills.
  import "../state/commands/install";
  import {
    applyTerminalSessionMetadata,
    applyGlobalTerminalName,
    broadcastTerminalInput,
    closeTab,
    clearTerminalSession,
    ensureTerminalKeyboardProtocol,
    dismissTerminalEnvironmentPrompt,
    failTerminalMetadataRename,
    failTerminalSecretMasking,
    flipHybrid,
    isTerminalMoving,
    panesHaveSides,
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
    seedTerminalSecretMasking,
    setActivePane,
    toggleTerminalGroupBroadcast,
    toggleTerminalSecretMasking,
    setTerminalActivity,
    setTerminalActivityPulsing,
    setTerminalPendingGlobalName,
    clearTerminalSeedInput,
    setTerminalQueueDepth,
    setTerminalProgram,
    setTerminalProgramStatus,
    setTerminalTmuxConsent, setTerminalTmuxHostGrid, setTerminalTmuxPane,
    setTabInspectorOpen,
    tabLabel,
    resolvePendingPrompt,
    failPendingPrompt,
    setTerminalSession,
    setTerminalSubmitAgent,
    tabFocusPulse,
    terminalBroadcastTargets,
    terminalEnvironmentPromptDismissed,
    terminalMetadataDraft,
    terminalSecretMaskingOn,
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
    dismissCliReloadNotice,
    scheduleSessionSave,
    openCommandLauncherFromMenu,
    setTransientStatus,
    surfaceThemeOverride,
    ui,
    appInputBlocked,
  } from "../state/store.svelte";
  import { middleEllipsis } from "../terminal/linkTarget";
  import { TerminalLinkMenu, type LinkRange } from "../terminal/linkMenu.svelte";
  import { terminalWsPath } from "../terminal/session";
  import { GhosttyStatusGuard } from "../terminal/ghosttyStatusGuard";
  import { applyProgramStatus, effectiveProgramApp, markProgramCompletionsSeen, presentProgramText, type ProgramStatus } from "../state/programStatus";
  import FailureCard from "./FailureCard.svelte";
  import Inspector from "./Inspector.svelte";
  import TmuxConsentBanner from "./TmuxConsentBanner.svelte";
  import type { TmuxAnswer, TmuxConsent } from "../state/tmuxConsent";
  import type { TmuxPaneRef } from "../state/tmux";
  import { terminalProgramFromWire, type TerminalProgram } from "../state/terminalProgram";
  import { windowModeSecretMaskingEnabled } from "../state/windowMode";
  import { windowCaps } from "../state/windowCaps";
  import {
    PtyWriteTracker,
    type PtyWriteOrigin,
    type TerminalByteWriter,
    routeTerminalData,
    shouldForwardGeneratedTerminalInput,
    terminalMessageBytes,
    terminalMouseReport,
  } from "../terminal/connection";
  import { StreamAck } from "../terminal/streamAck";
  import {
    controlSlashBytes,
    isTerminalInterruptKey,
    copyTerminalKeyboardProtocolState,
    terminalMetaKeyBytes,
    type TerminalKeyboardProtocolState,
  } from "../terminal/keymap";
  import { KeyboardProtocolObserver } from "../terminal/keyboardProtocolStream";
  import { installGhosttyKeyParity } from "../terminal/ghosttyKeys";
  import {
    handleTerminalClipboardChord,
    isTerminalCopyChord,
    isTerminalPasteChord,
    terminalClipboardKeyHandlerResult,
  } from "../terminal/clipboardChord";
  import { MouseModeFilter } from "../terminal/mouseModeFilter";
  import { installTerminalPrimarySelection, isPrimarySelectionDesktop } from "../terminal/primarySelection";
  import {
    ghosttyLoadIsFinal,
    onGhosttyKitLoaded,
    loadGhosttyKit,
    type GhosttyKit,
  } from "../terminal/backend";
  import { freshShellResetSequence, trackedModesOffSequence } from "../terminal/freshShellReset";
  import { FindAnnouncer } from "../terminal/findAnnouncer";
  import { GhosttyViewportController } from "../terminal/ghosttyViewport";
  import { GhosttyWheelRows, ghosttyWheelArrow } from "../terminal/ghosttyWheel";
  import { Osc52Bridge } from "../terminal/osc52Bridge";
  import { DEFAULT_SECRET_MASK_SUFFIXES } from "../terminal/secretMasking";
  import { GhosttySecretMasker } from "../terminal/secretMaskingGhostty";
  import type {
    Terminal as GhosttyTerminal,
    TerminalLinkActivation,
    TerminalSearch,
    TerminalSearchState,
  } from "@chan/ghostty-web-ng";
  import {
    createRepaintScheduler,
    refreshTerminalRows as refreshTerminalRowsImpl,
  } from "../terminal/renderer";
  import { watchDevicePixelRatio } from "../terminal/pixelRatio";
  import { resolveReadyTerminalFont } from "../terminal/font";
  import {
    createFitFrameScheduler,
    createTrailingFitScheduler,
    proposeGhosttyDimensions,
    runTerminalFit,
    shouldReclaimPtySize,
    type FitLike,
  } from "../terminal/resize";
  import { clampScrollbackMb } from "../terminal/scrollback";
  import {
    effectiveBackgroundOpacity,
    transparentColor,
    windowIsTransparent,
  } from "../terminal/backgroundOpacity";
  import { desktopTerminalOpacity } from "../terminal/desktopTerminalOpacity.svelte";
  import { handleGhosttyPaste, handleGhosttyPasteInput, pasteIntoGhostty } from "../terminal/ghosttyPaste";
  import { sessionRunsMuse } from "../terminal/drawnWraps";
  import { applyGhosttyTheme } from "../terminal/ghosttyTheme";
  import type { GhosttyVt } from "@chan/ghostty-web-ng/vt";
  import type { SubmitAgent } from "../terminal/submitMode";
  import { uiConfirm } from "../state/confirm.svelte";
  import { clampMenu } from "./menuClamp";
  import { menuEscape } from "./menuEscape";
  import { portal } from "./portal";
  import {
    closeTabMenu,
    openTabMenu,
    tabMenu,
  } from "../state/tabMenu.svelte";
  import RichPrompt from "./RichPrompt.svelte";
  import BubbleOverlay from "./BubbleOverlay.svelte";
  import {
    forgetRichPromptChrome,
    isRichPromptVisible,
    toggleRichPromptForTab,
    toggleRichPromptToolbar,
    hideRichPromptForTab,
  } from "../state/richPrompt.svelte";
  import { handKeyboardToOwner, launcherShownOverWindow, mayFocus, owner } from "../state/keyboardOwner.svelte";
  import { terminalRelocations } from "../state/terminalDock.svelte";
  import { filesContext, wirePathFromAbsolute } from "../state/fileContext.svelte";
  import { createTerminalConnectionHealth } from "./terminalConnectionHealth.svelte";
  import { createTerminalInputHold, type HeldInput } from "./terminalInputHold";
  import { createTerminalWakeProbe } from "./terminalWakeProbe";
  import TerminalConnectionNotice from "./TerminalConnectionNotice.svelte";

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

  // The keyboard's owner decides whether this terminal may take the
  // keyboard; a survey over it owns the keyboard while this is the focused
  // pane's active tab. Centralizing the guard keeps every refocus path from
  // taking it, the mount and pane focus included; once the owner releases
  // it, the same calls legitimately restore the terminal.
  function keyboardHeld(): boolean {
    return !mayFocus(host ?? null);
  }

  function focusTerminal(): void {
    if (keyboardHeld()) return;
    if (term) term.focus();
    else loadFailureCard?.takeKeyboard();
  }

  /// Whether nothing outside `within` holds the keyboard: it is on the body,
  /// or on an element inside `within`.
  function keyboardFreeOrIn(within: Element | null | undefined): boolean {
    const holder = document.activeElement;
    return (
      holder === null ||
      holder === document.body ||
      holder === document.documentElement ||
      !!within?.contains(holder)
    );
  }

  // What held the keyboard when the pane's focus last asked for this
  // terminal and found it still loading; undefined when no such ask waits
  // for start().
  let keyboardHolderAtLoadingAsk: Element | null | undefined;

  // The focused pane's active terminal takes the keyboard as the pane gains
  // focus and again once start() has wired it, since the focus effect found
  // no terminal while the core and font loaded. Both run later than the
  // change that asked for them, so they ask again when they run: a tab or
  // pane the user left meanwhile takes nothing, and neither does a terminal
  // whose Rich Prompt is shown, because the composer takes the keyboard
  // itself as it mounts and on each pulse.
  function focusActiveTerminal(): void {
    if (!active || !focused) return;
    if (isRichPromptVisible(tab.id)) return;
    if (!term && !loadFailure) {
      keyboardHolderAtLoadingAsk = document.activeElement;
      return;
    }
    focusTerminal();
  }

  // start() answers the pane's ask unless the user moved to a field while
  // the terminal loaded: a form field that did not hold the keyboard at the
  // ask (the tab menu's Name field, a sidebar field) keeps it, where taking
  // it would cut a word short and send the rest to the shell. Anything else
  // loses it, as the pane's focus says: the surface of the tab the user came
  // from, which under WebKit keeps DOM focus while hidden, and a surface
  // handed the keyboard back during the load, as the launcher hands it to
  // the terminal it opened from while the terminal its Split right opened
  // still loads.
  function focusLoadedTerminal(): void {
    const holderAtAsk = keyboardHolderAtLoadingAsk;
    keyboardHolderAtLoadingAsk = undefined;
    if (!active || !focused) return;
    if (isRichPromptVisible(tab.id)) return;
    const holder = document.activeElement;
    if (holder !== holderAtAsk && holder?.matches("input, textarea, select")) return;
    focusTerminal();
  }

  // The Linux desktop's middle press (PRIMARY paste) is kept from the widget
  // and from the pane, so it does here what a left press does through them:
  // the pane becomes the active one and the terminal takes the keyboard,
  // whatever owns it, as the widget's own pointer focus does.
  function focusFromMiddlePress(): void {
    setActivePane(paneId);
    term?.focus();
  }

  // An action on this terminal that waited before handing it the keyboard
  // (a clipboard round trip, the shell's first output for a seeded prompt)
  // hands it over only while this is still the focused pane's active tab
  // and nothing outside the terminal took the keyboard during the wait.
  function focusTerminalAfterWait(): void {
    if (!active || !focused || !keyboardFreeOrIn(host)) return;
    focusTerminal();
  }

  function dismissReloadNotice(): void {
    dismissCliReloadNotice(tab);
    focusTerminal();
    void tick().then(queueFit);
  }

  type ServerFrame =
    | { type: "ready"; cols: number; rows: number; cwd?: string | null; cwd_rel?: string | null }
    | {
        type: "session";
        id: string;
        seq: number;
        /// This session incarnation's epoch. A restart reuses the id but bumps
        /// it (and resets `seq`), so a redial's cursor from an older
        /// generation is refused and the server replays the whole ring.
        generation: number;
        missed_bytes?: number;
        /// Ring bytes before the alternate-screen and mode preludes; absent on older servers.
        replay_bytes?: number;
        /// Unacknowledged output the server allows this socket. Present only
        /// when this client dialed with `ack` and the server supports it.
        ack_window?: number;
        bytes_since_focus?: number;
        /// MESSAGE depth of the shared write queue at attach time, so every
        /// (re)attach re-syncs the badge (the tab field is never persisted).
        queue_depth?: number;
        /// What runs in the terminal, title and foreground command, both
        /// nullable. Absent from an older server.
        program?: TerminalProgram;
        program_status?: ProgramStatus;
        /// The tmux control-mode consent state, with the question that
        /// stands, if any; the attachment's authoritative value.
        tmux_consent?: TmuxConsent;
        /// Set when this session shows a tmux pane: its connection and tmux's
        /// pane id. A window with such a tab is a tmux window.
        tmux_pane?: TmuxPaneRef;
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
    /// A changed reading of what runs in the terminal, the whole pair.
    | { type: "program"; id: string; generation: number; program: TerminalProgram }
    | { type: "program-status"; id: string; generation: number; program_status: ProgramStatus }
    | { type: "tmux-consent"; id: string; generation: number; tmux_consent: TmuxConsent }
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
    | { type: "queue-details"; messages: QueuedMessagePreview[] }
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
    | { type: "pong" }
    | { type: "error"; message?: string; reason?: string };

  type QueuedMessagePreview = {
    text: string;
    source: "cs_write" | "rich_prompt";
    prompt_id: string | null;
    awaiting_submit: boolean;
  };

  type CloseReason = "idle" | "workspace" | "parked" | "shutdown" | "explicit" | "capped" | "error";

  let host: HTMLDivElement | undefined = $state();
  let searchInput: HTMLInputElement | undefined = $state();
  let tabEl: HTMLDivElement | undefined;
  let composerEl: HTMLDivElement | undefined = $state();
  let composer: RichPrompt | undefined = $state();
  // The surface inside this terminal that last took the keyboard. A move of
  // the element to another pane drops the keyboard, and it goes back here.
  let keyboardSurface: "terminal" | "find" | "composer" = "terminal";
  let term: GhosttyTerminal | null = null;
  let fit: FitLike | null = null;
  // Visual-only masking owner for this terminal: a painter over the widget's
  // canvas, disposed with the terminal. Whether it masks is the tab's own
  // state, which the launcher's toggle reads and flips too.
  let secretMasker: GhosttySecretMasker | null = null;
  const effectiveSecretMasking = $derived(terminalSecretMaskingOn(tab));
  // The one place a change of that state reaches the masker, whatever made
  // it: the menu's row, the launcher's, a chord, Privacy mode. The state is
  // read before the masker is asked for, since the masker is not reactive
  // and does not exist on the first run: an effect that reads no state then
  // would never run again. A masker built later is handed the state as it
  // is built (start()).
  $effect(() => {
    const masking = effectiveSecretMasking;
    untrack(() => secretMasker?.setEnabled(masking));
  });
  let ws: WebSocket | null = null;
  const terminalConnection = createTerminalConnectionHealth(() => sendPing());
  $effect(() => {
    const blocked = ui.disconnectBlocking || !active;
    untrack(() => terminalConnection.setNoticeBlocked(blocked));
  });
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
  // On a connection that takes no wake probe, how long an expired read
  // deadline waits before closing: its timer can run ahead of frames a stall
  // left queued, and any of them cancels the close.
  const READ_DEADLINE_GRACE_MS = 1_000;
  // The hold's cap while a probe runs: past the longest deadline a probe can
  // have, so the probe's verdict is what normally ends the hold.
  const INPUT_HOLD_BACKSTOP_MS = WS_PROBE_DEADLINE_MAX_MS + 1_000;
  const wakeProbe = createTerminalWakeProbe({
    onSilent: () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      inputHold.awaitReplacement(WS_CONNECT_DEADLINE_MS);
      void connect();
    },
  });
  const inputHold = createTerminalInputHold({
    canSend: () => ws?.readyState === WebSocket.OPEN,
    deliver: (entry) => {
      // A composer that stopped waiting for this message has told the user it
      // failed and kept the text, so sending it now could run it twice.
      if (entry.promptId) {
        const pending = tab.pendingPrompt;
        if (pending?.id !== entry.promptId || pending.phase !== "sent") return;
      }
      noteUserFrame(entry, send(entry.frame));
    },
    onDropped: () => {
      if (status !== "exited") terminalConnection.inputDropped();
    },
    verdictPending: () => wakeProbe.settling,
  });
  // The session a running hold's input was typed for. A redial that lands on
  // another one must not type it into a program the user never saw.
  let heldFor: { id: string | undefined; generation: number | null } | null = null;
  // Set while a key press that interrupts is being dispatched.
  let interruptKeyPress = false;
  // Resume state. `receivedSeq` tracks the server byte cursor (prelude `seq`
  // + live bytes since) so a redial of the screen this terminal still shows
  // knows where to resume from. `serverGeneration` is the live session epoch
  // (null until the first prelude).
  let receivedSeq = 0;
  // Reports each frame as the core takes it, in the same task as its parse.
  const streamAck = new StreamAck((frame) => send(frame));
  let serverGeneration: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let stopPixelRatioWatch: (() => void) | null = null;
  // Publication needs a fit since the last visibility change or relocation.
  let gridMeasured = false;
  // The dial may use a host measurement across a hide, but never a grid
  // adopted from another view. A shown reattach still waits for its own fit.
  // A covered redial with a known host grid declares the last shown fit. A
  // host resize while covered leaves that fit stale until the reveal.
  let hostGridKnown = false;
  // A tmux pane's grid is tmux's: the layout sizes the pane session and the
  // server says so in resize frames, which this renderer adopts whether or
  // not it is active; it fits nothing to its host, publishes no size and
  // reclaims none. Its host's grid goes to the tab instead, for the window
  // size the page asks tmux for.
  const tmuxSized = $derived(Boolean(tab.tmuxPane));
  let sentGrid: { cols: number; rows: number } | null = null;
  let broadcastGrid: { cols: number; rows: number } | null = null;
  // A reveal takes back the PTY even when the local grid has not changed.
  // Delivery, rather than a fit or a socket's creation, clears this debt.
  let revealPending = false;
  let status = $state<"closed" | "connecting" | "connected" | "exited">("closed");
  let statusDetail = $state("");
  let missedBytes = $state(0);
  let findOpen = $state(false);
  let queuedMessages = $state<QueuedMessagePreview[] | null>(null);
  $effect(() => {
    const connected = status === "connected";
    const enabled = active && !!tab.inspectorOpen;
    if (!enabled || !connected) queuedMessages = null;
    if (connected) send({ type: "queue-details", enabled });
  });
  function showProgramStatus(status: ProgramStatus): void {
    // A preference not yet loaded or without the key reads as the default, on.
    const visible = currentPreferences()?.terminal.program_status !== false
      ? status
      : { revision: status.revision, records: [] };
    setTerminalProgramStatus(tab, visible);
  }
  let findQuery = $state("");
  /// The find bar's match count, the terminal search's state; null leaves
  /// the count blank.
  let findCount = $state<TerminalSearchState | null>(null);
  /// "k of n", with a plus while the scan runs. A scan that has counted
  /// nothing yet reads "searching" rather than a zero: a fresh find can
  /// show its newest match, read from the core's listing, with a count of
  /// none for as long as output keeps its frames from placing a match.
  const findCountText = $derived(
    findCount === null
      ? ""
      : findCount.partial && findCount.total === 0
        ? "searching"
        : `${findCount.index ?? "?"} of ${findCount.total}${findCount.partial ? "+" : ""}`,
  );
  /// The find bar's live region: the count as a screen reader hears it,
  /// once it settles rather than on every frame the shown count changes.
  let findAnnounced = $state("");
  const findAnnouncer = new FindAnnouncer((text) => {
    findAnnounced = text;
  });
  $effect(() => findAnnouncer.update(findCountText, !findCount?.partial));
  $effect(() => () => findAnnouncer.dispose());
  // Set by a session frame: this terminal shows the session up to
  // `receivedSeq`, so a redial resumes from there. A dial that fails before
  // its own session frame leaves the screen as it was and keeps it; only a
  // disposed terminal clears it.
  let sawSessionControl = false;
  // Set when a socket is closed between a session frame and its `ready`
  // (closeSocket, which every redial's connect runs first, sets it): the
  // screen holds part of a replay and `receivedSeq` names the end of it, so
  // the live cursor is no place to resume from. A cut of a replay that
  // continued the view keeps where it left the view in `resume`, and the
  // redial echoes `parsed`, or `lossFrom` while a loss is owed its suffix,
  // since only a cursor before the lost bytes gets that suffix sent again;
  // it resumes from there as a redial after a clean close resumes from the
  // live cursor. After any other cut (`resume` null) the redial asks for
  // the whole ring: a nonempty replay with a byte count starts on a reset
  // screen; an empty or unmarked replay keeps it. The next `ready`, or a
  // session frame that continues the view, clears the cut.
  let cut: { resume: { parsed: number; lossFrom: number | null } | null } | null = null;
  // The replay in progress when it continues the view's own screen (the
  // server resumed the cursor this dial echoed in its live generation, or
  // recovers this socket's stream), in raw stream positions: its first
  // byte is at `start`, `taken` of its `length` bytes have arrived, and the
  // view had parsed up to `parsed` before it, which a replay that starts
  // earlier repeats and the tab does not write again. `lossFrom` is the
  // cursor the bytes it missed start at, while their recovery suffix,
  // which ends the replay, has not been parsed. Read only while
  // `attachReplayActive`, and set by the session frame that starts it. It
  // counts its own position rather than reading StreamAck's: on a re-ask
  // the view stands at the larger of `parsed` and the stream position,
  // while the acknowledgement follows the stream.
  let continuingReplay: {
    start: number;
    length: number;
    taken: number;
    parsed: number;
    lossFrom: number | null;
  } | null = null;
  // The keyboard protocol as it stood when the current replay began, which
  // the reset write's callback restores once the protocol observer has read
  // the reset and before the first ring byte is parsed.
  let keyboardProtocolBeforeReplay: TerminalKeyboardProtocolState | null = null;
  let pendingPromptSeed = "";
  let promptSeedSent = false;
  let terminalCwdAbs: string | null = $state(null);
  let terminalCwdVirtual: string | null = $state(null);
  const ptyWrites = new PtyWriteTracker();
  const customTerminalColors = $derived(
    resolveTerminalColors(currentPreferences()?.terminal_colors),
  );
  // Whether chan-desktop built this window transparent, fixed for the page.
  // The terminal then paints a transparent default background and the
  // `.terminal-tab` CSS paints the tint at the live opacity.
  const transparentWindow = windowIsTransparent();
  // Whether the desktop shows through this terminal now: a transparent
  // window with the desktop's own opacity below 100. The value is the
  // desktop's, not this window's tenant preference, so a devserver's 100
  // never paints a desktop window opaque. At 100 the tint is opaque, so the
  // terminal reads exactly as in an opaque window.
  const seeThrough = $derived(
    effectiveBackgroundOpacity(desktopTerminalOpacity(), transparentWindow) !== null,
  );
  // The writer handed to ptyWrites: a SYNCHRONOUS wrapper. ghostty-web
  // parses inside write() synchronously and only defers the optional
  // callback to requestAnimationFrame, which STALLS in a backgrounded or
  // headless page -- a stalled callback would wedge the tracker's replay-origin
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
  // Why the terminal's view did not load, shown in the terminal's place;
  // null while it loads and once it opens. A final failure stays for the
  // page's life (see backend.ts), so it offers a reload and no retry.
  let loadFailure = $state<{ final: boolean; error: unknown } | null>(null);
  let loadFailureArea: HTMLElement | undefined = $state();
  let loadFailureCard: ReturnType<typeof FailureCard> | undefined = $state();
  // Counts start() calls and teardowns. A start() whose count is no longer
  // the latest when a load settles was overtaken by a restart, a retry or a
  // close and does nothing more.
  let startAttempt = 0;
  // OSC 52 clipboard observer, non-null while a terminal is open: the VT
  // core drops OSC 52 and ghostty-web exposes no hook for it, so the
  // clipboard copy rides this byte observer (see osc52Bridge.ts).
  let osc52Bridge: Osc52Bridge | null = null;
  let ghosttyStatusGuard: GhosttyStatusGuard | null = null;
  // Follows the program's keyboard protocol requests in the output stream,
  // since the widget exposes no parser hooks. Fed in the termWriter, so it
  // sees the bytes in the order the VT parses them.
  let keyboardProtocolObserver: KeyboardProtocolObserver | null = null;
  // Removes the key listener (ghosttyKeys.ts). Non-null while a terminal is
  // open.
  let ghosttyKeyParity: (() => void) | null = null;
  let ghosttyReportedFocus: boolean | null = null;
  // Owns the calibrated macOS pixel-scroll path and hands PTY output and
  // writeChanLine to the terminal's write unchanged. Non-null while a
  // terminal is open and disposed with it.
  let ghosttyViewport: GhosttyViewportController | null = null;
  // The find bar's count following the terminal's search, subscribed when
  // the bar first opens (see terminalSearch) and ended with the terminal.
  let findSubscription: { dispose(): void } | null = null;
  // Rows built up by wheel input the app owns (see handleGhosttyWheel).
  const ghosttyWheelRows = new GhosttyWheelRows();
  let primarySelectionCleanup: (() => void) | null = null;
  let hostResumeTimers: ReturnType<typeof setTimeout>[] = [];
  let hostResumeListenerCleanup: (() => void) | null = null;
  // Wall-clock-gap sleep/wake detector (shared `installWakeGapDetector`). See
  // installHostResumeListeners for why focus/pageshow/visibilitychange miss a
  // macOS display/system sleep in WKWebView; the detector catches it off the
  // wall clock instead.
  let disposeWakeGap: (() => void) | null = null;
  const fitFrame = createFitFrameScheduler(fitToHost);
  const trailingFit = createTrailingFitScheduler(fitToHost);
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
    // A link menu's anchor is a band around the pointer: the menu opens
    // under it and flips to above it, so a second click lands outside.
    if (tabMenu.source === "link") return { x: Math.round(a.left), y: Math.round(a.bottom), flipY: Math.round(a.top) };
    return { x: Math.round(a.left), y: Math.round(a.bottom + 4) };
  });
  // The broadcast list, which the launcher's choice lists too. Self leads
  // it with a "self" marker, and its row is the only knob for THIS tab's
  // participation (no umbrella on/off button). Broadcast is group-scoped:
  // the list holds only terminals in this tab's group, so you can only ever
  // target same-group peers. Members in OTHER windows of this tenant that a
  // page holds follow under an "other windows" label; toggling one routes
  // through the server to its owning window.
  const broadcastTargets = $derived(terminalBroadcastTargets(tab));
  const localBroadcastTargets = $derived(broadcastTargets.filter((target) => !target.otherWindow));
  const otherWindowBroadcastTargets = $derived(broadcastTargets.filter((target) => target.otherWindow));
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
  $effect(() => () => terminalConnection.dispose());
  // A load another terminal made has passed, so this terminal's failed load
  // may pass too: a fetch the window's terminals failed together takes one
  // Retry, not one per terminal. A final failure stays for the page.
  $effect(() =>
    onGhosttyKitLoaded(() => {
      if (loadFailure && !loadFailure.final) retryLoad();
    }),
  );

  $effect(() => {
    const unregisterInput = registerTerminalInputSink(tab.id, (data, binary, interrupt) => {
      sendUserFrame(inputEntry(data, binary, !terminalMouseReport(data)), interrupt ?? false);
    });
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
    // stale by the visibility flip.
    recoverTerminalRendererAfterHostResume();
    setTerminalActivity(tab, false);
    untrack(() => markProgramCompletionsSeen(tab.programStatus));
    sendFocusState();
    queueMicrotask(focusActiveTerminal);
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
  // pane losing focus can paint stale in the desktop app's WKWebView,
  // where a single refresh does not always correct it. So run the SAME
  // recovery the host-resume / active-flip paths use (fit + repaint +
  // delayed re-fits) on blur too. The size is unchanged on a focus switch, so
  // the fit is a dimensional no-op; the value is the deferred repaint
  // pass WebKit needs.
  $effect(() => {
    if (focused) return;
    // Relinquish keyboard focus when this terminal stops being the active
    // tab, so a newly opened editor (e.g. `cs open {path}`) actually gets the
    // keystrokes instead of the widget's element keeping `document.activeElement`.
    // The load error's actions give it up the same way: under WebKit a hidden
    // tab keeps DOM focus, and a Space typed elsewhere would press Retry.
    term?.blur();
    untrack(releaseLoadFailureKeyboard);
    recoverTerminalRendererAfterHostResume();
    sendFocusState();
  });

  // A split rebuilds this terminal's pane and a move names another; either way
  // the element is docked into a new layer with its renderer and socket
  // intact (terminalDock.svelte.ts). The new host has a size of its own, so
  // fit on the next frame, when it is laid out, and publish the measured grid
  // even if unchanged, then repaint as after a host resume. The move also
  // drops the keyboard, which goes back to the surface that held it.
  let relocationsSeen = untrack(() => terminalRelocations(tab.id));
  // Invalidate before focus/recovery effects can fit. A pane move and a
  // visibility flip can happen together; both owe the same publication.
  $effect.pre(() => {
    active;
    terminalRelocations(tab.id);
    untrack(() => {
      gridMeasured = false;
      revealPending = true;
      if (!active || tmuxSized) adoptBroadcastGrid();
    });
  });
  $effect(() => {
    const relocations = terminalRelocations(tab.id);
    if (relocations === relocationsSeen) return;
    relocationsSeen = relocations;
    untrack(() => {
      recoverTerminalRendererAfterHostResume();
      returnKeyboardAfterRelocation();
    });
  });

  function noteKeyboardSurface(e: FocusEvent): void {
    const target = e.target as Node;
    if (target === searchInput) keyboardSurface = "find";
    else if (composerEl?.contains(target)) keyboardSurface = "composer";
    else if (host?.contains(target)) keyboardSurface = "terminal";
  }

  // Give the keyboard to the find input, the composer or the terminal,
  // whichever last took it and is still open.
  function focusLastKeyboardSurface(): void {
    if (keyboardHeld()) return;
    if (keyboardSurface === "find" && findOpen && searchInput) searchInput.focus();
    else if (keyboardSurface === "composer" && composer) composer.focus();
    else focusTerminal();
  }

  // Give the keyboard back when this is still the focused terminal and
  // nothing outside it has taken the keyboard since the move: to its owner
  // when something owns it, as the owner's surface takes it (a survey over
  // this terminal among them; the Computers launcher takes nothing here),
  // else to the surface of this terminal that last took it.
  function returnKeyboardAfterRelocation(): void {
    queueMicrotask(() => {
      if (!active || !focused || !keyboardFreeOrIn(tabEl)) return;
      if (owner() !== null) {
        handKeyboardToOwner();
        return;
      }
      focusLastKeyboardSurface();
    });
  }

  // An idle terminal (visible in its pane but NOT focused, or a
  // tab just switched to in a non-active pane) renders garbled until
  // the user clicks or resizes it. The tab uses `visibility: hidden`
  // (not `display: none`) while inactive, so the host keeps layout
  // dimensions, but the renderer can paint at a stale
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

  // Track the resolved terminal body theme so the terminal's canvas
  // palette follows a switch and the per-surface override.
  $effect(() => {
    effectiveHybridSurfaceTheme("terminal");
    customTerminalColors;
    seeThrough;
    applyTerminalTheme();
  });

  function effectiveTerminalTheme(): "dark" | "light" {
    return customTerminalColors?.contrast ?? effectiveHybridSurfaceTheme("terminal");
  }

  function terminalSurfaceThemeOverride(): "dark" | "light" | undefined {
    return customTerminalColors?.contrast ?? surfaceThemeOverride("terminal");
  }

  /// The terminal's background colour, opaque: what the renderer fills in an
  /// opaque window and what `.terminal-tab` tints with in a transparent one.
  function terminalBackground(styles: CSSStyleDeclaration): string {
    return (
      customTerminalColors?.background ??
      (styles.getPropertyValue("--bg").trim() || "#1c1c1e")
    );
  }

  function terminalTheme() {
    // Read CSS variables from `host` so the terminal surface's
    // `data-theme` override resolves before the terminal paints.
    const styles = getComputedStyle(host ?? document.documentElement);
    const bg = terminalBackground(styles);
    const text =
      customTerminalColors?.foreground ??
      (styles.getPropertyValue("--text").trim() || "#ebebf0");
    const cursor =
      customTerminalColors?.cursor ??
      (styles.getPropertyValue("--link").trim() || "#58a6ff");
    const base = {
      background: transparentWindow ? transparentColor(bg) : bg,
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
  // and the palette cannot reach truecolor. 4.5 (WCAG AA) has the
  // terminal darken only under-contrast foregrounds; 1 is the identity,
  // keeping dark rendering untouched. The widget takes the floor as a
  // field of its theme.
  function terminalMinimumContrastRatio(): number {
    // While the desktop shows through, the backdrop is whatever sits behind
    // the window, so a ratio measured against the theme background would be
    // wrong. At 100 the tint is the theme background itself.
    if (seeThrough) return 1;
    return effectiveTerminalTheme() === "light" ? 4.5 : 1;
  }

  /// Find's colours: a background and an ink for every match and for the
  /// active one. Each carries its own ink, since a cell's inherited ink on
  /// a match background can fall near 1:1 and the dark theme and a
  /// see-through window take no contrast floor to lift it; every pair
  /// reads at 4.5:1 or more.
  function terminalSearchColors() {
    return effectiveTerminalTheme() === "light"
      ? {
          searchMatchBackground: "#f6dc7f",
          searchMatchForeground: "#000000",
          searchActiveMatchBackground: "#f0961e",
          searchActiveMatchForeground: "#000000",
        }
      : {
          searchMatchBackground: "#806d36",
          searchMatchForeground: "#ffffff",
          searchActiveMatchBackground: "#ffb454",
          searchActiveMatchForeground: "#000000",
        };
  }

  /// The widget's theme: the colours plus the contrast floor, which it
  /// takes only there. The widget measures a cell on the default background
  /// against the background it paints. In a window built transparent that
  /// background is clear and `.terminal-tab` paints the tint behind it, so
  /// the tint is named as the backdrop to measure against; below 100%
  /// opacity the floor is off and the backdrop is not read.
  function ghosttyTerminalTheme() {
    return {
      ...terminalTheme(),
      ...terminalSearchColors(),
      minimumContrastRatio: terminalMinimumContrastRatio(),
      contrastBackdrop: transparentWindow
        ? terminalBackground(getComputedStyle(host ?? document.documentElement))
        : undefined,
    };
  }

  function applyTerminalTheme(): void {
    if (!term) return;
    applyGhosttyTheme(term, ghosttyTerminalTheme());
    secretMasker?.setColor(terminalSecretMaskColor());
  }

  function refreshTerminalRows(): void {
    refreshTerminalRowsImpl(term);
  }

  // Repaint the visible rows for the focus / blur / active-flip / wake
  // recovery. The call forces a full pass of the widget's canvas
  // renderer, since its frame loop repaints dirty rows only and the fit
  // below is a no-op while the grid is unchanged (refreshTerminalRows in
  // renderer.ts).
  //
  // At most one repaint is pending at a time (createRepaintScheduler): the
  // recovery runs on every focus, visibility and wake signal and on every
  // PTY redial, and a window that is off-screen runs none of the frames those
  // would otherwise queue until it comes back.
  const rendererRepaint = createRepaintScheduler(() => {
    if (!term) return;
    refreshTerminalRows();
  });
  function refreshTerminalRenderer(): void {
    if (!term) return;
    rendererRepaint.request();
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

  // Renderer recovery cannot restore the DOM/native keyboard bridge. A host
  // resume therefore reasserts focus for the one terminal that still owns the
  // pane, but never steals it from an editor, prompt, menu, find box, or other
  // focused surface, and never from the launcher shown over the window: the
  // desktop refocuses this webview itself when the launcher hides. Re-focus
  // even when the widget's element still appears active: WKWebView can
  // retain document.activeElement while detaching keyboard input.
  function recoverTerminalFocusAfterHostResume(): void {
    queueMicrotask(() => {
      if (!active || !focused) return;
      if (findOpen || menuOpen || isRichPromptVisible(tab.id)) return;
      if (launcherShownOverWindow()) return;
      if (!keyboardFreeOrIn(host)) return;
      // An owner can hold the keyboard by rule while DOM focus sits in the
      // host (a survey over this terminal after a press into it). Ask
      // before the blur below, which would drop the keyboard to the body
      // for a refocus the owner then refuses: the owner's surface takes it.
      if (keyboardHeld()) {
        handKeyboardToOwner();
        return;
      }
      const holder = document.activeElement;
      // ghostty-web focuses the host element it opened in, and focus() on
      // the element that is already document.activeElement is a DOM no-op,
      // so the refocus below re-arms nothing when WKWebView kept the
      // element active while detaching keyboard input. Blur it first: the
      // focus that follows is then a real focus change, as a click is. A
      // program with focus reporting on sees CSI O then CSI I, as on any
      // terminal's wake.
      if (holder instanceof HTMLElement && host?.contains(holder)) {
        holder.blur();
      }
      focusTerminal();
    });
  }

  function recoverTerminalAfterHostResume(): void {
    recoverTerminalRendererAfterHostResume();
    recoverTerminalFocusAfterHostResume();
  }

  function clearHostResumeTimers(): void {
    for (const timer of hostResumeTimers) clearTimeout(timer);
    hostResumeTimers = [];
  }

  function installHostResumeListeners(): void {
    if (hostResumeListenerCleanup) return;
    const onHostResume = () => recoverTerminalAfterHostResume();
    const onVisibility = () => {
      if (document.visibilityState === "visible") onHostResume();
    };
    window.addEventListener("focus", onHostResume);
    window.addEventListener("pageshow", onHostResume);
    document.addEventListener("visibilitychange", onVisibility);
    // macOS screensaver / display + system sleep does NOT fire focus
    // / pageshow / visibilitychange in the desktop app's WKWebView
    // (the window stays "visible" + focused through the sleep), so the
    // listeners above never fire on wake and the terminal stays
    // glitchy until the user RESIZES a window (ResizeObserver ->
    // queueFit -> recovery). The shared wall-clock detector catches the wake
    // directly (a coarse interval firing far later than scheduled means JS
    // timers froze while the machine slept); on wake it runs the renderer
    // recovery the resize path proves works AND probes the PTY socket, which
    // the sleep may have left half-open.
    // One detector per terminal so EVERY pane recovers at once, matching
    // "resize any window clears ALL terminals". (Pure display-only sleep that
    // does not freeze timers is not caught here; verify in chan-desktop --
    // WebKit-only.)
    disposeWakeGap = installWakeGapDetector(() => {
      recoverTerminalAfterHostResume();
      probePtySocketAfterWake();
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

  // A machine sleep can freeze the PTY socket into a half-open zombie: readyState
  // stays OPEN but the far end (through the gateway proxy) was torn down, so no
  // onclose fires and typed keys are swallowed. A main-thread stall trips the
  // same detector over a healthy socket, whose queued output a redial would
  // discard. So a wake pings the socket, and wakeProbe redials through the
  // resume path (sessionId/since/generation) only if neither that ping's pong
  // nor any other frame arrives for the watcher's RTT-scaled deadline. What the
  // user sends meanwhile waits in inputHold and goes once to whichever socket
  // wins. A socket that is not OPEN is already reconnecting (or intentionally
  // closed); leave it alone.
  function probePtySocketAfterWake(): void {
    if (skipsWakeProbe()) return;
    if (ws?.readyState !== WebSocket.OPEN) return;
    terminalConnection.forgetPingTimings();
    wakeProbe.begin(probeDeadlineMs(terminalConnection.rttMs));
    if (!inputHold.active) heldFor = { id: tab.terminalSessionId, generation: serverGeneration };
    inputHold.begin(INPUT_HOLD_BACKSTOP_MS);
    sendPing();
  }

  // The control terminal is a single-shot local runner owned by the desktop
  // exit watcher; a wake redial would mint a fresh session whose tenant default
  // re-runs the devserver connect script. The desktop's embedded server shares
  // the machine's sleep, so its socket cannot go half-open across one. A
  // browser on a loopback host gets no such pass: it may be an ssh tunnel to a
  // remote devserver.
  function skipsWakeProbe(): boolean {
    return ui.terminalControl || (isTauriDesktop() && windowLibraryId() === "local");
  }

  function noteInterruptKey(e: KeyboardEvent): void {
    if (!isTerminalInterruptKey(e, resolvedEventKey(e))) return;
    interruptKeyPress = true;
    // The terminal sends the key's bytes within this event's dispatch.
    setTimeout(() => {
      interruptKeyPress = false;
    }, 0);
  }

  let attachReplayActive = false;
  let suppressAttachReplayGeneratedReplies = false;

  async function start(): Promise<void> {
    if (!host || term) return;
    const attempt = ++startAttempt;
    // A teardown, a restart, a retry or a close since this call began.
    const overtaken = () => attempt !== startAttempt || !host || term !== null;
    loadFailure = null;
    const terminalPrefs = currentPreferences()?.terminal;
    const rendererFontSize = terminalPrefs?.font_size ?? 14;
    // Scrollback honors the Settings MB budget, which the widget takes as
    // its core's history budget in bytes (a MiB each), with no line count
    // beside it. Read once here so a settings change after spawn doesn't
    // reach through and resize the existing terminal's buffer; the hint
    // copy under the slider names this spawn-time-only contract.
    const scrollbackBytes = clampScrollbackMb(terminalPrefs?.scrollback_mb) * 1_048_576;
    // Mouse capture honors the Settings toggle under the same spawn-time
    // contract: read once here, so flipping the setting later affects only
    // newly opened terminals (the hint copy says so). Absent field (older
    // server) means true, today's behavior.
    mouseFilter = (terminalPrefs?.mouse_capture ?? true)
      ? null
      : new MouseModeFilter();
    // The preference and window kind seed each fresh tab. The menu/launcher
    // toggle changes only this terminal, so a respawn uses the rule again.
    seedTerminalSecretMasking(
      tab,
      windowModeSecretMaskingEnabled(terminalPrefs?.secret_masking, {
        terminalControl: ui.terminalControl,
      }),
    );
    const secretMaskSuffixes =
      terminalPrefs?.secret_mask_suffixes ?? DEFAULT_SECRET_MASK_SUFFIXES;
    const fontPref = terminalPrefs?.font ?? "os-default";
    // The canvas renderer caches glyph metrics synchronously. Resolve the
    // selected chain before the terminal exists so the bundled face cannot
    // swap in halfway through its first measurement. A failed load returns
    // a system-only chain, which keeps the live renderer stable if the face
    // appears later.
    const readyFont = await resolveReadyTerminalFont(
      currentOS(),
      fontPref,
      rendererFontSize,
      typeof document === "undefined" ? undefined : document.fonts,
    );
    if (overtaken()) return;
    const fontFamily = readyFont.fontFamily;
    if (readyFont.status === "fallback") {
      console.warn(
        "[chan] Source Code Pro unavailable; using the system terminal font:",
        readyFont.error,
      );
    }
    // The kit lazy-loads on the first spawn and each terminal gets its own
    // WASM instance (see backend.ts). A load that fails shows why in the
    // terminal's area, with the action that can get past it, and opens no
    // terminal: the PTY is dialed only once one is open, so a fresh tab
    // spawns none and a live session is left running.
    let ghosttyKit: GhosttyKit;
    let ghosttyInstance: GhosttyVt;
    try {
      ghosttyKit = await loadGhosttyKit();
      // A terminal that is gone needs no instance.
      if (overtaken()) return;
      ghosttyInstance = await ghosttyKit.instantiate({
        cellSize: () => term?.getMetrics(),
        onResizeReply: sendGeneratedTerminalInput,
      });
    } catch (err) {
      if (overtaken()) return;
      showLoadFailure(err, ghosttyLoadIsFinal(err));
      return;
    }
    if (attempt !== startAttempt || !host || term) return;
    try {
      openTerminal(host, ghosttyKit, ghosttyInstance, { fontFamily, rendererFontSize, scrollbackBytes, secretMaskSuffixes });
    } catch (err) {
      // What was built and wired goes as at a restart, and the error takes
      // the terminal's place: the next instance may open.
      teardown();
      showLoadFailure(err, false);
      return;
    }
    // This terminal is brand-new and EMPTY, so the attach below carries no
    // byte cursor and the server replays the session's full ring. A
    // carried-over cursor would make the server skip everything the
    // PREVIOUS terminal had seen, and that buffer died with term.dispose().
    void connect();
    queueMicrotask(focusLoadedTerminal);
  }

  /// Show why the terminal's view did not load in its place, and report it.
  function showLoadFailure(err: unknown, final: boolean): void {
    console.warn("[chan] ghostty-web failed to load:", err);
    loadFailure = { final, error: err };
    // The focused pane's terminal would take the keyboard once open; its
    // card takes it instead, once rendered: Retry, or a final failure's
    // card itself (see FailureCard's takeKeyboard).
    void tick().then(focusLoadedTerminal);
  }

  /// Construct the terminal over its own instance, open it in `host` (the
  /// bound host, checked by the caller) and wire it. Throws when the widget
  /// cannot be constructed or opened, leaving what it wired to teardown().
  function openTerminal(
    host: HTMLElement,
    ghosttyKit: GhosttyKit,
    ghosttyInstance: GhosttyVt,
    { fontFamily, rendererFontSize, scrollbackBytes, secretMaskSuffixes }: {
      fontFamily: string;
      rendererFontSize: number;
      scrollbackBytes: number;
      secretMaskSuffixes: readonly string[];
    },
  ): void {
    // lineHeight is 1.2 (not the widget's 1.0 default) so multi-row
    // ASCII glyphs (e.g. the Claude Code splash cube, figlet output,
    // nethack tiles) render with the row separation a user gets from
    // iTerm; the 1.0 default packs ascender glyphs against the next
    // row's descenders. Cursor is a non-blinking block, matching
    // iTerm's defaults.
    //
    // Reset the negotiated keyboard-protocol state ONLY on a fresh spawn
    // (no surviving session to reattach to). Reattaching to a long-lived
    // PTY keeps the protocol the program already announced, since a
    // running agent won't re-announce after the reconnect; resetting here
    // would turn Shift+Enter -> newline into a plain submit.
    const keyboardProtocol = ensureTerminalKeyboardProtocol(
      tab,
      !tab.terminalSessionId,
    );
    // Ghostty's WASM VT parser, drawn by ghostty-web's canvas renderer.
    const terminalHost = host;
    const ghosttyTerm = new ghosttyKit.Terminal({
      copy: (text: string) => {
        void copyToClipboard(text);
        if (isPrimarySelectionDesktop()) void writePrimarySelection(text);
      },
      joinDrawnWraps: runsMuse,
      lineHeight: 1.2,
      boxGlyphs: true,
      scrollbar: "overlay",
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily,
      fontSize: rendererFontSize,
      ghostty: ghosttyInstance,
      scrollbackBytes,
      // Synchronous scrolling (the widget's default eases over 100 ms) lets
      // calibrated pixel gestures accumulate directly in the widget's
      // fractional viewport.
      smoothScrollDuration: 0,
      theme: ghosttyTerminalTheme(),
    });
    term = ghosttyTerm;
    ghosttyTerm.onLinkActivate(onGhosttyLink);
    // Ghostty's auto-hiding scrollbar is painted onto the content without
    // clearing it, so the columns under
    // it stay readable and there is no gutter to hold back. Reserving width
    // here could not help in any case: the overlay is anchored to the canvas,
    // not to the host, so a narrower grid just moves the content it covers.
    // This FitLike keeps upstream's measurement and clamp behavior over the
    // whole content box.
    const proposeGhosttyGrid = () => {
      const metrics = ghosttyTerm.getMetrics();
      if (!metrics) return null;
      const style = window.getComputedStyle(terminalHost);
      return proposeGhosttyDimensions(
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
    };
    fit = {
      proposeDimensions: proposeGhosttyGrid,
      fit() {
        const proposed = proposeGhosttyGrid();
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
    // OSC 52 rides the byte observer: the ghostty VT core drops the
    // sequence and ghostty-web exposes no registerOscHandler
    // equivalent (see osc52Bridge.ts). Applied in writePtyOutput.
    osc52Bridge = new Osc52Bridge();
    ghosttyStatusGuard = new GhosttyStatusGuard();
    // The widget owns output following; the adapter forwards the tab's
    // writes and calibrates macOS pixel travel.
    const viewport = new GhosttyViewportController(ghosttyTerm, {
      os: currentOS,
      hasMouseTracking: () => ghosttyTerm.hasMouseTracking(),
      isAlternateScreen: () =>
        ghosttyTerm.buffer.active === ghosttyTerm.buffer.alternate,
      cellHeight: () => ghosttyTerm.getMetrics()?.height ?? 0,
    });
    ghosttyViewport = viewport;
    keyboardProtocolObserver = new KeyboardProtocolObserver(
      keyboardProtocol,
      sendGeneratedTerminalInput,
    );
    const protocolObserver = keyboardProtocolObserver;
    // Sync-callback writer for the origin tracker (see termWriter).
    termWriter = {
      write: (bytes, done) => {
        protocolObserver.push(bytes);
        viewport.write(bytes);
        done?.();
      },
    };
    // Wheel reporting shim: ghostty-web's capture-phase viewport
    // scroller stopPropagation()s the wheel before its own
    // InputHandler can report it, so SGR wheel-over-TUI reporting
    // never fires upstream (clicks do work). See handleGhosttyWheel.
    term.attachCustomWheelEventHandler(handleGhosttyWheel);
    // The widget's open() does not take the keyboard; a terminal in the
    // focused pane is focused once start() has wired it, below.
    term.open(host);
    host.addEventListener("keydown", noteInterruptKey, true);
    ghosttyKeyParity = installGhosttyKeyParity(host, {
      terminal: ghosttyTerm,
      platform: () => ({ isMac: currentOS() === "mac", isWindows: currentOS() === "windows" }),
      claimed: (e) =>
        isCloseExitedTabKey(e) ||
        shouldEscapeTerminal(e) ||
        isTerminalCopyChord(e, currentOS()) ||
        isTerminalPasteChord(e, currentOS()),
      chanBytes: (e) =>
        controlSlashBytes(e, resolvedEventKey(e)) ??
        terminalMetaKeyBytes(e, tab.keyboardProtocol),
      send: sendTypedInput,
    });
    host.addEventListener("focusin", onGhosttyFocusChange);
    host.addEventListener("focusout", onGhosttyFocusChange);
    primarySelectionCleanup = installTerminalPrimarySelection(host, ghosttyTerm, onTerminalContextMenu, focusFromMiddlePress);
    // The masker logged and disabled itself; record it on the tab so the
    // toggle's check stays truthful, and tell the user visibly.
    const onSecretMaskingFailure = () => {
      failTerminalSecretMasking(tab);
      setTransientStatus("Secret masking stopped working in this terminal");
    };
    // After open(): the widget retains a paint layer only once it is open.
    secretMasker = new GhosttySecretMasker(
      ghosttyTerm,
      secretMaskSuffixes,
      terminalSecretMaskColor(),
      effectiveSecretMasking,
      onSecretMaskingFailure,
    );
    refreshTerminalRenderer();
    installHostResumeListeners();
    // The widget skips a keystroke when its custom key handler returns
    // TRUE. handleTerminalKeyEvent returns FALSE for a key chan took and
    // TRUE for one the widget may type, with the native paste result
    // prepared for this inversion, so it is wrapped: "chan consumed this
    // chord" maps to the widget's "handled", while paste still reaches the
    // widget's native-paste early-return. The widget does not cancel a key
    // the handler takes from it, so every path in handleTerminalKeyEvent
    // that acts on a key cancels it itself.
    term.attachCustomKeyEventHandler((e) => !handleTerminalKeyEvent(e));
    term.onData(handleGhosttyData);
    term.onResize(({ cols, rows }) => publishLocalSize(cols, rows));
    resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(host);
    stopPixelRatioWatch?.();
    stopPixelRatioWatch = watchDevicePixelRatio(queueFit);
    // This empty renderer needs its host's grid before parsing replay, even
    // when born hidden. There is no socket to publish to at this one fit.
    broadcastGrid = null;
    gridMeasured = tmuxSized
      ? measureTmuxHost()
      : runTerminalFit(fit, term, (detail) => {
          statusDetail = detail;
        });
    hostGridKnown = gridMeasured;
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
    wakeProbe.reset();
    terminalConnection.retired();
  }

  function sendPing(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    terminalConnection.pingSent();
    send({ type: "ping" });
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
      // This timer can run ahead of frames a stall left queued, so expiry is
      // a suspicion: the socket gets the wake probe, or on a connection that
      // takes none a moment for a queued frame to cancel the close.
      if (wakeProbe.active) return;
      if (!skipsWakeProbe()) {
        probePtySocketAfterWake();
        return;
      }
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        try {
          ws?.close();
        } catch {
          // Already CLOSING/CLOSED; the pending onclose still drives the redial.
        }
      }, READ_DEADLINE_GRACE_MS);
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
    if (clientDetached()) return;
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
      setTerminalPendingGlobalName(tab, false);
      await applyGlobalTerminalName(tab);
      if (!term) return; // torn down during the fetch
    }
    closeSocket();
    status = "connecting";
    statusDetail = "";
    missedBytes = 0;
    const reattaching = Boolean(tab.terminalSessionId);
    // The cursor this dial echoes and the stream position the view has
    // parsed, which differ only while a cut replay owes a loss its suffix.
    const resume: { since: number; parsed: number } | undefined =
      !reattaching || !sawSessionControl || serverGeneration === null
        ? undefined
        : cut === null
          ? { since: receivedSeq, parsed: receivedSeq }
          : cut.resume
            ? { since: cut.resume.lossFrom ?? cut.resume.parsed, parsed: cut.resume.parsed }
            : undefined;
    const liveResumeSince = resume?.since;
    const liveResumeGeneration =
      liveResumeSince !== undefined ? (serverGeneration ?? undefined) : undefined;
    // Whether this dial's socket has delivered a session frame yet: its first
    // one on a reattach carries a replay of history the PTY already had.
    let dialSawSession = false;
    let resetBeforeReplay = false;
    pendingPromptSeed = reattaching ? "" : (tab.seedInput ?? "");
    promptSeedSent = false;
    // On a live socket reconnect the terminal still shows the screen it had
    // before the drop, so the dial resumes from the in-memory cursor, or
    // from where a cut replay that continued the view left it. On a remount
    // or reload the terminal is new and empty, so it asks for the whole
    // ring, as it does after any other cut replay.
    if (liveResumeSince === undefined) {
      receivedSeq = 0;
      serverGeneration = null;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const declareGrid = active && reattaching ? gridMeasured : hostGridKnown;
    const path = withTokenQuery(
      terminalWsPath({
        cols: declareGrid && !tmuxSized ? term.cols : undefined,
        rows: declareGrid && !tmuxSized ? term.rows : undefined,
        sizeIfUnset: !active,
        tabName: terminalTabName(tab),
        tabGroup: terminalTabGroup(tab),
        windowId: sessionWindowId(),
        paneId,
        side,
        tabId: tab.id,
        sessionId: tab.terminalSessionId,
        since: liveResumeSince,
        generation: liveResumeGeneration,
        cwd: reattaching ? undefined : tab.cwd,
        command: reattaching ? undefined : tab.spawnCommand,
        env: reattaching ? undefined : tab.spawnEnv,
        // Fresh-spawn only, like the three above: a reattach adopts whatever
        // shell the live PTY is already running, and the server ignores the
        // param on that path.
        profile: reattaching ? undefined : tab.profile,
        ack: true,
      }),
    );
    sentGrid = null;
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
        terminalConnection.opened();
        pingTimer = setInterval(sendPing, WS_PING_MS);
        sendPing();
      }
      if (term) publishLocalSize(term.cols, term.rows);
      sendFocusState();
    };
    ws.onmessage = async (event) => {
      // Any inbound frame proves the socket is live -- refresh the deadline
      // first, before decoding.
      armDeadline();
      wakeProbe.frameReceived();
      const bytes = await terminalMessageBytes(event.data);
      if (bytes) {
        // Count the frame before the terminal takes it. The core parses a
        // write before anything it then runs (replies, change listeners, a
        // render), so code inside the write sees the position the core
        // reached, and a throw from any of it cannot leave the position
        // short: a short ack stops the server once its window fills, and a
        // short cursor makes a redial replay what the screen already shows.
        // It precedes the reset and notice below, whose writes run the same
        // listeners.
        streamAck.parsed(bytes.length, attachReplayActive);
        // Advance the server byte cursor only for LIVE output: replay chunks
        // (between the `session` and `ready` frames) reconstruct history up to
        // the prelude `seq` we already adopted, so counting them would double.
        if (!attachReplayActive) receivedSeq += bytes.length;
        let written = bytes;
        const replay = attachReplayActive ? continuingReplay : null;
        if (replay) {
          const at = replay.start + replay.taken;
          const raw = Math.min(bytes.length, replay.length - replay.taken);
          replay.taken += raw;
          // What follows the replay's own bytes is the recovery suffix of
          // what it missed, which the view now parses.
          if (raw < bytes.length) replay.lossFrom = null;
          const repeated = Math.min(raw, Math.max(0, replay.parsed - at));
          if (repeated > 0) written = bytes.subarray(repeated);
          if (written.length === 0) return;
        }
        if (resetBeforeReplay && bytes.length > 0) {
          resetBeforeReplay = false;
          const terminal = term;
          const sessionId = tab.terminalSessionId;
          const protocol = tab.keyboardProtocol;
          const beforeReplay = keyboardProtocolBeforeReplay;
          // RIS resets the observed keyboard state too. Its write callback
          // runs once the observer has read it, before the replay is written.
          writeParsedPtyOutput(new TextEncoder().encode("\x1bc"), "replay", () => {
            if (term === terminal && tab.terminalSessionId === sessionId && protocol && beforeReplay) {
              copyTerminalKeyboardProtocolState(beforeReplay, protocol);
            }
          });
          if (missedBytes > 0) {
            writeParsedPtyOutput(new TextEncoder().encode(`\r\nterminal replay missed ${missedBytes} bytes\r\n`), "replay");
          }
        }
        writePtyOutput(written, attachPtyWriteOrigin());
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
      if (frame.type === "pong") {
        if (terminalConnection.pongArrived() && wakeProbe.active) {
          wakeProbe.answered();
          // Before its session frame a socket has not shown which session it
          // reached; that frame releases the hold instead.
          if (dialSawSession) inputHold.release();
        }
        return;
      }
      if (frame.type === "ready") {
        resetBeforeReplay = false;
        attachReplayActive = false;
        cut = null;
        suppressAttachReplayGeneratedReplies = false;
        statusDetail = `${frame.cols}x${frame.rows}`;
        if (tmuxSized) {
          broadcastGrid = { cols: frame.cols, rows: frame.rows };
          adoptBroadcastGrid();
        }
        terminalCwdAbs = frame.cwd ?? null;
        terminalCwdVirtual = frame.cwd_rel ?? null;
        recoverTerminalRendererAfterHostResume();
      } else if (frame.type === "session") {
        // The session id this tab held before adopting frame.id below. A
        // frame.id that differs is a fresh shell replacing the reaped session,
        // not a same-id live resume.
        const priorId = tab.terminalSessionId;
        const firstOnDial = !dialSawSession;
        if (
          inputHold.active &&
          heldFor &&
          ((heldFor.id !== undefined && heldFor.id !== frame.id) ||
            (heldFor.generation !== null && heldFor.generation !== frame.generation))
        ) {
          inputHold.abandon();
        }
        // A recovery on the live socket replays what the terminal never
        // parsed, like a redial's first frame: generated replies to the
        // replay stay local in both cases. A restart on the live socket has
        // a new generation: its replay is the new shell's first output, and
        // the queries in it are waiting for an answer.
        const duplicateReplay =
          (reattaching && !dialSawSession) ||
          (dialSawSession && frame.id === priorId && frame.generation === serverGeneration);
        // This frame continues the view's screen when the server resumed the
        // non-zero cursor this dial echoed in the live generation, or
        // recovers this socket's own stream after its `ready`. The frame
        // does not say so: this is the server's own rule, read again here
        // (the resume in `get_or_create_for_ws`, crates/chan-library's
        // `terminal_sessions.rs`, and the live recovery in chan-server's
        // `routes/terminal.rs`), so a change to when the server resumes a
        // view changes this expression too, and the redial tests' stand-in
        // server, which states the same rule.
        const continued =
          frame.id !== priorId
            ? undefined
            : firstOnDial
              ? resume && resume.since > 0 && frame.generation === liveResumeGeneration
                ? resume
                : undefined
              : !attachReplayActive && frame.generation === serverGeneration
                ? { since: receivedSeq, parsed: receivedSeq }
                : undefined;
        const replayLength = frame.replay_bytes;
        continuingReplay =
          continued && typeof replayLength === "number"
            ? {
                start: frame.seq - replayLength,
                length: replayLength,
                taken: 0,
                parsed: continued.parsed,
                lossFrom: (frame.missed_bytes ?? 0) > 0 ? continued.since : null,
              }
            : null;
        // The replay goes on from where the cut left the view.
        if (continuingReplay) cut = null;
        attachReplayActive = true;
        suppressAttachReplayGeneratedReplies = duplicateReplay;
        resetBeforeReplay = cut !== null && typeof frame.replay_bytes === "number" && frame.replay_bytes > 0;
        if (cut) {
          // These observers can hold a partial sequence even when the server
          // sends only its alternate-screen prelude and mode reassert.
          mouseFilter?.reset();
          osc52Bridge?.reset();
          // An answer with an empty replay is the prelude and a reassert that
          // only enables, which would leave on the view a mode the program
          // turned off since the cut. With the tracked modes cleared first,
          // the reassert leaves on exactly the ones the program has on; a
          // replay that starts with a reset clears them again.
          writeParsedPtyOutput(new TextEncoder().encode(trackedModesOffSequence()), "replay");
        }
        // After a cut, the protocol a reset replay restores is the one its
        // life had before the cut replay began. An answer in a generation
        // other than the one the dial echoed is either another life (a
        // restart whose reset came ahead of this frame) or a lossy restore
        // (another generation of the same program, with no reset ahead).
        // Both start from the protocol as it stands: the restart has already
        // reset it, and a lossy restore's ring may end behind the view, so
        // its replay may not repeat changes the view already saw.
        if (
          tab.keyboardProtocol &&
          (cut === null || (liveResumeGeneration !== undefined && frame.generation !== liveResumeGeneration))
        ) {
          keyboardProtocolBeforeReplay = copyTerminalKeyboardProtocolState(tab.keyboardProtocol);
        }
        dialSawSession = true;
        sawSessionControl = true;
        // A successful attach proves the session + path healthy: reset the
        // backoff ramp.
        reconnectBackoffMs = WS_RECONNECT_BACKOFF_MIN_MS;
        // Adopt the server's byte cursor + epoch for this incarnation.
        serverGeneration = frame.generation;
        receivedSeq = frame.seq;
        streamAck.adopt(frame);
        if (frame.tmux_consent) setTerminalTmuxConsent(tab, frame.tmux_consent, true);
        setTerminalTmuxPane(tab, frame.tmux_pane ?? null);
        // A fresh shell replacing this tab's session (frame.id changed) starts
        // with the terminal still holding a dead TUI's negotiated input
        // modes. Clear every mode in the server's tracked set plus the
        // alternate-screen exit, and drop the keyboard protocol, before any
        // replay so that leftover state does not leak into the new shell.
        // The protocol is reset in place, since the installed parser and key
        // handlers hold that object. A same-id live resume keeps the running
        // program's modes untouched, as the start does for a reattach.
        if (frame.id !== priorId) {
          ensureTerminalKeyboardProtocol(tab, true);
          keyboardProtocolBeforeReplay = copyTerminalKeyboardProtocolState(tab.keyboardProtocol!);
          writeParsedPtyOutput(new TextEncoder().encode(freshShellResetSequence()), "replay");
        }
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
        setTerminalProgram(tab, terminalProgramFromWire(frame.program));
        setTerminalActivity(tab, !focused && (frame.bytes_since_focus ?? 0) > 0);
        // Re-sync the queue badge on every (re)attach: the depth is absolute
        // server truth, never persisted client-side.
        setTerminalQueueDepth(tab, frame.queue_depth ?? 0);
        showProgramStatus(frame.program_status ?? { revision: 0, records: [] });
        queuedMessages = null;
        send({ type: "queue-details", enabled: active && !!tab.inspectorOpen });
        if (focused) markProgramCompletionsSeen(tab.programStatus);
        // Re-prove a RESTORED pending Rich Prompt message against the server's
        // authoritative queue (reload contract): re-lock + re-show it
        // with its position if still queued, clear it if it already drained.
        // Mutates tab state from this event handler (not a $derived); the
        // bubble's own onMount/$effect re-shows it when the view exists.
        reproveRestoredPrompt(tab, frame.queued_prompt_ids ?? []);
        scheduleTerminalSessionSave();
        // What the view lost past the position it shows. A dial that asked
        // again for a loss the view already shows lost only what its replay
        // starts past the position the view parsed: nothing when the replay
        // starts at or before it, and the view's parser goes on at its own
        // byte.
        missedBytes =
          continued !== undefined && continuingReplay !== null && continued.since < continued.parsed
            ? Math.max(0, continuingReplay.start - continued.parsed)
            : Math.max(0, Math.floor(frame.missed_bytes ?? 0));
        status = "connected";
        statusDetail = `session ${frame.id.slice(0, 8)}`;
        if (missedBytes > 0 && !resetBeforeReplay) {
          // The lost bytes can end inside a sequence whose rest never comes.
          // CAN on the output path ends it in the core and in every stream
          // observer, as the server's own recovery suffix does after the
          // replay, so neither this line nor the replay is read as part of
          // it. A reset replay starts with RIS, which ends it too.
          writePtyOutput(Uint8Array.of(0x18), "replay");
          writeChanLine(`\r\nterminal replay missed ${missedBytes} bytes`);
        }
        // A replacement socket has attached to the same session: what waited
        // for it goes now, unless a wake since its dial has it under a probe
        // of its own. The server reads it after the replay it is sending. A
        // later session frame is a recovery on this socket, which proves
        // nothing about a wake.
        if (firstOnDial) {
          if (wakeProbe.active) inputHold.replacementProven();
          else inputHold.release();
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
        broadcastGrid = { cols: frame.cols, rows: frame.rows };
        if (!active || tmuxSized) adoptBroadcastGrid();
        statusDetail = `${frame.cols}x${frame.rows}`;
      } else if (frame.type === "cwd") {
        terminalCwdAbs = frame.cwd ?? null;
        terminalCwdVirtual = frame.cwd_rel ?? null;
        links.noteCwd();
      } else if (frame.type === "activity") {
        setTerminalActivity(tab, !focused && frame.bytes_since_focus > 0);
      } else if (frame.type === "program") {
        // A reading from another session or an earlier incarnation of this
        // one describes a program that is not running here.
        if (frame.id === tab.terminalSessionId && frame.generation === serverGeneration) {
          setTerminalProgram(tab, terminalProgramFromWire(frame.program));
        }
      } else if (frame.type === "program-status") {
        if (frame.id === tab.terminalSessionId && frame.generation === serverGeneration) {
          showProgramStatus(applyProgramStatus(tab.programStatus, frame.program_status));
          if (focused) markProgramCompletionsSeen(tab.programStatus);
        }
      } else if (frame.type === "tmux-consent") {
        if (frame.id === tab.terminalSessionId && frame.generation === serverGeneration) {
          setTerminalTmuxConsent(tab, frame.tmux_consent);
        }
      } else if (frame.type === "queue-details") {
        if (active && tab.inspectorOpen) queuedMessages = frame.messages;
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
        status = "exited";
        inputHold.abandon();
        statusDetail = `session ended (${frame.reason})`;
        // The session (and its write queue) is gone: zero the badge and
        // fail any in-flight prompt so the bubble unlocks with its text.
        setTerminalQueueDepth(tab, 0);
        failPendingPrompt(tab);
        clearTerminalMetadataSink();
        // A parked PTY keeps the id, so every later save still names
        // the session and the reloaded window reattaches to the PTY the next
        // process restores; the server answers an id it no longer has with a
        // fresh shell. Other reasons, including unknown ones, clear the id.
        if (frame.reason !== "parked") clearTerminalSession(tab);
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
          writeChanLine(`\r\nsession ended (${frame.reason})`);
        }
      } else if (frame.type === "exit") {
        status = "exited";
        inputHold.abandon();
        // A session restored across a server restart has no reapable child,
        // so its exit frame carries no code.
        statusDetail = frame.code == null ? "exited" : `exit ${frame.code}`;
        setTerminalQueueDepth(tab, 0);
        failPendingPrompt(tab);
        clearTerminalMetadataSink();
        if (focused) markProgramCompletionsSeen(tab.programStatus);
        clearTerminalSession(tab, true);
        scheduleTerminalSessionSave();
        writeChanLine(
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
          writeChanLine(`\r\nterminal error: ${detail}`);
        }
      }
    };
    ws.onclose = () => {
      clearLiveness();
      streamAck.stop();
      clearTerminalMetadataSink();
      // Socket gone: any in-flight prompt can no longer observe its
      // delivery -- fail it (bubble unlocks, keeps text, labels honestly;
      // the message may still be queued server-side). The badge zeroes and
      // re-syncs from the session frame on reconnect.
      failPendingPrompt(tab);
      setTerminalQueueDepth(tab, 0);
      // A transient dial failure never strands a resumable session: the id
      // survives so an offline/sleep window can still reattach the persisted
      // remote session on reconnect. Only the server's `exit` frame and a
      // `closed` frame for any reason but `parked` clear the session id.
      if (status !== "exited") status = "closed";
      // Heal: redial with capped backoff through the reattach path. An exited
      // session stays down (the server ended it; the tab shows its exit
      // affordance) and the control terminal is a single-shot local runner that
      // never redials; everything else -- the gateway idle cut, a tunnel
      // bounce, the read-deadline forcing a zombie closed, a failed dial --
      // redials.
      if (status === "exited" || ui.terminalControl) return;
      inputHold.awaitReplacement(WS_CONNECT_DEADLINE_MS);
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
    // Whether an unfocused terminal holds unseen output is the server's
    // call: it counts the visible text written since the last focus and
    // says so in an `activity` frame, sent ahead of the chunk that carries
    // the first of it, and in the `session` frame at attach. A chunk is no
    // evidence on its own. A program with focus reporting on (DECSET 1004)
    // answers the terminal's own focus-out report, and a redraw that
    // changes nothing is control sequences alone; replayed history is not
    // output since the last focus either. So a chunk only PULSES a dot the
    // server already raised. A focused terminal is being watched, so no
    // pulse. Re-arm a quiet-timer on every chunk; when output stops (no
    // chunk within the quiet window) the dot stops pulsing and goes SOLID,
    // still unseen, until the user focuses the tab
    // (setTerminalActivity(false) clears both).
    if (focused || !tab.terminalActivity) return;
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
    clearTerminalSeedInput(tab);
    setTimeout(() => {
      // Sent directly, the seed arms no input ping, owes no note and
      // reaches no broadcast group.
      sendInput(seed);
      focusTerminalAfterWait();
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

  // The banner stays until the server says the question is closed: every
  // attached client shows it and the first answer wins.
  function answerTmux(answer: TmuxAnswer): void {
    send({ type: "tmux-answer", answer });
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

  /// `binary` marks `data` as one byte per character, which the server writes
  /// as the characters' codes rather than their UTF-8. Text frames carry no
  /// such field.
  function sendInput(data: string, binary = false): boolean {
    return send(binary ? { type: "input", data, binary } : { type: "input", data });
  }

  function sendGeneratedTerminalInput(data: string): void {
    if (!shouldForwardGeneratedTerminalInput(ptyWrites)) return;
    sendInput(data);
  }

  /// Rich Prompt + team-lead-identity submit path: send `data` over the existing
  /// terminal WS as a `prompt` frame so the server ENQUEUES it into this
  /// session's write queue (shared FIFO with `cs terminal write`) and applies
  /// the submit encoding when the agent is idle. Deliberately NOT `sendInput`
  /// (the raw keystroke path bypasses the queue). `agent` picks
  /// the encoding (claude CSI, agy/codex/kimi/muse/opencode bracketed paste
  /// + CR, gemini split CR); omitted defaults to claude server-side, and a name
  /// the server does not know as an agent ("none") gets no chord. A Rich
  /// Prompt is its own agent turn: the notification batcher never folds it
  /// into a batch.
  /// `id` tags the message for prompt-ack / prompt-delivered tracking; omitted
  /// = fire-and-forget (the orchestrator's lead-identity prompt stays so).
  /// Both Rich Prompt and deliverLeadIdentity reveal the submitted input;
  /// a disconnected retry leaves the reader's viewport untouched.
  /// Returns whether the send went out: false when the socket is not open,
  /// so the orchestrator can retry a freshly-spawned lead, and when the
  /// session is gone, where no retry can succeed.
  function sendPrompt(data: string, agent?: string, id?: string): boolean {
    // Untagged prompts are the orchestrator's, which retries on a refusal.
    if (id && inputHold.active) {
      term?.scrollToBottom();
      inputHold.offer({
        frame: { type: "prompt", data, ...(agent ? { agent } : {}), id },
        size: data.length,
        countsAsInput: true,
        promptId: id,
      });
      return true;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (id && status !== "exited") terminalConnection.inputRefused();
      return false;
    }
    term?.scrollToBottom();
    const sent = send({ type: "prompt", data, ...(agent ? { agent } : {}), ...(id ? { id } : {}) });
    if (sent && id) terminalConnection.inputSent();
    return sent;
  }

  /// Rich Prompt recall: ask the server to pull a still-queued message out of
  /// this session's write queue by its `prompt_id`. The server replies with a
  /// `prompt-cancelled` ack (removed: true|false). Returns whether the WS was
  /// open.
  function sendCancelPrompt(id: string): boolean {
    if (inputHold.remove(id)) {
      resolvePromptCancelled(tab, id, true);
      return true;
    }
    return send({ type: "cancel-prompt", id });
  }

  function chordLabel(id: string): string {
    return chordFor(id) ?? "";
  }

  // The command context as it reads with this terminal focused. A toggle's
  // state is the catalog's, read for the tab its context names, and a menu's
  // rows are about the terminal the menu belongs to.
  const menuContext = $derived<CommandContext>({
    ...commandContext(),
    activeSurface: "terminal",
    activeTabId: tab.id,
  });

  // The launcher's own toggle has no catalog row; the shortcut table names it.
  const launcherLabel = shortcutLabel("app.launcher.toggle");

  // Rich Prompt: the row mirrors the `terminal.richPrompt` chord (App.svelte
  // onWindowKey) and calls the toggle the chord's command reaches.
  function toggleRichPromptFromMenu(): void {
    closeTabMenu();
    toggleRichPromptForTab(tab.id);
  }

  // The bubble's style toolbar lives in the bubble, so its row is offered
  // only while the bubble is shown.
  function toggleRichPromptToolbarFromMenu(): void {
    closeTabMenu();
    toggleRichPromptToolbar(tab.id);
  }

  // Closing the inspector hands the keyboard back: to its owner when
  // something owns it (a survey over this terminal, which the floating
  // inspector does not cover), as the owner's surface takes it, else to the
  // surface of this terminal that last took it, so a shown Rich Prompt's
  // composer gets it back and not the terminal under it.
  function closeInspector(): void {
    tab.inspectorOpen = false;
    if (owner() !== null) handKeyboardToOwner();
    else focusLastKeyboardSurface();
  }

  // The launcher opens from this terminal, as its chord does from a focused
  // terminal, so it hands the keyboard back here when it closes.
  function openCommandsFromMenu(e: MouseEvent): void {
    const row = e.currentTarget as Element;
    closeTabMenu();
    openCommandLauncherFromMenu(row, focusTerminal);
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
    onComplete?: () => void,
  ): void {
    if (!term || !termWriter) return;
    // Observe (never alter) the stream for OSC 52 clipboard copies -- the
    // VT core drops them and exposes no JS hook.
    osc52Bridge?.push(bytes);
    if (ghosttyStatusGuard) bytes = ghosttyStatusGuard.push(bytes);
    if (!bytes.length) {
      onComplete?.();
      return;
    }
    ptyWrites.write(termWriter, bytes, origin, onComplete);
  }

  /// A line chan prints in the terminal itself: a replay gap, the session
  /// ending, an error. It is written to the terminal as output is, so the
  /// widget counts it in an open find bar's search and keeps a scrolled-back
  /// viewport where it is.
  function writeChanLine(line: string): void {
    ghosttyViewport?.write(`${line}\r\n`);
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
    if (typed) sendTypedInput(typed);
  }

  /// Keys and dropped paths bypass the widget's own input scroll. Mouse
  /// reports and program replies keep the send path without this scroll.
  function sendTypedInput(data: string): void {
    if (ws?.readyState === WebSocket.OPEN) term?.scrollToBottom();
    sendUserInput(data);
  }

  function sendUserInput(data: string, binary = false, probeInput = true): void {
    const interrupt = interruptKeyPress;
    sendUserFrame(inputEntry(data, binary, probeInput && !terminalMouseReport(data)), interrupt);
    broadcastTerminalInput(tab, data, binary, interrupt);
    // Cross-window broadcast: same-group members in OTHER windows live in the
    // shared terminal registry and are unreachable from this window's SPA, so
    // the server fans the input to them. Same-window members are covered by
    // `broadcastTerminalInput` above.
    if (tab.broadcastEnabled) {
      sendUserFrame({
        frame: binary ? { type: "broadcast-input", data, binary } : { type: "broadcast-input", data },
        size: data.length,
        countsAsInput: false,
      }, interrupt);
    }
  }

  function inputEntry(data: string, binary: boolean | undefined, countsAsInput: boolean): HeldInput {
    return {
      frame: binary ? { type: "input", data, binary } : { type: "input", data },
      size: data.length,
      countsAsInput,
    };
  }

  /// Everything the user originates reaches the socket here, through the hold
  /// while the socket is unproven.
  function sendUserFrame(entry: HeldInput, interrupt: boolean): void {
    if (inputHold.active) {
      if (interrupt) inputHold.interrupt(entry);
      else inputHold.offer(entry);
      return;
    }
    noteUserFrame(entry, send(entry.frame));
  }

  function noteUserFrame(entry: HeldInput, sent: boolean): void {
    if (!entry.countsAsInput) return;
    if (sent) terminalConnection.inputSent();
    else if (status !== "exited") terminalConnection.inputRefused();
  }

  function handleGhosttyData(data: string): void {
    const mouseReport = terminalMouseReport(data);
    if (mouseReport === "x10") {
      sendUserInput(data, true);
    } else if (mouseReport === "sgr") {
      sendUserInput(data);
    } else {
      handleTerminalData(data);
    }
  }

  function handleTerminalData(data: string): void {
    routeTerminalData(data, ptyWrites, sendInput, sendUserInput);
  }

  /// Focus reporting (DECSET 1004). xterm.js sends CSI I and
  /// CSI O itself when its input gains and loses focus; ghostty-web tracks
  /// the mode and sends nothing, so the report is made here, at the element
  /// ghostty-web focuses. A move between that element and its own input is
  /// not a change of focus for the program. The report is this terminal's
  /// answer to its own program, so it goes to this PTY alone.
  function onGhosttyFocusChange(e: FocusEvent): void {
    if (e.relatedTarget instanceof Node && host?.contains(e.relatedTarget)) {
      return;
    }
    const t = term;
    if (!t?.hasFocusEvents()) {
      // The program did not hear of this change, so its last report no
      // longer says where the keyboard is: the next change it does hear of
      // is reported whichever way it goes.
      ghosttyReportedFocus = null;
      return;
    }
    const hasFocus = e.type === "focusin";
    // A resume's blur/refocus and the browser's retained focus events can
    // report the same transition twice.
    if (hasFocus === ghosttyReportedFocus) return;
    ghosttyReportedFocus = hasFocus;
    sendInput(hasFocus ? "\x1b[I" : "\x1b[O");
  }

  /// Wheel input. ghostty-web registers its viewport scroller
  /// capture-phase with an unconditional stopPropagation(), so
  /// its InputHandler's wheel reporter (SGR 64/65) never sees the event;
  /// the custom-wheel hook runs before the scroller and true claims the
  /// event. On the primary buffer without mouse tracking the viewport
  /// controller claims only the calibrated macOS pixel-mode case and
  /// every other event declines to ghostty's native local scroll. When
  /// the app owns the wheel (mouse tracking, or the alternate screen
  /// without it) every event is claimed and paced like xterm.js
  /// (ghosttyWheel.ts): an event that completes a row sends one wheel
  /// report, or one up/down arrow, and the rest send nothing. Reports go
  /// as user input to this PTY and the broadcast group, X10 as bytes and
  /// SGR as text, with coordinates from the canvas rect / live grid size
  /// (SGR coords are 1-based cells).
  function handleGhosttyWheel(e: WheelEvent): boolean {
    const t = term;
    if (!t) return false;
    const tracking = t.hasMouseTracking();
    if (!tracking && t.buffer.active !== t.buffer.alternate) {
      return ghosttyViewport?.handleWheel(e) ?? false;
    }
    if (!tracking) {
      const cellHeight = t.getMetrics()?.height ?? 0;
      if (!(cellHeight > 0)) return false;
      if (ghosttyWheelRows.consume(e, cellHeight, t.rows) !== 0) {
        sendUserInput(ghosttyWheelArrow(e.deltaY < 0, t.getMode(1, false)), false, false);
      }
      return true;
    }
    const canvas = e.target as HTMLElement | null;
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return false;
    const cellW = rect.width / t.cols;
    const cellH = rect.height / t.rows;
    if (!(cellW > 0) || !(cellH > 0)) return false;
    if (ghosttyWheelRows.consume(e, cellH, t.rows) === 0) return true;
    const col = Math.min(t.cols, Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1));
    const row = Math.min(t.rows, Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1));
    // Modifier bits mirror xterm/ghostty-web: shift 4, alt 8, ctrl 16.
    const mods = (e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0);
    // Wheel reports are press-only, one per event that completes a row;
    // 64 = up, 65 = down. SGR encoding when mode 1006 is set (and by
    // default, mirroring ghostty-web's hasSgrMouseMode fallback);
    // legacy X10 otherwise.
    const button = (e.deltaY < 0 ? 64 : 65) + mods;
    if (t.getMode(1006, false)) {
      sendUserInput(`\x1b[<${button};${col};${row}M`);
    } else {
      const ch = (v: number) => String.fromCharCode(Math.min(v + 32, 255));
      sendUserInput(`\x1b[M${ch(button)}${ch(col)}${ch(row)}`, true);
    }
    return true;
  }

  function adoptBroadcastGrid(): void {
    if (term && broadcastGrid && (term.cols !== broadcastGrid.cols || term.rows !== broadcastGrid.rows)) {
      term.resize(broadcastGrid.cols, broadcastGrid.rows);
      hostGridKnown = false;
    }
  }

  function publishLocalSize(cols: number, rows: number, reclaim = false): void {
    if (tmuxSized || !active || !gridMeasured) return;
    if (!reclaim && !revealPending && sentGrid?.cols === cols && sentGrid.rows === rows) return;
    if (send({ type: "resize", cols, rows })) {
      sentGrid = { cols, rows };
      // The PTY holds this grid once the frame lands, so a reclaim before its
      // echo arrives does not send it again.
      broadcastGrid = { cols, rows };
      revealPending = false;
    }
  }

  // The PTY takes the size of whichever client sent one last, and a fit here
  // publishes only when this view's own grid changes. Another client showing
  // the same session therefore keeps the PTY at its grid until this view is
  // used. Nothing answers that client's resize frame directly: two shown
  // views answering each other would resize the PTY back and forth. The tab
  // listens in the capture phase, so the resize frame goes out before the
  // renderer turns the same key or paste into input.
  function reclaimPtySize(event: Event): void {
    if (!tmuxSized && term && shouldReclaimPtySize(event, term, broadcastGrid)) {
      publishLocalSize(term.cols, term.rows, true);
    }
  }

  /// The tab's capture-phase paste: the PTY size reclaim, then the paste
  /// itself, cleaned by the core's encoder before the renderer would frame
  /// it as the clipboard holds it, with an empty one (an image) that
  /// ghostty-web would drop (ghosttyPaste.ts).
  /// Only a paste aimed at the renderer host: the composer inside the tab
  /// takes its own pastes, images included.
  function onTerminalPasteCapture(event: ClipboardEvent): void {
    reclaimPtySize(event);
    if (!host) return;
    if (!(event.target instanceof Node) || !host.contains(event.target)) return;
    handleGhosttyPaste(event, term);
  }

  /// A paste delivered as an input with no paste event before it, which
  /// ghostty-web's textarea would send unclean; the same cleaned paste. Only
  /// on the renderer host, as for the paste event.
  function onTerminalBeforeInputCapture(event: InputEvent): void {
    if (!host) return;
    if (!(event.target instanceof Node) || !host.contains(event.target)) return;
    handleGhosttyPasteInput(event, term);
  }

  /// Measure what a tmux pane's host can show without fitting the renderer
  /// to it: the grid goes to the tab, and the renderer keeps tmux's size,
  /// adopted from the server's last word. True once the host is measurable.
  function measureTmuxHost(): boolean {
    let proposed: { cols: number; rows: number } | null | undefined = null;
    try {
      proposed = fit?.proposeDimensions();
    } catch {
      proposed = null;
    }
    const measured = Boolean(
      proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows) && proposed.cols > 0 && proposed.rows > 0,
    );
    setTerminalTmuxHostGrid(tab, measured ? proposed! : null);
    adoptBroadcastGrid();
    if (term) statusDetail = `${term.cols}x${term.rows}`;
    return measured;
  }

  function fitToHost(): void {
    if (!active) return;
    if (tmuxSized) {
      gridMeasured = measureTmuxHost();
      if (gridMeasured) hostGridKnown = true;
      return;
    }
    gridMeasured = runTerminalFit(fit, term, (detail) => {
      statusDetail = detail;
    });
    if (gridMeasured) hostGridKnown = true;
    // A fit can leave the renderer unchanged while its reveal still owes
    // the PTY a size. The same publisher absorbs the onResize notification.
    if (term) publishLocalSize(term.cols, term.rows);
  }

  function queueFit(): void {
    fitFrame.request();
    // Trailing-edge fit. ResizeObserver sometimes misses or swallows
    // the FINAL resize event of a drag gesture (a browser quirk: the
    // observer batches and can collapse intermediate sizes when the
    // host element transitions through layout-thrashing states like
    // `display: none` ↔ visible on tab switch). Without a
    // trailing-edge fit, the terminal stays at the size from
    // the FIRST observed resize tick instead of the FINAL pane
    // width. The frame fit above handles the leading edge; the
    // debounced trailing fit below converges on the steady-
    // state size 120ms after the last observed change. Idempotent
    // when the size hasn't drifted: `fit.fit` short-circuits +
    // `term.resize` no-ops on identical cols/rows so no
    // spurious SIGWINCH lands on the PTY.
    trailingFit.schedule();
  }

  function closeSocket(): void {
    if (attachReplayActive) {
      cut = {
        resume: continuingReplay && {
          parsed: Math.max(continuingReplay.parsed, continuingReplay.start + continuingReplay.taken),
          lossFrom: continuingReplay.lossFrom,
        },
      };
    }
    attachReplayActive = false;
    suppressAttachReplayGeneratedReplies = false;
    streamAck.stop();
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
    // A start() still loading settles to nothing.
    startAttempt += 1;
    loadFailure = null;
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    fitFrame.cancel();
    trailingFit.clear();
    clearHostResumeTimers();
    rendererRepaint.cancel();
    hostResumeListenerCleanup?.();
    if (activityPulseTimer) {
      clearTimeout(activityPulseTimer);
      activityPulseTimer = null;
    }
    closeSocket();
    inputHold.abandon();
    resizeObserver?.disconnect();
    resizeObserver = null;
    stopPixelRatioWatch?.();
    stopPixelRatioWatch = null;
    primarySelectionCleanup?.();
    primarySelectionCleanup = null;
    ghosttyKeyParity?.();
    ghosttyKeyParity = null;
    ghosttyReportedFocus = null;
    host?.removeEventListener("keydown", noteInterruptKey, true);
    host?.removeEventListener("focusin", onGhosttyFocusChange);
    host?.removeEventListener("focusout", onGhosttyFocusChange);
    secretMasker?.dispose();
    secretMasker = null;
    // The terminal's disposal frees its search and removes its layers.
    findSubscription?.dispose();
    findSubscription = null;
    term?.dispose();
    term = null;
    sawSessionControl = false;
    termWriter = null;
    ptyWrites.reset();
    mouseFilter = null;
    osc52Bridge = null;
    ghosttyStatusGuard = null;
    keyboardProtocolObserver = null;
    ghosttyViewport = null;
    fit = null;
    findCount = null;
  }

  /// The load error's Retry: load again, from whatever the loader kept.
  function retryLoad(): void {
    loadFailure = null;
    void start();
  }

  /// What the load error says still holds, and what its action does about
  /// it. Neither the loader nor the engine says why a final failure stays,
  /// so no cause is named. Of a session the tab held, the page knows only
  /// that the failure did not end it: with no socket, the view would not
  /// hear the server end it since.
  function loadFailureHint(final: boolean): string {
    const shell = tab.terminalSessionId
      ? `The failure did not end its shell; ${final ? "the reload" : "Retry"} attaches to it.`
      : "No shell was started.";
    return final ? `This window will not load the terminal again until it is reloaded. ${shell}` : shell;
  }

  function releaseLoadFailureKeyboard(): void {
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && loadFailureArea?.contains(holder)) holder.blur();
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
        // protocol no longer applies: reset it in place (the same object the
        // protocol observer and the key handling hold) so a fresh plain
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
    terminalConnection.restartRequested();
    explicitCloseSession();
    // An open find bar searches the terminal torn down here. It closes with
    // it, as on Escape, and keeps its query for the next open: left open it
    // would show that query over a terminal it has not searched. start()
    // hands the keyboard to the new terminal.
    if (findOpen) {
      findOpen = false;
      clearFind();
    }
    teardown();
    void tick().then(start);
  }

  function explicitCloseSession(): void {
    if (tab.terminalSessionId) {
      // The close frame needs an open socket. A view that did not load never
      // dialed, and a loaded one can still be dialing, or waiting to redial
      // after a drop; with no socket to carry the frame, the route ends the
      // live session.
      if (!send({ type: "close" })) {
        void api.closeTerminal(tab.terminalSessionId).catch(() => {});
      }
      clearTerminalMetadataSink();
      clearTerminalSession(tab);
      scheduleTerminalSessionSave();
    }
  }

  function closeTerminalForTab(): boolean {
    // A cross-window MOVE removes the tab from THIS window but the PTY must
    // survive (it lives in the shared `/terminal` registry and the target
    // window re-attaches to it by id). So skip the WS `close` frame that would
    // kill the shell; just clear the local session binding so this window's WS
    // doesn't reconnect during teardown. Window-local cleanup (the bubble's
    // entries) below still runs - the tab is gone here.
    const moving = isTerminalMoving(tab.id);
    if (moving) {
      clearTerminalMetadataSink();
      clearTerminalSession(tab);
    } else {
      explicitCloseSession();
    }
    // Discard this terminal's Rich Prompt draft folder (draft.md + any pasted
    // media) so nothing leaks in Drafts: the bubble's draft is tied to
    // the terminal lifecycle. Best-effort + fire-and-forget; the tab is going
    // away regardless. A moved tab keeps it: its new window names the same
    // draft, with or without a session.
    if (tab.richPromptDraftPath && !moving) {
      void api.discardDraft(tab.richPromptDraftPath);
    }
    // Drop this terminal's per-terminal bubble entries so they do not linger
    // in the keyed maps after the tab is gone.
    hideRichPromptForTab(tab.id);
    forgetRichPromptChrome(tab.id);
    return true;
  }

  /// Scrollback text for the copy actions. The widget formats the history
  /// and screen as plain text through getScrollbackText(), applying the
  /// current drawn-wrap policy.
  function scrollbackText(): string {
    return term?.getScrollbackText() ?? "";
  }

  /// Whether this terminal's session runs Muse, whose cut rows a ghostty
  /// copy joins; asked at each copy, so it follows the program in front.
  function runsMuse(): boolean {
    return sessionRunsMuse(tab.submitAgent, tab.terminalProgram?.command);
  }

  // The terminal's copies write through writeClipboardText and refocus the
  // terminal once the write lands. The menu and the chord fire them and
  // forget, so a failed write is logged here rather than left to reject
  // unhandled, and focus stays where the failure left it.
  async function copyToClipboard(text: string): Promise<void> {
    try {
      await writeClipboardText(text);
    } catch (err) {
      console.warn("terminal copy failed", err);
      return;
    }
    focusTerminalAfterWait();
  }

  async function copyScrollback(): Promise<void> {
    closeTabMenu();
    const text = scrollbackText();
    if (!text) return;
    await copyToClipboard(text);
  }

  /// The active find match's text while the find bar is open. Find paints
  /// the match on the widget's `search-active` highlight layer and leaves
  /// the selection to the user, so the match is read from the layer's
  /// range. Empty with the bar closed and with no match.
  function findMatchText(): string {
    if (!findOpen) return "";
    const match = term?.highlights.get("search-active")?.ranges[0];
    return match ? term!.getRangeText(match) : "";
  }

  async function copySelectionOrScrollback(): Promise<void> {
    closeTabMenu();
    const text = term?.getSelection() || findMatchText() || scrollbackText();
    if (!text) return;
    await copyToClipboard(text);
  }

  // The masking row. The launcher's command flips the same choice through
  // the same function and leaves the keyboard where the launcher has it;
  // the masker follows the choice from either.
  function toggleSecretMaskingFromMenu(): void {
    closeTabMenu();
    if (!toggleTerminalSecretMasking(tab)) return;
    focusTerminal();
  }

  // The right-click menu's "Paste" entry. A menu click is NOT an OS paste
  // gesture, so unlike Cmd+V (which rides the native `paste` event) it must
  // read the clipboard programmatically. `readClipboardText` does that natively
  // in Rust under chan-desktop so it bypasses WKWebView's DOM-paste "Paste"
  // button; on web it falls back to the gesture-permitted navigator.clipboard.
  // The text goes the way Cmd+V's does: chan's cleaned paste.
  async function pasteClipboard(): Promise<void> {
    closeTabMenu();
    const text = await readClipboardText();
    if (text && term) pasteIntoGhostty(term, text);
    focusTerminalAfterWait();
  }

  // Keyboard copy (Cmd+C / Ctrl+Shift+C, and a chord the user assigned to
  // the Copy command) copies the CURRENT SELECTION only. A bare copy chord
  // must never dump the whole scrollback - that is the explicit "Copy
  // Scrollback" menu action - so an empty selection is a no-op, matching
  // every native terminal. The menu's "Copy" falls back to the find match
  // and then the scrollback because an explicit click wants a result.
  async function copySelectionToClipboard(): Promise<void> {
    const text = term?.getSelection() ?? "";
    if (!text) return;
    await copyToClipboard(text);
  }

  function openFind(): void {
    closeTabMenu();
    // Find is the terminal's own search: with no terminal open, the failed
    // load's card included, the bar stays closed.
    if (!terminalSearch()) return;
    findOpen = true;
    void tick().then(() => {
      if (searchInput && mayFocus(searchInput)) searchInput.focus();
    });
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
    // A standalone window has no workspace root; its file context translates the
    // PTY's absolute cwd back to the wire-relative form.
    const filesCtx = filesContext.current;
    if (filesCtx && abs) {
      return wirePathFromAbsolute(filesCtx, abs.replace(/\\/g, "/"));
    }
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

  // The command launcher runs at the app root, but a terminal's live $CWD,
  // its session lifecycle and its renderer live in this component, so the
  // launcher's live-PTY terminal actions arrive as chan:command events the
  // focused terminal handles. Only the active tab of the focused pane
  // responds, so the launcher's active-surface gate and the acting terminal
  // agree. Find, Copy, Paste and Copy scrollback each call the function
  // their menu row calls, but for a Copy the command marks as run by the
  // chord the user assigned to it, which calls the copy chord's.
  //
  // The find family rides the same bus: on desktop the key bridge claims
  // the find chords before the webview sees the keydown and fires
  // app.find.open / app.find.next / app.find.prev as chan:command events.
  // While the keyboard is inside the active terminal tab the bridge
  // releases Mod+F in both forms (onShellKeydown opens the bar on
  // `terminal.find`, and Ctrl+F is the shell's) and Ctrl+G (BEL to a
  // shell; the find input steps on it in onFindKeydown). What still
  // arrives here is Cmd+G, the Shift+G form, and a find chord pressed with
  // the keyboard outside the tab. App.svelte serves the family for file
  // tabs only, so the focused terminal must serve itself here or those
  // are dead on a terminal pane.
  $effect(() => {
    const onLauncherCommand = (e: Event) => {
      // This bus reaches the listener past App's gate, so it keeps the
      // gate's cover rule itself.
      if (!active || !focused || appInputBlocked()) return;
      const detail = (e as CustomEvent).detail;
      const name = detail?.name;
      if (name === "app.terminal.restart") void restart();
      else if (name === "app.terminal.copyCwd") void copyTerminalCwd();
      else if (name === "app.terminal.newFsEntry") openNewFsEntry();
      else if (name === "terminal.copy" && detail.chord === true) void copySelectionToClipboard();
      else if (name === "terminal.copy") void copySelectionOrScrollback();
      else if (name === "terminal.paste") void pasteClipboard();
      else if (name === "app.terminal.copyScrollback") void copyScrollback();
      else if (name === "terminal.find" || name === "app.find.open") openFind();
      else if (name === "app.find.next" && findOpen) stepFind("older");
      else if (name === "app.find.prev" && findOpen) stepFind("newer");
    };
    window.addEventListener("chan:command", onLauncherCommand);
    return () => window.removeEventListener("chan:command", onLauncherCommand);
  });

  // Team Work has no composer of its own. It is the New team dialog +
  // orchestrator spawn/load; the lead is a NORMAL terminal whose identity
  // prompt the orchestrator auto-delivers through the write queue (the same
  // prompt-frame path every terminal uses). Per-terminal text input is the
  // universal Rich Prompt (Cmd+Shift+P) - see RichPrompt.svelte / sendPrompt.

  /// The open terminal's search, with the find bar's count following its
  /// state from the first use; null while no terminal is open, since a
  /// search reached before open is inert and reports nothing.
  function terminalSearch(): TerminalSearch | null {
    if (!term?.core) return null;
    findSubscription ??= term.search.onChange((state) => {
      findCount = state;
    });
    return term.search;
  }

  /// The bar closed or its query emptied: drop the highlights and the count,
  /// free the search and stop its scan.
  function clearFind(): void {
    term?.search.close();
    findCount = null;
  }

  /// The query changed: select the newest match, the bottom-most in the
  /// buffer. The scan selects it on the frame that finds it.
  function findNewest(): void {
    if (!findQuery.trim()) {
      clearFind();
      return;
    }
    terminalSearch()?.find(findQuery);
  }

  /// Step from the selected match. Next (Enter) walks toward older output,
  /// up the buffer, the way a terminal is read from the prompt. Newer is
  /// down the buffer. Both wrap.
  function stepFind(direction: "older" | "newer"): void {
    if (!findQuery.trim()) {
      clearFind();
      return;
    }
    terminalSearch()?.step(findQuery, direction);
  }

  function onFindKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      findOpen = false;
      clearFind();
      focusTerminal();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      stepFind(e.shiftKey ? "newer" : "older");
      return;
    }
    // Find next and Find previous, as the shortcut registry resolves them on
    // this client, a user's assignment included. The desktop's key bridge
    // claims those chords ahead of the page and they arrive as commands,
    // except the one it leaves to a focused terminal tab: Ctrl+G, BEL to a
    // shell. The find input sits in that tab but is not the shell, so the
    // chord steps here and goes no further. A key the bridge did claim never
    // reaches this handler, and a browser has neither chord unless the user
    // assigned one.
    const direction = eventMatchesShortcut(e, "app.find.next")
      ? "older"
      : eventMatchesShortcut(e, "app.find.prev")
        ? "newer"
        : null;
    if (direction) {
      consumeKey(e);
      stepFind(direction);
    }
  }

  /// The close-tab chord on an exited terminal is Ctrl+D and nothing near
  /// it. Shift is excluded because Ctrl+Shift+D is a different chord the
  /// terminal does not claim, so matching it would close a tab the user is
  /// not closing.
  function isCloseExitedTabKey(e: KeyboardEvent): boolean {
    return (
      e.type === "keydown" &&
      status === "exited" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "d"
    );
  }

  function closeExitedTabFromKey(e: KeyboardEvent): boolean {
    if (!isCloseExitedTabKey(e)) return false;
    e.preventDefault();
    // The widget calls its custom key handler and then lets the event
    // keep going: it returns out of its keydown without touching it.
    // It does not stop propagation, so without this the key this close took
    // would go on to the terminal root's onkeydown and every handler above
    // it.
    e.stopPropagation();
    void closeTab(paneId, tab.id, { force: true });
    return true;
  }

  function handleTerminalKeyEvent(e: KeyboardEvent): boolean {
    if (closeExitedTabFromKey(e)) return false;
    // Copy/paste chords act on the terminal's selection / system clipboard,
    // not the PTY. Resolve them here (the custom handler runs before the
    // widget processes the key) so no bytes reach the shell and Ctrl+Shift+C
    // does not raise SIGINT. `false` means chan took the keystroke. Paste
    // leaves the browser's native event to travel to the tab's capture
    // listener (onTerminalPasteCapture); its pre-inversion result is true so
    // the wrapper passes the key through without suppressing that native
    // event.
    if (
      handleTerminalClipboardChord(e, {
        os: currentOS(),
        copySelection: () => void copySelectionToClipboard(),
      })
    ) {
      // The copy is done here, and the component root claims the same chord
      // for a terminal whose renderer does NOT have focus. The widget does
      // not stop propagation on its own, so without this the event reaches the
      // root and copies a second time. Paste is only MATCHED here, never
      // acted on, and its work is the native paste event's listener, so it
      // keeps travelling.
      if (isTerminalCopyChord(e, currentOS())) e.stopPropagation();
      return terminalClipboardKeyHandlerResult(e, currentOS());
    }
    // Chord-escape registry. When the incoming event matches a shortcut
    // flagged `escapeTerminal: true` in shortcuts.ts, return false so the
    // widget does not consume the keystroke. It leaves the widget with its
    // default intact: the handler that acts on it (this tab's root for find,
    // the app's window keymap for the rest) cancels it there, and a chord
    // the app declines is still the browser's.
    if (shouldEscapeTerminal(e)) return false;
    // Every other key was decided before the widget saw it (ghosttyKeys.ts);
    // what reaches here is plain typing, which the widget types itself.
    return true;
  }

  function descendantOwnsCopy(e: KeyboardEvent): boolean {
    const target = e.target;
    const root = e.currentTarget;
    if (!(target instanceof Element) || !(root instanceof Element)) return false;
    const renderer = root.querySelector(".terminal-host");
    if (target.closest(".terminal-host")) return false;
    if (target.closest("input, textarea, select, [contenteditable]")) return true;
    const selection = root.ownerDocument.getSelection();
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    return Boolean(
      selection && !selection.isCollapsed && anchor && focus &&
      root.contains(anchor) && root.contains(focus) &&
      !renderer?.contains(anchor) && !renderer?.contains(focus)
    );
  }

  function onShellKeydown(e: KeyboardEvent): void {
    if (closeExitedTabFromKey(e)) {
      return;
    }
    // The renderer's custom handler stops its own copy chord before it gets
    // here. The root claims a copy only when a descendant has no editable
    // field or DOM selection to hand to the browser's native copy path.
    if (isTerminalCopyChord(e, currentOS())) {
      if (descendantOwnsCopy(e)) return;
      e.preventDefault();
      e.stopPropagation();
      void copySelectionToClipboard();
      return;
    }
    // Team-work entry points are `Mod+. p` (Hybrid Nav) and the hamburger,
    // with no direct chord - nothing terminal-local here. The only chord
    // this handler owns is `terminal.find`, resolved from the registry so the
    // form it acts on is the one the escape registry lets out of the widget: Cmd+F
    // on macOS, Ctrl+Shift+F elsewhere, and a bare Ctrl+F is the shell's.
    if (eventMatchesShortcut(e, "terminal.find")) {
      e.preventDefault();
      openFind();
    }
  }

  const menuKeys = menuEscape({
    open: () => menuOpen,
    inside: (target) => target instanceof Element && !!target.closest(".terminal-tab-menu-bubble"),
    // The link menu holds the keyboard while it shows; Escape hands it back.
    close: () => (tabMenu.source === "link" ? links.close(true) : closeTabMenu()),
  });

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

  function toggleDetailsFromMenu(): void {
    setTabInspectorOpen(tab, !tab.inspectorOpen);
    closeTabMenu();
  }

  function flipFromMenu(): void {
    closeTabMenu();
    flipHybrid(paneId);
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

  // ---- The menu on a link the terminal underlines ----
  //
  // Its state and actions live in `terminal/linkMenu.svelte.ts`; this tab
  // gives it the terminal and the menu bubble, and closes it when the link's
  // cells change or move on the screen.

  const LINK_BAND_PX = 8;
  const links = new TerminalLinkMenu({
    blocked: appInputBlocked,
    requestCwd: requestTerminalCwd,
    cwd: () => terminalCwdAbs,
    anchorKey: linkAnchorKey,
    // The anchor is a band around the pointer, which the menu opens below
    // and flips above (see `menuPos`).
    open: ({ x, y }) =>
      openTabMenu(tab.id, { left: x, right: x, top: y - LINK_BAND_PX, bottom: y + LINK_BAND_PX }, "link"),
    close: () => {
      if (tabMenu.openForTabId === tab.id && tabMenu.source === "link") closeTabMenu();
    },
    focusTerminal,
    focusTerminalAfterWait,
  });
  const linkMenuOpen = $derived(menuOpen && tabMenu.source === "link" && links.menu !== null);
  /// The longest target the menu shows whole; a longer one keeps both ends.
  const LINK_TARGET_SHOWN = 72;

  /// The rows a link sits on and where the viewport shows them; a change in
  /// either means the menu no longer points at what is on the screen.
  function linkAnchorKey(range: LinkRange): string | null {
    const t = term;
    if (!t) return null;
    const top = t.getScrollbackLength() - Math.floor(t.getViewportY());
    const rows: string[] = [String(range.start.y - top)];
    for (let y = range.start.y; y <= range.end.y; y++) {
      rows.push(t.buffer.active.getLine(y)?.translateToString(true) ?? "");
    }
    return rows.join("\n");
  }

  function onGhosttyLink({ target, range, event }: TerminalLinkActivation): void {
    void links.onLink(target, range, event);
  }

  /// The link menu takes the keyboard as it shows, onto its first live
  /// entry, unless something above the panes holds it. It waits a frame for
  /// the portal, whose move would drop the focus.
  function takeLinkMenuFocus(node: HTMLElement): void {
    requestAnimationFrame(() => {
      const first = node.querySelector<HTMLButtonElement>("button.mbtn:not(:disabled)");
      if (node.isConnected && first && mayFocus(first)) first.focus({ preventScroll: true });
    });
  }

  // The bubble can close without the link menu asking: a press outside it,
  // another menu opening in its place. The link menu's state goes with it.
  $effect(() => {
    if (!(menuOpen && tabMenu.source === "link")) untrack(() => links.dismiss());
  });

  // Closes the link menu when its link's cells change or move on the screen
  // (output, a scroll, a resize) or a cover rises over the window, read ten
  // times a second while it shows; the keyboard goes back to the terminal
  // only if the menu held it.
  $effect(() => {
    if (!linkMenuOpen) return;
    const watch = setInterval(() => {
      if (!untrack(() => links.menu)) return;
      const covered = appInputBlocked();
      if (covered || links.stale()) {
        const held = document.activeElement?.closest(".terminal-tab-menu-bubble") != null;
        links.close(held && !covered);
      }
    }, 100);
    return () => clearInterval(watch);
  });
</script>

<svelte:window
  onkeydowncapture={menuKeys.capture}
  onkeydown={menuKeys.bubble}
  onpointerdown={onDocPointerDown}
/>

<!-- A toggle command's row: the command's title and chord, with a check
     while the command reports itself on for this terminal. -->
{#snippet toggleRow(id: string, onclick: () => void)}
  {@const on = commandState(id, menuContext) === true}
  <button class="mbtn" role="menuitemcheckbox" aria-checked={on} {onclick}>
    <span class="mbtn-icon">
      {#if on}<Check size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
    </span>
    <span class="mbtn-label">{commandTitle(id)}</span>
    <span class="mbtn-chord">{chordLabel(id)}</span>
  </button>
{/snippet}

<div
  class="terminal-tab"
  class:active
  data-theme={terminalSurfaceThemeOverride()}
  style:--terminal-background={customTerminalColors?.background}
  data-terminal-tab-id={tab.id}
  role="tabpanel"
  aria-hidden={!active}
  bind:this={tabEl}
  onkeydown={onShellKeydown}
  onkeydowncapture={reclaimPtySize}
  onpointerdowncapture={reclaimPtySize}
  onpastecapture={onTerminalPasteCapture}
  onbeforeinputcapture={onTerminalBeforeInputCapture}
  onfocusin={noteKeyboardSurface}
  oncontextmenu={onTerminalContextMenu}
>
  {#if menuOpen}
    <div
      class="terminal-tab-menu-bubble"
      role={tabMenu.source === "tab" ? "dialog" : "menu"}
      tabindex="-1"
      aria-label={tabMenu.source === "link" ? "terminal link menu" : tabMenu.source === "body" ? "terminal menu" : "terminal tab settings"}
      use:portal
      use:clampMenu={menuPos}
      onmousedown={(e) => e.stopPropagation()}
    >
      {#if tabMenu.source === "link" && links.menu}
        <!-- Link menu: the link's real target, a web link's host on a line
             of its own (a target is untrusted, and its text can lead the eye
             to another host), then its two entries. A long target keeps both
             ends. A refused entry stays in place, disabled, with its reason. -->
        {@const linkMenu = links.menu}
        {@const link = linkMenu.link}
        {@const target = link.kind === "web" ? link.url : link.path}
        {@const clickChord = currentOS() === "mac" ? "\u2318 Click" : "Ctrl+Click"}
        <div class="action-list" use:takeLinkMenuFocus>
          {#if link.kind === "web" && link.host}
            <div class="terminal-link-target">
              <span>Host</span>
              <span class="terminal-link-value" data-terminal-link-host={link.host}>{link.host}</span>
            </div>
          {/if}
          <div class="terminal-link-target">
            <span>{link.kind === "web" ? "Link" : "Path"}</span>
            <span
              class="terminal-link-value"
              data-terminal-link-target={target}
              title={target}
            >{middleEllipsis(target, LINK_TARGET_SHOWN)}</span>
          </div>
          {#if link.kind === "web"}
            <button
              class="mbtn"
              role="menuitem"
              data-terminal-link-action="open-browser"
              disabled={link.refusal !== null}
              onclick={() => links.openInBrowser()}
            >
              <span class="mbtn-icon"><ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" /></span>
              <span class="mbtn-label">Open in browser</span>
              <span class="mbtn-chord">{clickChord}</span>
            </button>
            {#if link.refusal}
              <div class="terminal-link-reason" data-terminal-link-reason>{link.refusal}</div>
            {/if}
            <button class="mbtn" role="menuitem" data-terminal-link-action="copy-link" onclick={() => links.copyTarget()}>
              <span class="mbtn-icon"><LinkIcon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
              <span class="mbtn-label">Copy link</span>
              <span class="mbtn-chord"></span>
            </button>
          {:else}
            <button
              class="mbtn"
              role="menuitem"
              data-terminal-link-action="open-editor"
              disabled={linkMenu.editorRefusal !== null || linkMenu.editorBusy}
              onclick={() => links.openInEditor()}
            >
              <span class="mbtn-icon"><FileText size={16} strokeWidth={1.75} aria-hidden="true" /></span>
              <span class="mbtn-label">Open in editor</span>
              <span class="mbtn-chord">{clickChord}</span>
            </button>
            {#if linkMenu.editorRefusal}
              <div class="terminal-link-reason" data-terminal-link-reason>{linkMenu.editorRefusal}</div>
            {/if}
            <button class="mbtn" role="menuitem" data-terminal-link-action="copy-path" onclick={() => links.copyTarget()}>
              <span class="mbtn-icon"><Clipboard size={16} strokeWidth={1.75} aria-hidden="true" /></span>
              <span class="mbtn-label">Copy path</span>
              <span class="mbtn-chord"></span>
            </button>
          {/if}
        </div>
      {:else if tabMenu.source === "body"}
        <!-- Body-context terminal menu (right-click in the terminal
             body): the masking toggle, Find + Copy
             (selection or scrollback) + Paste + Copy scrollback, the Rich
             Prompt rows, then the window's command launcher. Each action
             row is worded by its catalog command. Name / Group / broadcast
             / MCP / spawn config lives on the tab-name menu. -->
        <div class="action-list">
          {@render toggleRow("app.terminal.secretMasking.toggle", toggleSecretMaskingFromMenu)}
          <div class="msep" role="separator"></div>
          <button class="mbtn" role="menuitem" onclick={openFind}>
            <span class="mbtn-icon">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">{commandTitle("terminal.find")}</span>
            <span class="mbtn-chord">{chordLabel("terminal.find")}</span>
          </button>
          <button class="mbtn" role="menuitem" onclick={copySelectionOrScrollback}>
            <span class="mbtn-icon">
              <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">{commandTitle("terminal.copy")}</span>
            <span class="mbtn-chord">{chordLabel("terminal.copy")}</span>
          </button>
          <button class="mbtn" role="menuitem" onclick={pasteClipboard}>
            <span class="mbtn-icon">
              <ClipboardPaste size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">{commandTitle("terminal.paste")}</span>
            <span class="mbtn-chord">{chordLabel("terminal.paste")}</span>
          </button>
          <button class="mbtn" role="menuitem" onclick={copyScrollback}>
            <span class="mbtn-icon">
              <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">{commandTitle("app.terminal.copyScrollback")}</span>
            <span class="mbtn-chord">{chordLabel("app.terminal.copyScrollback")}</span>
          </button>
          <!-- Rich Prompt drafts into the tenant's drafts store, so it
               needs one: this row calls the toggle directly, past the
               command gates, and a tenant without the store serves no
               drafts route. -->
          {#if windowCaps.drafts}
            {@render toggleRow("terminal.richPrompt", toggleRichPromptFromMenu)}
            {#if isRichPromptVisible(tab.id)}
              {@render toggleRow("terminal.richPromptToolbar", toggleRichPromptToolbarFromMenu)}
            {/if}
          {/if}
          <!-- The window's commands, after this terminal's own, as the
               browser puts its page-wide rows last. -->
          <div class="msep" role="separator"></div>
          <button class="mbtn" role="menuitem" onclick={openCommandsFromMenu}>
            <span class="mbtn-icon">
              <CommandIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">{launcherLabel}</span>
            <span class="mbtn-chord">{chordLabel("app.launcher.toggle")}</span>
          </button>
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
          <button type="button" onclick={() => void restart()}>{commandTitle("app.terminal.restart")}</button>
          <button type="button" onclick={() => dismissTerminalEnvironmentPrompt(tab)}>Later</button>
        </div>
      {/if}
      <!-- Terminal tab menu. Header rows stay above the broadcast
           controls; command-discovery actions live in the launcher. Each
           action row is worded by its catalog command, and the menu ends as
           every tab menu does, with the pane's flip and the tab's close.
           The bubble is a dialog, since it holds fields and the broadcast
           list's checkboxes, and a menu item is one only inside a menu. So
           each run of action rows sits in a menu of its own, which holds
           nothing but items and separators, and the fields and checkboxes
           stay the dialog's. -->
      <div class="action-list">
        <!-- Per-tab broadcast list, at the top of the menu right after the
             Group row, under the name of the launcher's choice that lists
             the same terminals. The group toggle turns every row on or
             off; there is no umbrella on/off for this tab alone, whose own
             row leads the list with a "self" marker. -->
        <div class="broadcast-section-label">
          <span class="mbtn-icon">
            <Radio size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span>{commandTitle("app.terminal.broadcastTargets")}</span>
        </div>
        <div class="menu-rows" role="menu" aria-label={commandTitle("app.terminal.broadcastTargets")}>
          {@render toggleRow("app.terminal.broadcastToggle", toggleAllBroadcastTargets)}
        </div>
        {#each localBroadcastTargets as target (target.id)}
          <label class="target-row">
            <span class="target-check">
              <input
                type="checkbox"
                checked={target.on}
                onchange={(e) => void target.set((e.currentTarget as HTMLInputElement).checked)}
              />
              {#if target.on}
                <Check size={13} strokeWidth={2} aria-hidden="true" />
              {/if}
            </span>
            <span class="target-name">
              {target.name}
              {#if target.self}
                <span class="target-self">(self)</span>
              {/if}
            </span>
          </label>
        {/each}
        {#if otherWindowBroadcastTargets.length > 0}
          <!-- Same-group terminals in OTHER windows. Toggling one routes
               through the server to its owning window, which flips its tab
               (re-syncs the flag + lights its sign). Group-wide selection
               spans windows; the checkbox reflects the member's own toggle
               from the roster, updated reactively after the round-trip. -->
          <div class="broadcast-other-windows-label">other windows</div>
          {#each otherWindowBroadcastTargets as target (target.id)}
            <label class="target-row">
              <span class="target-check">
                <input
                  type="checkbox"
                  checked={target.on}
                  onchange={(e) => void target.set((e.currentTarget as HTMLInputElement).checked)}
                />
                {#if target.on}
                  <Check size={13} strokeWidth={2} aria-hidden="true" />
                {/if}
              </span>
              <span class="target-name">
                {target.name}
              </span>
            </label>
          {/each}
        {/if}
        <div class="msep" role="separator"></div>
        <div class="menu-rows" role="menu" aria-label="terminal tab actions">
          {@render toggleRow("app.terminal.details", toggleDetailsFromMenu)}
          <div class="msep" role="separator"></div>
          {#if panesHaveSides()}
            <button class="mbtn" role="menuitem" onclick={flipFromMenu}>
              <span class="mbtn-icon">
                <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span class="mbtn-label">{commandTitle("app.pane.flip")}</span>
              <span class="mbtn-chord">{chordLabel("app.pane.flip")}</span>
            </button>
          {/if}
          <button class="mbtn" role="menuitem" onclick={closeFromMenu}>
            <span class="mbtn-icon">
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">{commandTitle("app.tab.close")}</span>
            <span class="mbtn-chord">{chordLabel("app.tab.close")}</span>
          </button>
        </div>
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
          findNewest();
        }}
        onkeydown={onFindKeydown}
      />
      <span class="find-count" aria-hidden="true">{findCountText}</span>
      <span class="find-announce" role="status" aria-label="find matches">{findAnnounced}</span>
    </div>
  {/if}
  {#if active && tab.cliReloadNotice}
    <!-- This notice depends on same-origin sessionStorage; an origin change loses its marker. -->
    <div class="cli-reload-notice" role="alert">
      <span>After reload, this tab opened a plain shell. Its requested command was not restored here and may still be running in another session.</span>
      <button type="button" aria-label="Dismiss notice" onclick={dismissReloadNotice}>Dismiss notice</button>
    </div>
  {/if}
  <!-- data-file-drop-zone exempts the terminal from the global drop
       guard's not-allowed cursor; onTerminalFileDrop owns the drop
       (path-print on desktop, silent no-op in a plain browser). The
       div is the terminal widget's mount, not an interactive control:
       the widget handles the keyboard there itself. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="terminal-main" class:inspector-open={tab.inspectorOpen}>
    <div
      class="terminal-host"
      data-file-drop-zone
      ondrop={onTerminalFileDrop}
      hidden={loadFailure !== null}
      bind:this={host}
    ></div>
    {#if loadFailure}
      <!-- In the terminal's place in the row: beside an open inspector the
           card centres in the terminal's column. -->
      <div class="terminal-load-failure" bind:this={loadFailureArea}>
        <FailureCard
          bind:this={loadFailureCard}
          title="The terminal view could not load."
          error={loadFailure.error}
          hint={loadFailureHint(loadFailure.final)}
          onRetry={loadFailure.final ? undefined : retryLoad}
          retryLabel="Retry"
          reloadLabel={commandTitle("app.window.reload")}
          onReload={() => void reloadWindow()}
          closeLabel={tabLabel(tab)}
          onClose={() => void closeTab(paneId, tab.id)}
        />
      </div>
    {/if}
    <TerminalConnectionNotice
      notice={terminalConnection.state.notice && status === "connected" && active && !ui.disconnectBlocking}
      {findOpen}
      inspectorOpen={!!tab.inspectorOpen}
      inspectorWidth={tab.inspectorWidth ?? 280}
    />
    <TmuxConsentBanner
      question={tab.tmuxConsent?.question ?? null}
      program={terminalTabName(tab)}
      onAnswer={answerTmux}
    />
    {#if tab.inspectorOpen}
      <Inspector
        title={commandTitle("app.terminal.details")}
        floating
        reserveSpace
        bind:width={() => tab.inspectorWidth ?? 280, (width) => (tab.inspectorWidth = width)}
        onClose={closeInspector}
      >
        {#if currentPreferences()?.terminal.program_status !== false && tab.programStatus?.records.length}
        <div class="program-inspector" aria-label={`Program status for ${terminalTabName(tab)}`}>
          <h3>Program status</h3>
          {#each [...(tab.programStatus?.records ?? [])].sort((a, b) => a.update_order - b.update_order) as record (`${record.source}:${record.id ?? ""}`)}
            <section class="program-record">
              <div><strong>{record.source}</strong> · {record.id === null ? "root" : presentProgramText(record.id, 120)}</div>
              <div>{record.state}{record.kind ? ` · ${record.kind}` : ""}{record.progress === null ? "" : ` · ${record.progress}%`}</div>
              {#if tab.programStatus}
                {@const app = effectiveProgramApp(record, tab.programStatus)}
                {#if app}<div>App: {presentProgramText(app, 120)}</div>{/if}
              {/if}
              {#if record.title}<div>Title: {presentProgramText(record.title, 120)}</div>{/if}
              {#if record.msg}<div>Message: {presentProgramText(record.msg, 120)}</div>{/if}
            </section>
          {/each}
        </div>
        {/if}
        <section class="queue-inspector" aria-label="Queued messages">
          <h3>Queued messages ({queuedMessages?.length ?? tab.queueDepth ?? 0})</h3>
          {#if queuedMessages?.length}
            <ol>
              {#each queuedMessages as message}
                <li>
                  <div class="queue-source">{message.source === "rich_prompt" ? "Rich Prompt" : "Terminal write"}</div>
                  {#if message.awaiting_submit}
                    <p>Text delivered; waiting to submit.</p>
                  {:else}
                    <pre>{message.text}</pre>
                  {/if}
                </li>
              {/each}
            </ol>
          {:else if (tab.queueDepth ?? 0) > 0 && queuedMessages === null}
            <p>Waiting for queued messages...</p>
          {:else}
            <p>No queued messages.</p>
          {/if}
        </section>
      </Inspector>
    {/if}
  </div>
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
    <div class="terminal-composer" bind:this={composerEl}>
      <RichPrompt bind:this={composer} {tab} {focused} shown={active} />
    </div>
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
  /* A transparent window: the tint is painted once, here, at the live
     opacity, and the layers inside it stay clear so the alpha does not
     stack. The terminal paints a transparent default background. */
  :global(:root[data-transparent-window]) .terminal-tab {
    background: color-mix(
      in srgb,
      var(--terminal-background, var(--bg)) var(--terminal-opacity, 100%),
      transparent
    );
  }
  :global(:root[data-transparent-window]) .terminal-host {
    background-color: transparent;
  }
  /* Marks the composer's subtree for the keyboard's return; the composer
     positions against the terminal tab, so the wrapper adds no box. */
  .terminal-composer {
    display: contents;
  }
  .terminal-find {
    position: absolute;
    top: 8px;
    right: 10px;
    display: flex;
    align-items: center;
    /* Above the terminal's canvas, so the box takes its own clicks
       rather than the terminal under it. */
    z-index: 11;
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
  /* The count as shown, on every frame it changes; it takes no room while
     blank. Screen readers hear .find-announce instead. */
  .find-count {
    margin-left: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .find-count:empty {
    margin-left: 0;
  }
  /* The live region: in the tree from the bar's first frame so a screen
     reader hears it fill, and out of sight and of the bar's layout. */
  .find-announce {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .terminal-host {
    flex: 1;
    min-height: 0;
    /* What the cell grid keeps clear on a side that is the window's edge:
       enough that a glyph does not touch the window's frame, and no more,
       so the window's width and height go to columns and rows. */
    --terminal-edge-inset: 2px;
    padding: 8px;
    background: var(--terminal-background, var(--bg));
    overflow: hidden;
    /* The terminal draws its own cursor. ghostty-web makes this element
       contenteditable, and the browser caret it would draw at the start
       of the host sits under the renderer's canvas, showing wherever the
       canvas is see-through, as in a transparent window. */
    caret-color: transparent;
  }
  /* The pane marks its sides on the window's edge. The host reaches the
     pane's top only under no strip, and its right only beside no inspector;
     next to either it keeps the full inset. */
  :global(.pane.edge-top:not(.has-strip)) .terminal-host {
    padding-top: var(--terminal-edge-inset);
  }
  :global(.pane.edge-right) .terminal-main:not(.inspector-open) .terminal-host {
    padding-right: var(--terminal-edge-inset);
  }
  :global(.pane.edge-bottom) .terminal-host {
    padding-bottom: var(--terminal-edge-inset);
  }
  :global(.pane.edge-left) .terminal-host {
    padding-left: var(--terminal-edge-inset);
  }
  .cli-reload-notice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: color-mix(in srgb, var(--warn-text) 12%, var(--bg));
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-size: 0.875rem;
  }
  .cli-reload-notice span { flex: 1; min-width: 0; }
  .cli-reload-notice button {
    flex: none;
    padding: 0.25rem 0.75rem;
    background: var(--btn-bg);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .cli-reload-notice button:hover { border-color: var(--btn-hover); }
  .terminal-main { display: flex; flex: 1; min-width: 0; min-height: 0; position: relative; isolation: isolate; }
  /* The load error takes the hidden host's place in the row, so the
     inspector keeps its column and the card centres in the terminal's. It
     paints nothing around the card, which leaves a transparent window's
     tint to the tab, painted once. */
  .terminal-load-failure {
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .program-inspector, .queue-inspector { padding: 10px; overflow-wrap: anywhere; }
  .program-inspector h3, .queue-inspector h3 { margin: 0 0 10px; font-size: 13px; }
  .queue-inspector ol { margin: 0; padding-left: 24px; }
  .queue-inspector li + li { margin-top: 12px; }
  .queue-inspector pre { margin: 6px 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  .queue-inspector p, .queue-source { margin: 6px 0; color: var(--text-secondary); font-size: 12px; }
  .program-record { padding: 8px 0; border-top: 1px solid var(--separator); }
  .program-record div + div { margin-top: 4px; }
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
    animation: bubble-pop 260ms var(--ease-pop);
    transition: transform 200ms var(--ease-pop);
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
  /* A run of rows inside the tab menu's list, laid out as the list lays
     out its own rows. */
  .menu-rows {
    display: flex;
    flex-direction: column;
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
      transform 260ms var(--ease-pop);
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
  .terminal-link-target {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 4px 8px 6px;
    color: var(--text-secondary);
    font-size: 12px;
    max-width: min(480px, calc(100vw - 40px));
  }
  /* The value wraps rather than ending in an ellipsis: an untrusted
     target's end (the host after a long path, the name after a long
     folder) must show, and the menu shortens it in the middle. */
  .terminal-link-value {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .terminal-link-reason {
    padding: 0 8px 6px 34px;
    color: var(--text-secondary);
    font-size: 12px;
    max-width: min(480px, calc(100vw - 40px));
    overflow-wrap: anywhere;
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
