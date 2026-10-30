#!/usr/bin/python3 -I
"""Drive `tmux -CC` over a PTY and record the raw byte stream per scenario."""
import os, pty, select, signal, sys, time, json, subprocess

TMUX = "/opt/tmuxbundle/tmux"
OUT = "/root/cap"
os.makedirs(OUT, exist_ok=True)
env = dict(os.environ, TERM="xterm-256color", LANG="C.UTF-8", HOME="/root")


def run(name, steps, sock, args=("-CC", "new-session", "-s", "m1"), tail=1.0):
    """steps: list of (delay, bytes | callable). Returns raw bytes read."""
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(TMUX, [TMUX, "-L", sock, *args], env)
    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    buf = bytearray()
    exit_status = None

    def pump(t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return False
                if not d:
                    return False
                buf.extend(d)
        return True

    alive = pump(0.8)
    for delay, data in steps:
        if not alive:
            break
        if callable(data):
            data()
        else:
            os.write(fd, data)
        alive = pump(delay)
    if alive:
        pump(tail)
    try:
        wp, st = os.waitpid(pid, os.WNOHANG)
        if wp == 0:
            os.kill(pid, signal.SIGKILL)
            wp, st = os.waitpid(pid, 0)
            exit_status = "killed-by-harness"
        else:
            exit_status = os.waitstatus_to_exitcode(st)
    except ChildProcessError:
        pass
    open(f"{OUT}/{name}.raw", "wb").write(bytes(buf))
    print(f"{name}: {len(buf)} bytes, child={exit_status}")
    return bytes(buf)


def tm(sock, *a):
    return subprocess.run([TMUX, "-L", sock, *a], env=env, capture_output=True)


# 1: entry, one command, graceful detach by empty line.
run("01-entry-detach", [(0.5, b"list-windows\n"), (0.5, b"display-message -p '#{version}'\n"), (0.5, b"\n")], "s1")
tm("s1", "kill-server")

# 2: output escaping. Print ESC, backslash, NUL, UTF-8, non-BMP, CR/LF.
run("02-output-escape", [
    (0.5, b"send-keys -t %0 \"printf 'A\\\\\\\\B\\\\033[1mC\\\\000D\\\\303\\\\251 \\\\360\\\\237\\\\230\\\\200 E\\\\r\\\\nF\\\\n'\" Enter\n"),
    (1.0, b"\n"),
], "s2")
tm("s2", "kill-server")

# 3: splits, layout-change and checksum, new-window, resize, rename.
run("03-layout", [
    (0.4, b"refresh-client -C 120,40\n"),
    (0.4, b"split-window -h -t %0\n"),
    (0.4, b"split-window -v -t %1\n"),
    (0.4, b"new-window -PF '#{window_id}'\n"),
    (0.4, b"rename-window -t @1 hello\n"),
    (0.4, b"list-windows -F '#{window_id} #{window_layout} #{window_flags} #{window_visible_layout}'\n"),
    (0.4, b"refresh-client -C 100,30\n"),
    (0.4, b"kill-window -t @1\n"),
    (0.4, b"\n"),
], "s3")
tm("s3", "kill-server")

# 3b: tmux 3.8 JSON layouts.
run("03b-new-layouts", [
    (0.4, b"refresh-client -f new-layouts\n"),
    (0.4, b"split-window -h -t %0\n"),
    (0.4, b"list-windows -F '#{window_id} #{window_layout}'\n"),
    (0.4, b"\n"),
], "s3b")
tm("s3b", "kill-server")

# 4: capture-pane history restore, with a line holding a backslash and a control char.
run("04-capture", [
    (0.4, b"send-keys -t %0 \"printf 'x\\\\\\\\y\\\\033[31mred\\\\033[0m\\\\n'; seq 1 30\" Enter\n"),
    (0.8, b"capture-pane -peqJ -t %0 -S -50\n"),
    (0.4, b"capture-pane -p -P -C -t %0\n"),
    (0.4, b"list-panes -t %0 -F '#{cursor_x} #{cursor_y} #{pane_in_mode} #{alternate_on} #{scroll_region_upper} #{scroll_region_lower}'\n"),
    (0.4, b"\n"),
], "s4")
tm("s4", "kill-server")

# 5: pause-after flow control with heavy output.
run("05-pause", [
    (0.4, b"refresh-client -f pause-after=1\n"),
    (0.4, b"send-keys -t %0 'seq 1 200000' Enter\n"),
    (2.0, b""),
    (0.4, b"refresh-client -A '%0:continue'\n"),
    (1.0, b""),
    (0.4, b"\n"),
], "s5", tail=2.0)
tm("s5", "kill-server")

# 6: %exit inside a reply block (capture-pane of a pane that printed '%exit').
run("06-exit-in-block", [
    (0.4, b"send-keys -t %0 'echo %exit; echo %end' Enter\n"),
    (0.8, b"capture-pane -p -t %0\n"),
    (0.4, b"\n"),
], "s6")
tm("s6", "kill-server")

# 7: server death while attached: kill-server from outside; and SIGKILL of server pid.
run("07-kill-server", [
    (0.4, lambda: tm("s7", "kill-server")),
    (1.0, b""),
], "s7")

def killpid():
    pid = tm("s8", "display-message", "-p", "#{pid}").stdout.strip()
    os.kill(int(pid), signal.SIGKILL)

run("08-sigkill-server", [(0.4, killpid), (1.0, b"")], "s8")
subprocess.run(["pkill", "-f", "tmux.bin"])

# 9: reattach to an existing session (second client), and attach to a missing one.
tm("s9", "new-session", "-d", "-s", "m1")
run("09-reattach", [(0.5, b"list-sessions\n"), (0.4, b"\n")], "s9", args=("-CC", "attach", "-t", "m1"))
run("10-attach-missing", [(0.5, b"")], "s9x", args=("-CC", "attach", "-t", "nope"))
tm("s9", "kill-server")

# 11: bad command and error block.
run("11-error", [(0.4, b"no-such-command\n"), (0.4, b"\n")], "s11")
tm("s11", "kill-server")

# 12: wire after %exit: does anything follow ST?
run("12-after-exit", [(0.4, b"detach-client\n"), (1.0, b"")], "s12")
tm("s12", "kill-server")
