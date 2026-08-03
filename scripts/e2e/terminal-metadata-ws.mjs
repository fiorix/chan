#!/usr/bin/env node

const [url, name, group] = process.argv.slice(2);
const rename = name !== undefined || group !== undefined;

if (!url || (rename && (name === undefined || group === undefined))) {
  console.error("usage: terminal-metadata-ws.mjs URL [NAME GROUP]");
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error("this check requires Node's WebSocket implementation");
  process.exit(2);
}

const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  let session = null;
  let proposed = false;
  let settled = false;

  function closeSocket() {
    try {
      socket.close();
    } catch {}
  }

  const timer = setTimeout(() => {
    fail("terminal metadata WebSocket timed out");
  }, 20_000);

  function finish(value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    closeSocket();
    resolve(value);
  }

  function fail(message) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    closeSocket();
    reject(new Error(message));
  }

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;

    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch (error) {
      fail(`invalid terminal metadata frame: ${error.message}`);
      return;
    }

    if (frame.type === "error") {
      fail(frame.message ?? frame.reason ?? "terminal WebSocket error");
    } else if (frame.type === "session" && !session) {
      session = frame;
      if (!rename) {
        finish({ session });
      } else if (!proposed) {
        proposed = true;
        try {
          socket.send(JSON.stringify({ type: "rename", name, group }));
        } catch (error) {
          fail(`sending terminal metadata rename failed: ${error.message}`);
        }
      }
    } else if (frame.type === "renamed") {
      if (!session) {
        fail("rename acknowledgement preceded the session prelude");
        return;
      }
      finish({ session, renamed: frame });
    } else if (frame.type === "rename_failed") {
      fail(frame.message ?? "terminal metadata rename failed");
    }
  });
  socket.addEventListener("error", () => {
    fail("terminal metadata WebSocket failed");
  });
  socket.addEventListener("close", () => {
    if (!settled) fail("terminal metadata WebSocket closed before settlement");
  });
});

console.log(JSON.stringify(result));
