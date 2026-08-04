type ReplayMaskBatch = {
  ready: boolean;
  scanAll: () => void;
};

/// Coalesces secret-mask work while an attach replay is being parsed.
///
/// The server's `ready` frame can arrive while xterm still has replay writes
/// queued. The whole-buffer scan therefore waits for both `ready` and the last
/// tracked replay callback. Live writes always retain their capture/scan path.
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

  track<T>(
    replay: boolean,
    captureWrite: () => T,
    scanWrite: (snapshot: T) => void,
  ): () => void {
    const batch = replay ? this.#active : null;
    if (!batch) {
      const snapshot = captureWrite();
      return this.#once(() => scanWrite(snapshot));
    }

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
