<script lang="ts">
  import { tick } from "svelte";
  import {
    Check,
    Clipboard,
    ClipboardPaste,
    FilePlus,
    Folder,
    History,
    Info,
    MessageSquare,
    Network,
    Pencil,
    Radio,
    RotateCcw,
    Search,
    Settings2,
    Terminal as TerminalIcon,
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
  import { chordFor, shouldEscapeTerminal } from "../state/shortcuts";
  import {
    advanceTerminalSeq,
    allTerminalTabs,
    broadcastTerminalInput,
    canReopenClosedTab,
    closeTab,
    clearTerminalSession,
    flipHybrid,
    dismissTerminalEnvNamePrompt,
    markTerminalEnvNameRestarted,
    registerTerminalCloseSink,
    registerTerminalInputSink,
    renameTerminalTab,
    reopenClosedTab,
    setTerminalBroadcastEnabled,
    setTerminalBroadcastTarget,
    setTerminalActivity,
    setTerminalActivityPulsing,
    setTerminalMcpEnv,
    setTerminalSession,
    tabFocusPulse,
    terminalBroadcastMemberIds,
    terminalEnvTabNameStale,
    terminalMcpEnvEnabled,
    terminalTabName,
    type TerminalTab as TerminalTabState,
  } from "../state/tabs.svelte";
  import {
    workspace,
    effectiveHybridSurfaceTheme,
    fileOps,
    openFsGraphForDirectory,
    scheduleSessionSave,
    surfaceThemeOverride,
    ui,
  } from "../state/store.svelte";
  import { terminalWsPath } from "../terminal/session";
  import {
    createTerminalKeyboardProtocolState,
    handleTerminalMetaKey,
    installKeyboardProtocolHandlers,
    resetTerminalKeyboardProtocolState,
  } from "../terminal/keymap";
  import { injectShowMcpEnvCommand } from "../terminal/mcpEnv";
  import { installTerminalReportGuards } from "../terminal/xtermReports";
  import { AGENT_SUBMIT_CHORD } from "../terminal/submitMode";
  import {
    clampScrollbackMb,
    scrollbackLinesFromMb,
    SCROLLBACK_MB_DEFAULT,
  } from "../terminal/scrollback";
  import { uiConfirm } from "../state/confirm.svelte";
  import { clampMenu } from "./menuClamp";
  import { portal } from "./portal";
  import {
    closeTabMenu,
    openTabMenu,
    tabMenu,
  } from "../state/tabMenu.svelte";
  import BubbleOverlay from "./BubbleOverlay.svelte";
  import McpEnvInfoModal from "./McpEnvInfoModal.svelte";
  import { markPaneModalOpen } from "../state/paneModalGuard.svelte";
  import TeamWork from "./TeamWork.svelte";

  let {
    tab,
    paneId,
    active,
    focused,
  }: {
    tab: TerminalTabState;
    paneId: string;
    active: boolean;
    focused: boolean;
  } = $props();

  type ServerFrame =
    | { type: "ready"; cols: number; rows: number; cwd?: string | null; cwd_rel?: string | null }
    | {
        type: "session";
        id: string;
        seq: number;
        missed_bytes?: number;
        bytes_since_focus?: number;
      }
    | { type: "activity"; bytes_since_focus: number }
    | { type: "cwd"; cwd?: string | null; cwd_rel?: string | null }
    | { type: "resize"; cols: number; rows: number }
    | { type: "resize_other"; cols: number; rows: number }
    | { type: "closed"; reason: CloseReason }
    | { type: "exit"; code: number }
    | { type: "error"; message?: string; reason?: string };

  type CloseReason = "idle" | "workspace" | "shutdown" | "explicit" | "capped" | "error";

  let host: HTMLDivElement | undefined = $state();
  let searchInput: HTMLInputElement | undefined = $state();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;
  let serialize: SerializeAddon | null = null;
  // Scrollback line cap captured at construction time from the
  // persisted MB budget so xterm.js gets a stable number. Held on
  // the component so the "copy scrollback" actions serialize the same
  // window that's actually in memory.
  let scrollbackLines = scrollbackLinesFromMb(SCROLLBACK_MB_DEFAULT);
  let ws: WebSocket | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let status = $state<"closed" | "connecting" | "connected" | "exited">("closed");
  let statusDetail = $state("");
  let missedBytes = $state(0);
  let sessionClosedReason = $state<CloseReason | null>(null);
  let findOpen = $state(false);
  let findQuery = $state("");
  let mcpInfoOpen = $state(false);
  // While the MCP-env info dialog is up it renders OVER this terminal
  // pane and owns the keyboard. Register with the shared pane-modal
  // guard so App.svelte's paneChordBlocked() bails on Cmd+, instead of
  // flipping the pane hidden behind the dialog.
  $effect(() => {
    if (!mcpInfoOpen) return;
    return markPaneModalOpen();
  });
  let sawSessionControl = false;
  let pendingPromptSeed = "";
  let promptSeedSent = false;
  let terminalCwdAbs: string | null = $state(null);
  let terminalCwdVirtual: string | null = $state(null);
  let webglRendererActive = false;
  let webglContextLossRetries = 0;
  let ptyOutputWriteDepth = 0;
  let hostResumeTimers: ReturnType<typeof setTimeout>[] = [];
  const keyboardProtocol = createTerminalKeyboardProtocolState();
  let hostResumeListenerCleanup: (() => void) | null = null;
  // Wall-clock-gap sleep/wake detector. See
  // installHostResumeListeners for why focus/pageshow/visibilitychange
  // miss a macOS display/system sleep in WKWebView.
  let wakeProbeTimer: ReturnType<typeof setInterval> | null = null;
  let lastWakeProbe = 0;
  // Probe every 2s; a gap past 6s (several missed ticks) means JS
  // timers froze (the machine slept) and the probe is firing late on
  // wake.
  const WAKE_PROBE_MS = 2000;
  const WAKE_GAP_MS = 6000;
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
  const broadcastTargets = $derived(
    allTerminalTabs().sort((a, b) => {
      if (a.id === tab.id) return -1;
      if (b.id === tab.id) return 1;
      return 0;
    }),
  );
  const selectedBroadcastTargets = $derived(new Set(terminalBroadcastMemberIds(tab)));
  // "Select All" walks every row INCLUDING self so the bulk action
  // stays consistent with the per-row UI.
  const allBroadcastTargetsSelected = $derived(
    broadcastTargets.length > 0 &&
      broadcastTargets.every((target) =>
        target.id === tab.id ? tab.broadcastEnabled : selectedBroadcastTargets.has(target.id),
      ),
  );
  const mcpEnvOn = $derived(terminalMcpEnvEnabled(tab));
  const showMcpEnvDisabled = $derived(tab.sessionMcpEnv === false);
  const staleEnvName = $derived(terminalEnvTabNameStale(tab));
  const showStaleEnvPrompt = $derived(
    staleEnvName && !tab.terminalEnvNamePromptDismissed,
  );
  $effect(() => {
    if (!host || term) return;
    void tick().then(start);
    return teardown;
  });

  $effect(() => {
    const unregisterInput = registerTerminalInputSink(tab.id, (data) => sendInput(data));
    const unregisterClose = registerTerminalCloseSink(tab.id, closeTerminalForTab);
    return () => {
      unregisterInput();
      unregisterClose();
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
      // When the Team Work prompt is open it owns the keyboard. Cmd+K
      // p on a pane without a terminal spawns one and opens the
      // prompt in the same Svelte tick; without this gate, xterm's
      // mount-time focus races past the prompt's focus effect and
      // steals the caret. Bump `focusNonce` so the prompt's
      // open-effect re-runs and lands the caret on the editor. This
      // covers both the Cmd+K p race AND the user returning to a pane
      // whose prompt was already open (no focusNonce bump would
      // otherwise fire there).
      if (tab.teamWork?.open) {
        if (tab.teamWork) {
          tab.teamWork.focusNonce = (tab.teamWork.focusNonce ?? 0) + 1;
        }
        return;
      }
      term?.focus();
    });
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
    applyTerminalTheme();
  });

  function effectiveTerminalTheme(): "dark" | "light" {
    return effectiveHybridSurfaceTheme("terminal");
  }

  function terminalTheme() {
    // Read CSS variables from `host` so the terminal surface's
    // `data-theme` override resolves before xterm paints.
    const styles = getComputedStyle(host ?? document.documentElement);
    const bg = styles.getPropertyValue("--bg").trim() || "#1c1c1e";
    const text = styles.getPropertyValue("--text").trim() || "#ebebf0";
    const cursor = styles.getPropertyValue("--link").trim() || "#58a6ff";
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

  function applyTerminalTheme(): void {
    if (!term) return;
    term.options.theme = terminalTheme();
  }

  function refreshTerminalRows(): void {
    if (!term) return;
    const maybeRefresh = (term as Terminal & {
      refresh?: (start: number, end: number) => void;
    }).refresh;
    maybeRefresh?.call(term, 0, Math.max(0, term.rows - 1));
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
    // queueFit -> recovery). Detect the wake directly: a coarse
    // interval whose callback fires far
    // later than scheduled means the wall clock jumped while JS timers
    // were frozen (the machine slept), so run the same recovery the
    // resize path proves works. One interval per terminal so EVERY pane
    // recovers at once, matching "resize any window clears ALL
    // terminals". (Pure display-only sleep that does not freeze timers
    // is not caught here; verify in chan-desktop - WebKit-only.)
    lastWakeProbe = Date.now();
    wakeProbeTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastWakeProbe;
      lastWakeProbe = now;
      if (gap > WAKE_GAP_MS) recoverTerminalRendererAfterHostResume();
    }, WAKE_PROBE_MS);
    hostResumeListenerCleanup = () => {
      window.removeEventListener("focus", onHostResume);
      window.removeEventListener("pageshow", onHostResume);
      document.removeEventListener("visibilitychange", onVisibility);
      if (wakeProbeTimer) {
        clearInterval(wakeProbeTimer);
        wakeProbeTimer = null;
      }
      hostResumeListenerCleanup = null;
    };
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

  function enableWebglRenderer(): void {
    if (!term) return;
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
      term.loadAddon(webgl);
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

  function start(): void {
    if (!host || term) return;
    // Scrollback honors the Settings MB budget. Read once here so a
    // settings change after spawn doesn't reach through and resize
    // the existing xterm.js buffer; the hint copy under the slider
    // names this spawn-time-only contract.
    scrollbackLines = scrollbackLinesFromMb(
      clampScrollbackMb(workspace.info?.preferences?.terminal?.scrollback_mb),
    );
    // lineHeight is 1.2 (not xterm.js's 1.0 default) so multi-row
    // ASCII glyphs (e.g. the Claude Code splash cube, figlet output,
    // nethack tiles) render with the row separation a user gets from
    // iTerm; the 1.0 default packs ascender glyphs against the next
    // row's descenders. Cursor is a non-blinking block, matching
    // iTerm's defaults.
    //
    // Font chain: by default it leads with the OS's installed mono
    // face (SF Mono / Cascadia / DejaVu) so the lean default build
    // (no `--features embed-font`) doesn't 404 on a missing woff2.
    // Source Code Pro stays in the chain but only leads when the user
    // opts in via Settings: that download flow writes the woff2 to
    // `<user-config>/chan/fonts/` and the SPA reorders the chain to
    // lead with SCP. The browser still falls back gracefully if the
    // face hasn't loaded yet (or the user-config-dir copy is missing
    // on a non-embed-font build). Spawn-time-only, like the
    // scrollback contract: existing terminals keep their current font
    // until session restart.
    const FONT_CHAIN_OS_DEFAULT =
      '"SF Mono", SFMono-Regular, "Cascadia Code", "DejaVu Sans Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", "Source Code Pro", monospace';
    const FONT_CHAIN_SOURCE_CODE_PRO =
      '"Source Code Pro", "SF Mono", SFMono-Regular, "Cascadia Code", "DejaVu Sans Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';
    const fontPref = workspace.info?.preferences?.terminal?.font ?? "os-default";
    const fontFamily =
      fontPref === "source-code-pro"
        ? FONT_CHAIN_SOURCE_CODE_PRO
        : FONT_CHAIN_OS_DEFAULT;
    term = new Terminal({
      allowTransparency: false,
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily,
      fontSize: 14,
      lineHeight: 1.2,
      macOptionIsMeta: true,
      scrollback: scrollbackLines,
      tabStopWidth: 8,
      theme: terminalTheme(),
    });
    resetTerminalKeyboardProtocolState(keyboardProtocol);
    installTerminalReportGuards(term);
    installKeyboardProtocolHandlers(term, keyboardProtocol, sendInput);
    fit = new FitAddon();
    search = new SearchAddon({ highlightLimit: 1000 });
    serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
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
    refreshTerminalRenderer();
    installHostResumeListeners();
    term.attachCustomKeyEventHandler(handleTerminalKeyEvent);
    term.onData(handleXtermData);
    term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(host);
    queueFit();
    connect();
    if (focused) queueMicrotask(() => term?.focus());
  }

  function connect(): void {
    if (!term) return;
    closeSocket();
    status = "connecting";
    statusDetail = "";
    missedBytes = 0;
    sessionClosedReason = null;
    sawSessionControl = false;
    const reattaching = Boolean(tab.terminalSessionId);
    pendingPromptSeed = reattaching ? "" : (tab.seedInput ?? "");
    promptSeedSent = false;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = withTokenQuery(
      terminalWsPath({
        cols: term.cols,
        rows: term.rows,
        tabName: terminalTabName(tab),
        windowId: sessionWindowId(),
        sessionId: tab.terminalSessionId,
        lastSeq: tab.lastSeq,
        mcpEnv: mcpEnvOn,
        cwd: reattaching ? undefined : tab.cwd,
      }),
    );
    ws = new WebSocket(`${proto}//${window.location.host}${path}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      status = "connected";
      statusDetail = `${term?.cols ?? 0}x${term?.rows ?? 0}`;
      if (term) send({ type: "resize", cols: term.cols, rows: term.rows });
      sendFocusState();
    };
    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        writePtyOutput(bytes);
        recordOutputBytes(bytes.byteLength);
        maybeSeedPrompt();
        return;
      }
      if (event.data instanceof Blob) {
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        writePtyOutput(bytes);
        recordOutputBytes(bytes.byteLength);
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
        statusDetail = `${frame.cols}x${frame.rows}`;
        terminalCwdAbs = frame.cwd ?? null;
        terminalCwdVirtual = frame.cwd_rel ?? null;
        recoverTerminalRendererAfterHostResume();
      } else if (frame.type === "session") {
        sawSessionControl = true;
        setTerminalSession(tab, frame.id, frame.seq, mcpEnvOn);
        setTerminalActivity(tab, !focused && (frame.bytes_since_focus ?? 0) > 0);
        scheduleTerminalSessionSave();
        missedBytes = Math.max(0, Math.floor(frame.missed_bytes ?? 0));
        status = "connected";
        statusDetail = `session ${frame.id.slice(0, 8)}`;
        if (missedBytes > 0) {
          term?.writeln(`\r\nterminal replay missed ${missedBytes} bytes`);
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
      } else if (frame.type === "closed") {
        sessionClosedReason = frame.reason;
        status = "exited";
        statusDetail = `session ended (${frame.reason})`;
        clearTerminalSession(tab);
        scheduleTerminalSessionSave();
        term?.writeln(`\r\nsession ended (${frame.reason})`);
      } else if (frame.type === "exit") {
        status = "exited";
        statusDetail = `exit ${frame.code}`;
        clearTerminalSession(tab);
        scheduleTerminalSessionSave();
        term?.writeln(`\r\nprocess exited (${frame.code}); press Ctrl+D to close this tab`);
      } else if (frame.type === "error") {
        const detail = frame.message ?? frame.reason ?? "unknown error";
        statusDetail = detail;
        term?.writeln(`\r\nterminal error: ${detail}`);
      }
    };
    ws.onclose = () => {
      if (tab.terminalSessionId && !sawSessionControl && status === "connecting") {
        clearTerminalSession(tab);
        scheduleTerminalSessionSave();
      }
      if (status !== "exited") status = "closed";
    };
    ws.onerror = () => {
      statusDetail = "connection failed";
      if (tab.terminalSessionId && !sawSessionControl) {
        clearTerminalSession(tab);
        scheduleTerminalSessionSave();
      }
    };
  }

  function recordOutputBytes(bytes: number): void {
    advanceTerminalSeq(tab, bytes);
    scheduleTerminalSessionSave();
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
      term?.focus();
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

  function send(frame: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  function sendInput(data: string): void {
    send({ type: "input", data });
  }

  function writePtyOutput(bytes: Uint8Array): void {
    if (!term) return;
    ptyOutputWriteDepth += 1;
    try {
      term.write(bytes, () => {
        ptyOutputWriteDepth = Math.max(0, ptyOutputWriteDepth - 1);
      });
    } catch (err) {
      ptyOutputWriteDepth = Math.max(0, ptyOutputWriteDepth - 1);
      throw err;
    }
  }

  function sendUserInput(data: string): void {
    sendInput(data);
    broadcastTerminalInput(tab, data);
  }

  function handleXtermData(data: string): void {
    // xterm emits onData for user input and terminal-generated
    // replies. Replies belong only to the PTY that requested them;
    // they must not enter chan's broadcast fan-out.
    if (ptyOutputWriteDepth > 0) {
      sendInput(data);
      return;
    }
    sendUserInput(data);
  }

  function queueFit(): void {
    requestAnimationFrame(() => {
      try {
        fit?.fit();
        if (term) statusDetail = `${term.cols}x${term.rows}`;
      } catch {
        // xterm throws if fit runs before dimensions settle.
      }
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
    scheduleTrailingFit();
  }

  /// Trailing-edge fit scheduler. Coalesces rapid ResizeObserver
  /// fires (pane-divider drag = dozens per
  /// second) into a single fit 120ms after the last fire. 120ms
  /// matches the perception threshold for "the user has stopped
  /// dragging" + leaves room for one more frame of paint.
  let trailingFitTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleTrailingFit(): void {
    if (trailingFitTimer) clearTimeout(trailingFitTimer);
    trailingFitTimer = setTimeout(() => {
      trailingFitTimer = null;
      try {
        fit?.fit();
        if (term) statusDetail = `${term.cols}x${term.rows}`;
      } catch {
        // Same throw guard as `queueFit`.
      }
    }, 120);
  }

  function closeSocket(): void {
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
    if (trailingFitTimer) {
      // Clear the trailing-edge fit timer so a resize-during-teardown
      // rAF doesn't race against the `term?.dispose()` below + throw
      // at fit-time.
      clearTimeout(trailingFitTimer);
      trailingFitTimer = null;
    }
    clearHostResumeTimers();
    hostResumeListenerCleanup?.();
    if (activityPulseTimer) {
      clearTimeout(activityPulseTimer);
      activityPulseTimer = null;
    }
    closeSocket();
    resizeObserver?.disconnect();
    resizeObserver = null;
    term?.dispose();
    term = null;
    ptyOutputWriteDepth = 0;
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
          window_id: sessionWindowId(),
        });
        markTerminalEnvNameRestarted(tab);
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
      clearTerminalSession(tab);
      scheduleTerminalSessionSave();
    }
  }

  function closeTerminalForTab(): boolean {
    explicitCloseSession();
    return true;
  }

  async function copyScrollback(): Promise<void> {
    closeTabMenu();
    const text = serialize?.serialize({ scrollback: scrollbackLines }) ?? "";
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    term?.focus();
  }

  async function copySelectionOrScrollback(): Promise<void> {
    closeTabMenu();
    const text =
      term?.getSelection() ||
      serialize?.serialize({ scrollback: scrollbackLines }) ||
      "";
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    term?.focus();
  }

  async function pasteClipboard(): Promise<void> {
    closeTabMenu();
    const text = await navigator.clipboard?.readText();
    if (text) sendUserInput(text);
    term?.focus();
  }

  function openFind(): void {
    closeTabMenu();
    findOpen = true;
    void tick().then(() => searchInput?.focus());
  }

  function openNewFile(): void {
    const cwd = terminalCwdRel();
    if (cwd === null) return terminalCwdUnavailable();
    closeTabMenu();
    void fileOps.createFile(cwd);
  }

  /// From-$CWD spawn entries on the terminal right-click menu. Each
  /// routes through the same `chan:command` event the keymap layer
  /// uses, so the menu click + the chord both arrive at `runCommand`
  /// in App.svelte. Toggle commands open the surface in a fresh
  /// pane / tab; the originating terminal's $CWD context isn't passed
  /// through (terminal spawn already inherits the terminal's CWD via
  /// the broker, but the FB / Graph toggles open at the workspace
  /// root, matching the empty-pane spawn-grid behavior).
  function dispatchChanCommand(id: string): void {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: id } }),
    );
  }
  function openNewTerminal(): void {
    closeTabMenu();
    dispatchChanCommand("app.terminal.toggle");
  }
  function openNewFileBrowser(): void {
    closeTabMenu();
    dispatchChanCommand("app.files.toggle");
  }
  function openNewGraph(): void {
    closeTabMenu();
    dispatchChanCommand("app.graph.toggle");
  }

  /// Settings (toggle) flips to the hybrid back-side config view
  /// (HybridTerminalConfig). Mirrors the pane hamburger's Flip entry.
  function flipToSettings(): void {
    closeTabMenu();
    flipHybrid(paneId);
  }

  /// Close, an explicit menu entry. `force: true` matches the chord
  /// path (`closeExitedTabFromKey`); the dirty-prompt path lives on
  /// the file editor, not here.
  function closeFromMenu(): void {
    closeTabMenu();
    void closeTab(paneId, tab.id);
  }

  function doReopenClosedTab(): void {
    closeTabMenu();
    reopenClosedTab();
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
    term?.focus();
  }

  async function copyTerminalCwd(): Promise<void> {
    const cwd = terminalCwdRel();
    if (cwd === null) return terminalCwdUnavailable();
    closeTabMenu();
    await navigator.clipboard?.writeText(cwd);
    term?.focus();
  }

  function ensureTeamWork(): NonNullable<TerminalTabState["teamWork"]> {
    if (!tab.teamWork) {
      tab.teamWork = {
        buffer: "",
        heightPx: Math.max(220, Math.round((host?.clientHeight ?? 640) / 2)),
        open: false,
        mode: "wysiwyg",
      };
    }
    if (!tab.teamWork.heightPx) {
      tab.teamWork.heightPx = Math.max(220, Math.round((host?.clientHeight ?? 640) / 2));
    }
    if (!tab.teamWork.mode) tab.teamWork.mode = "wysiwyg";
    return tab.teamWork;
  }

  function openTeamWork(): void {
    closeTabMenu();
    ensureTeamWork().open = true;
    scheduleTerminalSessionSave();
  }

  function closeTeamWork(): void {
    ensureTeamWork().open = false;
    scheduleTerminalSessionSave();
    term?.focus();
  }

  function toggleTeamWorkFromMenu(): void {
    closeTabMenu();
    if (tab.teamWork?.open) closeTeamWork();
    else openTeamWork();
  }

  function teamWorkUsesAgentSubmit(): boolean {
    const rp = tab.teamWork;
    if (!rp) return false;
    if (rp.agentTarget && rp.agentTarget !== "none") return true;
    return rp.submitMode === "agent";
  }

  function submitTeamWork(source: string): void {
    // When the prompt is in Agent submit-mode, strip any trailing
    // newline the editor left on the buffer and append the
    // agent-submit chord. Claude Code reads `\x1b[27;9;13~` (xterm
    // modifyOtherKeys Cmd+Enter) as submit; a stray `\n` before the
    // chord would land as a newline in the agent's multi-line draft.
    // Shell mode appends a missing trailing newline so the command
    // actually executes.
    if (teamWorkUsesAgentSubmit()) {
      const stripped = source.replace(/\n+$/, "");
      sendUserInput(stripped + AGENT_SUBMIT_CHORD);
    } else {
      sendUserInput(source.endsWith("\n") ? source : `${source}\n`);
    }
    scheduleTerminalSessionSave();
    // Every submit to the lead terminal resets the draft back to
    // empty unconditionally.
    if (tab.teamWork) {
      tab.teamWork.buffer = "";
      // Caret stays in the prompt after Cmd+Enter so consecutive
      // prompts are fluid; refocusing the terminal here would force
      // the user to click back into the prompt for every entry.
      tab.teamWork.focusNonce = (tab.teamWork.focusNonce ?? 0) + 1;
    }
  }

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
      term?.focus();
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
    // Chord-escape registry. When the incoming event matches a
    // shortcut flagged `escapeTerminal: true` in shortcuts.ts, return
    // false so
    // xterm doesn't consume the keystroke (the contract
    // `attachCustomKeyEventHandler` reads: false = let the
    // browser dispatch it). App.svelte's window-level keymap
    // then handles the chord. Without this gate Cmd+P,
    // Cmd+Shift+M, Cmd+R, etc. fired from a focused terminal
    // would be swallowed by xterm + written to the PTY as
    // escape sequences.
    if (shouldEscapeTerminal(e)) return false;
    return handleTerminalMetaKey(e, sendUserInput, keyboardProtocol);
  }

  function onShellKeydown(e: KeyboardEvent): void {
    if (closeExitedTabFromKey(e)) {
      return;
    }
    // Team-work entry points are Cmd+P (native), Cmd+Alt+P (web
    // Mac), and `Mod+. p` (Hybrid Nav).
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
    const select = !allBroadcastTargetsSelected;
    for (const target of broadcastTargets) {
      if (target.id === tab.id) {
        setTerminalBroadcastEnabled(tab, select);
      } else {
        setTerminalBroadcastTarget(tab, target.id, select);
      }
    }
  }

  function toggleMcpEnv(): void {
    setTerminalMcpEnv(tab, !mcpEnvOn);
    scheduleTerminalSessionSave();
  }

  function showMcpEnv(): void {
    if (showMcpEnvDisabled) return;
    injectShowMcpEnvCommand(sendUserInput);
    term?.focus();
  }

  /// Open / close the MCP env info modal. Closing the menu when the
  /// modal opens keeps the chrome from stacking: the modal sits at
  /// z=26000 above the menu bubble, but the bubble would visually
  /// compete for attention, so collapsing it on open keeps the dialog
  /// the only focus.
  function openMcpInfoModal(): void {
    closeTabMenu();
    mcpInfoOpen = true;
  }
  function closeMcpInfoModal(): void {
    mcpInfoOpen = false;
  }

  function onTerminalContextMenu(e: MouseEvent): void {
    e.preventDefault();
    requestTerminalCwd();
    openTabMenu(tab.id, {
      left: e.clientX,
      top: e.clientY,
      right: e.clientX,
      bottom: e.clientY,
    });
  }
</script>

<svelte:window onkeydown={onMenuKeydown} onpointerdown={onDocPointerDown} />

<div
  class="terminal-tab"
  class:active
  data-theme={surfaceThemeOverride("terminal")}
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
      <label class="rename-row">
        <span class="rename-label">
          <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Name</span>
        </span>
        <input
          class="rename-input"
          value={tab.title}
          spellcheck="false"
          oninput={(e) => renameTerminalTab(tab, (e.currentTarget as HTMLInputElement).value)}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <!-- Status reads "connected: <detail>" (colon, not em dash). -->
      <div class="terminal-status-row">
        <span class:connected={status === "connected"} class="terminal-status">
          {status}{statusDetail ? `: ${statusDetail}` : ""}
        </span>
        {#if missedBytes > 0}
          <span class="session-note">missed {missedBytes} bytes</span>
        {/if}
        {#if staleEnvName}
          <span class="session-note">stale env</span>
        {/if}
      </div>
      {#if showStaleEnvPrompt}
        <div class="env-stale-row">
          <span>Tab name changed. $CHAN_TAB_NAME will stay at {tab.terminalEnvTabName} until restart.</span>
          <button type="button" onclick={() => void restart()}>Restart now</button>
          <button type="button" onclick={() => dismissTerminalEnvNamePrompt(tab)}>Later</button>
        </div>
      {/if}
      <!-- Terminal right-click menu. Header (Name → SEP → status
           colon → MCP-env + Restart) lands ahead of the find/copy
           band; the "From $CWD" section gathers New File / New
           Terminal / New File Browser / New Graph; the broadcast
           section carries the Terminals dropdown; Settings
           (flipHybrid) + Reopen + Close anchor the foot. No `Reload
           Window` / `Open Inspector` entries; Cmd+R and the pane
           hamburger surface them. -->
      <div class="action-list">
        {#if sessionClosedReason}
          <button class="mbtn" onclick={() => void restart()}>
            <span class="mbtn-icon">
              <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Start New Session</span>
            <span class="mbtn-chord"></span>
          </button>
        {/if}
        <!-- Info button opens a modal dialog
             (McpEnvInfoModal.svelte). The "Show MCP env in terminal"
             button is the dialog's primary CTA; the menu row carries
             only the toggle + the info button. -->
        <div class="mcp-env-row">
          <button class="mbtn" class:on={mcpEnvOn} onclick={toggleMcpEnv}>
            <span class="mbtn-icon">
              {#if mcpEnvOn}
                <Check size={15} strokeWidth={2} aria-hidden="true" />
              {/if}
            </span>
            <span class="mbtn-label">Set MCP env vars</span>
          </button>
          <button
            type="button"
            class="info-btn"
            aria-label="About MCP env vars"
            onclick={openMcpInfoModal}
          >
            <Info size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <button class="mbtn destructive" onclick={() => void restart()}>
          <span class="mbtn-icon">
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Restart</span>
          <span class="mbtn-chord"></span>
        </button>
        <div class="msep" role="separator"></div>
        <button class="mbtn" onclick={openFind}>
          <span class="mbtn-icon">
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Find</span>
          <span class="mbtn-chord">{chordFor("app.find.open") ?? ""}</span>
        </button>
        <button class="mbtn" onclick={copySelectionOrScrollback}>
          <span class="mbtn-icon">
            <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Copy</span>
          <span class="mbtn-chord"></span>
        </button>
        <button class="mbtn" onclick={pasteClipboard}>
          <span class="mbtn-icon">
            <ClipboardPaste size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Paste</span>
          <span class="mbtn-chord"></span>
        </button>
        <button class="mbtn" onclick={copyTerminalCwd}>
          <span class="mbtn-icon">
            <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Copy path to $CWD</span>
          <span class="mbtn-chord"></span>
        </button>
        <button class="mbtn" onclick={copyScrollback}>
          <span class="mbtn-icon">
            <Clipboard size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Copy Scrollback</span>
          <span class="mbtn-chord"></span>
        </button>
        <div class="msep" role="separator"></div>
        <!-- "From $CWD" spawn band. New File uses `openNewFile`
             which seeds the dialog with `$CWD/untitled.md`. New
             Terminal / FB / Graph fire the same `chan:command` events
             the chord-routing layer + the empty-pane carousel use, so
             handlers stay singular. -->
        <div class="from-cwd-label">From $CWD</div>
        <button class="mbtn" onclick={openNewFile}>
          <span class="mbtn-icon">
            <FilePlus size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">New File</span>
          <span class="mbtn-chord">{chordFor("app.file.new") ?? ""}</span>
        </button>
        <button class="mbtn" onclick={openNewTerminal}>
          <span class="mbtn-icon">
            <TerminalIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">New Terminal</span>
          <span class="mbtn-chord">{chordFor("app.terminal.toggle") ?? ""}</span>
        </button>
        <button class="mbtn" onclick={openNewFileBrowser}>
          <span class="mbtn-icon">
            <Folder size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">New File Browser</span>
          <span class="mbtn-chord">{chordFor("app.files.toggle") ?? ""}</span>
        </button>
        <button class="mbtn" onclick={openNewGraph}>
          <span class="mbtn-icon">
            <Network size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">New Graph</span>
          <span class="mbtn-chord">{chordFor("app.graph.toggle") ?? ""}</span>
        </button>
        <div class="msep" role="separator"></div>
        <button class="mbtn" onclick={toggleTeamWorkFromMenu}>
          <span class="mbtn-icon">
            <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">
            {tab.teamWork?.open ? "Hide Team Work" : "Show Team Work"}
          </span>
          <span class="mbtn-chord">
            {chordFor("app.terminal.teamWork") ?? ""}
          </span>
        </button>
        <div class="msep" role="separator"></div>
        <!-- Per-tab broadcast selector. There is no umbrella
             "Broadcast Input On/Off" rocker; the per-row checkboxes
             are the only controls. Self appears at the top of the
             list with a "self" marker. -->
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
          <span class="mbtn-chord"></span>
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
        <div class="msep" role="separator"></div>
        <button class="mbtn" onclick={flipToSettings}>
          <span class="mbtn-icon">
            <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Settings</span>
          <span class="mbtn-chord"></span>
        </button>
        <div class="msep" role="separator"></div>
        <button
          class="mbtn"
          disabled={!canReopenClosedTab()}
          onclick={doReopenClosedTab}
        >
          <span class="mbtn-icon">
            <History size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Reopen Closed Tab</span>
          <span class="mbtn-chord">{chordFor("app.tab.reopenClosed") ?? ""}</span>
        </button>
        <button class="mbtn" onclick={closeFromMenu}>
          <span class="mbtn-icon">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Close</span>
          <span class="mbtn-chord">{chordFor("app.tab.close") ?? ""}</span>
        </button>
      </div>
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
  <!-- The bubble overlay is a self-contained static example. It
       reads its own visibility (the bubbleStub rune, flipped by the
       Team Work right-click menu) and the persisted stack/tray layout
       preference, so it carries no props and is mounted
       unconditionally rather than gated on the Team Work prompt being
       open. -->
  <BubbleOverlay />
  {#if tab.teamWork?.open}
    <TeamWork
      prompt={tab.teamWork}
      onSubmit={submitTeamWork}
      terminalSessionId={tab.terminalSessionId}
    />
  {/if}
  <!-- When the Team Work prompt is open we reserve space at the
       bottom of the terminal-host equal to the prompt's current
       height plus the resize-handle gap. The xterm ResizeObserver
       picks the new size up and calls `fit()`, so the bottom-most
       rendered line stays visible above the prompt instead of being
       painted over.

       Prefer the prompt's measured runtime height (written by a
       ResizeObserver in the Team Work editor) over the user-resized
       `heightPx` so the reserved space tracks the collapse
       transition. When collapsed the CSS `height: auto` branch
       shrinks the prompt to header-only (~44 px) but `heightPx` stays
       at the expanded value; reading `measuredHeightPx` collapses the
       reserved space in lockstep with the visible pill. Falls back to
       `heightPx` for the brief mount window before the first observer
       tick fires. -->
  <div
    class="terminal-host"
    bind:this={host}
    style:margin-bottom={tab.teamWork?.open
      ? `${(tab.teamWork.measuredHeightPx ?? tab.teamWork.heightPx ?? 320) + 12}px`
      : null}
  ></div>
</div>

<McpEnvInfoModal
  open={mcpInfoOpen}
  onClose={closeMcpInfoModal}
  onShowInTerminal={showMcpEnv}
  showInTerminalDisabled={showMcpEnvDisabled}
/>

<style>
  .terminal-tab {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
    color: var(--text);
    visibility: hidden;
    pointer-events: none;
  }
  .terminal-tab.active {
    visibility: visible;
    pointer-events: auto;
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
    background: var(--bg);
    overflow: hidden;
  }
  .terminal-host :global(.xterm) {
    height: 100%;
  }
  .terminal-host :global(.xterm-viewport) {
    scrollbar-color: var(--separator) var(--bg);
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
  .mbtn:hover,
  .mbtn.on {
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
  /* Destructive hint for Restart. Color-only; no background change
     so the hover affordance still reads. */
  .mbtn.destructive {
    color: var(--danger-text, #d33);
  }
  /* "From $CWD" section label. Subdued style matching the
     .terminal-status row's secondary text; telegraphs section
     grouping, not actionable. */
  .from-cwd-label {
    padding: 4px 8px 2px;
    color: var(--text-secondary);
    font-size: 11px;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  .mbtn-icon {
    width: 18px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .mcp-env-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .info-btn {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .info-btn:hover {
    background: var(--hover-bg);
    color: var(--text);
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
