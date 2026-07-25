#!/usr/bin/env bash
# zone-isolation-probe -- demonstrate the ONE network fact that decides the e2e
# topology: a container can initiate TCP to a SAME-zone peer, but NOT to a
# different-zone peer. The tunnel is `chan devserver` -> `devserver-proxy`
# (client -> server), so the two must share a zone on this host.
#
# These two checks are container-INITIATED to a peer container IP, so they do
# not touch the host's routing and are fully deterministic. The host-involving
# facts are noted below but NOT asserted here, because every sdme zone bridge
# reuses 169.254.0.0/16, which makes host<->container routing ambiguous once
# more than one zone exists (the single-zone e2e is unaffected: one bridge):
#
#   host -> container          : OK in the single-zone e2e (run.sh healthz/200)
#   container -> host TCP       : BLOCKED (host INPUT firewall; ICMP-only),
#                                 verified manually with `ping` vs a TCP connect
#   container -> container same : OK     <- asserted below
#   container -> container cross: BLOCKED <- asserted below
#   -p publish does not bridge zones either.
#
# Net: two separate zones for the tunnel would need host iptables/forwarding
# (root). The e2e's sudo is sdme-only, so it uses one zone, two containers.
# The tunnel still crosses between two separate containers.
set -uo pipefail
SDME="sudo -n sdme"; RFS=chan-e2e-run
say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
res(){ printf '   %-40s %s\n' "$1" "$2"; }
mk(){ $SDME create --name "$1" -r $RFS --network-zone "$2" --started -t 90 >/dev/null 2>&1
  for _ in $(seq 1 20); do $SDME ps 2>/dev/null | grep -qE "^$1[[:space:]].*running" && return 0; sleep 1; done; return 1; }
ipof(){ for _ in $(seq 1 15); do ip=$($SDME exec "$1" -- /usr/bin/hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$ip" ] && { echo "$ip"; return; }; sleep 1; done; }
conn(){ $SDME exec "$1" -- /usr/bin/python3 -c "import socket
try:
 c=socket.create_connection(('$2',$3),timeout=4);print(c.recv(8).decode());c.close()
except Exception as e:print('BLOCKED('+type(e).__name__+')')" 2>&1; }

say "setup: server gw-pa + peer gw-pa2 in zone gw-pz1; gw-pb in zone gw-pz2"
$SDME rm -f gw-pa gw-pa2 gw-pb >/dev/null 2>&1 || true
mk gw-pa gw-pz1 && mk gw-pa2 gw-pz1 && mk gw-pb gw-pz2 || { echo "create failed"; exit 1; }
ipA=$(ipof gw-pa); ipof gw-pa2 >/dev/null; ipof gw-pb >/dev/null
# listener in gw-pa, confirmed reachable from its same-zone peer below
$SDME exec gw-pa -- /usr/bin/systemd-run --unit=lst --collect /usr/bin/python3 -c "import socket
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',9001));s.listen(8)
while True:
 c,a=s.accept();c.sendall(b'OK');c.close()" >/dev/null 2>&1
sleep 3

say "container-initiated TCP to a peer container (gw-pa=$ipA:9001)"
res "same-zone  gw-pa2 -> gw-pa  (z1->z1)" "$(conn gw-pa2 "$ipA" 9001)"
res "cross-zone gw-pb  -> gw-pa  (z2->z1)" "$(conn gw-pb "$ipA" 9001)"

say "conclusion: tunnel needs SAME zone; two zones would need host iptables (root)."
$SDME rm -f gw-pa gw-pa2 gw-pb >/dev/null 2>&1 || true
