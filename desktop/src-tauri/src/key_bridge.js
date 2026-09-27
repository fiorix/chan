
(() => {
  function fire(e, name, detail) {
    e.preventDefault();
    e.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent('chan:command',
      { detail: Object.assign({ name: name }, detail || {}) }));
  }
  // Cmd+R reloads the webview, Cmd+Opt+I opens
  // DevTools. Both bypass the SPA event bus and invoke their
  // Tauri IPC commands directly so a frozen Svelte runtime or a
  // broken chord registry can't lock the dev affordances away.
  // GUARD the bridge BEFORE swallowing the event: when window.__TAURI__ is
  // absent (e.g. a devserver window where the bridge did not survive the
  // connecting -> external navigation), do NOT preventDefault -- let the event
  // bubble to the SPA's own handler (Cmd+R -> location.reload()) so the chord
  // degrades to a working fallback instead of dying: swallowing it with no
  // bridge would leave Cmd+R/devtools/zoom with neither IPC nor a fallback.
  function invokeIpc(e, cmd, args) {
    const tauri = window.__TAURI__;
    if (!(tauri && tauri.core && typeof tauri.core.invoke === 'function')) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    tauri.core.invoke(cmd, args).catch((err) => {
      console.error('[chan] IPC ' + cmd + ' failed:', err);
    });
  }
  // True while the keyboard belongs to a terminal. This script shares the
  // SPA's document, so the focused element answers that with no protocol
  // between the two: both renderer backends mount inside `.terminal-host`,
  // a child of the tab root, and the find bar and the Rich Prompt composer
  // sit in the same subtree, which is exactly the region whose root keydown
  // handler owns terminal find. `activeElement` is tested for null before
  // `closest` is called, rather than reached through an optional chain,
  // because `undefined !== null` reads a document with no focused element
  // as a focused terminal and would release the chords below everywhere.
  // The `active` class is required because every terminal tab stays
  // mounted: a background one keeps its renderer and its DOM and is only
  // hidden, so an ancestor test alone would hand a stale focus the keyboard.
  function terminalHasFocus() {
    const el = document.activeElement;
    if (!el || typeof el.closest !== 'function') return false;
    const root = el.closest('.terminal-tab');
    return root !== null && root.classList.contains('active');
  }
  // The key a chord names under the active layout, spelled as the code the
  // switches below match, so a chord follows the symbol the user typed and
  // not where the key sits (Colemak T has code KeyF, Dvorak / has code
  // BracketLeft). Letters and punctuation come from `key`; a US shifted
  // glyph (`{`, `?`, `+`) names Shift plus its base symbol, as the chord
  // grammar spells `?`. Top-row digits keep their position, so AZERTY's
  // digit row still selects tabs. A letter or supported symbol the layout
  // typed wins before the Option fallback: only when Option left neither,
  // typing a glyph or a dead key instead, does a letter fall back to its
  // position. Null for a keydown that enters text instead: an IME
  // composition, a dead key the Option fallback cannot place, or AltGr off
  // macOS. Windows reports AltGr as Ctrl+Alt, so AltGr+W typing 'å' would
  // otherwise close the window mid-word; macOS is exempt because there
  // Option is Alt and an engine may flag it as AltGraph too. The workspace
  // app's `shortcutKey` is the same contract, and both are run against one
  // table of layout vectors.
  const MAC = /Mac OS X|Macintosh/.test(navigator.userAgent);
  const SYMBOL_CODES = new Map([
    ['[', 'BracketLeft'], [']', 'BracketRight'], ['/', 'Slash'], ['=', 'Equal'], ['-', 'Minus'],
  ]);
  const SHIFTED = new Map([['{', '['], ['}', ']'], ['?', '/'], ['+', '='], ['_', '-']]);
  function chordKey(e) {
    const k = e.key || '';
    if (e.isComposing || k === 'Process') return null;
    if (!MAC && e.getModifierState('AltGraph')) return null;
    if (/^Digit[0-9]$/.test(e.code)) return { code: e.code, shifted: false };
    if (/^[a-z]$/i.test(k)) return { code: 'Key' + k.toUpperCase(), shifted: false };
    if (/^[0-9]$/.test(k)) return { code: 'Digit' + k, shifted: false };
    const base = SHIFTED.get(k) || k;
    if (SYMBOL_CODES.has(base)) return { code: SYMBOL_CODES.get(base), shifted: base !== k };
    if (e.altKey && /^Key[A-Z]$/.test(e.code)) return { code: e.code, shifted: false };
    if (k === 'Dead') return null;
    return { code: '', shifted: false };
  }
  // Chord policy: actions reachable through Hybrid Nav (Cmd+.) stay
  // unbound here so the native layer claims as little as possible.
  // The command-launcher chords (Cmd+K, Cmd+Shift+K, and the Ctrl+Alt
  // variants off-mac) stay page-owned too: the SPA's inline command deck
  // binds them identically on every surface, so no native claim exists.
  // Direct chords exist where Hybrid Nav is no substitute: Cmd+W (close
  // tab; pairs with the SPA's context-aware Ctrl+D), Cmd+Shift+W (close
  // window), Cmd+F/G (find on page), Cmd+1..9 (jump to tab), Cmd+[/Cmd+]
  // (pane nav), Cmd+/ and Cmd+Shift+/ (split right / down), Cmd+Shift+[/]
  // (tab nav), Cmd+Shift+G (find prev), plus New terminal (Cmd+T on
  // macOS, Ctrl+Shift+T off-mac) and Reopen closed tab (Cmd+Shift+T on
  // macOS, Ctrl+Alt+Shift+T off-mac), which route through the
  // context-aware helpers in App.svelte. Off-mac the bridge additionally
  // claims New Window (Ctrl+Shift+N) and Quit (Ctrl+Q) -- the chords a
  // menubar would own; off-mac these windows have none -- gated on !metaKey so macOS,
  // whose menubar still owns them, never double-fires.
  // A focused terminal takes four of these back, because their Ctrl form
  // encodes a byte the shell reads and terminal find belongs to the tab
  // rather than to the page: Find in both modifier forms, and Find Next
  // and Previous/Next Pane under Ctrl alone.
  function onKey(e) {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const key = chordKey(e);
    if (!key) return;
    const code = key.code;
    const shift = e.shiftKey || key.shifted;
    const alt = e.altKey;
    if (alt) {
      // Cmd+Opt+I (macOS) / Ctrl+Alt+I (Linux/Windows) → DevTools.
      // Ctrl+Alt+Shift+T reopens the last closed tab on the Linux /
      // Windows desktop, where Ctrl+Shift+T is the New-terminal chord.
      // Ctrl+Alt+W closes the window on the Linux / Windows desktop,
      // where Ctrl+Shift+W is tab close; macOS keeps Cmd+Shift+W (the
      // shift branch below) so this is gated on !metaKey.
      // Other meta+alt chords are left to the webview defaults.
      if (!shift && code === 'KeyI') {
        invokeIpc(e, 'open_devtools');
      } else if (!e.metaKey && shift && code === 'KeyT') {
        fire(e, 'app.tab.reopenClosed');
      } else if (!e.metaKey && !shift && code === 'KeyW') {
        // On the connecting screen the SPA command bus is dead, so
        // destroy the window directly to cancel the connect, exactly
        // as the other two KeyW routings do.
        if (location.pathname.endsWith('/connecting.html')) {
          invokeIpc(e, 'request_close_window');
        } else {
          fire(e, 'app.window.close');
        }
      }
      return;
    }
    // Zoom chords route regardless of shift so
    // Cmd+= (US) and Cmd+Shift+= (= Cmd++) both fire zoom_in.
    // NumpadAdd / NumpadSubtract similarly, matched by position so
    // they zoom with Num Lock off as well. Cmd+0 / Cmd+Numpad0
    // reset to 100 %.
    switch (/^Numpad/.test(e.code) ? e.code : code) {
      case 'Equal':
      case 'NumpadAdd':
        invokeIpc(e, 'zoom_in');
        return;
      case 'Minus':
      case 'NumpadSubtract':
        invokeIpc(e, 'zoom_out');
        return;
      case 'Digit0':
      case 'Numpad0':
        invokeIpc(e, 'zoom_reset');
        return;
    }
    if (!shift) {
      switch (code) {
        // Quit on Linux/Windows: Ctrl+Q. The native Quit item owned this
        // chord while these windows had menubars; with the bars gone the
        // bridge claims it and routes to the same confirm-then-quit flow
        // the launcher's Quit item runs. Routed over IPC (like reload/
        // zoom) so a frozen SPA can't lock it away, and gated on
        // !metaKey so macOS Cmd+Q stays with the menubar. Claiming Ctrl+Q
        // costs a focused terminal its XON chord exactly as the menu
        // accelerator already did.
        case 'KeyQ': if (!e.metaKey) invokeIpc(e, 'request_app_quit'); return;
        // Reload. macOS binds Cmd+R (metaKey); Linux/Windows moves to
        // Ctrl+Shift+R (shift branch below) so plain Ctrl+R reaches a
        // focused terminal's shell reverse-search. Gating on metaKey
        // here leaves Linux/macOS plain Ctrl+R untouched (no
        // preventDefault -> falls through to xterm), mirroring the
        // Cmd+W idiom below.
        case 'KeyR': if (e.metaKey) invokeIpc(e, 'reload_window'); return;
        // New terminal: Cmd+T on macOS. Off-mac the chord is Ctrl+Shift+T
        // (shift branch below), so gate on metaKey and leave plain Ctrl+T
        // to a focused terminal, mirroring the reload idiom above.
        case 'KeyT': if (e.metaKey) fire(e, 'app.terminal.toggle'); return;
        // Cmd+W closes the tab
        // on macOS. On Linux the platform mod is Ctrl and Ctrl+W is
        // readline delete-word inside a focused terminal, so DON'T
        // claim it - let it reach xterm. Linux closes tabs with
        // Ctrl+Shift+W (the shift branch below) or Ctrl+D
        // (context-aware via the SPA's onCtrlDCapture, which leaves a
        // focused terminal to its EOF). Gating on metaKey (Cmd) leaves
        // Linux Ctrl+W untouched (no preventDefault -> reaches xterm).
        case 'KeyW':
          if (e.metaKey) {
            // On the connecting/retry page there are no tabs and the
            // app.tab.close dispatch is dead: Cmd+W means cancel, so
            // close the window for real (request_close_window
            // destroys, bypassing bury-on-close). The bridge claims
            // KeyW with stopImmediatePropagation BEFORE the page's own
            // listener AND before the File menu accelerator gets a
            // look-in, so the routing must happen here. Gate on the
            // CURRENT document (this init script re-runs after the
            // success navigation, where Cmd+W must stay tab-close).
            if (location.pathname.endsWith('/connecting.html')) {
              invokeIpc(e, 'request_close_window');
              return;
            }
            fire(e, 'app.tab.close');
          }
          return;
        // Find. A focused terminal owns both forms, so the bridge releases
        // them: Cmd+F reaches the tab root's keydown handler and opens the
        // terminal's own find bar, and Ctrl+F reaches the shell as 0x06.
        // Claiming either is what the SPA cannot undo, since app.find.open
        // resolves against the active FILE tab and is dropped outright while
        // a terminal is the active one. With focus anywhere else the chord
        // still opens find for a file editor. Off-mac the terminal's find
        // chord is Ctrl+Shift+F, which the shift branch never claims.
        case 'KeyF':
          if (terminalHasFocus()) return;
          fire(e, 'app.find.open');
          return;
        // Find next. Ctrl+G is 0x07 to a focused shell, so the Ctrl form is
        // released there; Cmd+G keeps its claim, which is find navigation
        // for a file editor and is not a chord the shell reads.
        case 'KeyG':
          if (!e.metaKey && terminalHasFocus()) return;
          fire(e, 'app.find.next');
          return;
        // Cmd+I does NOT open Dashboard; it is reserved for the editor's
        // italic chord (bound in Wysiwyg.svelte's CM6 keymap). Dashboard
        // is reachable via the launcher + the Dashboard hamburger. With
        // no `KeyI` case here, Cmd+I falls through to the focused webview
        // (the editor toggles italic; otherwise inert). Cmd+Opt+I opens
        // DevTools (the alt branch above).

        // Previous pane. Ctrl+[ is ESC to a focused shell, so the Ctrl form
        // is released there; Cmd+[ stays pane navigation on macOS.
        case 'BracketLeft':
          if (!e.metaKey && terminalHasFocus()) return;
          fire(e, 'app.pane.prev');
          return;
        // Next pane. Ctrl+] is the Group Separator (0x1D) to a focused
        // shell; Cmd+] stays pane navigation on macOS.
        case 'BracketRight':
          if (!e.metaKey && terminalHasFocus()) return;
          fire(e, 'app.pane.next');
          return;
        // Cmd+/ split right. Split
        // bottom is Cmd+Shift+/ (shift branch below). Cmd+\ is
        // deliberately NOT used: 1Password's system-wide Cmd+\
        // hotkey is dispatched by macOS before the key reaches this
        // webview, so chan never receives it. Web reaches splits via
        // Hybrid Nav `/` and `?`.
        case 'Slash':        fire(e, 'app.pane.splitRight'); return;
      }
      const m = code.match(/^Digit([1-9])$/);
      if (m) {
        fire(e, 'app.tab.jump', { index: Number(m[1]) - 1 });
        return;
      }
    } else {
      switch (code) {
        // New Window on Linux/Windows: Ctrl+Shift+N -- another chord a
        // menubar would own. The IPC routes by the
        // INVOKING window's label (another window of its connection, a
        // standalone terminal from a control window), which is
        // focus-proof and works on the connecting screen, where the SPA
        // command bus is dead. !metaKey: macOS Cmd+Shift+N stays with
        // the menubar.
        case 'KeyN': if (!e.metaKey) invokeIpc(e, 'open_new_window'); return;
        // Reload on Linux/Windows: Ctrl+Shift+R. Gate on !metaKey so
        // macOS Cmd+Shift+R does NOT reload (macOS reloads on Cmd+R in
        // the !shift branch above); the !metaKey form fires only for the
        // Ctrl+Shift+R that Linux/Windows users press.
        case 'KeyR': if (!e.metaKey) invokeIpc(e, 'reload_window'); return;
        // Cmd+Shift+W (macOS) stays window close (app.window.close).
        // Ctrl+Shift+W (Linux, Windows) is the chord a user reaches for
        // to close a TAB, so it fires app.tab.close; window close moved
        // to Ctrl+Alt+W (the alt branch above). app.tab.close cannot
        // carry escapeTerminal (the flag is per entry and would also
        // escape the entry's web Ctrl+D, breaking shell EOF in a
        // browser), so what stands between Ctrl+Shift+W and a focused
        // shell is this listener's window-capture
        // stopImmediatePropagation. On the connecting screen the SPA
        // command bus is dead, so destroy the window directly to cancel
        // the connect.
        case 'KeyW':
          if (location.pathname.endsWith('/connecting.html')) {
            invokeIpc(e, 'request_close_window');
            return;
          }
          if (e.metaKey) fire(e, 'app.window.close');
          else fire(e, 'app.tab.close');
          return;
        case 'KeyG':         fire(e, 'app.find.prev');     return;
        // Reopen closed tab: Cmd+Shift+T on macOS. Off-mac Ctrl+Shift+T is
        // New terminal (bare Ctrl+T being a terminal chord), so reopen
        // moves to Ctrl+Alt+Shift+T (the alt branch above).
        case 'KeyT':
          if (e.metaKey) fire(e, 'app.tab.reopenClosed');
          // A control terminal is a singleton (no tabs; the SPA blocks
          // app.terminal.toggle there), so off-mac its New-terminal chord
          // spawns a standalone terminal window, the chord a menubar would
          // own. The kind rides the init script
          // (window.__CHAN_WINDOW_KIND__).
          else if (!e.metaKey && window.__CHAN_WINDOW_KIND__ === 'control') invokeIpc(e, 'open_new_window');
          else fire(e, 'app.terminal.toggle');
          return;
        case 'BracketLeft':  fire(e, 'app.tab.prev');      return;
        case 'BracketRight': fire(e, 'app.tab.next');      return;
        // Cmd+Shift+/ (= Cmd+?) splits the active pane
        // bottom, pairing with Cmd+/ split-right above. Cmd+\ is
        // avoided - 1Password's global hotkey shadows it.
        case 'Slash':        fire(e, 'app.pane.splitDown');  return;
      }
    }
  }
  window.addEventListener('keydown', onKey, true);
})();
