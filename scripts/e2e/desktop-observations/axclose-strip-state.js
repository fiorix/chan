(() => {
  const rect = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  };
  const name = (node) => node.getAttribute('aria-label') ??
    (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ');
  return {
    userAgent: navigator.userAgent,
    desktop: Boolean(window.__TAURI_INTERNALS__),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    frames: window.__axcloseFrames ?? [],
    tabs: [...document.querySelectorAll('.tabs .tab-row > .tab')].map((outer) => {
      const tab = outer.matches('[role="tab"]') ? outer : outer.querySelector('[role="tab"]');
      const close = outer.querySelector('button.close');
      const box = rect(outer);
      return {
        label: outer.querySelector('.path')?.textContent?.trim() ?? null,
        selected: tab?.getAttribute('aria-selected') ?? null,
        activeClass: outer.classList.contains('active'),
        rolePresent: Boolean(tab),
        nativeActionsInsideRole: tab?.querySelectorAll('button,select').length ?? null,
        closeName: close?.getAttribute('aria-label') ?? null,
        closeInsideRole: Boolean(tab?.contains(close)),
        rect: box, labelRect: rect(tab), closeRect: rect(close),
        visible: Boolean(box.width && box.height && getComputedStyle(outer).visibility !== 'hidden'),
        pane: outer.closest('.pane')?.getAttribute('data-pane-id') ?? null,
        inBar: Boolean(outer.closest('.tabs.in-bar')),
      };
    }),
    panes: [...document.querySelectorAll('.pane')].map((pane) => ({
      id: pane.getAttribute('data-pane-id'), focused: pane.classList.contains('focused'),
      sole: pane.classList.contains('sole'),
    })),
    terminals: [...document.querySelectorAll('.terminal-tab')].map((node) => ({
      id: node.getAttribute('data-terminal-tab-id'), active: node.classList.contains('active'),
      status: node.querySelector('.terminal-status')?.textContent?.trim() ?? null,
    })),
    dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .map((node) => ({ name: name(node), text: node.textContent?.trim(), rect: rect(node) }))
      .filter((node) => node.rect.width && node.rect.height),
  };
})()
