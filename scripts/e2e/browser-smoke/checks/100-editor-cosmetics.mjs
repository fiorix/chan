// Editor-cosmetics regression guard. Covers two theme tokens:
//
// 1. LIGHT: the fenced code-block slab must visibly separate from the
//    page background (a github-theme --chan-editor-code-block-bg of
//    #f6f8fa on a #ffffff canvas is indistinguishable).
// 2. DARK: the editor selection must follow --selection-bg (GitHub's
//    accent-muted blue), not CM6's hard-coded light greys (#d7d4f0),
//    and the selected text must stay readable against it.
//
// Assertions sample the RENDERED colors (computed style of the fence
// ::before slab and of the live .cm-selectionBackground markers), not
// just screenshots.

const DOC = "doc.md";

async function openDoc(page) {
  await page.bringToFront();
  const open = await page.$(".file-tree, [role=tree]");
  if (!open) {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
      );
    });
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
  }
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (b) => b.textContent?.trim() === name,
    );
    if (!row) return false;
    row.click();
    return true;
  }, DOC);
  if (!clicked) throw new Error(`tree row not found: ${DOC}`);
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Open",
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error("inspector Open button not found");
  await page.waitForSelector(".cm-content", { timeout: 30_000 });
}

/// Flip the app theme by setting the same [data-theme] attribute the
/// store's applyResolvedTheme() maintains, then wait for paint.
/// Deliberately NOT the settings UI / config PATCH path: a preferences
/// write echoes back over config_changed and races the check (the
/// server's CHAN_HOME is sandboxed, so it would be harmless, just
/// racy). The chan:command bridge no-ops app.theme.* ids
/// (catalog-only commands). Every token this check samples (fence slab,
/// --selection-bg) keys off the attribute directly, so this exercises
/// the real rendering path without side effects.
///
/// Hybrid surface roots (editor, browser, ...) pin their own
/// data-theme from the hybrid_surface_themes preference (design.md #1),
/// so a root-only flip leaves a pinned surface in the old scheme - they
/// get aligned to the requested scheme too.
async function setTheme(page, theme) {
  await page.bringToFront();
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll("[data-theme]")) {
      el.setAttribute("data-theme", t);
    }
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
  await new Promise((r) => setTimeout(r, 300));
  const now = await page.evaluate(() => document.documentElement.dataset.theme);
  if (now !== theme) {
    throw new Error(`data-theme did not hold: wanted ${theme}, got ${now}`);
  }
}

/// "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.4)" -> [r, g, b, a]
function parseColor(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not a css color: ${str}`);
  const parts = m[1].split(",").map((s) => Number.parseFloat(s.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) {
    throw new Error(`not a css color: ${str}`);
  }
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/// Alpha-composite fg over bg (both from parseColor).
function composite(fg, bg) {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
    1,
  ];
}

/// WCAG relative-luminance contrast ratio (1..21).
function contrastRatio(c1, c2) {
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [l1, l2] = [lum(c1), lum(c2)];
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function maxChannelDelta(c1, c2) {
  return Math.max(
    Math.abs(c1[0] - c2[0]),
    Math.abs(c1[1] - c2[1]),
    Math.abs(c1[2] - c2[2]),
  );
}

export default {
  name: "editor-cosmetics",
  async run(ctx) {
    const { page } = ctx;
    await openDoc(page);

    // -- 1. Light-mode code-block slab vs page -----------------------
    await setTheme(page, "light");
    const light = await page.evaluate(() => {
      const fence = document.querySelector(".cm-line.cm-md-code-block");
      if (!fence) return { error: "no .cm-md-code-block line in viewport" };
      return {
        fenceBg: getComputedStyle(fence, "::before").backgroundColor,
        pageBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    if (light.error) throw new Error(light.error);
    const lightFence = parseColor(light.fenceBg);
    const lightPage = parseColor(light.pageBg);
    const lightDelta = maxChannelDelta(lightFence, lightPage);
    if (lightDelta < 10) {
      throw new Error(
        `light fence bg ${light.fenceBg} does not separate from page ${light.pageBg} (max channel delta ${lightDelta} < 10)`,
      );
    }
    await ctx.shot("light-codeblock");

    // -- 2. Dark mode: slab still separates, selection readable ------
    await setTheme(page, "dark");
    const darkFence = await page.evaluate(() => {
      const fence = document.querySelector(".cm-line.cm-md-code-block");
      if (!fence) return { error: "no .cm-md-code-block line in viewport" };
      return {
        fenceBg: getComputedStyle(fence, "::before").backgroundColor,
        pageBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    if (darkFence.error) throw new Error(darkFence.error);
    const darkFenceDelta = maxChannelDelta(
      parseColor(darkFence.fenceBg),
      parseColor(darkFence.pageBg),
    );
    if (darkFenceDelta < 4) {
      throw new Error(
        `dark fence bg ${darkFence.fenceBg} collapsed into page ${darkFence.pageBg} (max channel delta ${darkFenceDelta} < 4)`,
      );
    }
    await ctx.shot("dark-codeblock");

    // Select the whole doc through the real editor so drawSelection
    // paints .cm-selectionBackground markers.
    await page.click(".cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.waitForSelector(".cm-selectionLayer .cm-selectionBackground", {
      timeout: 10_000,
    });
    const sel = await page.evaluate(() => {
      const marker = document.querySelector(
        ".cm-selectionLayer .cm-selectionBackground",
      );
      const content = document.querySelector(".cm-content");
      return {
        theme: document.documentElement.dataset.theme,
        selBg: getComputedStyle(marker).backgroundColor,
        textColor: getComputedStyle(content).color,
        pageBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    if (sel.theme !== "dark") {
      throw new Error(`theme flipped back to ${sel.theme} before sampling`);
    }
    // The pre-fix rendering: CM6's base-theme light greys, unreadable on
    // the dark canvas. Pin against both (focused + unfocused defaults).
    for (const cmDefault of ["rgb(215, 212, 240)", "rgb(217, 217, 217)"]) {
      if (sel.selBg === cmDefault) {
        throw new Error(`selection still uses CM6's default ${cmDefault}`);
      }
    }
    const selEffective = composite(parseColor(sel.selBg), parseColor(sel.pageBg));
    const selDelta = maxChannelDelta(selEffective, parseColor(sel.pageBg));
    if (selDelta < 30) {
      throw new Error(
        `selection ${sel.selBg} (effective rgb(${selEffective.slice(0, 3).join(",")})) does not stand out from page ${sel.pageBg} (max channel delta ${selDelta} < 30)`,
      );
    }
    const selContrast = contrastRatio(selEffective, parseColor(sel.textColor));
    if (selContrast < 3) {
      throw new Error(
        `selected text ${sel.textColor} unreadable on selection ${sel.selBg}: contrast ${selContrast.toFixed(2)} < 3`,
      );
    }
    await ctx.shot("dark-selection");

    return {
      lightFenceBg: light.fenceBg,
      lightPageBg: light.pageBg,
      lightDelta,
      darkFenceBg: darkFence.fenceBg,
      darkFenceDelta,
      selectionBg: sel.selBg,
      selectionTextColor: sel.textColor,
      selectionContrast: Number(selContrast.toFixed(2)),
    };
  },
};
