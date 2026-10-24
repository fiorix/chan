import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fetchWindows, goto, killChild, mask, poll, spawnDevserver } from "../lib/launcher-devserver.mjs";

const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const INPUT = `${LAUNCHER} input[role="combobox"]`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function launcherOpen(page, target) {
  await page.bringToFront();
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForSelector(INPUT, { timeout: 30_000 });
  await page.type(INPUT, `Open ${target}`);
  await page.waitForSelector(`${LAUNCHER} [role="option"]`, { timeout: 30_000 });
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/api/open"),
    { timeout: 30_000 },
  );
  await page.keyboard.press("Enter");
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, `launcher Open refused: ${JSON.stringify(body)}`);
  assert.equal(typeof body.window, "string", "routed reply names its destination window");
  await page.waitForFunction(
    (message) => document.querySelector(".status-msg")?.textContent?.trim() === message,
    { timeout: 30_000 },
    body.message,
  );
  return body;
}

export default {
  name: "launcher-open-routed",
  async run(ctx) {
    assert.ok(existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html")), "launcher bundle is required");
    const fixture = mkdtempSync(join(tmpdir(), "chan-routed-open-"));
    const chanHome = join(fixture, "home");
    const workspace = join(fixture, "workspace");
    mkdirSync(chanHome);
    mkdirSync(workspace);
    const outside = join(fixture, "outside.txt");
    const contents = "routed outside file visible in its standalone editor";
    writeFileSync(outside, `${contents}\n`);
    const devserver = spawnDevserver(ctx.chanBin, chanHome);
    const popups = [];
    let source = null;
    let destination = null;
    let cdp = null;
    try {
      const launchUrl = new URL(await devserver.url);
      const origin = launchUrl.origin;
      const token = launchUrl.searchParams.get("t");
      assert.ok(token, "devserver URL carries its management token");
      const request = async (url, bearer, body, expectedStatus = 200) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const result = await response.json();
        assert.equal(response.status, expectedStatus, `fixture request refused: ${mask(JSON.stringify(result))}`);
        return result;
      };
      await request(`${origin}/api/library/workspaces`, token, { path: workspace });
      const record = await request(`${origin}/api/library/windows`, token, {
        kind: "workspace", workspace_path: workspace, origin: "browser",
      });
      const sourceUrl = new URL(`${record.prefix}/`, origin);
      sourceUrl.searchParams.set("w", record.window_id);
      sourceUrl.searchParams.set("t", record.token);
      sourceUrl.searchParams.set("lib", "local");
      sourceUrl.searchParams.set("h", "routed-open-source");
      source = await ctx.browser.newPage();
      source.on("popup", (page) => popups.push(page));
      await goto(source, sourceUrl.toString());
      await source.waitForSelector(".pane", { timeout: 30_000 });
      // This check owns a different devserver from ctx.waitWindowLive's
      // server. Its library feed reads that tenant's live session registry.
      // HTTP Open admission and the PTY's cs command need this window to be
      // addressable; a rendered pane alone does not establish that.
      const waitLive = (windowId) => poll(`hosted window ${windowId} connected`, async () => {
        const row = (await fetchWindows(origin, token)).find((item) => item.window_id === windowId);
        return row?.connected ? row : null;
      });
      await waitLive(record.window_id);
      const initialTerminalIds = (await fetchWindows(origin, token))
        .filter((row) => row.kind === "terminal").map((row) => row.window_id);

      const first = await launcherOpen(source, outside);
      assert.notEqual(first.window, record.window_id);
      assert.ok(!initialTerminalIds.includes(first.window), "first routed open mints its standalone window");
      const wirePath = outside.replace(/^\/+/, "");
      const acknowledgment = `open request queued for ${wirePath} in standalone window ${first.window}`;
      assert.equal(first.message, `${acknowledgment} (opening)`);
      destination = await poll("routed popup", () => popups.find((page) =>
        new URL(page.url()).searchParams.get("w") === first.window));
      await destination.waitForSelector(".pane", { timeout: 30_000 });
      const destinationRecord = await waitLive(first.window);
      assert.equal(destinationRecord.kind, "terminal");
      assert.equal(destinationRecord.origin, "browser");
      await destination.waitForFunction(
        (name, text) => [...document.querySelectorAll(".tab")].some((tab) => tab.textContent?.includes(name)) &&
          document.body.innerText.includes(text),
        { timeout: 30_000 },
        basename(outside), contents,
      );
      await ctx.shot("routed-file-editor", destination);

      // Observe a new command for each reuse so an already-open editor
      // cannot conceal a request that acknowledged without delivering.
      const opens = [];
      cdp = await destination.createCDPSession();
      await cdp.send("Network.enable");
      cdp.on("Network.webSocketFrameReceived", ({ response }) => {
        if (response.opcode !== 1) return;
        let frame;
        try { frame = JSON.parse(response.payloadData); } catch { return; }
        if (frame.type === "window_command" && frame.command === "open_file") opens.push(frame);
      });
      const expectDelivery = async (count) => {
        await poll(`routed delivery ${count}`, () => opens.length >= count);
        assert.equal(opens.length, count);
        assert.equal(opens[count - 1].window_id, first.window);
        assert.equal(opens[count - 1].path, wirePath);
      };

      // The server spawns this command as a real PTY owned by the source
      // window, supplying its own control socket and window environment.
      const receipt = join(fixture, "cs-open");
      const command = [
        `printf '%s' "$CHAN_WINDOW_ID" > ${quote(`${receipt}.window`)}`,
        `${quote(ctx.chanBin)} shell open ${quote(outside)} > ${quote(`${receipt}.out`)} 2> ${quote(`${receipt}.err`)}`,
        `printf '%s' "$?" > ${quote(`${receipt}.status`)}`,
      ].join("; ");
      await waitLive(record.window_id);
      await request(new URL(`${record.prefix}/api/terminals`, origin), record.token, {
        name: "routed-open-cs", command, window_id: record.window_id,
      }, 201);
      await poll("cs open receipt", () => existsSync(`${receipt}.status`) &&
        readFileSync(`${receipt}.status`, "utf8").length > 0);
      const cliReceipt = Object.fromEntries(["status", "window", "out", "err"]
        .map((field) => [field, readFileSync(`${receipt}.${field}`, "utf8")]));
      writeFileSync(join(ctx.outDir, "routed-open-cli-receipt.json"), JSON.stringify(cliReceipt, null, 2));
      assert.equal(cliReceipt.status, "0", cliReceipt.err);
      assert.equal(cliReceipt.window, record.window_id);
      assert.equal(cliReceipt.out, "", "queued-request acknowledgments use stderr");
      const cliAcknowledgment = cliReceipt.err.trim();
      assert.equal(cliAcknowledgment, acknowledgment);
      await expectDelivery(1);

      const second = await launcherOpen(source, outside);
      assert.deepEqual(second, { message: cliAcknowledgment, window: first.window });
      await expectDelivery(2);
      const terminalIds = (await fetchWindows(origin, token))
        .filter((row) => row.kind === "terminal").map((row) => row.window_id).sort();
      assert.deepEqual(terminalIds, [...initialTerminalIds, first.window].sort());
      assert.equal(popups.length, 1, "repeated opens reuse the one popup");
      assert.equal(readFileSync(outside, "utf8"), `${contents}\n`);
      await ctx.shot("routed-status", source);
      return {
        sourceWindow: record.window_id, destinationWindow: first.window,
        firstAcknowledgment: first.message, cliAcknowledgment,
        secondAcknowledgment: second.message, reuseDeliveries: opens.length, popups: popups.length,
      };
    } catch (error) {
      if (source) await ctx.shot("routed-source-failure", source).catch(() => {});
      if (destination) await ctx.shot("routed-destination-failure", destination).catch(() => {});
      throw error;
    } finally {
      if (cdp) await cdp.detach().catch(() => {});
      for (const popup of popups) await popup.close().catch(() => {});
      if (source) await source.close().catch(() => {});
      await killChild(devserver.child);
      rmSync(fixture, { recursive: true, force: true });
    }
  },
};
