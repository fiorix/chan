// Runs on every navigation, before page code. Never reuse a creation-time
// snapshot: privacy may have changed since this webview was built.
(() => {
  if (window.__CHAN_PRIVACY__) return;
  const api = window.__TAURI__;
  let subscription;
  const bridge = window.__CHAN_PRIVACY__ = {
    state: { enabled: true, mask_terminal_secrets: false, revision: -1 },
    ready: false,
    error: '',
    async set(patch) {
      const state = await api.core.invoke('set_privacy_settings', { patch });
      apply(state);
    },
    async refresh() {
      try {
        // Subscribe before reading. Keep a successful subscription on read
        // failure, but let Retry repair a failed subscription as well.
        subscription ??= api.event.listen('privacy-settings', event => apply(event.payload))
          .catch(error => { subscription = undefined; throw error; });
        await subscription;
        apply(await api.core.invoke('privacy_settings'));
      } catch (_) {
        bridge.error = 'Privacy settings are unavailable. Sensitive fields remain hidden.';
        announce();
      }
    },
  };
  function announce() {
    window.dispatchEvent(new CustomEvent('chan:privacy-change'));
  }
  function apply(state) {
    if (!state || typeof state.enabled !== 'boolean' ||
        typeof state.mask_terminal_secrets !== 'boolean' ||
        !Number.isSafeInteger(state.revision) || state.revision < bridge.state.revision) return;
    bridge.state = state;
    bridge.ready = true;
    bridge.error = '';
    announce();
  }
  // Revision ordering prevents a delayed read from undoing a newer event.
  void bridge.refresh();
})();
