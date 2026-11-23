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
      const open = Terminal.prototype.open;
      const writes = new Map();
      const decoder = new TextDecoder();
      const state = window[key] = {
        terminals: [], notices: [],
        restore() {
          Terminal.prototype.open = open;
          for (const [term, descriptor] of writes) {
            if (descriptor) Object.defineProperty(term, "write", descriptor);
            else delete term.write;
          }
          writes.clear();
          delete window[key];
        },
      };
      Terminal.prototype.open = function (...args) {
        state.terminals.push(this);
        if (notices && !writes.has(this)) {
          writes.set(this, Object.getOwnPropertyDescriptor(this, "write"));
          const write = this.write;
          // A flood evicts local notices before a buffer read can see them.
          this.write = function (data, ...rest) {
            const text = typeof data === "string" ? data : data.length < 256 ? decoder.decode(data) : "";
            for (const match of text.matchAll(/terminal (?:replay missed \d+ bytes|error: [^\r\n]*)/g)) {
              state.notices.push(match[0]);
            }
            return write.call(this, data, ...rest);
          };
        }
        return open.apply(this, args);
      };
      return url;
    }
    return null;
  }, { key, notices });
}
