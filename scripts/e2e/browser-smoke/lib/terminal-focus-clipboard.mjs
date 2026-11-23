// Run inside the page. The native read still runs under the menu gesture;
// only delivery of its answer waits for the controller's release.
export function installHeldClipboard() {
  if (window.__heldClipboard) throw new Error("clipboard hold already installed");
  const clipboard = navigator.clipboard;
  if (typeof clipboard?.readText !== "function") return { available: false, reason: "clipboard.readText is unavailable" };
  const descriptor = Object.getOwnPropertyDescriptor(clipboard, "readText");
  const original = clipboard.readText;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = {
    calls: 0, delivered: 0, nativeStatus: "idle", released: false,
    release() { state.released = true; release(); },
    restore() {
      if (descriptor) Object.defineProperty(clipboard, "readText", descriptor);
      else delete clipboard.readText;
      state.release();
      delete window.__heldClipboard;
    },
  };
  try {
    Object.defineProperty(clipboard, "readText", { configurable: true, writable: true,
      value: async function (...args) {
        state.calls++;
        state.nativeStatus = "pending";
        let text;
        try { text = await original.apply(this, args); state.nativeStatus = "fulfilled"; }
        catch (error) { state.nativeStatus = "rejected"; throw error; }
        await gate;
        state.delivered++;
        return text;
      },
    });
  } catch (error) {
    return { available: false, reason: error.message };
  }
  window.__heldClipboard = state;
  return { available: true };
}

export const readHeldClipboard = (page) => page.evaluate(() => {
  const state = window.__heldClipboard;
  return state ? { calls: state.calls, delivered: state.delivered, nativeStatus: state.nativeStatus, released: state.released } : null;
});
