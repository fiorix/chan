/** Each surface owns its transport and refusal type. The body stays unread
 * until the wait checks that the window is still open. */
export type WindowPageCheck = (url: string, signal: AbortSignal) => Promise<{
  response: Response;
  readRefusal: () => Promise<Error>;
}>;

const WINDOW_PAGE_OWNER_ATTRIBUTE = "data-chan-window-page-owner";
const WINDOW_PAGE_WAIT_MS = 60_000;
// Long enough for the assigned location, and the capability redirect before
// it, to commit a document right after the check fetched the same URL. It is a
// policy: a slower commit can be navigated twice, and a stopped one keeps
// every caller out for this long.
const WINDOW_PAGE_NAVIGATION_MS = 10_000;
const WINDOW_CLOSED_POLL_MS = 100;
const WINDOW_PAGE_RETRY_MIN_MS = 1000;
const waitingPages = new WeakMap<Window, Promise<boolean>>();

type MarkPhase = "waiting" | "navigating";

const MARK_BOUND_MS: Record<MarkPhase, number> = {
  waiting: WINDOW_PAGE_WAIT_MS,
  navigating: WINDOW_PAGE_NAVIGATION_MS,
};

type Mark =
  | { phase: "absent"; value: string | null }
  | { phase: MarkPhase; value: string; remainingMs: number };

/** A caller's reading of a window's record once its page answers: a socket
 * tagged with the window's id is live, none is, or the record no longer
 * exists. */
export type WindowConnection = "connected" | "disconnected" | "gone";

type Arrival = "navigate" | "stay" | "closed";

/** An unreadable location is not evidence of an empty window. */
export function isBlankWindow(h: Window): boolean {
  try {
    return h.location.href === "" || h.location.href === "about:blank";
  } catch {
    return false;
  }
}

/** A blank window whose readable document carries no mark of any age or form,
 * as `window.open` makes one. A wait marks every readable document it takes
 * and leaves a mark on one that carried a mark, so a blank that an earlier
 * wait left answers false. So does an unreadable document. */
export function isUnmarkedBlankWindow(h: Window): boolean {
  if (!isBlankWindow(h)) return false;
  const page = readableDocument(h);
  return page !== undefined && readMark(page).value === null;
}

function readableDocument(h: Window): Document | undefined {
  try {
    return h.document;
  } catch {
    return undefined;
  }
}

// Opener pages share the document, not their module state, so the mark says
// until when its phase holds by the clock every page of the browser reads. A
// value that has expired, or promises more than its phase allows, as after
// the clock was set back, is no mark: the window is repaired rather than kept
// out of reach.
function readMark(
  page: Document | undefined,
  value = page?.documentElement.getAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE) ?? null,
): Mark {
  const match = value === null ? null : /^(waiting|navigating):(\d{1,16})$/.exec(value);
  if (value === null || match === null) return { phase: "absent", value };
  const phase = match[1] as MarkPhase;
  const remainingMs = Number(match[2]) - Date.now();
  if (remainingMs <= 0 || remainingMs > MARK_BOUND_MS[phase]) return { phase: "absent", value };
  return { phase, value, remainingMs };
}

function writeMark(page: Document | undefined, phase: MarkPhase): string | undefined {
  if (!page) return undefined;
  const value = `${phase}:${Date.now() + MARK_BOUND_MS[phase]}`;
  page.documentElement.setAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE, value);
  return value;
}

