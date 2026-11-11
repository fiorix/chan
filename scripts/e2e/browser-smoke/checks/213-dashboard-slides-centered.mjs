// A Dashboard's Workspace, Search and About slides sit in the middle of their
// stage.
//
// The Workspace and About slides each keep the 720px column the carousel
// centers across the tab and scroll inside it, and their content (the slide's
// title and the rows under it) is as tall as it is. A stage larger than the
// content has room to spare, split evenly left and right of the content and
// above and below it. A stage smaller than the content has none: the content
// starts at the stage's top and the slide scrolls from its first line. That
// last case is where centering a scrollable box goes wrong, since a box
// centered past its container's start keeps the rows above the scroll origin
// out of reach.
//
// The Search slide spans the tab and draws the workspace's directory spine on
// a canvas under its title. The drawn spine is framed in the middle of the
// canvas, with as much room left of it as right and above as below, and the
// workspace root is the disc at its bottom, the spine growing up from it.
// While there is no spine to draw, the slide's note takes the graph's place
// in the middle of the room under the title. A tab that changes size with
// the slide showing frames the spine again in its new canvas.
//
// Measured, not pinned: at check 212's four viewport sizes, and a shorter one
// where the About content no longer fits, the check reads the stage, the
// slide that scrolls inside it and the content, the union of the title's and
// the rows' laid-out boxes, so the reading does not depend on how the slide
// wraps its rows. Each column slide names the sizes whose stage is larger
// than its content, and the check refuses a size that does not put the slide
// in the case it is named for. The Workspace slide shows the runner's seeded
// workspace, which is small, and is measured once its height holds. The
// spine is read from the canvas's own pixels, which it clears to transparent
// before each frame: the painted box is the spine's, and the root is the one
// disc filled with the card colour. The seed has no directories, so the check
// makes a few nested ones for the spine and removes them after. The note is
// shown by answering the slide's indexing-state poll with no directories,
// through the browser's request interception, which leaves every other
// request alone; the resize is read with that poll held unanswered, so the
// layout is at rest and only the new size can move the view. The controls row is read under each slide against its place
// under Metrics at the same size.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../lib/drafts.mjs";

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
// The painted spine reaches past the boxes the graph frames by its discs'
// outline and anti-aliasing, a pixel or so on every side alike. The spine
// framed from its root instead is off by the root's margin from the canvas's
// bottom edge less its disc, tens of pixels.
const GRAPH_TOLERANCE = 3;
const SETTLE_MS = 15_000;
const REST_MS = 4_000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/// The directories the Search slide's spine draws, under one fixture
/// directory: a chain three deep with a branch off it, and a sibling.
const SPINE_DIR = "dashboard-spine-213";
const SPINE_LEAVES = ["alpha/one/two", "alpha/three", "beta"];
const EMPTY_NOTE = "No directories to graph yet.";
const GRAPH = ".slide-indexing .indexing-graph-host canvas";

