// What the page says about a mutation whose outcome it does not know. A
// mutation the server stores and announces runs on in the server's worker
// past the page's answer deadline, so a request that got no answer may have
// been stored: the page says so, never that it failed, and shows what the
// server holds by refreshing at once; the watch frame that announces a stored
// result refreshes the same view again when it lands. Nothing is retried.

import { isUncertainOutcome, type UncertainOutcomeError } from "../api/errors";

/// The sentence for `action` (the caller's own words, as its failure line
/// spells them: "New draft", "delete", "Draft close") when its request got no
/// answer within the deadline.
export function uncertainOutcomeText(action: string, err: UncertainOutcomeError): string {
  return `${action} may have completed: no answer within ${err.timeoutMs / 1000} s`;
}

/// When `err` is an uncertain outcome, run `refresh` at once and answer the
/// sentence for `action`; otherwise null, and the caller says its own failure.
/// `refresh` is null where the announcing frame is the only refresh: a session
/// conflict's overwrite, whose bar the document session sets from its own
/// `conflict` frame, the server's announcement of the overwrite, and a read
/// would set that flag outside the session's mirror.
export function reportUncertainOutcome(
  action: string,
  err: unknown,
  refresh: (() => unknown) | null,
): string | null {
  if (!isUncertainOutcome(err)) return null;
  if (refresh) runRefresh(refresh);
  return uncertainOutcomeText(action, err);
}

function runRefresh(refresh: () => unknown): void {
  try {
    void Promise.resolve(refresh()).catch((e) => {
      console.warn("[chan] refresh after an uncertain mutation failed", e);
    });
  } catch (e) {
    console.warn("[chan] refresh after an uncertain mutation failed", e);
  }
}
