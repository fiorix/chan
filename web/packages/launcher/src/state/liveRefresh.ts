export function coalescedLiveRefresh(
  read: () => Promise<void>,
  after?: () => void,
): () => Promise<void> {
  let refreshing = false;
  let pending = false;
  return async () => {
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      do {
        pending = false;
        await read();
      } while (pending);
      after?.();
    } catch {
      // A later feed signal retries a failed best-effort read.
    } finally {
      refreshing = false;
    }
  };
}
