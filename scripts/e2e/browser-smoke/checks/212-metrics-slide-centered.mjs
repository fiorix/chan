// A Dashboard's Metrics slide sits in the middle of its tab. The slide caps
// its own width and is as tall as its content, so a tab larger than the slide
// has room to spare on both axes: that room is split evenly left and right of
// the slide, and above and below it inside the stage (the tab less the
// carousel's padding and its controls row). A tab smaller than the slide has
// none: the slide fills the stage's width, takes the stage's height and
// scrolls from its first row. That last case is where centering a scrollable
// box goes wrong, since a box centered past its container's start keeps the
// rows above the scroll origin out of reach, so every size reads the scroll
// position and the first row as well as the box.
//
// Measured, not pinned: the check reads the laid-out boxes at four viewport
// sizes, two widths either side of the slide's cap by two heights either side
// of its content, and refuses a size that does not put the slide in the case
// it is named for. The slides beside it are read at the largest size too: the
// Search slide fills the same wide stage, the About slide keeps its centered
// column, and the controls row sits in one place under all three.

const SIZES = [
  { name: "narrow, short", width: 900, height: 520, wider: false, taller: false },
  { name: "narrow, tall", width: 900, height: 1400, wider: false, taller: true },
  { name: "wide, short", width: 1900, height: 520, wider: true, taller: false },
  { name: "wide, tall", width: 1900, height: 1400, wider: true, taller: true },
];
// Sub-pixel layout and an odd pixel of room, not a missing rule: an
// uncentered slide is off by the whole of the room.
const TOLERANCE = 2;

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

/// The visible slide's box against its stage's and the tab's, in CSS px.
/// `left` and `right` are the room between the slide and the tab's side
/// edges, `stageRoom` the same for the stage with the room above it, and
/// `above` and `below` the room between the slide and the stage's top and
/// bottom edges; the controls row is the tab's own, below the stage.
async function readBoxes(page, selector) {
  return page.evaluate(async (slideSelector) => {
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
    await frame();
    await frame();
    const tab = document.querySelector(".dashboard.active");
    const carousel = tab?.querySelector(".carousel");
    const stage = tab?.querySelector(".slide-stage");
    const slide = tab?.querySelector(slideSelector);
    const controls = tab?.querySelector(".carousel-controls");
    const first = slide?.firstElementChild;
    if (!tab || !carousel || !stage || !slide || !controls || !first) return null;
    const round = (n) => Math.round(n * 10) / 10;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: round(r.left),
        top: round(r.top),
        width: round(r.width),
        height: round(r.height),
      };
    };
    const t = tab.getBoundingClientRect();
    const g = stage.getBoundingClientRect();
    const s = slide.getBoundingClientRect();
    const padding = getComputedStyle(carousel);
    return {
      tab: box(tab),
      stage: box(stage),
      slide: box(slide),
      controls: box(controls),
      left: round(s.left - t.left),
      right: round(t.right - s.right),
      above: round(s.top - g.top),
      below: round(g.bottom - s.bottom),
      stageRoom: {
        left: round(g.left - t.left),
        right: round(t.right - g.right),
        top: round(g.top - t.top),
      },
      carouselPadding: {
        left: parseFloat(padding.paddingLeft),
        right: parseFloat(padding.paddingRight),
        top: parseFloat(padding.paddingTop),
      },
      scrolls: slide.scrollHeight > slide.clientHeight + 1,
      scrollTop: slide.scrollTop,
      firstRowOffset: round(first.getBoundingClientRect().top - s.top),
      paddingTop: parseFloat(getComputedStyle(slide).paddingTop),
    };
  }, selector);
}

const differ = (a, b, by = TOLERANCE) => Math.abs(a - b) > by;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/// The wide stage takes the whole tab inside the carousel's padding, down to
/// the controls row. Each judge below returns what is wrong, one line a
/// finding, and nothing when nothing is.
function judgeWideStage(m) {
  const room = m.stageRoom;
  const pad = m.carouselPadding;
  if (!differ(room.left, pad.left, 1) && !differ(room.right, pad.right, 1) && !differ(room.top, pad.top, 1)) {
    return [];
  }
  return [
    `the stage does not span the tab inside the carousel's padding: room ${JSON.stringify(room)}, padding ${JSON.stringify(pad)}`,
  ];
}

