// A Dashboard's Workspace and About slides sit in the middle of their stage.
// Each keeps the 720px column the carousel centers across the tab and scrolls
// inside it, and its content (the slide's title and the rows under it) is as
// tall as it is. A stage larger than the content has room to spare, split
// evenly left and right of the content and above and below it. A stage
// smaller than the content has none: the content starts at the stage's top
// and the slide scrolls from its first line. That last case is where
// centering a scrollable box goes wrong, since a box centered past its
// container's start keeps the rows above the scroll origin out of reach.
//
// Measured, not pinned: at check 212's four viewport sizes, and a shorter one
// where the About content no longer fits, the check reads the stage, the
// slide that scrolls inside it and the content, the union of the title's and
// the rows' laid-out boxes, so the reading does not depend on how the slide
// wraps its rows. Each slide names the sizes whose stage is larger than its
// content, and the check refuses a size that does not put the slide in the
// case it is named for. The Workspace slide shows the runner's seeded
// workspace, which is small, and is measured once its height holds. The
// controls row is read under each slide against its place under Metrics at
// the same size.

const SIZES = [
  { name: "narrow, short", width: 900, height: 520 },
  { name: "narrow, tall", width: 900, height: 1400 },
  { name: "wide, short", width: 1900, height: 520 },
  { name: "wide, tall", width: 1900, height: 1400 },
  { name: "narrow, shorter", width: 900, height: 400 },
];
// Sub-pixel layout and an odd pixel of room, not a missing rule: an
// uncentered slide is off by the whole of the room, and the About slide's
// side padding added to its column's width put its content 4 px off.
const TOLERANCE = 2;
const SETTLE_MS = 15_000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/// The slides read here, in the carousel's order. `rows` select the
/// content's top-level boxes, title first, inside the slide; `fits` names
/// the sizes whose stage is larger than the content; `judge` reads one
/// measurement and returns what is wrong with it. In Chrome the stage is
/// 135 px shorter than the viewport, the About content is 344 px tall and the
/// seeded Workspace content 488 px: About fits from the 520 px sizes up, with
/// 41 px to spare there, and Workspace only at the 1400 px sizes.
const SLIDES = [
  {
    label: "Workspace",
    selector: ".slide-workspace",
    // The inspector body's own box, not its host's: a host that grows to
    // the slide's height would read as content that fills the stage.
    rows: [".slide-title", ".workspace-info-host > .info"],
    fits: (size) => size.height >= 1400,
    judge: judgeColumnSlide,
  },
  {
    label: "About",
    selector: ".slide-about",
    rows: [
      ".slide-title",
      ".about-grid",
      ".about-links",
      ".about-fund",
      ".about-sep",
      ".about-credits",
    ],
    fits: (size) => size.height >= 520,
    judge: judgeColumnSlide,
  },
];