/// The slides read here. `dot` is the carousel dot that shows the slide and
/// `selector` what the check waits for once it is shown; `measure` reads one
/// size and `judge` returns what is wrong with the reading. A column slide's
/// `rows` select the content's top-level boxes, title first, inside the
/// slide, and `fits` names the sizes whose stage is larger than the content.
/// In Chrome the stage is 135 px shorter than the viewport, the About content
/// is 344 px tall and the seeded Workspace content 488 px: About fits from the
/// 520 px sizes up, with 41 px to spare there, and Workspace only at the
/// 1400 px sizes. `before` and `after` bracket a leg that changes what the
/// slide is served.
const SLIDES = [
  {
    key: "Workspace",
    dot: "Workspace",
    selector: ".slide-workspace",
    // The inspector body's own box, not its host's: a host that grows to
    // the slide's height would read as content that fills the stage.
    rows: [".slide-title", ".workspace-info-host > .info"],
    // The report's own loading line, which its rows replace when it lands.
    pending: ".workspace-info-host > .info > .refs-loading",
    fits: (size) => size.height >= 1400,
    measure: measureColumn,
    judge: judgeColumnSlide,
  },
  {
    key: "About",
    dot: "About",
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
    measure: measureColumn,
    judge: judgeColumnSlide,
  },
  {
    key: "Search",
    dot: "Search",
    selector: GRAPH,
    measure: measureGraph,
    judge: judgeGraph,
  },
  {
    key: "Search note",
    dot: "Search",
    selector: ".slide-indexing .indexing-stub",
    // Through Metrics, so the Search slide mounts again and polls at once.
    before: async (env) => {
      await env.serveEmpty(true);
      await showSlide(env.page, "Metrics", ".metrics-slide");
    },
    after: (env) => env.serveEmpty(false),
    measure: measureNote,
    judge: judgeNote,
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

/// Read until `key` of what `read` answers holds over three more reads a
/// quarter second apart, by `near`, and answer the last reading. A slide read
/// while a row lands, or while the graph eases into its fit, reads a box
/// about to move.
async function steady(read, key, label, near = (a, b) => JSON.stringify(a) === JSON.stringify(b)) {
  const deadline = Date.now() + SETTLE_MS;
  let last = null;
  let runs = 0;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await read();
    const k = seen && !seen.missing ? key(seen) : null;
    runs = k !== null && last !== null && near(k, last) ? runs + 1 : 0;
    last = k;
    if (runs >= 3) return seen;
    await delay(250);
  }
  throw new Error(`${label}: the slide did not settle in ${SETTLE_MS} ms: ${JSON.stringify(seen)}`);
}

/// A column slide's reading, once its content's height holds, with whether a
/// loading line showed. The Workspace slide fills its report and contacts
/// after it mounts. The report's loading line is waited out, up to the settle
/// time, since the report's rows replace it and the content's height decides
/// whether the slide fits; the contacts' lines are not: they read
/// "rebuilding" for as long as the server's index rebuilds, which an earlier
/// check in the run can start, and the content is placed the same way
/// whatever it holds.
async function measureColumn(page, spec, label) {
  const landed = !spec.pending
    ? true
    : await page
        .waitForFunction(
          (slideSelector, pending) => {
            const slide = document.querySelector(`.dashboard.active ${slideSelector}`);
            return slide !== null && slide.querySelector(pending) === null;
          },
          { timeout: SETTLE_MS, polling: 100 },
          spec.selector,
          spec.pending,
        )
        .then(() => true)
        .catch(() => false);
  const held = await steady(
    () =>
      page.evaluate(
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
      ),
    (seen) => seen.height,
    label,
  );
  const m = await readSlide(page, spec);
  return m && { ...m, loading: held.loading, landed };
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

/// The Search slide's canvas and what it painted, in CSS px. `ink` is the box
/// of every pixel the graph painted, relative to the canvas, and `room` the
/// room it leaves to each of the canvas's edges. `root` is the box of the
/// opaque pixels in the root disc's fill, the card colour the graph reads
/// from its host as it paints; `ring` is the outline colour every disc is
/// stroked in, which must differ from it for the root to be told apart.
/// `belowRoot` counts the pixels painted below the root's middle outside its
/// disc's width, with the lowest one's depth: a small zoom leaves only a few
/// fill pixels around the root's icon, so its fill box says where the disc
/// is but not exactly where it ends.
async function readGraph(page) {
  return page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
    await frame();
    await frame();
    const tab = document.querySelector(".dashboard.active");
    const stage = tab?.querySelector(".slide-stage");
    const slide = tab?.querySelector(".slide-indexing");
    const canvas = slide?.querySelector(".indexing-graph-host canvas");
    const controls = tab?.querySelector(".carousel-controls");
    if (!tab || !stage || !slide || !(canvas instanceof HTMLCanvasElement) || !controls) {
      return { missing: "the Search slide's canvas" };
    }
    const context = canvas.getContext("2d");
    const { width, height } = canvas;
    if (!context || width === 0 || height === 0 || canvas.clientWidth === 0) {
      return { missing: "a canvas with a size" };
    }
    const round = (n) => Math.round(n * 10) / 10;
    const box = (r) => ({
      left: round(r.left),
      top: round(r.top),
      width: round(r.width),
      height: round(r.height),
    });
    const host = getComputedStyle(canvas.parentElement);
    const rgba = (color) => {
      const probe = document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      const p = probe.getContext("2d");
      p.fillStyle = color;
      p.fillRect(0, 0, 1, 1);
      return [...p.getImageData(0, 0, 1, 1).data];
    };
    // The same lookups, with the same fallbacks, the graph paints from.
    const card = rgba(host.getPropertyValue("--bg-card").trim() || "#232325");
    const ring = rgba(host.getPropertyValue("--bg").trim() || "#1c1c1e");
    const pixels = context.getImageData(0, 0, width, height).data;
    const ink = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, count: 0 };
    const root = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, count: 0 };
    const grow = (b, x, y) => {
      if (x < b.left) b.left = x;
      if (x > b.right) b.right = x;
      if (y < b.top) b.top = y;
      if (y > b.bottom) b.bottom = y;
      b.count += 1;
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        if (pixels[o + 3] === 0) continue;
        grow(ink, x, y);
        if (
          pixels[o + 3] === 255 &&
          Math.abs(pixels[o] - card[0]) <= 2 &&
          Math.abs(pixels[o + 1] - card[1]) <= 2 &&
          Math.abs(pixels[o + 2] - card[2]) <= 2
        ) {
          grow(root, x, y);
        }
      }
    }
    // Device pixels to CSS px, a painted pixel covering its whole cell.
    const scale = width / canvas.clientWidth;
    const below = { count: 0, bottom: null };
    if (root.count > 0) {
      const middle = (root.top + root.bottom) / 2;
      const pad = Math.ceil(3 * scale);
      for (let y = Math.ceil(middle); y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (x >= root.left - pad && x <= root.right + pad) continue;
          if (pixels[(y * width + x) * 4 + 3] === 0) continue;
          below.count += 1;
          below.bottom = y;
        }
      }
    }
    const css = (b) =>
      b.count === 0
        ? { count: 0 }
        : {
            count: b.count,
            left: round(b.left / scale),
            top: round(b.top / scale),
            right: round((b.right + 1) / scale),
            bottom: round((b.bottom + 1) / scale),
            width: round((b.right + 1 - b.left) / scale),
            height: round((b.bottom + 1 - b.top) / scale),
          };
    const painted = css(ink);
    const c = canvas.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    return {
      stage: box(stage.getBoundingClientRect()),
      slide: box(slide.getBoundingClientRect()),
      canvas: box(c),
      controls: box(controls.getBoundingClientRect()),
      canvasRoom: { left: round(c.left - t.left), right: round(t.right - c.right) },
      ink: painted,
      root: css(root),
      belowRoot: {
        count: below.count,
        bottom: below.bottom === null ? null : round((below.bottom + 1) / scale),
      },
      room:
        painted.count === 0
          ? null
          : {
              left: painted.left,
              right: round(c.width - painted.right),
              above: painted.top,
              below: round(c.height - painted.bottom),
            },
      card: card.join(","),
      ring: ring.join(","),
      scale,
    };
  });
}