function judgeMetrics(size, m) {
  const wrong = judgeWideStage(m);
  const wider = m.stage.width - m.slide.width > TOLERANCE;
  const taller = !m.scrolls && m.stage.height - m.slide.height > TOLERANCE;
  if (wider !== size.wider) {
    wrong.push(
      `the viewport does not make the stage ${size.wider ? "wider than" : "as wide as"} the slide: stage ${m.stage.width}, slide ${m.slide.width}`,
    );
  }
  if (taller !== size.taller || m.scrolls === size.taller) {
    wrong.push(
      `the viewport does not make the stage ${size.taller ? "taller" : "shorter"} than the slide's content: stage ${m.stage.height}, slide ${m.slide.height}, scrolls ${m.scrolls}`,
    );
  }
  if (differ(m.left, m.right)) {
    wrong.push(`the room left of the slide (${m.left}) and right of it (${m.right}) differ`);
  }
  if (taller && differ(m.above, m.below)) {
    wrong.push(`the room above the slide (${m.above}) and below it (${m.below}) differ`);
  }
  if (m.scrolls && (differ(m.above, 0, 1) || differ(m.below, 0, 1))) {
    wrong.push(
      `a slide that scrolls does not keep to the stage's box: room above ${m.above}, below ${m.below}`,
    );
  }
  if (m.scrollTop !== 0 || differ(m.firstRowOffset, m.paddingTop, 1)) {
    wrong.push(
      `the slide does not start at its first row: scrollTop ${m.scrollTop}, first row ${m.firstRowOffset} below the slide's top, padding ${m.paddingTop}`,
    );
  }
  return wrong;
}

/// The Search slide takes the whole of the wide stage.
function judgeSearch(m) {
  const wrong = judgeWideStage(m);
  if (!same(m.slide, m.stage)) {
    wrong.push(
      `the slide does not fill its stage: stage ${JSON.stringify(m.stage)}, slide ${JSON.stringify(m.slide)}`,
    );
  }
  return wrong;
}

/// The About slide's stage is a column in the middle of the tab, narrower than
/// the wide stage, and the slide starts at the column's top left corner and is
/// as tall as the column. The slide's width is left unread: its side padding
/// is added to the column's width.
function judgeAbout(m, wide) {
  const wrong = [];
  const room = m.stageRoom;
  if (differ(room.left, room.right) || !(m.stage.width < wide.stage.width - TOLERANCE)) {
    wrong.push(
      `its stage is not a column in the middle of the tab: ${m.stage.width} wide against ${wide.stage.width}, room left ${room.left}, right ${room.right}`,
    );
  }
  if (differ(m.slide.left, m.stage.left, 1) || differ(m.above, 0, 1) || differ(m.below, 0, 1)) {
    wrong.push(
      `the slide does not start at its stage's corner and take its height: stage ${JSON.stringify(m.stage)}, slide ${JSON.stringify(m.slide)}`,
    );
  }
  return wrong;
}

export default {
  name: "metrics-slide-centered",
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

    const details = { sizes: [], search: null, about: null };
    const failures = [];
    const report = (label, wrong) => {
      for (const line of wrong) failures.push(`${label}: ${line}`);
    };
    const read = async (selector, label) => {
      const boxes = await readBoxes(page, selector);
      if (!boxes) throw new Error(`${label}: the slide did not render its boxes`);
      return boxes;
    };

    try {
      await showSlide(page, "Metrics", ".metrics-slide");
      // The cards arrive with the first sample; the slide before it is two
      // lines tall, which is no slide to measure.
      await page.waitForSelector(".dashboard.active .metrics-slide .details", {
        timeout: 20_000,
      });

      let metrics = null;
      for (const size of SIZES) {
        await resize(page, size);
        const label = `${size.name} (${size.width}x${size.height})`;
        metrics = await read(".metrics-slide", label);
        details.sizes.push({ size: label, ...metrics });
        report(label, judgeMetrics(size, metrics));
      }
      await ctx.shot("wide-tall");

      await showSlide(page, "Search", ".slide-indexing");
      const search = await read(".slide-indexing", "Search");
      details.search = search;
      report("Search", judgeSearch(search));

      await showSlide(page, "About", ".slide-about");
      const about = await read(".slide-about", "About");
      details.about = about;
      report("About", judgeAbout(about, search));

      for (const [label, other] of [["Search", search], ["About", about]]) {
        if (!same(other.controls, metrics.controls)) {
          failures.push(
            `${label}: the controls row is not where it is under Metrics: ${JSON.stringify(other.controls)} against ${JSON.stringify(metrics.controls)}`,
          );
        }
      }

      if (failures.length > 0) {
        const error = new Error(
          `Dashboard slide placement:\n  ${failures.join("\n  ")}`,
        );
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
