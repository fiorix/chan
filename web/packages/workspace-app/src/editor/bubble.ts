// Shared shell for the editor's inline popovers.
//
// Every "bubble" in the WYSIWYG editor (wiki link, tag, mention,
// image, calendar) opens a non-focus-stealing popover anchored
// under the caret. The host (Wysiwyg.svelte) leaves the caret in
// the document; the bubble runs alongside it, watches the typed
// query, and commits on Enter or click. The keyboard model is
// uniform: ArrowUp / ArrowDown to navigate results, Enter to
// commit, Escape to dismiss.
//
// This module provides `openBubbleShell`, the DOM scaffolding shared
// by every bubble. It creates an absolute-positioned, body-attached
// wrap div with a high z-index, anchors it under the trigger, and
// re-anchors on viewport changes. The adapter builds its specific
// content (result list, preview, footer) inside `shell.wrap`.
//
// The handle the wiki, tag, contact and image adapters hand back to
// the host is `BubbleHandle` in bubbles/types.ts.
//
// Per-bubble specifics (search source, result rendering, commit
// transform) stay in the adapter files. The shell does not try to
// unify the result list or item rendering; bubble visuals differ
// by type and the shell only owns the geometry / lifecycle.

import { positionPopover, watchViewport } from "./extensions/popover";

export interface BubbleShellOpts {
  /// Anchor element. Pass the caret-anchor shim so the wrap sits
  /// under the cursor.
  host: HTMLElement;
  /// Type-specific class applied to the wrap so each adapter can
  /// own its layout / colors (e.g. `md-wiki-bubble`,
  /// `md-tag-bubble`). The base `md-bubble` class is also applied
  /// so a single style block can cover shared scaffolding.
  className: string;
}

export interface BubbleShell {
  /// Wrap div, already attached to `document.body`. Append result
  /// rows / preview / footer here. The shell does not assume any
  /// inner structure.
  wrap: HTMLElement;
  /// Re-anchor under the trigger. Call after content changes that
  /// resize the wrap (adding / removing rows, toggling preview).
  reposition(): void;
  /// Tear down DOM + viewport listener. Idempotent; safe to call
  /// from the adapter's `dismiss()` after its own cleanup.
  dismiss(): void;
}

/// Z-index above the in-app overlay layer (search panel, inline
/// assist sit at 25000) so a bubble triggered inside another
/// overlay still floats on top.
const Z_INDEX = "30000";

export function openBubbleShell(opts: BubbleShellOpts): BubbleShell {
  const wrap = document.createElement("div");
  wrap.className = `md-bubble ${opts.className}`;
  wrap.style.position = "absolute";
  wrap.style.zIndex = Z_INDEX;
  document.body.appendChild(wrap);
  positionPopover(opts.host, wrap);
  const stopWatch = watchViewport(opts.host, wrap);
  let alive = true;

  // Outside-mousedown dismiss. Without this, the bubble stays open
  // until the controller sees a selection change that invalidates the
  // trigger spec - and a click in the doc that lands inside the still-
  // valid trigger range (or on a button that preventDefaults) won't
  // dismiss. With outside-mousedown, clicks anywhere not inside the
  // bubble close it immediately AND let the underlying click through
  // to move the caret. Deferred one tick so the bubble's own opening
  // event doesn't immediately trigger dismiss.
  const onOutsideMouseDown = (e: MouseEvent): void => {
    if (!alive) return;
    const t = e.target as Node | null;
    if (t && wrap.contains(t)) return;
    if (t && opts.host.contains(t)) return;
    dismissSelf();
  };
  window.setTimeout(() => {
    if (alive) document.addEventListener("mousedown", onOutsideMouseDown, true);
  }, 0);

  function dismissSelf(): void {
    if (!alive) return;
    alive = false;
    stopWatch();
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
    wrap.remove();
  }

  return {
    wrap,
    reposition(): void {
      if (alive && wrap.isConnected) positionPopover(opts.host, wrap);
    },
    dismiss: dismissSelf,
  };
}
