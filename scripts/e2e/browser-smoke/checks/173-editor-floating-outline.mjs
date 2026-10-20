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
      const label = { "app.editor.outline": "Toggle outline", "app.editor.details": "Toggle details" }[name];
      await page.evaluate((name) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } })), label ? "app.launcher.toggle" : name);
      if (!label) return;
      await page.waitForSelector('.deck-input', { visible: true });
      await page.click('.deck-input', { clickCount: 3 });
      await page.keyboard.type(label);
      await page.waitForFunction((label) => [...document.querySelectorAll('[role="option"]')].some(el => el.textContent.includes(label)), {}, label);
      await page.evaluate((label) => [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.includes(label)).click(), label);
      await page.waitForFunction(() => !document.querySelector('.deck-input'));
    };
    const width = (selector) => page.$eval(selector, (el) => el.getBoundingClientRect().width);
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
      assert.equal(await page.$eval('aside.inspector.left', (el) => getComputedStyle(el).position), "absolute");
      assert.equal(await page.$eval('.slide-outline', (el) => getComputedStyle(el).scrollbarGutter), "stable");
      assert.ok(await page.$eval('.slide-outline', (el) => parseFloat(getComputedStyle(el).paddingRight) >= 16));
      const editorWidth = await width('.editor-host');
      await page.click('[aria-label="Close Outline"]');
      assert.equal(await width('.editor-host'), editorWidth);
      await command('app.editor.outline');
      await page.waitForSelector('aside.inspector.left');
      assert.equal(await width('.editor-host'), editorWidth);
      await command('app.editor.details');
      await page.waitForSelector('aside.inspector.right');
      assert.equal(await width('.editor-host'), editorWidth);
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
      assert.equal(await width('.editor-host'), editorWidth);
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
      assert.ok(await page.$eval('aside.inspector.left', el => {
        const card = el.getBoundingClientRect(), host = el.parentElement.getBoundingClientRect();
        return card.left >= host.left && card.right <= host.right && card.bottom <= host.bottom;
      }));
      await page.screenshot({ path: join(ctx.outDir, '173-editor-slides-narrow.png') });
      assert.deepEqual(errors, []);
      return { pass: true, detail: 'Floating editor panels keep the editor width; live thumbnails, heading-free slides, caret/scroll selection, resize, keyboard and Preview work.' };
    } catch (error) {
      await page.screenshot({ path: join(ctx.outDir, '173-failure.png') });
      throw error;
    } finally {
      await page.close();
    }
  },
};
