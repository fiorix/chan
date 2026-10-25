// The launcher's desktop bridge inside a chan window. The launcher is a
// webview chan-desktop places inside the window itself, outside Tauri, so it
// has no Tauri IPC. This script gives the launcher the two calls its desktop
// module makes, `__TAURI__.core.invoke` and `__TAURI__.event.listen`, over the
// webview's own message channel (`window.ipc`). chan-desktop answers an invoke
// through `__chanLauncherHost.settle` and delivers an event through
// `__chanLauncherHost.emit`; launcher_panel.rs owns both ends and the command
// list.
(() => {
  if (window.__chanLauncherHost) return;
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;
  window.__chanLauncherHost = {
    settle(id, ok, value) {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (ok) call.resolve(value);
      else call.reject(value);
    },
    emit(event, payload) {
      const handlers = listeners.get(event);
      if (!handlers) return;
      for (const handler of Array.from(handlers.values())) {
        try {
          handler({ event, payload });
        } catch (err) {
          console.error('[chan] launcher event ' + event + ' handler failed:', err);
        }
      }
    },
  };
  function invoke(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try {
        window.ipc.postMessage(JSON.stringify({ id, cmd, args: args === undefined ? null : args }));
      } catch (err) {
        pending.delete(id);
        reject(String(err));
      }
    });
  }
  function listen(event, handler) {
    let handlers = listeners.get(event);
    if (!handlers) {
      handlers = new Map();
      listeners.set(event, handlers);
    }
    const id = ++seq;
    handlers.set(id, handler);
    return Promise.resolve(() => {
      handlers.delete(id);
    });
  }
  window.__TAURI__ = { core: { invoke }, event: { listen } };
})();