async function dispatch(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

/// Stop or resume the carousel's rotation through its own toggle, and say
/// whether the toggle was there to press. A slide rotating out from under the
/// reads below would measure another slide. The toggle writes a server
/// preference that outlives the check, so `run` resumes what it stopped.
async function setCycling(page, cycling) {
  const before = cycling ? "resume carousel cycle" : "stop carousel cycle";
  const after = cycling ? "stop carousel cycle" : "resume carousel cycle";
  const pressed = await page.evaluate((label) => {
    const toggle = document.querySelector(
      `.dashboard.active .cycle-toggle[aria-label="${label}"]`,
    );
    if (!(toggle instanceof HTMLElement)) return false;
    toggle.click();
    return true;
  }, before);
  if (pressed) {
    await page.waitForSelector(
      `.dashboard.active .cycle-toggle[aria-label="${after}"]`,
      { timeout: 10_000 },
    );
  }
  return pressed;
}

async function showSlide(page, label, selector) {
  const clicked = await page.evaluate((dotLabel) => {
    const dot = document.querySelector(
      `.dashboard.active .dot-btn[aria-label="${dotLabel}"]`,
    );
    if (!(dot instanceof HTMLElement)) return false;
    dot.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`carousel dot not found: ${label}`);
  await page.waitForSelector(`.dashboard.active ${selector}`, { timeout: 15_000 });
}

async function resize(page, { width, height }) {
  await page.setViewport({ width, height });
  await page.waitForFunction(
    (w, h) => window.innerWidth === w && window.innerHeight === h,
    { timeout: 10_000 },
    width,
    height,
  );
}

/// Wait until the content's height holds over three reads a quarter second
/// apart, and say whether a loading line showed. The Workspace slide fills its
/// report and contacts after it mounts, and a slide read while a row lands
/// reads a box about to move. A loading line is no reason to wait longer: the
/// contacts read "rebuilding" for as long as the server's index rebuilds,
/// which an earlier check in the run can start, and the content is placed the
/// same way whatever it holds.
async function settle(page, spec, label) {
  const deadline = Date.now() + SETTLE_MS;
  let last = null;
  let steady = 0;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await page.evaluate(
      (slideSelector, rowSelectors) => {
        const slide = document.querySelector(`.dashboard.active ${slideSelector}`);
        if (!slide) return { missing: slideSelector };
        const rows = rowSelectors.map((s) => slide.querySelector(s));
        if (rows.some((row) => !row)) return { missing: rowSelectors.join(", ") };
        const rects = rows.map((row) => row.getBoundingClientRect());
        const top = Math.min(...rects.map((r) => r.top));
        const bottom = Math.max(...rects.map((r) => r.bottom));
        return {
          loading: slide.querySelector(".refs-loading") !== null,
          height: Math.round((bottom - top) * 10) / 10,
        };
      },
      spec.selector,
      spec.rows,
    );
    const still = !seen.missing && last !== null && seen.height === last;
    steady = still ? steady + 1 : 0;
    last = seen.missing ? null : seen.height;
    if (steady >= 3) return seen.loading;
    await delay(250);
  }
  throw new Error(
    `${label}: the content did not settle in ${SETTLE_MS} ms: ${JSON.stringify(seen)}`,
  );
}

/// The visible slide against its stage and the tab, in CSS px, with the
/// slide at the scroll position it has. `content` is the union of the rows'
/// boxes; `left`, `right`, `above` and `below` are the room between the
/// content and the stage's edges, negative where the content runs past one.
/// `stageRoom` is the room between the stage and the tab's sides.
async function readSlide(page, spec) {
  return page.evaluate(
    async (slideSelector, rowSelectors) => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
      await frame();
      await frame();
      const tab = document.querySelector(".dashboard.active");
      const stage = tab?.querySelector(".slide-stage");
      const slide = tab?.querySelector(slideSelector);
      const controls = tab?.querySelector(".carousel-controls");
      if (!tab || !stage || !slide || !controls) return null;
      const rows = rowSelectors.map((s) => slide.querySelector(s));
      if (rows.some((row) => !row)) return null;
      const round = (n) => Math.round(n * 10) / 10;
      const box = (r) => ({
        left: round(r.left),
        top: round(r.top),
        width: round(r.width),
        height: round(r.height),
      });
      const rects = rows.map((row) => row.getBoundingClientRect());
      const c = {
        left: Math.min(...rects.map((r) => r.left)),
        top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
      const t = tab.getBoundingClientRect();
      const g = stage.getBoundingClientRect();
      const s = slide.getBoundingClientRect();
      return {
        stage: box(g),
        slide: box(s),
        content: box({ left: c.left, top: c.top, width: c.right - c.left, height: c.bottom - c.top }),
        controls: box(controls.getBoundingClientRect()),
        left: round(c.left - g.left),
        right: round(g.right - c.right),
        above: round(c.top - g.top),
        below: round(g.bottom - c.bottom),
        stageRoom: { left: round(g.left - t.left), right: round(t.right - g.right) },
        scrolls: slide.scrollHeight > slide.clientHeight + 1,
        scrollTop: slide.scrollTop,
        paddingTop: parseFloat(getComputedStyle(slide).paddingTop),
      };
    },
    spec.selector,
    spec.rows,
  );
}

const differ = (a, b, by = TOLERANCE) => Math.abs(a - b) > by;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameBox = (a, b) =>
  !differ(a.left, b.left, 1) &&
  !differ(a.top, b.top, 1) &&
  !differ(a.width, b.width, 1) &&
  !differ(a.height, b.height, 1);

/// A slide in the centered column: the column in the middle of the tab, the
/// slide taking the column's box and scrolling inside it, and the content in
/// the middle of the column on both axes when it fits, or across it and from
/// its first line when it does not. Returns one line a finding.
function judgeColumnSlide(spec, size, m) {
  const wrong = [];
  if (differ(m.stageRoom.left, m.stageRoom.right)) {
    wrong.push(
      `its column is not in the middle of the tab: room left ${m.stageRoom.left}, right ${m.stageRoom.right}`,
    );
  }
  if (!sameBox(m.slide, m.stage)) {
    wrong.push(
      `the slide does not take its column's box: stage ${JSON.stringify(m.stage)}, slide ${JSON.stringify(m.slide)}`,
    );
  }
  const fits = spec.fits(size);
  const room = m.stage.height - m.content.height;
  if (fits ? m.scrolls || room <= TOLERANCE : !m.scrolls) {
    wrong.push(
      `the viewport does not make the stage ${fits ? "taller" : "shorter"} than the content: stage ${m.stage.height}, content ${m.content.height}, scrolls ${m.scrolls}`,
    );
  }
  if (differ(m.left, m.right)) {
    wrong.push(`the room left of the content (${m.left}) and right of it (${m.right}) differ`);
  }
  if (!m.scrolls && differ(m.above, m.below)) {
    wrong.push(`the room above the content (${m.above}) and below it (${m.below}) differ`);
  }
  if (m.scrolls && (m.scrollTop !== 0 || differ(m.above, m.paddingTop, 1))) {
    wrong.push(
      `the slide does not start at its first line: scrollTop ${m.scrollTop}, content ${m.above} below the stage's top, padding ${m.paddingTop}`,
    );
  }
  return wrong;
}

export default {
  name: "dashboard-slides-centered",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    await dispatch(page, "app.dashboard.open");
    await page.waitForSelector(".dashboard.active .carousel", { timeout: 20_000 });
    const tabs = await page.evaluate(
      () => document.querySelectorAll(".dashboard.active").length,
    );
    if (tabs !== 1) throw new Error(`expected one visible Dashboard tab, found ${tabs}`);
    const stopped = await setCycling(page, false);

    const details = { sizes: [] };
    const failures = [];
    try {
      for (const size of SIZES) {
        await resize(page, size);
        const sizeLabel = `${size.width}x${size.height}`;
        await showSlide(page, "Metrics", ".metrics-slide");
        const controls = await page.evaluate(async () => {
          const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
          await frame();
          await frame();
          const r = document
            .querySelector(".dashboard.active .carousel-controls")
            ?.getBoundingClientRect();
          if (!r) return null;
          const round = (n) => Math.round(n * 10) / 10;
          return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height) };
        });
        if (!controls) throw new Error(`${sizeLabel}: no controls row under Metrics`);
        const entry = { size: `${size.name} (${sizeLabel})`, controls, slides: {} };
        details.sizes.push(entry);

        for (const spec of SLIDES) {
          const label = `${spec.label}, ${size.name} (${sizeLabel})`;
          await showSlide(page, spec.label, spec.selector);
          const loading = await settle(page, spec, label);
          const m = await readSlide(page, spec);
          if (!m) throw new Error(`${label}: the slide did not render its boxes`);
          entry.slides[spec.label] = { ...m, loading };
          await ctx.shot(`${spec.label.toLowerCase()}-${sizeLabel}`);
          for (const line of spec.judge(spec, size, m)) failures.push(`${label}: ${line}`);
          if (!same(m.controls, controls)) {
            failures.push(
              `${label}: the controls row is not where it is under Metrics: ${JSON.stringify(m.controls)} against ${JSON.stringify(controls)}`,
            );
          }
        }
      }

      if (failures.length > 0) {
        const error = new Error(`Dashboard slide placement:\n  ${failures.join("\n  ")}`);
        error.smokeDetails = details;
        throw error;
      }
      return details;
    } finally {
      await page.setViewport({ width: 1600, height: 1000 }).catch(() => {});
      if (stopped) await setCycling(page, true).catch(() => {});
    }
  },
};
