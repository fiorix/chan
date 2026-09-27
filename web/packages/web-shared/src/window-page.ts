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

function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return WINDOW_PAGE_RETRY_MIN_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(WINDOW_PAGE_WAIT_MS, Math.max(WINDOW_PAGE_RETRY_MIN_MS, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(WINDOW_PAGE_WAIT_MS, Math.max(WINDOW_PAGE_RETRY_MIN_MS, date - Date.now())) : WINDOW_PAGE_RETRY_MIN_MS;
}

export function navigateWindowWhenReady(h: Window, url: string, checkPage: WindowPageCheck): Promise<boolean> {
  const waiting = waitingPages.get(h);
  if (waiting) return waiting;
  if (h.closed) return Promise.resolve(false);
  const page = h.document;
  // Other opener pages have their own module state but share this document.
  if (page.documentElement.hasAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE)) {
    h.focus?.();
    return Promise.resolve(true);
  }
  page.body.textContent = "Waiting for the window to be ready...";
  page.documentElement.setAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE, "waiting");
  const controller = new AbortController();
  let lastRefusal: Error = new Error("Timed out waiting for the window page");
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closedPoll: ReturnType<typeof setInterval> | undefined;
  const stopped = new Promise<boolean>((resolve, reject) => {
    deadline = setTimeout(() => reject(lastRefusal), WINDOW_PAGE_WAIT_MS);
    closedPoll = setInterval(() => {
      if (h.closed) resolve(false);
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
  // The deadline and close check also cover a fetch or response body that stalls.
  // One pending navigation owns a named window even when the user clicks twice.
  const pending = Promise.race([check(), stopped]).then((ready) => {
    if (!ready || h.closed) return false;
    h.location.href = url;
    navigatingDocuments.set(h, page);
    page.documentElement.setAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE, "navigating");
    return true;
  }).finally(() => {
    clearTimeout(retryTimer);
    clearTimeout(deadline);
    clearInterval(closedPoll);
    controller.abort();
    waitingPages.delete(h);
    // Keep ownership through navigation commit, when the document is replaced.
    if (page.documentElement.getAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE) === "waiting") {
      page.documentElement.removeAttribute(WINDOW_PAGE_OWNER_ATTRIBUTE);
    }
  });
  waitingPages.set(h, pending);
  return pending;
}

/** Location can still describe the outgoing document until navigation commits.
 * A later refusal document on this window must remain retryable. */
export function isWindowNavigating(h: Window): boolean {
  if (navigatingDocuments.get(h) === h.document) return true;
  navigatingDocuments.delete(h);
  return false;
}
