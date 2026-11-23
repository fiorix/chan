import { captureGhosttyTerminals } from "../ghostty-capture.mjs";

export const FIELDS = ["type", "key", "code", "keyCode", "location",
  "ctrlKey", "altKey", "shiftKey", "metaKey", "repeat", "isComposing",
  "inputType", "data", "isTrusted", "altGraph", "defaultPrevented",
  "gotThrough", "target"];

export const INSTALL_SRC = `(() => {
  for (const off of window.__nativeInput?.uninstallers || []) off();
  const rec = (window.__nativeInput = { terms: [], events: [], bytes: [], t0: performance.now(),
    hookError: null, composing: false });
  const stamp = () => Math.round((performance.now() - rec.t0) * 1000) / 1000;
  const pathHas = (e, pred) => {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    return path.some((n) => n && pred(n));
  };
  const inHost = (e) => pathHas(e, (n) => n.classList && n.classList.contains("terminal-host"));
  const inTextarea = (e) => pathHas(e, (n) => n.tagName === "TEXTAREA");
  const seen = new WeakMap();
  const putCapture = (e) => {
    if (!inHost(e)) return;
    const row = { t: stamp(), target: inTextarea(e) ? "textarea" : "host",
      defaultPrevented: false, gotThrough: false };
    for (const f of ["type", "key", "code", "keyCode", "location",
      "ctrlKey", "altKey", "shiftKey", "metaKey", "repeat", "isComposing",
      "inputType", "data", "isTrusted", "altGraph", "defaultPrevented",
      "gotThrough", "target"]) {
      try {
        if (f === "altGraph") row[f] = typeof e.getModifierState === "function" ? e.getModifierState("AltGraph") : null;
        else if (f === "defaultPrevented" || f === "gotThrough" || f === "target") row[f] = row[f] ?? null;
        else row[f] = e[f] ?? null;
      } catch { row[f] = null; }
    }
    if (e.type === "paste") {
      try {
        const dt = e.clipboardData;
        row.clipTypes = dt ? [...dt.types] : null;
        row.clipText = dt ? dt.getData("text/plain") : null;
      } catch { row.clipTypes = null; row.clipText = null; }
    }
    seen.set(e, row);
    rec.events.push(row);
    queueMicrotask(() => { row.defaultPrevented = !!e.defaultPrevented; });
  };
  const putBubble = (e) => {
    const row = seen.get(e);
    if (!row) return;
    row.gotThrough = true;
    try { row.defaultPrevented = !!e.defaultPrevented; } catch { row.defaultPrevented = null; }
  };
  const TYPES = ["keydown", "keyup", "keypress", "beforeinput", "compositionstart",
    "compositionupdate", "compositionend", "paste", "input",
    "mousedown", "mouseup", "wheel", "contextmenu"];
  rec.uninstallers = [];
  for (const t of TYPES) {
    window.addEventListener(t, putCapture, true);
    window.addEventListener(t, putBubble, false);
  }
  rec.uninstallers.push(() => {
    for (const t of TYPES) {
      window.removeEventListener(t, putCapture, true);
      window.removeEventListener(t, putBubble, false);
    }
  });
  const onCompositionStart = () => { rec.composing = true; };
  const onCompositionEnd = () => { rec.composing = false; };
  window.addEventListener("compositionstart", onCompositionStart, true);
  window.addEventListener("compositionend", onCompositionEnd, true);
  rec.uninstallers.push(() => {
    window.removeEventListener("compositionstart", onCompositionStart, true);
    window.removeEventListener("compositionend", onCompositionEnd, true);
  });
  rec.hookTerm = (term, host) => {
    try {
      const off = term.onData((data) => {
        rec.bytes.push({ t: stamp(), data, codes: [...data].map((ch) => ch.codePointAt(0)) });
      });
      if (off && typeof off.dispose === "function") rec.uninstallers.push(() => off.dispose());
    } catch (err) {
      rec.hookError = String((err && err.message) || err).slice(0, 200);
      throw err;
    }
    rec.terms.push(!!term);
  };
  return "installed";
})()`;

// The inspector cannot await imports, so it reads the settle box; Chrome
// awaits this same call. Capture discovery and restoration stay shared.
export const WRAP_OPEN_SRC = `((key) => {
  const box = (window[key + ":wrap"] = { state: "settling", value: null });
  return (async () => {
    try {
      const href = await (${captureGhosttyTerminals.toString()})({ evaluate: (fn, args) => fn(args) }, key);
      box.state = href ? "wrapped" : "missing";
      box.value = href ? "wrapped" : null;
      return box.value;
    } catch (err) {
      box.state = "failed";
      box.value = "failed: " + String(err.message || err).slice(0, 200);
      throw err;
    }
  })();
})`;

export const FIND_TERM_SRC = `((key, query) => {
  const rec = window.__nativeInput;
  if (!rec) throw new Error("recorder not installed");
  if (rec.hookError) throw new Error("hook failed: " + rec.hookError);
  const host = document.querySelector(query);
  const terms = window[key]?.terminals || [];
  const term = terms.find((t) => host && t.element === host) ?? null;
  if (term) rec.hookTerm(term, host);
  return term ? "hooked" : null;
})`;

export const RESET_SRC = `(() => {
  const rec = window.__nativeInput;
  rec.events.length = 0;
  rec.bytes.length = 0;
  rec.t0 = performance.now();
  return "reset";
})()`;

export const READ_SRC = `(() => {
  const rec = window.__nativeInput;
  const ae = document.activeElement;
  return {
    events: rec.events,
    bytes: rec.bytes,
    terms: rec.terms.length,
    hookError: rec.hookError,
    composing: rec.composing,
    focused: ae ? { tag: ae.tagName, aria: ae.getAttribute && ae.getAttribute("aria-label"), inHost: !!ae.closest(".terminal-host") } : null,
    textareaPresent: !!document.querySelector(".terminal-host textarea"),
  };
})()`;
