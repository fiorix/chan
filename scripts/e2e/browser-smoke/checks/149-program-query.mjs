import assert from "node:assert/strict";
import { runPtyPython, withProgramStatusTabs } from "../lib/program-status.mjs";

const reader = String.raw`
import os
import pathlib
import select
import sys
import termios
import time
import tty

fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
data = bytearray()
try:
    tty.setraw(fd)
    os.write(sys.stdout.fileno(), b"\x1b]7501;?\x07\x1b]7501;?\x1b\\\x1b[c")
    deadline = time.monotonic() + 5
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            break
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        data.extend(chunk)
finally:
    termios.tcsetattr(fd, termios.TCSANOW, saved)
pathlib.Path(sys.argv[1]).write_bytes(data)
`;

export default {
  name: "program status: a PTY program gets one reply per query before device attributes",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "149", async (tab) => {
      const data = await runPtyPython(ctx, tab, "query", reader);
      const input = data.toString("latin1");
      const device = /\x1b\[\?[0-9;]*c/.exec(input);
      assert.ok(device, `${tab.backend} device-attributes reply reached the PTY reader: ${data.toString("hex")}`);
      const replies = [...input.matchAll(/\x1b\]7501;[^\x07\x1b]*(?:\x07|\x1b\\)/g)].map((match) => match[0]);
      assert.deepEqual(replies, ["\x1b]7501;?\x07", "\x1b]7501;?\x1b\\"], "one byte-exact reply for each terminator");
      assert.ok(input.indexOf(replies[1]) < device.index, "both 7501 replies precede the engine's CSI c answer");
      await ctx.shot(`${tab.backend}-query-answers`, tab.page);
    });
  },
};
