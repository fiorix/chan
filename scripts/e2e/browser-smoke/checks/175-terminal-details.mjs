import assert from "node:assert/strict";
import { join } from "node:path";
import { TERMINAL_SURFACE } from "../lib/terminal-attach.mjs";

const ACTIVE_SURFACE = `.terminal-tab.active ${TERMINAL_SURFACE}`;
const DETAILS = '.terminal-main aside.inspector.right.floating.reserve-space[aria-label="Details"]';

export default {
  name: "terminal-details",
  async run(ctx) {
    const page = await ctx.browser.newPage();
    const errors = [];
    const windowId = `details-175-${Date.now().toString(36)}`;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    page.on("pageerror", error => errors.push(error.message));
    async function waitReady() {
      try {
        await page.waitForSelector('.pane', { timeout: 30_000 });
        await ctx.waitWindowLive(windowId);
        await page.waitForFunction((surface) => {
          const box = document.querySelector(surface)?.getBoundingClientRect();
          return box?.width > 0 && box.height > 0 && window.__detailsState?.id &&
            window.__detailsState.ready && window.__detailsSocket?.readyState === WebSocket.OPEN;
        }, { timeout: 30_000 }, ACTIVE_SURFACE);
      } catch (cause) {
        const error = new Error(`terminal Details setup did not reach routed-window and Ghostty session readiness: ${cause.message}`, { cause });
        error.smokeEnvironment = true;
        throw error;
      }
      return page.evaluate(() => window.__detailsState);
    }
    async function waitEmptyQueue() {
      await page.waitForFunction(() => {
        const queue = document.querySelector('.queue-inspector');
        return queue?.textContent.includes('No queued messages.') && queue.querySelectorAll('li').length === 0;
      }, { timeout: 15_000 });
      assert.deepEqual(await page.$$eval('.queue-inspector pre', els => els.map(el => el.textContent)), []);
    }
    async function waitSavedDetails(open, session) {
      // Reload only after the server holds this terminal and inspector state.
      await page.waitForFunction(async ({ id, auth, open, session }) => {
        const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute('content') ?? '';
        const response = await fetch(`${prefix}/api/session?w=${encodeURIComponent(id)}`, {
          headers: auth ? { authorization: `Bearer ${auth}` } : {},
        });
        if (response.status === 204) return false;
        if (!response.ok) throw new Error(`GET session -> ${response.status}`);
        const terminals = node => !node ? [] : node.k === 's'
          ? [...terminals(node.a), ...terminals(node.b)] : (node.t ?? []).filter(tab => tab.k === 't');
        const tabs = terminals((await response.json()).layout);
        return tabs.length === 1 && tabs[0].n === 'Details smoke' &&
          tabs[0].tsid === session && (tabs[0].o === 1) === open;
      }, { timeout: 20_000, polling: 100 }, { id: windowId, auth: token, open, session });
    }
    try {
      await page.evaluateOnNewDocument(() => {
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            if (String(args[0]).includes('/api/terminal/ws')) {
              window.__detailsSocket = this;
              window.__detailsOutput = '';
              const state = window.__detailsState = { id: null, ready: false, queueDepth: null, queuedIds: null };
              this.addEventListener('message', event => {
                if (event.data instanceof ArrayBuffer) window.__detailsOutput += new TextDecoder().decode(event.data);
                if (typeof event.data !== 'string') return;
                let frame;
                try { frame = JSON.parse(event.data); } catch { return; }
                if (frame.type === 'session') {
                  state.id = frame.id;
                  state.ready = false;
                  state.queueDepth = frame.queue_depth;
                  state.queuedIds = frame.queued_prompt_ids;
                }
                if (frame.type === 'ready') state.ready = true;
                if (frame.type === 'queue') state.queueDepth = frame.depth;
              });
            }
          }
        };
      });
      await page.setViewport({ width: 1440, height: 1000 });
      const url = new URL(ctx.serverUrl);
      url.searchParams.set('w', windowId);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [{ k: "t", n: "Details smoke", a: 1 }] }));
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const original = await waitReady();
      await page.click('.tab.active', { button: 'right' });
      await page.waitForSelector('.terminal-tab-menu-bubble');
      const labels = await page.$$eval('.terminal-tab-menu-bubble .mbtn-label', els => els.map(el => el.textContent.trim()));
      assert.ok(labels.includes('Details'));
      assert.ok(!labels.includes('Program status'));
      assert.deepEqual(await page.$$eval('.terminal-tab-menu-bubble button', buttons => {
        const row = buttons.find(button => button.querySelector('.mbtn-label')?.textContent.trim() === 'Details');
        // The row leads the menu that holds the tab's actions, so what stands before it is what stands before that menu.
        const before = row.previousElementSibling ?? row.closest('[role="menu"]')?.previousElementSibling;
        return [before?.getAttribute('role'), row.nextElementSibling?.getAttribute('role')];
      }), ['separator', 'separator']);
      await page.$$eval('.terminal-tab-menu-bubble button', buttons => buttons.find(button => button.querySelector('.mbtn-label')?.textContent.trim() === 'Details').click());
      await page.waitForSelector(DETAILS, { visible: true, timeout: 15_000 });
      await waitEmptyQueue();
      await page.evaluate(() => window.__detailsSocket.send(JSON.stringify({
        type: 'input', data: `python3 -u -c 'import time; [(print("details queue smoke"), time.sleep(0.1)) for _ in range(300)]'\r`,
      })));
      await page.waitForFunction(() => window.__detailsOutput.includes('details queue smoke\r\n'));
      await page.evaluate(() => {
        for (const [id, data] of [['details-smoke-1', 'First queued message'], ['details-smoke-2', 'Second queued message']]) {
          window.__detailsSocket.send(JSON.stringify({ type: 'prompt', id, data }));
        }
      });
      await page.waitForFunction(() => document.querySelectorAll('.queue-inspector li').length === 2);
      assert.deepEqual(await page.$$eval('.queue-inspector pre', els => els.map(el => el.textContent)), ['First queued message', 'Second queued message']);
      await page.screenshot({ path: join(ctx.outDir, '175-terminal-queued-messages.png') });
      await page.evaluate(() => {
        for (const id of ['details-smoke-1', 'details-smoke-2']) window.__detailsSocket.send(JSON.stringify({ type: 'cancel-prompt', id }));
      });
      await waitEmptyQueue();
      await page.evaluate(() => window.__detailsSocket.send(JSON.stringify({ type: 'input', data: '\u0003' })));
      await waitSavedDetails(true, original.id);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      const reopened = await waitReady();
      assert.equal(reopened.id, original.id, 'open Details reload retains its terminal session');
      assert.equal(reopened.queueDepth, 0);
      assert.deepEqual(reopened.queuedIds, []);
      await page.waitForSelector(DETAILS, { visible: true, timeout: 15_000 });
      await waitEmptyQueue();
      await page.screenshot({ path: join(ctx.outDir, '175-terminal-details.png') });
      await page.focus('.terminal-main [aria-label="Resize Details"]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.terminal-main aside.inspector'));
      await waitSavedDetails(false, original.id);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      const closed = await waitReady();
      assert.equal(closed.id, original.id, 'closed Details reload retains its terminal session');
      assert.equal(closed.queueDepth, 0);
      assert.deepEqual(closed.queuedIds, []);
      assert.equal(await page.$('.terminal-main aside.inspector'), null);
      assert.equal(await page.$('.queue-inspector'), null);
      assert.deepEqual(errors, []);
      return { pass: true, session: original.id, reloads: { reopened, closed }, detail: 'Terminal Details uses the right floating frame, shows real queued messages in FIFO order, removes cancelled messages and preserves open/closed state through reload.' };
    } catch (error) {
      await page.screenshot({ path: join(ctx.outDir, '175-failure.png') }).catch(() => {});
      throw error;
    } finally {
      await page.evaluate(() => {
        if (window.__detailsSocket?.readyState === WebSocket.OPEN) window.__detailsSocket.send(JSON.stringify({ type: 'close' }));
      }).catch(() => {});
      await page.close();
    }
  },
};
