import assert from "node:assert/strict";
import { join } from "node:path";

export default {
  name: "terminal-details",
  async run(ctx) {
    const page = await ctx.browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.evaluateOnNewDocument(() => {
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            if (String(args[0]).includes('/api/terminal/ws')) {
              window.__detailsSocket = this;
              window.__detailsOutput = '';
              this.addEventListener('message', event => {
                if (event.data instanceof ArrayBuffer) window.__detailsOutput += new TextDecoder().decode(event.data);
              });
            }
          }
        };
      });
      await page.setViewport({ width: 1440, height: 1000 });
      const url = new URL(ctx.serverUrl);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [{ k: "t", n: "Details smoke", a: 1 }] }));
      await page.goto(url.href, { waitUntil: "networkidle0" });
      await page.waitForSelector('.terminal-host canvas');
      await page.click('.tab.active', { button: 'right' });
      await page.waitForSelector('.terminal-tab-menu-bubble');
      const labels = await page.$$eval('.terminal-tab-menu-bubble .mbtn-label', els => els.map(el => el.textContent.trim()));
      assert.ok(labels.includes('Details'));
      assert.ok(!labels.includes('Program status'));
      assert.deepEqual(await page.$$eval('.terminal-tab-menu-bubble button', buttons => {
        const row = buttons.find(button => button.querySelector('.mbtn-label')?.textContent.trim() === 'Details');
        return [row.previousElementSibling?.getAttribute('role'), row.nextElementSibling?.getAttribute('role')];
      }), ['separator', 'separator']);
      await page.$$eval('.terminal-tab-menu-bubble button', buttons => buttons.find(button => button.querySelector('.mbtn-label')?.textContent.trim() === 'Details').click());
      await page.waitForSelector('.terminal-main aside.inspector.right.floating.reserve-space[aria-label="Details"]');
      await page.waitForFunction(() => document.querySelector('.queue-inspector')?.textContent.includes('No queued messages.'));
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
      await page.waitForFunction(() => document.querySelector('.queue-inspector')?.textContent.includes('No queued messages.'));
      await page.evaluate(() => window.__detailsSocket.send(JSON.stringify({ type: 'input', data: '\u0003' })));
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.terminal-main aside.inspector.right');
      await page.screenshot({ path: join(ctx.outDir, '175-terminal-details.png') });
      await page.focus('.terminal-main [aria-label="Resize Details"]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.terminal-main aside.inspector'));
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.terminal-host canvas');
      assert.equal(await page.$('.terminal-main aside.inspector'), null);
      assert.deepEqual(errors, []);
      return { pass: true, detail: 'Terminal Details is always available under its new menu label, uses the right floating frame, shows real queued messages in FIFO order, removes cancelled messages and preserves open/closed state through reload.' };
    } catch (error) {
      await page.screenshot({ path: join(ctx.outDir, '175-failure.png') });
      throw error;
    } finally {
      await page.evaluate(() => {
        if (window.__detailsSocket?.readyState === WebSocket.OPEN) window.__detailsSocket.send(JSON.stringify({ type: 'close' }));
      }).catch(() => {});
      await page.close();
    }
  },
};
