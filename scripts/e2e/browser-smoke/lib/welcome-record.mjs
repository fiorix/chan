// A page-side record of the empty pane's welcome: when its region appears
// and when it goes, every canvas context request with where its canvas
// stands at that moment, and when the first terminal tab appears. Times are
// the page's own `performance.now()`.
//
// Install with `page.evaluateOnNewDocument(installWelcomeRecord)` so the
// record is in place before any page script runs.

/// The welcome's start delay, as the product sets it.
export const WELCOME_START_DELAY_MS = 2000;

/// What the record's own readings allow between the region's time and a
/// timer set after it: clock rounding in the engine. An allowance for the
/// instrument, not for a loaded host.
export const WELCOME_RECORD_SKEW_MS = 100;

export function installWelcomeRecord() {
  const record = {
    regionAt: null,
    regionGoneAt: null,
    canvasAt: null,
    terminalAt: null,
    contexts: [],
  };
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  window.__welcomeRecord = record;
  // Kept for a check's own readings, which must not land in the record.
  window.__nativeGetContext = nativeGetContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    const at = performance.now();
    const context = nativeGetContext.call(this, kind, ...rest);
    record.contexts.push({
      at,
      ms: performance.now() - at,
      kind,
      inWelcome: this.closest(".welcome") !== null,
      connected: this.isConnected,
      answered: context !== null,
    });
    return context;
  };
  // The region's time is read as the call that inserted it returns. A
  // mutation observer reports only after the inserting script has finished,
  // which at mount is after the welcome's own first work (tens of
  // milliseconds here), so its time alone would make the welcome look
  // early. A region inserted some other way is still seen by the observer
  // below, late, which can fail a check and cannot pass one.
  const inserts = [
    [Node.prototype, ["appendChild", "insertBefore", "replaceChild"]],
    [Element.prototype, ["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]],
    [CharacterData.prototype, ["before", "after", "replaceWith"]],
    [DocumentFragment.prototype, ["append", "prepend", "replaceChildren"]],
  ];
  for (const [prototype, names] of inserts) {
    for (const name of names) {
      const native = prototype[name];
      prototype[name] = function (...args) {
        const result = native.apply(this, args);
        if (record.regionAt === null && document.querySelector(".welcome")) {
          record.regionAt = performance.now();
        }
        return result;
      };
    }
  }
  const scan = () => {
    const now = performance.now();
    const region = document.querySelector(".welcome");
    if (region && record.regionAt === null) record.regionAt = now;
    if (!region && record.regionAt !== null && record.regionGoneAt === null) {
      record.regionGoneAt = now;
    }
    if (record.canvasAt === null && document.querySelector(".welcome canvas")) {
      record.canvasAt = now;
    }
    if (record.terminalAt === null && document.querySelector(".terminal-tab")) {
      record.terminalAt = now;
    }
  };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
}

export async function readWelcomeRecord(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__welcomeRecord)));
}

/// The context requests made on a canvas under the welcome's region.
export function welcomeContexts(record) {
  return record.contexts.filter((request) => request.inWelcome);
}

/// The WebGL2 requests made on a canvas outside the document: the shape of
/// the welcome's reading of the page's renderer.
export function rendererReadings(record) {
  return record.contexts.filter(
    (request) => !request.connected && request.kind === "webgl2",
  );
}
