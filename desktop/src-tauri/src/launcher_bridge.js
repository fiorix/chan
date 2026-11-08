(() => {
  function invoke(cmd, fallback) {
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      tauri.core.invoke(cmd).catch(fallback);
    } else {
      fallback();
    }
  }
  function reload() {
    invoke('reload_window', () => window.location.reload());
  }
  // Off macOS the menubar the window wears while its launcher shows and this
  // chord both reach the toggle, and a second toggle inside the first one's
  // transition is dropped; on macOS the global menubar's Cmd+P accelerator
  // pre-empts the page, so the chord is gated on !metaKey like the workspace
  // key bridge's off-mac chords.
  function toggleLauncher() {
    invoke('toggle_launcher_panel', () => {});
  }
  // Where the window wears no menubar while its launcher shows (on Windows,
  // a window whose title bar holds its page's tab bar), chan-desktop sets
  // __chanLauncherMenuChords and the bridge carries the chords only that
  // menubar would serve here, naming the menu item each runs: Ctrl+Shift+T
  // New Standalone Terminal, Ctrl+Alt+W Close Window, Ctrl+Q Quit. The key
  // follows the layout's letter, so AltGr typing a character is no chord. A
  // held key does not repeat the item.
  function menuItemFor(e) {
    if (window.__chanLauncherMenuChords !== true) return null;
    if (!e.ctrlKey || e.metaKey || e.repeat) return null;
    const key = (e.key || '').toLowerCase();
    if (key === 't' && e.shiftKey && !e.altKey) return 'app-new-terminal';
    if (key === 'w' && e.altKey && !e.shiftKey) return 'app-close-window';
    if (key === 'q' && !e.shiftKey && !e.altKey) return 'chan-quit';
    return null;
  }
  window.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key === 'Process') return;
    const item = menuItemFor(e);
    if (item) {
      e.preventDefault();
      e.stopImmediatePropagation();
      invoke(item, () => {});
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (!/Mac OS X|Macintosh/.test(navigator.userAgent) && e.getModifierState('AltGraph')) return;
    // Match workspace zoom: symbols follow the layout, while the top-row
    // zero and numpad keys retain their positions, including Num Lock off.
    const zoomKey = /^Numpad/.test(e.code) ? e.code
      : /^Digit[0-9]$/.test(e.code) ? e.code
      : e.key;
    if (['=', '+', '-', '_', '0', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(zoomKey)) {
      const tauri = window.__TAURI__;
      if (!(tauri && tauri.core && typeof tauri.core.invoke === 'function')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const failed = (error) => console.error('[chan] launcher zoom failed:', error);
      if (['=', '+', 'NumpadAdd'].includes(zoomKey)) invoke('zoom_in', failed);
      else if (['-', '_', 'NumpadSubtract'].includes(zoomKey)) invoke('zoom_out', failed);
      else invoke('zoom_reset', failed);
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'r' && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      reload();
    } else if (key === 'p' && e.shiftKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleLauncher();
    }
  }, true);
})();
