import type { IEvent } from './interfaces';

export class EventEmitter<T> {
  #listeners: Array<(arg: T) => void> = [];

  fire(arg: T): void {
    // A listener may dispose its subscription while handling the event.
    for (const listener of [...this.#listeners]) {
      listener(arg);
    }
  }

  event: IEvent<T> = (listener) => {
    this.#listeners.push(listener);
    return {
      dispose: () => {
        const index = this.#listeners.indexOf(listener);
        if (index >= 0) {
          this.#listeners.splice(index, 1);
        }
      },
    };
  };

  dispose(): void {
    this.#listeners = [];
  }
}
