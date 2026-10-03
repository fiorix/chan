export function coalescedLiveRefresh(
  _read: () => Promise<void>,
  _after?: () => void,
): () => Promise<void> {
  return async () => {};
}