/// The Search slide's spine once its fit holds: the graph eases into its fit
/// over a second or so after it mounts or its directories change. The
/// spine's and the root's boxes are what hold, to a pixel: the directories
/// being indexed pulse, which fades the outer pixels of their discs in and
/// out of the painted set, and each poll of the indexing state warms the
/// layout a little.
async function measureGraph(page, spec, label) {
  const edges = (b) => [b.left, b.top, b.right, b.bottom];
  return steady(
    () => readGraph(page),
    (m) => (m.room && m.root.count > 0 ? [...edges(m.ink), ...edges(m.root)] : null),
    label,
    (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1),
  );
}

/// The Search slide's note against the room under the title, in CSS px.
/// `note` is the union of the note's lines; the room above it starts below
/// the title and the gap the slide keeps under it.
async function readNote(page) {
  return page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
    await frame();
    await frame();
    const tab = document.querySelector(".dashboard.active");
    const stage = tab?.querySelector(".slide-stage");
    const slide = tab?.querySelector(".slide-indexing");
    const title = slide?.querySelector(":scope > .slide-title");
    const note = slide?.querySelector(":scope > .indexing-stub");
    const controls = tab?.querySelector(".carousel-controls");
    if (!tab || !stage || !slide || !title || !note || !controls) {
      return { missing: "the Search slide's title and note" };
    }
    const lines = [...note.querySelectorAll("p")].map((p) => p.getBoundingClientRect());
    if (lines.length === 0) return { missing: "the note's lines" };
    const round = (n) => Math.round(n * 10) / 10;
    const box = (r) => ({
      left: round(r.left),
      top: round(r.top),
      width: round(r.width),
      height: round(r.height),
    });
    const n = {
      left: Math.min(...lines.map((r) => r.left)),
      top: Math.min(...lines.map((r) => r.top)),
      right: Math.max(...lines.map((r) => r.right)),
      bottom: Math.max(...lines.map((r) => r.bottom)),
    };
    const s = slide.getBoundingClientRect();
    const roomTop = title.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(slide).rowGap) || 0);
    return {
      text: note.textContent.replace(/\s+/g, " ").trim(),
      stage: box(stage.getBoundingClientRect()),
      slide: box(s),
      note: box({ left: n.left, top: n.top, width: n.right - n.left, height: n.bottom - n.top }),
      controls: box(controls.getBoundingClientRect()),
      left: round(n.left - s.left),
      right: round(s.right - n.right),
      above: round(n.top - roomTop),
      below: round(s.bottom - n.bottom),
    };
  });
}

