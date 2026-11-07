// Make the web process commit a frame without changing any geometry. WebKit
// shows a webview's content again only on a layer tree commit from its web
// process; inserting an element schedules a rendering update, and every
// rendering update commits. The element is fixed, one pixel, invisible and
// inert, so no other box moves or changes size, no terminal grid changes and
// no PTY is resized. It goes two animation frames later, once a frame with it
// has been rendered; a page that renders no frames (a hidden one) drops it
// after a second.
(() => {
  const ID = 'chan-wake-repaint';
  const root = document.documentElement;
  if (!root) return;
  document.getElementById(ID)?.remove();
  const probe = document.createElement('div');
  probe.id = ID;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;' +
    'pointer-events:none;contain:strict;will-change:transform';
  root.appendChild(probe);
  const remove = () => probe.remove();
  requestAnimationFrame(() => requestAnimationFrame(remove));
  setTimeout(remove, 1000);
})();
