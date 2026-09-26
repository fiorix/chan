
(() => {
  function reload() {
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      tauri.core.invoke('reload_window').catch(() => window.location.reload());
    } else {
      window.location.reload();
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'r' || e.altKey || e.shiftKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    reload();
  }, true);
})();
