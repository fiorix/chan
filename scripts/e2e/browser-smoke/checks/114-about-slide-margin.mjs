// The Dashboard's About card ends with the margin it starts with. The slide
// owns its own vertical scroll, so once the About content is taller than the
// tab the last row lands wherever the slide's box ends: with no bottom pad
// that is flush against the stage edge, while the top of the same card still
// carries the carousel's 2rem. The card then reads as cut off at the bottom,
// which is the wrong impression on the surface that exists to say what this
// build is.
//
// Measured, not pinned: the check shrinks the viewport until the slide really
// scrolls, then reads the gap above the first row and the gap below the last
// one off the laid-out boxes.

const SLIDE_LABEL = "slide 3";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function dispatch(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

/// Stop the carousel cycling before measuring: a slide rotating out from
/// under the reads below would make this check's numbers a lottery. The
/// toggle is persisted, so this also holds across the reflow after the
/// viewport change.
async function stopCycling(page) {
  await page.evaluate(() => {
    const stop = document.querySelector(
      '.cycle-toggle[aria-label="stop carousel cycle"]',
    );
    if (stop instanceof HTMLElement) stop.click();
  });
}

async function showAboutSlide(page) {
  const clicked = await page.evaluate((label) => {
    const dot = document.querySelector(`.dot-btn[aria-label="${label}"]`);
    if (!(dot instanceof HTMLElement)) return false;
    dot.click();
    return true;
  }, SLIDE_LABEL);
  if (!clicked) throw new Error(`carousel dot not found: ${SLIDE_LABEL}`);
  await page.waitForSelector(".slide-about", { timeout: 15_000 });
}

/// The space above the first row and below the last one, in the same units:
/// the carousel's own top padding against the slide's bottom padding, read
/// with the slide scrolled to each end.
async function readMargins(page) {
  return page.evaluate(async () => {
    const carousel = document.querySelector(".carousel");
    const slide = document.querySelector(".slide-about");
    const title = slide?.querySelector(".slide-title");
    const credits = slide?.querySelector(".about-credits");
    if (!carousel || !slide || !title || !credits) return null;
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));

    slide.scrollTop = 0;
    await frame();
    const above =
      title.getBoundingClientRect().top - carousel.getBoundingClientRect().top;

    slide.scrollTop = slide.scrollHeight;
    await frame();
    const below =
      slide.getBoundingClientRect().bottom - credits.getBoundingClientRect().bottom;

    return {
      above: Math.round(above),
      below: Math.round(below),
      scrolls: slide.scrollHeight > slide.clientHeight + 1,
    };
  });
}

export default {
  name: "about-slide-margin",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    await dispatch(page, "app.dashboard.open");
    await page.waitForSelector(".carousel", { timeout: 20_000 });
    await stopCycling(page);
    await showAboutSlide(page);

    try {
      // Small enough that the About card cannot fit the stage, which is the
      // only state in which the bottom margin is observable at all.
      await page.setViewport({ width: 900, height: 520 });
      await delay(400);
      const margins = await readMargins(page);
      if (!margins) throw new Error("About slide did not render its rows");
      if (!margins.scrolls) {
        ctx.skip(`About slide still fits the stage: ${JSON.stringify(margins)}`);
      }
      await ctx.shot("about-slide-bottom");

      // 2rem top and bottom. The tolerance absorbs sub-pixel layout, not a
      // missing pad: without one `below` is 0.
      if (margins.below < 24) {
        throw new Error(
          `About slide's last row is flush against its bottom edge: ${JSON.stringify(margins)}`,
        );
      }
      if (Math.abs(margins.above - margins.below) > 6) {
        throw new Error(
          `About slide's margins are not symmetric: ${JSON.stringify(margins)}`,
        );
      }
      return margins;
    } finally {
      await page.setViewport({ width: 1600, height: 1000 }).catch(() => {});
      await delay(200);
    }
  },
};
