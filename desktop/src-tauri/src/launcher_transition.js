// The launcher toggle's transition, evaluated into a window's page by
// chan-desktop at each stage of a toggle. The host page and the launcher are
// two webviews that are never composited together, so each stage animates one
// page while the desktop sequences the handoff between them:
//
//   show: hostOut (the panes gather)  -> panel shown -> launcherIn
//   hide: launcherOut                 -> panel hidden -> hostIn (the panes deal)
//
// The durations here are mirrored by constants in launcher_panel.rs, which
// sleeps them between stages; a desktop test keeps the two in step. The file
// is self-contained (no init script to rely on) and idempotent, so it can be
// evaluated on every stage. Animations run through the Web Animations API so
// the forward-filled end state can be cancelled, which restores the page's own
// styles with nothing left behind.
(() => {
  const EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
  const HOST_OUT_MS = 180;
  const HOST_IN_MS = 220;
  const LAUNCHER_IN_MS = 200;
  const LAUNCHER_OUT_MS = 160;
  // The stagger between panes shrinks as panes multiply so the whole phase
  // ends within the budget the desktop waits for, whatever the pane count.
  const STAGGER_MS = 25;
  const STAGGER_BUDGET_MS = 80;
  const HOLD = { duration: 0, fill: 'forwards' };

  const registry = (window.__chanLauncherTransitionAnims ||= []);
  function remember(anim) {
    registry.push(anim);
    return anim;
  }
  function cancelAll() {
    while (registry.length) {
      const anim = registry.pop();
      try { anim.cancel(); } catch (_) { /* already gone */ }
    }
  }
  function reducedMotion() {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  // The window's panes, or the document root when the page has none (the
  // connecting screen, an empty window): the same motion then moves the
  // whole page.
  function paneTargets() {
    const panes = Array.from(document.querySelectorAll('.pane'));
    return panes.length ? panes : [document.documentElement];
  }
  // Each pane's gathered keyframe: its center moved onto the viewport center,
  // shrunk and faded, as a hand of cards pulled together. It reads the
  // pane's layout box, so it must run while no transition holds a
  // transform on the pane: every caller cancels first and measures every
  // pane before animating any.
  function gatheredFrame(el) {
    const rect = el.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
    const dy = window.innerHeight / 2 - (rect.top + rect.height / 2);
    return { transform: `translate(${dx}px, ${dy}px) scale(0.85)`, opacity: 0 };
  }
  function stagger(count) {
    return count > 1 ? Math.min(STAGGER_MS, STAGGER_BUDGET_MS / (count - 1)) : 0;
  }
  function restingFrame() {
    return { transform: 'none', opacity: 1 };
  }
  function launcherRoot() {
    return document.getElementById('app') || document.documentElement;
  }
  const LAUNCHER_AWAY = { transform: 'scale(0.96)', opacity: 0 };
  const LAUNCHER_HOME = { transform: 'none', opacity: 1 };

  window.__chanLauncherTransition = {
    // The panes gather toward the center and fade; the end state holds until
    // hostReset runs under the shown panel.
    hostOut() {
      cancelAll();
      if (reducedMotion()) return;
      const targets = paneTargets();
      const frames = targets.map(gatheredFrame);
      const step = stagger(targets.length);
      targets.forEach((el, i) => {
        remember(el.animate([restingFrame(), frames[i]], {
          duration: HOST_OUT_MS, delay: i * step, easing: EASING, fill: 'forwards',
        }));
      });
    },
    // Drops every held end state so the covered page is its normal self.
    hostReset() {
      cancelAll();
    },
    // Holds the panes at their gathered state while the panel still covers
    // them, so the deal starts from where the gather ended.
    hostPrimeIn() {
      cancelAll();
      if (reducedMotion()) return;
      const targets = paneTargets();
      const frames = targets.map(gatheredFrame);
      targets.forEach((el, i) => {
        remember(el.animate([frames[i]], HOLD));
      });
    },
    // The panes deal back out to their places; nothing is held afterwards.
    // The hold is dropped and the layout measured in the same task, so no
    // frame paints between the hold and the deal's first keyframe; a pane
    // waiting out its stagger is filled backwards at the gathered state.
    hostIn() {
      cancelAll();
      if (reducedMotion()) return;
      const targets = paneTargets();
      const frames = targets.map(gatheredFrame);
      const step = stagger(targets.length);
      targets.forEach((el, i) => {
        el.animate([frames[i], restingFrame()], {
          duration: HOST_IN_MS, delay: i * step, easing: EASING, fill: 'backwards',
        });
      });
    },
    // Holds the launcher faded and slightly small before the panel shows, so
    // its first painted frame is the start of the fade.
    launcherPrimeIn() {
      cancelAll();
      if (reducedMotion()) return;
      remember(launcherRoot().animate([LAUNCHER_AWAY], HOLD));
    },
    launcherIn() {
      cancelAll();
      if (reducedMotion()) return;
      launcherRoot().animate([LAUNCHER_AWAY, LAUNCHER_HOME], {
        duration: LAUNCHER_IN_MS, easing: 'ease-out',
      });
    },
    // Fades the launcher down and holds it there until the panel is hidden;
    // the next launcherPrimeIn drops the hold.
    launcherOut() {
      cancelAll();
      if (reducedMotion()) return;
      remember(launcherRoot().animate([LAUNCHER_HOME, LAUNCHER_AWAY], {
        duration: LAUNCHER_OUT_MS, easing: 'ease-in', fill: 'forwards',
      }));
    },
    launcherReset() {
      cancelAll();
    },
  };
})();
