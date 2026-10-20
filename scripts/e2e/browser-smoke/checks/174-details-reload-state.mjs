import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = "details-state-smoke.md";

export default {
  name: "details-reload-state",
  async run(ctx) {
    writeFileSync(join(ctx.workspaceDir, fixture), '---\nchan:\n  kind: slides\n---\n\n# Details state\n\nA searchable document for Details reload checks.\n');
    const page = await ctx.browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const command = name => page.evaluate(name => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } })), name);
    const layoutUrl = tab => {
      const url = new URL(ctx.serverUrl);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [{ ...tab, a: 1 }] }));
      return url.href;
    };
    const waitSearchBit = bit => page.waitForFunction(bit => new URLSearchParams(location.hash.slice(1)).get('search')?.startsWith(`${bit}:`), {}, bit);
    const details = '[role="dialog"][aria-label="Search"] aside.inspector';
    try {
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(layoutUrl({ p: fixture, m: "wysiwyg", ol: 1, o: 1 }), { waitUntil: "networkidle0" });
      await page.waitForSelector('.editor-tab.active aside.inspector.right');
      await page.click('[aria-label="Close Outline"]');
      await page.click('[aria-label="Close Details"]');
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector('.editor-tab.active .cm-content');
      assert.equal(await page.$('.editor-tab.active aside.inspector'), null, 'closed editor cards stay closed after reload, including slide Outline');

      await command('app.search.toggle');
      await page.waitForSelector(details);
      assert.ok(await page.$eval(details, el => el.classList.contains('floating') && el.classList.contains('reserve-space')));
      await page.type('.search input', 'details-state-smoke');
      await page.waitForSelector('.search .hits li');
      const bounds = await page.evaluate(() => {
        const result = document.querySelector('.search .results').getBoundingClientRect();
        const card = document.querySelector('.search aside.inspector').getBoundingClientRect();
        return { resultRight: result.right, cardLeft: card.left };
      });
      assert.ok(bounds.resultRight <= bounds.cardLeft - 11, 'Search results stay clear of the floating Details card');
      await page.screenshot({ path: join(ctx.outDir, '174-search-details.png') });
      await page.click('.search [aria-label="Close Details"]');
      await page.click('.search .hits li');
      assert.equal(await page.$(details), null, 'selecting a result respects an explicit close');
      await waitSearchBit('0');
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector('.search input');
      assert.equal(await page.$(details), null, 'closed Search Details survives reload');
      await page.click('.search header [aria-label="Close"]');
      await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(1)).has('search'));
      await page.reload({ waitUntil: "networkidle0" });
      await command('app.search.toggle');
      await page.waitForSelector('.search input');
      assert.equal(await page.$(details), null, 'the Search Details preference survives a reload while Search is closed');
      await page.click('.search', { button: 'right' });
      await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some(el => el.textContent.includes('Show Details')));
      await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('Show Details')).click());
      await page.waitForSelector(details);
      await waitSearchBit('1');
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector(details);
      await page.focus('.search [aria-label="Resize Details"]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.search aside.inspector'));
      assert.ok(await page.$eval('.search input', el => el === document.activeElement));
      assert.ok(await page.$('[role="dialog"][aria-label="Search"]'), 'Escape closes Details before Search');
      await page.click('.search header [aria-label="Close"]');

      for (const [name, tab, host] of [
        ['browser', { k: 'b', bs: fixture, bi: 1 }, '.browser'],
        ['semantic graph', { k: 'g', gm: 's', gs: 'workspace', gn: fixture, gi: 1 }, '.graph-tab'],
        ['filesystem graph', { k: 'g', gm: 'f', gs: 'workspace', gn: fixture, gi: 1 }, '.graph-tab'],
        ['dashboard', { k: 'd', cs: 1, ar: false, dsi: '' }, '.dashboard'],
      ]) {
        await page.goto(layoutUrl(tab), { waitUntil: 'networkidle0' });
        await page.waitForSelector(`${host} aside.inspector.right.floating.reserve-space`);
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector(`${host} aside.inspector.right`);
        await page.screenshot({ path: join(ctx.outDir, `174-${name.replaceAll(' ', '-')}-details.png`) });
        await page.click(`${host} aside.inspector .close`);
        await page.waitForFunction(host => !document.querySelector(`${host} aside.inspector`), {}, host);
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector(host);
        assert.equal(await page.$(`${host} aside.inspector.right`), null, `${name} keeps Details closed after reload`);
      }
      assert.deepEqual(errors, []);
      return { pass: true, detail: 'Search defaults to floating Details, retains closed/open state across reload and overlay closure; editor, file browser, graph and dashboard restore closed cards without reopening them for a restored selection.' };
    } catch (error) {
      await page.screenshot({ path: join(ctx.outDir, '174-failure.png') });
      throw error;
    } finally { await page.close(); }
  },
};
