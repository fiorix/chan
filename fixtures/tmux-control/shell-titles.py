#!/usr/bin/python3 -I
"""Record the pane names subscription while a shell titles its panes: `shell-titles.py <tmux> <out dir>`."""
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time

TMUX, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
os.chdir(OUT)
env = {"PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "C.UTF-8", "HOME": OUT, "USER": "user"}
SOCK = f"chan-fixture-{os.getpid()}"
FORMAT = "#{==:#{pane_title},#{host}} #{n:pane_current_command} #{n:pane_title} #{pane_current_command} #{pane_title}"

# The prompt hook Arch's /etc/bash.bashrc installs in a tmux or xterm
# terminal: every prompt titles the pane user@host:dir with OSC 0.
RC = f"{OUT}/titled.bashrc"
with open(RC, "w") as rc:
    rc.write("unset PROMPT_COMMAND\n")
    rc.write("PS1='$ '\n")
    rc.write("PROMPT_COMMAND='printf \"\\033]0;%s@%s:%s\\007\" \"${USER}\" \"${HOSTNAME%%.*}\" \"${PWD/#$HOME/\\~}\"'\n")
SHELL = f"bash --noprofile --rcfile {RC} -i"

# 15: two panes of one window whose shell titles them at every prompt; one
# runs top under that title (watching one process, so its screen stays
# short) and quits it, the other changes directory.
STEPS = [
    (1.3, f"refresh-client -B 'chan-pane-name:%*:{FORMAT}'\n".encode()),
    (1.3, f"split-window -h -t %0 \"{SHELL}\"\n".encode()),
    (2.3, b"send-keys -t %1 'top -d 10 -p 1' Enter\n"),
    (1.3, b"send-keys -t %0 'cd /tmp' Enter\n"),
    (1.3, b"send-keys -t %1 q\n"),
    (0.6, b"\n"),
]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(TMUX, [TMUX, "-L", SOCK, "-f", "/dev/null", "-CC", "new-session", "-s", "m1", SHELL], env)
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


pump(1.2)
for delay, data in STEPS:
    os.write(fd, data)
    pump(delay)
subprocess.run([TMUX, "-L", SOCK, "kill-server"], env=env, capture_output=True)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
os.remove(RC)
open(f"{OUT}/15-shell-titles.raw", "wb").write(bytes(buf))
print(f"15-shell-titles: {len(buf)} bytes")