function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return WINDOW_PAGE_RETRY_MIN_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(WINDOW_PAGE_WAIT_MS, Math.max(WINDOW_PAGE_RETRY_MIN_MS, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(WINDOW_PAGE_WAIT_MS, Math.max(WINDOW_PAGE_RETRY_MIN_MS, date - Date.now())) : WINDOW_PAGE_RETRY_MIN_MS;
}

type WaitOptions = {
  focus?: boolean;
  /** Asked after the page answers, for a window that is not blank, so a
   * record that changed during the wait decides instead of the one the
   * caller started from. */
  readConnection?: (signal: AbortSignal) => WindowConnection | Promise<WindowConnection>;
};

/** Decide again from what the window holds. `expired` is the mark whose time
 * ran out while it was followed, so that mark no longer counts. */
type Again = { again: true; expired?: string };

export function navigateWindowWhenReady(
  h: Window,
  url: string,
  checkPage: WindowPageCheck,
  opts: WaitOptions = {},
): Promise<boolean> {
  const waiting = waitingPages.get(h);
  if (waiting) return waiting;
  // One pending answer owns a named window even when the user clicks twice.
  const pending = settle(h, url, checkPage, opts).finally(() => waitingPages.delete(h));
  waitingPages.set(h, pending);
  return pending;
}

// Other opener pages have their own module state but share the window's
// document, so what another page is doing with the window is read from the
// mark on it. A navigating mark is a wait already decided. A waiting one is
// followed until it is decided, so no caller answers for the window before its
// owner does.
async function settle(h: Window, url: string, checkPage: WindowPageCheck, opts: WaitOptions): Promise<boolean> {
  let expired: string | undefined;
  let first = true;
  for (;;) {
    if (h.closed) return false;
    const page = readableDocument(h);
    const mark = readMark(page);
    const live = mark.phase !== "absent" && mark.value !== expired ? mark : undefined;
    if (live && first && opts.focus !== false) h.focus?.();
    first = false;
    if (live?.phase === "navigating") return true;
    const outcome = page && live ? await follow(h, page, live) : await own(h, page, url, checkPage, opts);
    if (typeof outcome === "boolean") return outcome;
    expired = outcome.expired;
  }
}

// A follower sends nothing: it watches what the window shares until the owner
// has decided, the window has closed, or the mark's time has run out.
function follow(h: Window, page: Document, mark: { value: string; remainingMs: number }): Promise<boolean | Again> {
  return new Promise((resolve) => {
    const finish = (outcome: boolean | Again) => {
      clearTimeout(expiry);
      clearInterval(poll);
      resolve(outcome);
    };
    const expiry = setTimeout(() => finish({ again: true, expired: mark.value }), mark.remainingMs);
    const poll = setInterval(() => {
      if (h.closed) finish(false);
      else if (readableDocument(h) !== page) finish(true);
      else if (readMark(page).value !== mark.value) finish({ again: true });
    }, WINDOW_CLOSED_POLL_MS);
  });
}

function own(
  h: Window,
  page: Document | undefined,
  url: string,
  checkPage: WindowPageCheck,
  opts: WaitOptions,
): Promise<boolean | Again> {
  if (page?.body && isBlankWindow(h)) page.body.textContent = "Waiting for the window to be ready...";
  const replaced = readMark(page).value;
  const mark = writeMark(page, "waiting");
  const controller = new AbortController();
  let lastRefusal: Error = new Error("Timed out waiting for the window page");
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closedPoll: ReturnType<typeof setInterval> | undefined;
  const stopped = new Promise<Arrival>((resolve, reject) => {
    deadline = setTimeout(() => reject(lastRefusal), WINDOW_PAGE_WAIT_MS);
    closedPoll = setInterval(() => {
      if (h.closed) resolve("closed");
    }, WINDOW_CLOSED_POLL_MS);
  });
  const check = async (): Promise<boolean> => {
    while (!h.closed && !controller.signal.aborted) {
      const { response, readRefusal } = await checkPage(url, controller.signal);
      if (h.closed || controller.signal.aborted) return false;
      if (response.ok) {
        await response.body?.cancel();
        return true;
      }
      const refusal = await readRefusal();
      if (response.status !== 503) throw refusal;
      lastRefusal = refusal;
      if (h.closed || controller.signal.aborted) return false;
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, retryAfterMs(response.headers.get("Retry-After")));
      });
    }
    return false;
  };
  // A window whose socket came back during the wait is on its page and keeps
  // it; one whose record went away ends the wait as a closed window does. A
  // blank window holds no page, whatever its record says.
  const arrive = async (): Promise<Arrival> => {
    if (!(await check())) return "closed";
    if (!opts.readConnection || isBlankWindow(h)) return "navigate";
    const connection = await opts.readConnection(controller.signal);
    if (connection === "gone") return "closed";
    return connection === "connected" && !isBlankWindow(h) ? "stay" : "navigate";
  };
  // Another page can take this window once this wait's mark has run out, as
  // it does when this page's timers fire late. This wait then answers what
  // that page makes of the window, and its caller closes nothing under it.
  const taken = (): boolean => {
    if (!page || readableDocument(h) !== page) return false;
    const current = readMark(page);
    return current.phase !== "absent" && current.value !== mark;
  };
  // The deadline and close check also cover a fetch, a response body or a
  // reading that stalls.
  return Promise.race([arrive(), stopped]).then(
    (arrival): boolean | Again => {
      if (taken()) return { again: true };
      if (arrival === "closed" || h.closed) return false;
      if (arrival === "stay") return true;
      // The navigation replaces the document the window holds now, which need
      // not be the one the wait began on.
      const current = readableDocument(h);
      h.location.href = url;
      writeMark(current, "navigating");
      return true;
    },
    (error: unknown): Again => {
      if (taken()) return { again: true };
      throw error;
    },
  ).finally(() => {
    clearTimeout(retryTimer);
    clearTimeout(deadline);
    clearInterval(closedPoll);
    controller.abort();
    // Only this wait's own waiting mark goes; a navigating mark stays until
    // its document is replaced or its time runs out. A document that carried
    // a mark keeps one, spent if the replaced value still reads live, as it
    // can when a follower's timer counted it out before the clock did.
    if (page && readMark(page).value === mark) {
      if (replaced === null) {
        page.documentElement.removeAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE);
      } else {
        const back = readMark(page, replaced);
        page.documentElement.setAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE, back.phase === "absent" ? replaced : `${back.phase}:0`);
      }
    }
  });
}
