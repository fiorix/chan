import assert from "node:assert/strict";
import { installSizeObserver } from "./terminal-size-page.mjs";

class FakeSocket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = FakeSocket.OPEN; }
  addEventListener() {}
  send() {}
}

globalThis.window = { WebSocket: FakeSocket };
globalThis.document = { querySelector: () => null };
globalThis.location = { href: "http://localhost/" };
globalThis.CSS = { escape: (value) => value };
installSizeObserver();
try {
  new window.WebSocket("ws://localhost/api/terminal/ws?tab_name=root&tab_id=root-tab");
  new window.WebSocket("ws://localhost/workspace-one/api/terminal/ws?tab_name=native&tab_id=native-tab");
  new window.WebSocket("ws://localhost/api/other/ws?tab_name=other&tab_id=other-tab");
  const attaches = window.__terminalSizeObserver.drain().records.filter((record) => record.kind === "attach");
  assert.deepEqual(attaches.map((record) => record.view.name), ["root", "native"]);
  assert.deepEqual(window.__terminalSizeObserver.snapshot().map((view) => view.tab), ["root-tab", "native-tab"]);
  console.log(JSON.stringify({ rootSocket: "observed", prefixedSocket: "observed", otherSocket: "ignored" }));
} finally {
  window.__terminalSizeObserver.stop();
}