async function measureNote(page, spec, label) {
  return steady(() => readNote(page), (m) => [m.text, m.note], label);
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

/// The Search slide's spine: the slide taking the wide stage's box, the
/// canvas in the middle of the tab, the painted spine in the middle of the
/// canvas on both axes, and the root's disc at the spine's bottom with the
/// spine reaching above it.
function judgeGraph(spec, size, m) {
  const wrong = [];
  if (!sameBox(m.slide, m.stage)) {
    wrong.push(
      `the slide does not take the stage's box: stage ${JSON.stringify(m.stage)}, slide ${JSON.stringify(m.slide)}`,
    );
  }
  if (differ(m.canvasRoom.left, m.canvasRoom.right)) {
    wrong.push(
      `the canvas is not in the middle of the tab: room left ${m.canvasRoom.left}, right ${m.canvasRoom.right}`,
    );
  }
  if (!m.room) {
    wrong.push("the canvas painted nothing");
    return wrong;
  }
  if (differ(m.room.left, m.room.right, GRAPH_TOLERANCE)) {
    wrong.push(`the room left of the spine (${m.room.left}) and right of it (${m.room.right}) differ`);
  }
  if (differ(m.room.above, m.room.below, GRAPH_TOLERANCE)) {
    wrong.push(`the room above the spine (${m.room.above}) and below it (${m.room.below}) differ`);
  }
  if (m.card === m.ring) {
    wrong.push(`the root's fill and every disc's outline share one colour (${m.card}): the root cannot be told apart`);
  } else if (m.root.count === 0) {
    wrong.push(`no disc is filled with the root's colour (${m.card})`);
  } else {
    if (m.belowRoot.count > 0) {
      wrong.push(
        `${m.belowRoot.count} pixels are painted below the root's middle outside its disc, down to ${m.belowRoot.bottom} px: the root is not at the spine's bottom`,
      );
    }
    if (m.root.top - m.ink.top < m.root.height) {
      wrong.push(
        `the spine reaches only ${m.root.top - m.ink.top} px above the root's disc, ${m.root.height} px tall: it does not grow up from the root`,
      );
    }
  }
  return wrong;
}

/// The Search slide's note: the empty spine's line, across the slide in its
/// middle and in the middle of the room under the title.
function judgeNote(spec, size, m) {
  const wrong = [];
  if (!m.text.startsWith(EMPTY_NOTE)) {
    wrong.push(`the note reads ${JSON.stringify(m.text)}, not the empty spine's`);
  }
  if (!sameBox(m.slide, m.stage)) {
    wrong.push(
      `the slide does not take the stage's box: stage ${JSON.stringify(m.stage)}, slide ${JSON.stringify(m.slide)}`,
    );
  }
  if (differ(m.left, m.right)) {
    wrong.push(`the room left of the note (${m.left}) and right of it (${m.right}) differ`);
  }
  if (differ(m.above, m.below)) {
    wrong.push(`the room above the note, under the title (${m.above}), and below it (${m.below}) differ`);
  }
  return wrong;
}

/// Make the spine's directories, each with a note in it, and wait until the
/// indexing state lists the deepest, so the slide's first poll draws them.
async function makeSpine(ctx) {
  const root = join(ctx.workspaceDir, SPINE_DIR);
  for (const leaf of SPINE_LEAVES) {
    const dir = join(root, leaf);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "note.md"), `# ${leaf}\n`);
  }
  const deepest = `${SPINE_DIR}/${SPINE_LEAVES[0]}`;
  const deadline = Date.now() + 30_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await request(ctx, "/api/indexing/state");
    if (last.status === 200 && last.json?.nodes?.some((n) => n.path === deepest)) {
      return last.json.nodes.length;
    }
    await delay(250);
  }
  throw new Error(`the indexing state never listed ${deepest}: ${last?.status} ${last?.text?.slice(0, 200)}`);
}

