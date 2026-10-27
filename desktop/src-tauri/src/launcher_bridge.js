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
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.isComposing || e.key === 'Process') return;
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
