#!/usr/bin/python3 -I
"""Record the pane names subscription over a PTY: `pane-names.py <tmux> <out dir>`."""
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time

TMUX, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
env = {"PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "C.UTF-8", "HOME": OUT}
SOCK = f"chan-fixture-{os.getpid()}"
FORMAT = "#{==:#{pane_title},#{host}} #{n:pane_current_command} #{n:pane_title} #{pane_current_command} #{pane_title}"

# 14: two panes of one window, each named at tmux's once-a-second look: a
# default title, a title a program set, a window rename, an emptied title.
STEPS = [
    (1.3, f"refresh-client -B 'chan-pane-name:%*:{FORMAT}'\n".encode()),
    (1.3, b"split-window -h -t %0 sh\n"),
    (1.3, b"send-keys -t %1 \"printf '\\\\033]2;build log\\\\007'\" Enter\n"),
    (1.3, b"rename-window -t @0 renamed\n"),
    (1.3, b"send-keys -t %1 \"printf '\\\\033]2;\\\\007'\" Enter\n"),
    (0.6, b"\n"),
]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(TMUX, [TMUX, "-L", SOCK, "-f", "/dev/null", "-CC", "new-session", "-s", "m1", "sh"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
buf = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            buf.extend(data)


pump(0.8)
for delay, data in STEPS:
    os.write(fd, data)
    pump(delay)
subprocess.run([TMUX, "-L", SOCK, "kill-server"], env=env, capture_output=True)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
open(f"{OUT}/14-pane-names.raw", "wb").write(bytes(buf))
print(f"14-pane-names: {len(buf)} bytes")
