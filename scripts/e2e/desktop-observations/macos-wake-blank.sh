#!/usr/bin/env bash
# Read how long each chan-desktop page stayed blank after it came back into
# view on macOS: after a display sleep, a system sleep, or a switch back to
# its Space or its tile. macOS only, and read-only: it queries the unified
# log for what WebKit already recorded and puts nothing to sleep itself.
#
# WebKit hides a webview's content when the view turns visible and shows it
# again on the first layer tree commit from its web process. Both ends are in
# the unified log at the default level, per page:
#   "view visibility state changed 0 -> 1"   (category ViewState)
#   "hideContentUntilPendingUpdate"          (category RemoteLayerTree)
#   "Unhiding layer tree"                    (category RemoteLayerTree)
# The blank is the time from the first to the last, for a page whose content
# was hidden when it turned visible. A page whose content WebKit kept is
# reported as kept.
#
#   macos-wake-blank.sh [--last 15m | --start "YYYY-MM-DD HH:MM:SS"] \
#       [--pid CHAN_DESKTOP_PID] [--limit SECONDS]
#
# --last and --start bound the log query (default --last 15m). --pid keeps
# one chan-desktop process; without it every one in the window is read.
# --limit is the longest blank that passes (default 2).
#
# Exit 0 if every page that turned visible was shown within the limit, 1 if
# one took longer, 3 if no page turned visible in the window, 2 if this is
# not macOS or a tool is missing.
set -euo pipefail

last=15m
start=''
pid=''
limit=2
while [[ $# -gt 0 ]]; do
    case "$1" in
    --last) last=$2; shift 2 ;;
    --start) start=$2; shift 2 ;;
    --pid) pid=$2; shift 2 ;;
    --limit) limit=$2; shift 2 ;;
    *) echo "usage: $0 [--last 15m | --start \"YYYY-MM-DD HH:MM:SS\"] [--pid PID] [--limit SECONDS]" >&2; exit 2 ;;
    esac
done
[[ $(uname -s) == Darwin ]] || { echo "macos-wake-blank: macOS only" >&2; exit 2; }
for tool in log python3; do
    command -v "$tool" >/dev/null || { echo "macos-wake-blank: $tool is required" >&2; exit 2; }
done

predicate='(process == "chan-desktop" AND subsystem == "com.apple.WebKit" AND (
    (category == "ViewState" AND eventMessage CONTAINS "view visibility state changed")
    OR category == "RemoteLayerTree"
    OR (category == "Process" AND eventMessage CONTAINS "runJavaScriptInFrameInScriptWorld: frameID")))
  OR (process == "WindowServer" AND eventMessage CONTAINS "Display:Power" AND eventMessage CONTAINS "Broadcast: Will")'

if [[ -n $start ]]; then
    window=(--start "$start")
else
    window=(--last "$last")
fi

log show --style compact --predicate "$predicate" "${window[@]}" |
    python3 -c '
import bisect, collections, datetime, re, sys

pid_filter, limit = sys.argv[1], float(sys.argv[2])
stamp = lambda text: datetime.datetime.strptime(text, "%Y-%m-%d %H:%M:%S.%f")
head = re.compile(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \S+\s+(\S+?)\[(\d+):")

visible = []                              # (time, app pid, page)
scripts = collections.defaultdict(list)   # (app pid, page) -> script times
areas = collections.defaultdict(list)     # (app pid, drawing area) -> (time, H|U)
power = []                                # (time, Will Sleep|Will Wake)
for line in sys.stdin:
    found = head.match(line)
    if not found:
        continue
    at, process, app = stamp(found.group(1)), found.group(2), found.group(3)
    if process == "WindowServer":
        change = re.search(r"Broadcast: (Will Sleep|Will Wake)", line)
        if change:
            power.append((at, change.group(1)))
        continue
    if pid_filter and app != pid_filter:
        continue
    change = re.search(r"webPageID=(\d+), PID=\d+\].*changed (\d) -> (\d)", line)
    if change:
        if change.group(3) == "1":
            visible.append((at, app, int(change.group(1))))
        continue
    script = re.search(r"webPageID=(\d+)\] WebPage::runJavaScript", line)
    if script:
        scripts[(app, int(script.group(1)))].append(at)
        continue
    area = re.search(r"DrawingAreaProxy\((\d+)\)(.*)", line)
    if area:
        rest = area.group(2)
        kind = "U" if "Unhiding" in rest else None if "completed" in rest else "H"
        if kind:
            areas[(app, int(area.group(1)))].append((at, kind))

# A page and its drawing area are numbered from one counter, the area a few
# after the page, so the area of a page is the next area identifier above it.
by_app = collections.defaultdict(list)
for app, area in areas:
    by_app[app].append(area)
for known in by_app.values():
    known.sort()

def area_of(app, page):
    known = by_app.get(app, [])
    index = bisect.bisect_right(known, page)
    return known[index] if index < len(known) and known[index] - page <= 12 else None

if not visible:
    print("no chan-desktop page turned visible in this window")
    sys.exit(3)

worst = 0.0
print("time                     pid    page   blank    script   after")
for at, app, page in visible:
    area = area_of(app, page)
    events = areas.get((app, area), [])
    index = bisect.bisect_right(events, (at + datetime.timedelta(milliseconds=30), "Z"))
    hidden = index > 0 and events[index - 1][1] == "H"
    before = [change for change in power if change[0] <= at]
    after = ""
    if before:
        after = "%.1f s after %s" % ((at - before[-1][0]).total_seconds(), before[-1][1])
    ran = scripts.get((app, page), [])
    nth = bisect.bisect_left(ran, at)
    script = "%7.2f" % (ran[nth] - at).total_seconds() if nth < len(ran) else "      -"
    if not hidden:
        blank = "   kept"
    else:
        shown = next((event for event in events[index:] if event[1] == "U"), None)
        if shown is None:
            blank = "  never"
            worst = float("inf")
        else:
            seconds = (shown[0] - at).total_seconds()
            worst = max(worst, seconds)
            blank = "%7.2f" % seconds
    print("%s  %-6s %-6d %s  %s  %s" % (at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3], app, page, blank, script, after))

print("longest blank: %s s, limit %s s" % ("never shown" if worst == float("inf") else "%.2f" % worst, limit))
sys.exit(1 if worst > limit else 0)
' "$pid" "$limit"
