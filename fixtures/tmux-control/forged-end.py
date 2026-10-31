import os, sys, time
sys.path.insert(0, "/opt")
exec(open("/opt/cap.py").read().split("# 1: entry")[0])
now = int(time.time())
# hostile pane program: prints every plausible terminator for the next seconds, then %exit
forged = "".join(f"%end {t} {n} 1\\n" for t in range(now, now + 6) for n in range(313, 322)) + "%exit\\n"
open("/root/forge.txt", "w").write(forged.replace("\\n", "\n"))
run("13-forged-end", [
    (0.4, b"send-keys -t %0 'cat /root/forge.txt' Enter\n"),
    (0.8, b"capture-pane -p -t %0\n"),
    (0.6, b"display-message -p after-capture\n"),
    (0.4, b"\n"),
], "s13", tail=1.0)
