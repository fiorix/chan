// Two live webviews share the viewport during the carousel. The launcher is
// transparent outside its moving card; the host remains visible underneath.
(() => {
  if (window.__chanLauncherTransition) return;
  const SLIDE_MS = 320;
  const EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
  let active;
  let colorObserver;
  let lastColor;

  function hostFocusColor() {
    const read = () => {
      const pane = document.querySelector('.pane.focused') || document.querySelector('.pane');
      const styles = getComputedStyle(pane || document.documentElement);
      const color = (styles.getPropertyValue('--pane-highlight-color') ||
        styles.getPropertyValue('--pane-active-focus') ||
        styles.getPropertyValue('--pane-focus')).trim();
      return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null;
    };
    if (!colorObserver) {
      colorObserver = new MutationObserver(() => {
        const color = read();
        if (!color || color === lastColor) return;
        lastColor = color;
        window.__TAURI__?.core?.invoke('set_launcher_focus_color', { color }).catch(() => {});
      });
      // The per-window colour is applied to the root, including library-watch
      // updates from other windows. Theme changes also change the default blue.
      colorObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    }
    lastColor = read();
    return lastColor;
  }

  function settled(value) {
    window.__chanLauncherSettled = value;
    window.dispatchEvent(new Event('chan-launcher-settled'));
  }

  function motionEnabled() {
    return !matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function reset() {
    if (!active) return;
    clearTimeout(active.timer);
    active.animation?.cancel();
    for (const [el, name, value, priority] of active.styles) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
    active = undefined;
  }
  function prepare(launcher, position) {
    reset();
    if (!motionEnabled()) return false;
    const el = document.getElementById('app') || document.body;
    const state = active = { el, styles: [], timer: 0, animation: null };
    const set = (target, name, value) => {
      state.styles.push([target, name, target.style.getPropertyValue(name), target.style.getPropertyPriority(name)]);
      target.style.setProperty(name, value, 'important');
    };
    // The body's stationary background must not cover the other webview.
    // Paint it on the card instead, including an otherwise short launcher.
    if (launcher) {
      const bg = getComputedStyle(document.body).backgroundColor;
      set(el, 'background-color', bg === 'rgba(0, 0, 0, 0)' ? 'var(--bg)' : bg);
      set(el, 'min-height', '100vh');
      set(document.documentElement, 'background', 'transparent');
      set(document.body, 'background', 'transparent');
    }
    const overflow = typeof CSS !== 'undefined' && CSS.supports?.('overflow-x', 'clip') ? 'clip' : 'hidden';
    set(document.documentElement, 'overflow-x', overflow);
    set(document.body, 'overflow-x', overflow);
    set(el, 'will-change', 'transform');
    set(el, 'pointer-events', 'none');
    set(el, 'transform', `translate3d(${position}vw, 0, 0)`);
    return true;
  }
  function slide(launcher, from, to, startAt) {
    // Keep primed backgrounds and positions until the first animated frame.
    if (!active && !prepare(launcher, from)) return;
    const state = active;
    if (!motionEnabled()) { reset(); return; }
    const delay = Math.max(0, (startAt || Date.now()) - Date.now());
    // Inline !important beats a Web Animation. The fill owns the transform
    // until reset restores the page's original inline value and priority.
    state.el.style.removeProperty('transform');
    state.animation = state.el.animate(
      [{ transform: `translate3d(${from}vw, 0, 0)` }, { transform: `translate3d(${to}vw, 0, 0)` }],
      { duration: SLIDE_MS, delay, easing: EASING, fill: 'both' },
    );
    // Catch up if one webview's script queue ran after the shared start time.
    if (startAt && Date.now() > startAt) state.animation.currentTime = Date.now() - startAt;
    const finish = () => {
      if (active !== state) return;
      clearTimeout(state.timer);
      if (to === 0) reset();
      // Outgoing cards hold their endpoint until the native handoff resets it.
    };
    state.animation.finished.then(finish, () => {});
    state.timer = setTimeout(finish, delay + SLIDE_MS);
  }
  window.__chanLauncherTransition = {
    hostFocusColor,
    motionEnabled,
    hostPrimeOut() { return prepare(false, 0); },
    hostOut(startAt) { slide(false, 0, 100, startAt); },
    hostReset() { reset(); },
    hostPrimeIn() { return prepare(false, 100); },
    hostIn(startAt) { slide(false, 100, 0, startAt); },
    launcherPrimeIn() { return prepare(true, -100); },
    launcherPrimeOut() { return prepare(true, 0); },
    launcherIn(startAt) { slide(true, -100, 0, startAt); },
    launcherOut(startAt) { slide(true, 0, -100, startAt); },
    launcherReset() { reset(); },
    launcherShown() { settled(true); },
    launcherSuspended() { settled(false); },
  };
})();
