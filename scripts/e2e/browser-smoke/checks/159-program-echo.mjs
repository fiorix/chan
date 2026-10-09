import assert from "node:assert/strict";
import { runPtyPython, withProgramStatusTabs } from "../lib/program-status.mjs";

const reader = String.raw`
import json
import os
import pathlib
import select
import sys
import termios
import time

fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
assert saved[3] & termios.ECHO
assert not saved[3] & termios.ECHOCTL

def set_reader(echoctl):
    mode = termios.tcgetattr(fd)
    mode[3] &= ~termios.ICANON
    mode[3] |= termios.ECHO
    if echoctl:
        mode[3] |= termios.ECHOCTL
    else:
        mode[3] &= ~termios.ECHOCTL
    mode[6][termios.VMIN] = 1
    mode[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, mode)

def read_for(seconds):
    data = bytearray()
    deadline = time.monotonic() + seconds
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
    return data.hex()

try:
    set_reader(False)
    os.write(sys.stdout.fileno(), b"\x1b]7501;?\x1b\\")
    suppressed = read_for(1.2)
    os.write(sys.stdout.fileno(), b"\x1b[6n")
    control = read_for(2.5)
    set_reader(True)
    os.write(sys.stdout.fileno(), b"\x1b]7501;?\x1b\\")
    default = read_for(2.5)
finally:
    termios.tcsetattr(fd, termios.TCSANOW, saved)
pathlib.Path(sys.argv[1]).write_text(json.dumps({"suppressed": suppressed, "control": control, "default": default}))
`;

export default {
  name: "program status: echo loop is suppressed while normal replies still work",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "159", async (tab) => {
      const command = `stty echo -echoctl\n`;
      await tab.cs(["write", "--tab-name", tab.subject, command]);
      const result = JSON.parse((await runPtyPython(ctx, tab, "echo", reader)).toString());
      const suppressed = Buffer.from(result.suppressed, "hex");
      const control = Buffer.from(result.control, "hex");
      const normal = Buffer.from(result.default, "hex");
      assert.equal(suppressed.length, 0, "echo on with ECHOCTL off sends no byte to PTY input");
      assert.match(control.toString("latin1"), /\x1b\[[0-9]+;[0-9]+R/, "CSI 6 n answer reaches the same PTY reader");
      assert.deepEqual(normal, Buffer.from("\x1b]7501;?\x1b\\"), "default ECHOCTL sends exactly one 7501 reply");
      await tab.sendReport("state=working:id=after-echo");
      await tab.wait("after-echo-report", (state) =>
        state.row.program_status?.records?.some((record) => record.id === "after-echo" && record.state === "working") &&
        state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          frame.program_status?.records?.some((record) => record.id === "after-echo" && record.state === "working")));
      await tab.cs(["write", "--tab-name", tab.subject, "stty sane\n"]);
    });
  },
};
