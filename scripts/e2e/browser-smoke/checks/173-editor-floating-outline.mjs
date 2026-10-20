import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = "floating-outline-smoke.md";
const deck = `---\nchan:\n  kind: slides\n  slides:\n    aspect_ratio: "16:9"\n---\n\n` + Array.from({ length: 10 }, (_, i) => i === 4
  ? "A slide without a heading.\n"
  : `# Slide ${i + 1}\n\n${"A paragraph to edit and preview.\n\n".repeat(3)}`
).join('\n<hr class="chan-page-break">\n\n');

export default {
  name: "editor-floating-outline",
  async run(ctx) {
    writeFileSync(join(ctx.workspaceDir, fixture), deck);
    const page = await ctx.browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const command = async (name) => {
      const label = { "app.editor.outline": "Toggle outline", "app.editor.details": "Toggle details", "app.editor.styleToolbar": "Toggle style toolbar" }[name];
      if (!label) {
        await page.evaluate((name) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } })), name);
        return;
      }
      await page.click('.tab.active', { button: 'right' });
      await page.waitForSelector('.tab-menu-bubble', { visible: true });
      await page.evaluate((label) => [...document.querySelectorAll('.tab-menu-bubble .mbtn')].find(el => el.querySelector('.mbtn-label')?.textContent === label).click(), label);
      await page.waitForFunction(() => !document.querySelector('.tab-menu-bubble'));
      assert.ok(await page.$eval('.cm-content', el => el.contains(document.activeElement)), 'a menu toggle returns focus to the editor');
    };
    const width = (selector) => page.$eval(selector, (el) => el.getBoundingClientRect().width);
    const clearDocumentMargins = async () => {
      const bounds = await page.evaluate(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width };
        };
        return { editor: rect('.editor-host'), content: rect('.cm-content'), gutter: rect('.cm-gutters'), outline: rect('aside.inspector.left'), details: rect('aside.inspector.right') };
      });
      assert.ok(bounds.editor.width >= 200, 'the document retains a usable minimum width');
      if (bounds.outline) {
        assert.ok(bounds.editor.left >= bounds.outline.right + 11, 'the document begins beyond the Outline card');
        if (bounds.gutter) assert.ok(bounds.gutter.left >= bounds.outline.right + 11, 'heading chevrons and line numbers clear Outline');
      }
      if (bounds.details) assert.ok(bounds.editor.right <= bounds.details.left - 11, 'the document ends before the Details card');
      assert.ok(bounds.content.left >= bounds.editor.left, 'document text stays inside its area');
    };
    const selected = () => page.$eval('.slide-thumb[aria-current="true"]', (el) => el.getAttribute("aria-label"));
    const select = async (number) => {
      await page.$eval(`.slide-thumb[aria-label="Slide ${number}"]`, (el) => el.click());
      await page.waitForFunction((number) => document.querySelector('.slide-thumb[aria-current="true"]')?.getAttribute("aria-label") === `Slide ${number}`, {}, number);
    };
    try {
      await page.setViewport({ width: 1440, height: 1000 });
      const url = new URL(ctx.serverUrl);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [{ p: fixture, m: "wysiwyg", a: 1, ol: 1, ow: 280 }] }));
      await page.goto(url.href, { waitUntil: "networkidle0" });
      await page.waitForSelector('.slide-miniature .md-slide-preview-content');
      assert.equal(await page.$$eval('.slide-thumb', (nodes) => nodes.length), 10);
      assert.ok(await page.$eval('aside.inspector.left', (el) => el.classList.contains('floating') && parseFloat(getComputedStyle(el).borderRadius) > 0));
      assert.equal(await page.$eval('.slide-outline', (el) => getComputedStyle(el).scrollbarGutter), "stable");
      assert.ok(await page.$eval('.slide-outline', (el) => parseFloat(getComputedStyle(el).paddingRight) >= 16));
      await clearDocumentMargins();
      await command('app.editor.styleToolbar');
      await page.waitForSelector('.style-toolbar');
      await page.click('.tab.active', { button: 'right' });
      await page.waitForSelector('.tab-menu-bubble', { visible: true });
      assert.deepEqual(await page.$$eval('.tab-menu-bubble [role="menuitemcheckbox"]', nodes => nodes.map(el => [el.querySelector('.mbtn-label').textContent, el.getAttribute('aria-checked')])), [
        ['Toggle outline', 'true'], ['Toggle details', 'false'], ['Toggle style toolbar', 'true'],
      ]);
      await page.$eval('.tab-menu-bubble', async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
      await page.screenshot({ path: join(ctx.outDir, '173-editor-tab-menu.png') });
      await page.keyboard.press('Escape');
      await command('app.editor.styleToolbar');
      await page.waitForFunction(() => !document.querySelector('.style-toolbar'));
      const editorWidth = await width('.editor-host');
      await page.click('[aria-label="Close Outline"]');
      assert.ok(await width('.editor-host') > editorWidth);
      await clearDocumentMargins();
      await command('app.editor.outline');
      await page.waitForSelector('aside.inspector.left');
      assert.equal(await width('.editor-host'), editorWidth);
      await command('app.editor.details');
      await page.waitForSelector('aside.inspector.right');
      assert.ok(await width('.editor-host') < editorWidth);
      await clearDocumentMargins();
      await page.focus('[aria-label="Resize Details"]');
      await page.keyboard.press('ArrowLeft');
      await clearDocumentMargins();
      await page.click('[aria-label="Close Outline"]');
      await clearDocumentMargins();
      await command('app.editor.outline');
      await page.waitForSelector('aside.inspector.left');
      await page.click('[aria-label="Close Details"]');
      assert.equal(await width('.editor-host'), editorWidth);

      const handle = await page.$('[aria-label="Resize Outline"]');
      const box = await handle.boundingBox();
      const oldWidth = await width('aside.inspector.left');
      await page.mouse.move(box.x + box.width / 2, box.y + 60);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 50, box.y + 60, { steps: 4 });
      await page.mouse.up();
      assert.equal(await width('aside.inspector.left'), oldWidth + 50);
      assert.equal(await width('.editor-host'), editorWidth - 50);
      await clearDocumentMargins();
      await handle.focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await width('aside.inspector.left'), oldWidth + 40);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('aside.inspector.left'));
      assert.ok(await page.$eval('.cm-content', el => el.contains(document.activeElement)));
      await command('app.editor.outline');
      await page.waitForSelector('aside.inspector.left');
      assert.equal(await width('aside.inspector.left'), oldWidth + 40);

      for (let n = 1; n <= 10; n++) await select(n);
      await select(5);
      await page.waitForFunction(() => document.querySelector('.slide-thumb[aria-label="Slide 5"] .slide-miniature')?.textContent.includes('without a heading'));
      await page.focus('.slide-thumb[aria-label="Slide 5"]');
      await page.keyboard.press('End');
      assert.equal(await selected(), 'Slide 10');
      await page.keyboard.press('Home');
      assert.equal(await selected(), 'Slide 1');

      await select(5);
      await page.click('.slide-action[title^="Preview slides"]');
      await page.waitForFunction(() => document.querySelector('.md-slide-preview .md-slide-preview-counter')?.textContent.includes('5 / 10'));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.md-slide-preview'));

      await command('app.editor.toggleMode');
      await page.waitForSelector('.md-source .cm-content');
      await command('app.editor.styleToolbar');
      await page.waitForSelector('.editor-host .style-toolbar');
      await command('app.editor.styleToolbar');
      await page.waitForFunction(() => !document.querySelector('.style-toolbar'));
      await clearDocumentMargins();
      await command('app.editor.details');
      await page.waitForSelector('aside.inspector.right');
      await clearDocumentMargins();
      await page.click('[aria-label="Close Details"]');
      await select(1);
      await page.focus('.cm-content');
      await page.keyboard.type('Live thumbnail update\n');
      await page.waitForFunction(() => document.querySelector('.slide-thumb[aria-label="Slide 1"] .slide-miniature')?.textContent.includes('Live thumbnail update'));

      await page.mouse.move(1100, 600);
      await page.mouse.wheel({ deltaY: 100000 });
      await page.waitForFunction(() => document.querySelector('.slide-thumb[aria-current="true"]')?.getAttribute('aria-label') === 'Slide 10');
      assert.ok(await page.$eval('.slide-thumb[aria-current="true"]', el => {
        const row = el.getBoundingClientRect(), nav = el.closest('.slide-outline').getBoundingClientRect();
        return row.top >= nav.top && row.bottom <= nav.bottom;
      }));
      await command('app.editor.toggleMode');
      await select(3);
      await page.screenshot({ path: join(ctx.outDir, '173-editor-slides.png') });
      await page.setViewport({ width: 390, height: 844 });
      await clearDocumentMargins();
      await command('app.editor.details');
      await page.waitForSelector('aside.inspector.right');
      await clearDocumentMargins();
      await page.screenshot({ path: join(ctx.outDir, '173-editor-slides-narrow.png') });
      assert.deepEqual(errors, []);
      return { pass: true, detail: 'Floating editor panels reserve document margins and keep heading controls clear; live thumbnails, heading-free slides, caret/scroll selection, resize, keyboard and Preview work.' };
    } catch (error) {
      await page.screenshot({ path: join(ctx.outDir, '173-failure.png') });
      throw error;
    } finally {
      await page.close();
    }
  },
};
