// Optional transport-loss matrix for tmux-feed.mjs. Everything this module
// stops is a process from this run or the gateway harness's disposable fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export async function disconnectChecks(ctx) {
  const { work, run, port, until, pass, inspect, api, local, remote, localOrigin,
    base, token, secrets, inspector, here, fixture, gatewayId, server } = ctx;
  const socket = path.join(work, "loss-tmux.sock");
  const children = [];
  const clients = new Set();
  let sshDevserver;
  let ingressPaused = false;
  const log = fs.openSync(path.join(work, "ssh.log"), "a", 0o600);
  const start = (cmd, args) => {
    const child = spawn(cmd, args, { stdio: ["ignore", log, log] });
    children.push(child);
    return child;
  };
  const killClient = (pid) => {
    assert.ok(Number.isInteger(pid) && pid > 1, "owned SSH process id");
    process.kill(pid, "SIGKILL"); clients.delete(pid);
  };
  const card = (name) => `[...document.querySelectorAll('section.machine')].find(c => c.textContent.includes(${JSON.stringify(name)}))`;
  const listPages = async () => {
    const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "list"], { timeout: 15000 });
    return stdout.trim().split("\n").map((line) => JSON.parse(line).text);
  };
  const native = async (ids, present) => {
    const pages = await listPages();
    return ids.every((id) => pages.some((page) => page.includes(`w=${id}`)) === present);
  };
  async function present(owner, name) {
    const record = await until(`${name}: owner record`, async () =>
      (await owner("GET", "/api/library/tmux")).find((r) => r.session?.name === name && r.windows.length));
    const windows = (await owner("GET", "/api/library/windows"))
      .filter((w) => w.tmux?.connection === record.connection && !w.tmux.control).map((w) => w.window_id);
    assert.ok(windows.length, `${name}: pane windows exist on owner`);
    await until(`${name}: desktop record`, async () =>
      (await local("GET", "/api/library/tmux")).some((r) => r.connection === record.connection));
    await until(`${name}: native card`, async () => inspect(`Boolean(${card(name)})`));
    await until(`${name}: native pane windows`, () => native(windows, true), 60000);
    const pattern = `\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`;
    const xids = await until(`${name}: visible X windows`, async () => {
      const { stdout } = await run("xdotool", ["search", "--onlyvisible", "--name", pattern]).catch(() => ({ stdout: "" }));
      const ids = stdout.trim().split(/\s+/).filter(Boolean);
      return ids.length === windows.length ? ids : false;
    });
    for (const id of xids) await run("xdotool", ["getwindowname", id]);
    return { name, connection: record.connection, windows, xids };
  }
  async function absent(connection, label) {
    try {
      const started = Date.now();
      const remaining = () => Math.max(1, 120000 - (Date.now() - started));
      await until(`${label}: desktop record removed`, async () =>
        !(await local("GET", "/api/library/tmux")).some((r) => r.connection === connection.connection), remaining());
      await until(`${label}: card removed`, async () => inspect(`!(${card(connection.name)})`), remaining());
      await until(`${label}: native pane windows closed`, () => native(connection.windows, false), remaining());
      await until(`${label}: X windows destroyed`, async () => {
        const exist = await Promise.all(connection.xids.map((id) => run("xdotool", ["getwindowname", id]).then(() => true, () => false)));
        return exist.every((value) => !value);
      }, remaining());
      await run("xdotool", ["getdisplaygeometry"]);
      assert.ok(!(await local("GET", "/api/library/windows")).some((w) => connection.windows.includes(w.window_id)), "launcher window rows removed");
      await run("tmux", ["-S", socket, "has-session", "-t", connection.name]);
      pass(label, { cleanup_ms: Date.now() - started, native_windows: connection.windows.length, x_windows_destroyed: connection.xids, tmux_survives: true });
    } catch (error) { error.e2eFault = true; throw error; }
  }
  async function attach(owner, origin, name, command, trustSsh = false) {
    console.log(`CHECK: ${name}: attach and show native pane windows`);
    await run("tmux", ["-S", socket, "new-session", "-d", "-s", name, "-n", name, "sleep 1200"]);
    const window = await owner("POST", "/api/library/windows", { kind: "terminal" });
    secrets.push(window.token);
    if (trustSsh) {
      const config = await api(origin, window.token, "GET", `${window.prefix}/api/config`);
      const terminal = { ...config.preferences.terminal, tmux: { enabled: true, trust: ["ssh"] } };
      await api(origin, window.token, "PATCH", `${window.prefix}/api/config`, {
        expected_revision: config.revision, preferences: { terminal },
      });
    }
    await api(origin, window.token, "POST", `${window.prefix}/api/terminals`, {
      name, window_id: window.window_id,
      command: `exec bash -i -c ${quote(`${command(name)}; exec bash`)}`,
    });
    return present(owner, name);
  }
  const tmuxCommand = (name) => `tmux -CC -S ${quote(socket)} attach-session -t ${quote(name)}`;
  const end = (owner, record) => owner("POST", `/api/library/tmux/${record.connection}/request`, { request: "detach" });
  async function connect(id) {
    await local("POST", `/api/library/devservers/${encodeURIComponent(id)}/connect`, {});
    await until("devserver connected", async () =>
      (await local("GET", "/api/library/devservers")).some((d) => d.id === id && d.status === "connected"), 60000);
  }
  const disconnect = (id) => local("POST", `/api/library/devservers/${encodeURIComponent(id)}/disconnect`, {});

  try {
    const sshPort = await port();
    const key = path.join(work, "ssh-key");
    const hostKey = path.join(work, "ssh-host-key");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    const { stdout: username } = await run("id", ["-un"]);
    const config = path.join(work, "sshd.conf");
    fs.writeFileSync(config, `ListenAddress 127.0.0.1\nPort ${sshPort}\nHostKey ${hostKey}\nPidFile ${work}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nAllowUsers ${username.trim()}\nLogLevel ERROR\n`, { mode: 0o600 });
    const { stdout: sshd } = await run("sh", ["-c", "command -v sshd"]);
    start(sshd.trim(), ["-D", "-e", "-f", config]);
    const sshArgs = ["-p", String(sshPort), "-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${work}/known_hosts`, "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=2"];
    const host = `${username.trim()}@127.0.0.1`;
    await until("disposable SSH server", async () => run("ssh", [...sshArgs, host, "true"], { timeout: 5000 }).then(() => true, () => false));
    const sshCommand = sshArgs.map(quote).join(" ");
    const sentinel = await attach(local, localOrigin, "unrelated-local", tmuxCommand);
    const sshCase = async (owner, origin, name) => {
      const pidFile = path.join(work, `${name}.pid`);
      const connection = await attach(owner, origin, name, (session) =>
        `bash -c ${quote(`echo $$ > ${quote(pidFile)}; exec ssh ${sshCommand} -tt ${quote(host)} ${quote(tmuxCommand(session))}`)}`, true);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(pid) && pid > 1);
      clients.add(pid);
      console.log(`CHECK: ${name}: dropping the SSH client`);
      killClient(pid);
      await absent(connection, `${name}: SSH loss removes card and native windows`);
      assert.ok(!(await owner("GET", "/api/library/tmux")).some((r) => r.connection === connection.connection));
    };
    await sshCase(local, localOrigin, "local-ssh-loss");
    await sshCase(remote, base, fixture ? "gateway-ssh-loss" : "devserver-ssh-loss");

    const original = (await local("GET", "/api/library/devservers"))
      .find((d) => fixture ? d.gateway_id === gatewayId : d.label === "tmux-feed-test");
    assert.ok(original);
    if (!fixture) {
      await disconnect(original.id);
      const forward = await port();
      const pidFile = path.join(work, "ssh-forward.pid");
      sshDevserver = await local("POST", "/api/library/devservers", {
        url: `http://127.0.0.1:${forward}`, host: "127.0.0.1", port: forward, label: "tmux-ssh-forward", token,
        script: `echo $$ > ${quote(pidFile)}; exec ssh ${sshCommand} -o ExitOnForwardFailure=yes -N -L 127.0.0.1:${forward}:127.0.0.1:${new URL(base).port} ${quote(host)}`,
      });
      await connect(sshDevserver.id);
      const connection = await attach(remote, base, "ssh-forward-loss", tmuxCommand);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      clients.add(pid);
      killClient(pid);
      await absent(connection, "devserver SSH forwarding loss removes card and native windows");
      assert.ok((await remote("GET", "/api/library/tmux")).some((r) => r.connection === connection.connection));
      await disconnect(sshDevserver.id);
      sshDevserver = null;
      await end(remote, connection);
      await connect(original.id);
    }

    const explicit = await attach(remote, base, "devserver-disconnect", tmuxCommand);
    await disconnect(original.id);
    await absent(explicit, "explicit devserver disconnect removes card and native windows");
    await connect(original.id);
    await present(remote, explicit.name);
    await end(remote, explicit);
    pass("fresh devserver connection restores the surviving tmux session");

    if (fixture) {
      let gateway = await attach(remote, base, "gateway-disconnect", tmuxCommand);
      await local("POST", `/api/library/gateways/${gatewayId}/disconnect`, {});
      await absent(gateway, "explicit gateway disconnect removes card and native windows");
      await local("POST", `/api/library/gateways/${gatewayId}/connect`, {});
      await until("gateway roster restored", async () => (await local("GET", "/api/library/devservers")).some((d) => d.id === original.id));
      await connect(original.id);
      gateway = await present(remote, gateway.name);
      // Freeze the owned TCP ingress: existing sockets become half-open and
      // fresh dials cannot bypass the outage. The feed keepalive must expire.
      process.kill(fixture.ingressPid, "SIGSTOP");
      ingressPaused = true;
      await absent(gateway, "gateway half-open transport removes card and native windows");
      assert.ok((await remote("GET", "/api/library/tmux")).some((r) => r.connection === gateway.connection));
      process.kill(fixture.ingressPid, "SIGCONT");
      ingressPaused = false;
      await present(remote, gateway.name);
      await end(remote, gateway);
      pass("fresh gateway feed restores the surviving tmux session");
    }

    const crash = await attach(remote, base, "devserver-crash", tmuxCommand);
    if (fixture) process.kill(fixture.devserverPid, "SIGKILL");
    else server.kill("SIGKILL");
    await absent(crash, "devserver process loss removes card and native windows");
    await until("unrelated local tmux record survives", async () =>
      (await local("GET", "/api/library/tmux")).some((r) => r.connection === sentinel.connection));
    await until("unrelated local card survives", async () => inspect(`Boolean(${card(sentinel.name)})`));
    await until("unrelated local pane pages survive", () => native(sentinel.windows, true));
    for (const id of sentinel.xids) await run("xdotool", ["getwindowname", id]);
    pass("unrelated local tmux card and native windows survive every remote loss");
    await end(local, sentinel);
  } finally {
    if (ingressPaused) process.kill(fixture.ingressPid, "SIGCONT");
    if (sshDevserver) await disconnect(sshDevserver.id).catch(() => {});
    for (const pid of clients) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const child of children) child.kill("SIGTERM");
    await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
    fs.closeSync(log);
  }
}