export default {
  name: "dashboard-slides-centered",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const spineRoot = join(ctx.workspaceDir, SPINE_DIR);
    const cdp = await page.createCDPSession();
    // The slide's indexing-state poll, while intercepted, is either answered
    // with a spine of no directories ("empty") or left waiting ("hold");
    // every other request is never paused.
    let mode = null;
    let answered = 0;
    const held = [];
    cdp.on("Fetch.requestPaused", (event) => {
      if (mode === "hold") {
        held.push(event.requestId);
        return;
      }
      answered += 1;
      const body = JSON.stringify({ root: ctx.workspaceDir, nodes: [] });
      cdp
        .send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(body).toString("base64"),
        })
        .catch(() => {});
    });
    const intercept = async (next) => {
      if (next !== null && mode === null) {
        await cdp.send("Fetch.enable", {
          patterns: [{ urlPattern: "*/api/indexing/state*", requestStage: "Request" }],
        });
      }
      mode = next;
      if (next === null) {
        for (const requestId of held.splice(0)) {
          await cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
        }
        await cdp.send("Fetch.disable");
      }
    };
    const env = {
      page,
      serveEmpty: (on) => intercept(on ? "empty" : null),
    };

    const details = { sizes: [] };
    const failures = [];
    let stopped = false;
    try {
      details.spineNodes = await makeSpine(ctx);
      await dispatch(page, "app.dashboard.open");
      await page.waitForSelector(".dashboard.active .carousel", { timeout: 20_000 });
      const tabs = await page.evaluate(
        () => document.querySelectorAll(".dashboard.active").length,
      );
      if (tabs !== 1) throw new Error(`expected one visible Dashboard tab, found ${tabs}`);
      stopped = await setCycling(page, false);

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
          const label = `${spec.key}, ${size.name} (${sizeLabel})`;
          await spec.before?.(env);
          try {
            await showSlide(page, spec.dot, spec.selector);
            const m = await spec.measure(page, spec, label);
            if (!m) throw new Error(`${label}: the slide did not render its boxes`);
            entry.slides[spec.key] = m;
            await ctx.shot(`${spec.key.toLowerCase().replace(/ /g, "-")}-${sizeLabel}`);
            for (const line of spec.judge(spec, size, m)) failures.push(`${label}: ${line}`);
            if (!same(m.controls, controls)) {
              failures.push(
                `${label}: the controls row is not where it is under Metrics: ${JSON.stringify(m.controls)} against ${JSON.stringify(controls)}`,
              );
            }
          } finally {
            await spec.after?.(env);
          }
        }
      }
      details.answeredEmpty = answered;

      // The tab changes size with the Search slide showing: from the last
      // size, with the spine fitted there, to the wide, tall one, with no
      // other slide shown in between. Each poll answered warms the layout,
      // and the graph follows a moving layout anyway, so the polls are held
      // and the layout left to rest first: the new size alone has to frame
      // the spine again.
      const from = SIZES[SIZES.length - 1];
      const to = SIZES[3];
      const resized = `Search resized from ${from.width}x${from.height} to ${to.width}x${to.height}`;
      await showSlide(page, "Metrics", ".metrics-slide");
      await showSlide(page, "Search", GRAPH);
      await measureGraph(page, null, `${resized}, before`);
      await intercept("hold");
      // A poll answered just before the hold warms the layout for under 3 s.
      await delay(REST_MS);
      details.resizedFrom = await measureGraph(page, null, `${resized}, at rest`);
      await resize(page, to);
      const m = await measureGraph(page, null, resized);
      details.heldPolls = held.length;
      await intercept(null);
      details.resized = m;
      await ctx.shot(`search-resized-${to.width}x${to.height}`);
      for (const line of judgeGraph(null, to, m)) failures.push(`${resized}: ${line}`);
      const toControls = details.sizes.find((entry) =>
        entry.size.endsWith(`(${to.width}x${to.height})`),
      )?.controls;
      if (!same(m.controls, toControls)) {
        failures.push(
          `${resized}: the controls row is not where it is under Metrics: ${JSON.stringify(m.controls)} against ${JSON.stringify(toControls)}`,
        );
      }

      if (failures.length > 0) {
        const error = new Error(`Dashboard slide placement:\n  ${failures.join("\n  ")}`);
        error.smokeDetails = details;
        throw error;
      }
      return details;
    } finally {
      await intercept(null).catch(() => {});
      await cdp.detach().catch(() => {});
      await page.setViewport({ width: 1600, height: 1000 }).catch(() => {});
      if (stopped) await setCycling(page, true).catch(() => {});
      rmSync(spineRoot, { recursive: true, force: true });
    }
  },
};
