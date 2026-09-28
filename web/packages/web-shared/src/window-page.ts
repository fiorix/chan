/** Each surface owns its transport and refusal type. The body stays unread
 * until the wait checks that the window is still open. */
export type WindowPageCheck = (url: string, signal: AbortSignal) => Promise<{
  response: Response;
  readRefusal: () => Promise<Error>;
}>;

const WINDOW_PAGE_OWNER_ATTRIBUTE = "data-chan-window-page-owner";
const WINDOW_PAGE_WAIT_MS = 60_000;
const WINDOW_CLOSED_POLL_MS = 100;
const WINDOW_PAGE_RETRY_MIN_MS = 1000;
const waitingPages = new WeakMap<Window, Promise<boolean>>();
const navigatingDocuments = new WeakMap<Window, Document>();

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

function readableDocument(h: Window): Document | undefined {
  try {
    return h.document;
  } catch {
    return undefined;
  }
}

function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return WINDOW_PAGE_RETRY_MIN_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(WINDOW_PAGE_WAIT_MS, Math.max(WINDOW_PAGE_RETRY_MIN_MS, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(WINDOW_PAGE_WAIT_MS, Math.max(WINDOW_PAGE_RETRY_MIN_MS, date - Date.now())) : WINDOW_PAGE_RETRY_MIN_MS;
}

export function navigateWindowWhenReady(
  h: Window,
  url: string,
  checkPage: WindowPageCheck,
  opts: {
    focus?: boolean;
    /** Asked after the page answers, for a window that is not blank, so a
     * record that changed during the wait decides instead of the one the
     * caller started from. */
    readConnection?: (signal: AbortSignal) => WindowConnection | Promise<WindowConnection>;
  } = {},
): Promise<boolean> {
  const waiting = waitingPages.get(h);
  if (waiting) return waiting;
  if (h.closed) return Promise.resolve(false);
  const page = readableDocument(h);
  // Other opener pages have their own module state but share this document.
  if (page?.documentElement.hasAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE)) {
    if (opts.focus !== false) h.focus?.();
    return Promise.resolve(true);
  }
  if (page?.body && isBlankWindow(h)) page.body.textContent = "Waiting for the window to be ready...";
  page?.documentElement.setAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE, "waiting");
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
  // The deadline and close check also cover a fetch, a response body or a
  // reading that stalls.
  // One pending navigation owns a named window even when the user clicks twice.
  const pending = Promise.race([arrive(), stopped]).then((arrival) => {
    if (arrival === "closed" || h.closed) return false;
    if (arrival === "stay") return true;
    h.location.href = url;
    if (page) navigatingDocuments.set(h, page);
    page?.documentElement.setAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE, "navigating");
    return true;
  }).finally(() => {
    clearTimeout(retryTimer);
    clearTimeout(deadline);
    clearInterval(closedPoll);
    controller.abort();
    waitingPages.delete(h);
    // Keep ownership through navigation commit, when the document is replaced.
    if (page?.documentElement.getAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE) === "waiting") {
      page.documentElement.removeAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE);
    }
  });
  waitingPages.set(h, pending);
  return pending;
}

/** Location can still describe the outgoing document until navigation commits.
 * A later refusal document on this window must remain retryable. */
export function isWindowNavigating(h: Window): boolean {
  const page = readableDocument(h);
  if (page && navigatingDocuments.get(h) === page) return true;
  navigatingDocuments.delete(h);
  return false;
}
