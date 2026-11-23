// Keep emitted-chunk discovery and prototype instrumentation in one place.
// Callers read their own registry and restore it before the page is reused.
export async function captureGhosttyTerminals(page, key, { notices = false } = {}) {
  return page.evaluate(async ({ key, notices }) => {
    if (window[key]) throw new Error(`Ghostty terminal capture already installed: ${key}`);
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
      if (!name) continue;
      const url = new URL(name, script.src).href;
      const { Terminal } = await import(url);
      // Link wrappers so either restoration order keeps other captures alive.
      const chain = Symbol.for("chan.smoke.capture");
      const wrap = (target, name, wrapper) => {
        wrapper[chain] = { original: target[name], descriptor: Object.getOwnPropertyDescriptor(target, name) };
        target[name] = wrapper;
        return wrapper;
      };
      const unwrap = (target, name, wrapper) => {
        const previous = wrapper[chain];
        if (target[name] === wrapper) {
          if (previous.descriptor) Object.defineProperty(target, name, previous.descriptor);
          else delete target[name];
          return;
        }
        for (let current = target[name]; current?.[chain]; current = current[chain].original) {
          if (current[chain].original !== wrapper) continue;
          current[chain] = { ...previous };
          return;
        }
      };
      const writes = new Map();
      const decoder = new TextDecoder();
      const state = window[key] = {
        terminals: [], notices: [],
        restore() {
          unwrap(Terminal.prototype, "open", open);
          for (const [term, wrapper] of writes) unwrap(term, "write", wrapper);
          writes.clear();
          delete window[key];
        },
      };
      const open = wrap(Terminal.prototype, "open", function (...args) {
        state.terminals.push(this);
        if (notices && !writes.has(this)) {

          // A flood evicts local notices before a buffer read can see them.
          const write = wrap(this, "write", function (data, ...rest) {
            const text = typeof data === "string" ? data : data.length < 256 ? decoder.decode(data) : "";
            for (const match of text.matchAll(/terminal (?:replay missed \d+ bytes|error: [^\r\n]*)/g)) {
              state.notices.push(match[0]);
            }
            return write[chain].original.call(this, data, ...rest);
          });
          writes.set(this, write);
        }
        return open[chain].original.apply(this, args);
      });
      return url;
    }
    return null;
  }, { key, notices });
}
