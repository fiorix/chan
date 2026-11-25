type ReplayMaskBatch = {
  ready: boolean;
  scanAll: () => void;
};

/// Coalesces secret-mask work while an attach replay is being parsed.
///
/// The server's `ready` frame can arrive while xterm still has replay writes
/// queued. The whole-buffer scan therefore waits for both `ready` and the last
/// tracked replay callback. A live write needs no scan of its own: the masker
/// follows the widget's change event.
export class ReplayMaskScanBatch {
  #active: ReplayMaskBatch | null = null;
  #pendingReplayWrites = 0;
  #lifecycle = 0;

  begin(scanAll: () => void): void {
    // Do not clear pending writes here. A reconnect can start a new attach
    // while callbacks from the abandoned socket are still ahead in the same
    // xterm queue; the newest batch's final scan must wait for those too.
    this.#active = { ready: false, scanAll };
  }

  ready(): void {
    const batch = this.#active;
    if (!batch) return;
    batch.ready = true;
    this.#flush(batch);
  }

  /// Tracks one PTY write; the returned callback is run once it is parsed.
  /// A replay write holds the batch's whole-buffer scan until then; any
  /// other write holds nothing.
  track(replay: boolean): () => void {
    const batch = replay ? this.#active : null;
    if (!batch) return () => {};

    const lifecycle = this.#lifecycle;
    this.#pendingReplayWrites += 1;
    return this.#once(() => {
      if (lifecycle !== this.#lifecycle) return;
      this.#pendingReplayWrites -= 1;
      this.#flush(this.#active);
    });
  }

  reset(): void {
    this.#lifecycle += 1;
    this.#active = null;
    this.#pendingReplayWrites = 0;
  }

  #flush(batch: ReplayMaskBatch | null): void {
    if (
      !batch ||
      batch !== this.#active ||
      !batch.ready ||
      this.#pendingReplayWrites !== 0
    ) {
      return;
    }
    this.#active = null;
    batch.scanAll();
  }

  #once(callback: () => void): () => void {
    let pending = true;
    return () => {
      if (!pending) return;
      pending = false;
      callback();
    };
  }
}
