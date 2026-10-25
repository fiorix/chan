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
