// Stand-ins for the xterm packages: a terminal that opens, resizes and
// disposes without a canvas. A test that mounts terminals returns these from
// its own mocks, e.g.
//
//   vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
//
// This module imports nothing from the app, so a mock factory can load it
// while the app's own imports are still resolving.

export const xterm = {
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    blur() {}
    dispose() {}
  },
};

export const fit = {
  FitAddon: class {
    fit() {}
  },
};

export const search = { SearchAddon: class {} };

export const serialize = {
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
};

export const webLinks = { WebLinksAddon: class {} };
