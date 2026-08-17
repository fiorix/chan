// WinBox adapter: the one module that knows the window manager is WinBox.
// The shell talks frames (create/focus/close/retitle/list + focus events), so
// a tab-strip presentation would be a sibling adapter over the same calls.

import {
  cascadePlacement,
  clampFramePosition,
  loadGeometry,
  saveGeometry,
} from "./hybrid-core.mjs";

export function createWinboxWm(opts) {
  const {
    winbox,
    storage,
    offsets,
    onFocused,
    onCloseRequested,
    onFrameReady,
    onFramesChanged,
    onZoomHover,
    onZoomLeave,
  } = opts;
  const frames = new Map(); // id -> { id, wb, iframe, url, kind, silent, managed, createdAt }
  let focusedId = null;

  // The set of frames changed. A host reads this set as its window-manager
  // census, so it has to hear about every add and every removal.
  function framesChanged() {
    if (onFramesChanged) onFramesChanged();
  }

  function usableArea(off = offsets()) {
    const root = document.documentElement;
    return {
      left: off.left,
      top: off.top,
      width: Math.max(0, root.clientWidth - off.left),
      height: Math.max(0, root.clientHeight - off.top),
    };
  }

  // The vendored bundle is minified with property renaming: `dom` is gone
  // (only the `window` alias survives) and the state fields cannot be relied
  // on either. The root element and its state classes are the stable truth,
  // so window state is read from the DOM rather than from the instance.
  function rootOf(entry) {
    return entry.root || null;
  }

  function inState(entry, name) {
    const root = rootOf(entry);
    return root ? root.classList.contains(name) : false;
  }

  function persistGeometry(entry) {
    if (!entry.wb) return;
    const wb = entry.wb;
    saveGeometry(storage, entry.id, {
      x: wb.x,
      y: wb.y,
      width: wb.width,
      height: wb.height,
      max: inState(entry, "max"),
    });
  }

  function createFrame({ id, url, title, kind, managed = true }) {
    const existing = frames.get(id);
    if (existing) {
      focusFrame(id);
      return existing;
    }
    const iframe = document.createElement("iframe");
    iframe.className = "hybrid-frame";
    iframe.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
    iframe.setAttribute("allowfullscreen", "true");
    iframe.src = url;

    const off = offsets();
    const saved = loadGeometry(storage, id);
    const area = usableArea(off);
    const place = saved
      ? { ...saved, ...clampFramePosition(saved, area) }
      : cascadePlacement(frames.size, area);
    const entry = {
      id,
      wb: null,
      iframe,
      url,
      kind,
      title,
      silent: false,
      managed,
      createdAt: Date.now(),
    };
    let debounce = 0;
    const schedulePersist = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => persistGeometry(entry), 250);
    };
    const wb = new winbox({
      title,
      class: ["chan", kind === "terminal" ? "chan-terminal" : "chan-workspace"],
      mount: iframe,
      x: place.x,
      y: place.y,
      width: place.width,
      height: place.height,
      top: off.top,
      left: off.left,
      bottom: 0,
      right: 0,
      onfocus() {
        focusedId = id;
        if (onFocused) onFocused(id);
        setTimeout(() => {
          try {
            iframe.contentWindow && iframe.contentWindow.focus();
          } catch {
            // Cross-origin content cannot be focused programmatically.
          }
        }, 0);
      },
      onclose() {
        // The titlebar close is a HIDE request (chan-desktop's close buries):
        // veto the destroy and let the shell flip the record's visibility;
        // the frame only really dies on closeFrame() (record discarded).
        if (!entry.silent) {
          if (onCloseRequested) onCloseRequested(id);
          return true;
        }
        clearTimeout(debounce);
        frames.delete(id);
        if (focusedId === id) focusedId = null;
        framesChanged();
        return false;
      },
      onmove: schedulePersist,
      onresize: schedulePersist,
      onminimize() {
        // The green control is gone while minimised, so its menu must not
        // linger over the chip.
        if (onZoomLeave) onZoomLeave(id);
      },
      onmaximize() {
        persistGeometry(entry);
      },
      onrestore() {
        persistGeometry(entry);
      },
    });
    entry.wb = wb;
    entry.root = iframe.closest(".winbox") || wb.window || null;
    frames.set(id, entry);
    // macOS puts the zoom alternatives behind a hover on the green control;
    // the click itself keeps WinBox's own maximize.
    const zoom = entry.root && entry.root.querySelector(".wb-max");
    if (zoom && onZoomHover) {
      zoom.addEventListener("mouseenter", () => onZoomHover(id, zoom));
      zoom.addEventListener("mouseleave", () => onZoomLeave && onZoomLeave(id));
      zoom.addEventListener("click", () => onZoomLeave && onZoomLeave(id));
    }
    if (saved && saved.max) wb.maximize(true);
    iframe.addEventListener("load", () => {
      if (onFrameReady) onFrameReady(id, iframe);
    });
    framesChanged();
    return entry;
  }

  function focusFrame(id) {
    const entry = frames.get(id);
    if (!entry) return false;
    if (entry.hidden) showFrame(id);
    if (inState(entry, "min")) entry.wb.restore();
    entry.wb.focus();
    return true;
  }

  // Warm hide: the WinBox (and the iframe inside it) stays in the DOM with
  // display:none, so the SPA keeps running and its /ws presence stays up.
  function hideFrame(id) {
    const entry = frames.get(id);
    if (!entry || entry.hidden) return false;
    persistGeometry(entry);
    entry.hidden = true;
    entry.wb.hide();
    if (focusedId === id) focusedId = null;
    return true;
  }

  function showFrame(id) {
    const entry = frames.get(id);
    if (!entry || !entry.hidden) return false;
    entry.hidden = false;
    entry.wb.show();
    entry.wb.focus();
    return true;
  }

  function closeFrame(id, { silent = true } = {}) {
    const entry = frames.get(id);
    if (!entry) return false;
    entry.silent = silent;
    entry.wb.close();
    return true;
  }

  function setTitle(id, title) {
    const entry = frames.get(id);
    if (entry && entry.title !== title) {
      entry.title = title;
      entry.wb.setTitle(title);
    }
  }

  // Re-apply viewport offsets after the dock collapses or expands. A
  // maximized window re-maximizes so it fills the new area.
  function applyOffsets() {
    const off = offsets();
    const area = usableArea(off);
    for (const entry of frames.values()) {
      const wb = entry.wb;
      wb.top = off.top;
      wb.left = off.left;
      if (inState(entry, "max")) {
        wb.restore();
        wb.maximize(true);
      } else if (!inState(entry, "min")) {
        const position = clampFramePosition(wb, area);
        wb.move(position.x, position.y);
      }
    }
  }

  return {
    createFrame,
    focusFrame,
    hideFrame,
    showFrame,
    closeFrame,
    setTitle,
    applyOffsets,
    isMaximized: (id) => {
      const entry = frames.get(id);
      return entry ? inState(entry, "max") : false;
    },
    get: (id) => frames.get(id) || null,
    has: (id) => frames.has(id),
    list: () => [...frames.values()],
    focusedId: () => focusedId,
  };
}
