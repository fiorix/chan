// The node discs a graph canvas paints, read from the page. GraphCanvas draws
// a node as a full circle followed by its glyph's image, under the one
// transform it sets for the frame, and starts each frame by clearing the
// canvas. The trace keeps, per canvas, the discs of the last frame in device
// pixels; the context's own methods do the drawing, the trace only reads
// their arguments. A label or an edge is not a disc, so the box of the discs
// is the box of the nodes, which is what the graph's fit frames.

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/// CSS pixels the graph keeps between the workspace's node and the bottom
/// edge of its canvas, where it seats that node halfway across: GraphCanvas's
/// bottom anchor.
const ROOT_BOTTOM_MARGIN = 56;

/// Start recording the discs of every canvas under `hostSelector`. Install it
/// before the graph first paints: a graph at rest paints nothing new.
export async function traceGraphDiscs(page, hostSelector) {
  await page.evaluate((host) => {
    if (window.__smokeGraphDiscs) return;
    const proto = CanvasRenderingContext2D.prototype;
    const original = { clearRect: proto.clearRect, arc: proto.arc, drawImage: proto.drawImage };
    const frames = new WeakMap();
    proto.clearRect = function (...args) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest(host)) {
        frames.set(this.canvas, { discs: [], arc: null });
      }
      return original.clearRect.apply(this, args);
    };
    proto.arc = function (x, y, radius, ...rest) {
      const frame = frames.get(this.canvas);
      if (frame) {
        const m = this.getTransform();
        frame.arc = { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, r: radius * Math.hypot(m.a, m.b) };
      }
      return original.arc.call(this, x, y, radius, ...rest);
    };
    proto.drawImage = function (image, ...rest) {
      const frame = frames.get(this.canvas);
      if (frame?.arc && image instanceof HTMLImageElement) {
        frame.discs.push(frame.arc);
        frame.arc = null;
      }
      return original.drawImage.call(this, image, ...rest);
    };
    window.__smokeGraphDiscs = { frames, original };
  }, hostSelector);
}

/// Put the context's methods back; the page can outlive the check.
export async function untraceGraphDiscs(page) {
  await page.evaluate(() => {
    const traced = window.__smokeGraphDiscs;
    if (!traced) return;
    Object.assign(CanvasRenderingContext2D.prototype, traced.original);
    delete window.__smokeGraphDiscs;
  });
}

/// The last frame's discs on the canvas under `hostSelector`, in device
/// pixels: how many, their box, the room it leaves to each edge, and how far
/// the disc nearest the root's seat is from it, `[across, down]`.
export function readGraphDiscs(page, hostSelector) {
  return page.evaluate(({ host, margin }) => {
    const canvas = document.querySelector(`${host} canvas`);
    const frame = canvas && window.__smokeGraphDiscs?.frames.get(canvas);
    if (!canvas || !frame) return { missing: `no traced frame on ${host} canvas` };
    const { discs } = frame;
    if (discs.length === 0) return { canvas: [canvas.width, canvas.height], count: 0 };
    const round = (n) => Math.round(n * 10) / 10;
    const left = Math.min(...discs.map((d) => d.x - d.r));
    const right = Math.max(...discs.map((d) => d.x + d.r));
    const top = Math.min(...discs.map((d) => d.y - d.r));
    const bottom = Math.max(...discs.map((d) => d.y + d.r));
    const scale = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    const seat = { x: canvas.width / 2, y: canvas.height - margin * scale };
    const off = (d) => Math.hypot(d.x - seat.x, d.y - seat.y);
    const nearest = discs.reduce((best, d) => (off(d) < off(best) ? d : best));
    return {
      canvas: [canvas.width, canvas.height],
      count: discs.length,
      box: [round(left), round(top), round(right), round(bottom)],
      room: { left: round(left), right: round(canvas.width - right), above: round(top), below: round(canvas.height - bottom) },
      rootOff: [round(nearest.x - seat.x), round(nearest.y - seat.y)],
    };
  }, { host: hostSelector, margin: ROOT_BOTTOM_MARGIN });
}

/// The discs once their box holds: two reads `gap` ms apart within a pixel on
/// every side and with the same count. The graph eases into its fit as the
/// layout settles, over a second or so.
export async function steadyGraphDiscs(page, hostSelector, { gap = 600, timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readGraphDiscs(page, hostSelector);
  for (;;) {
    await delay(gap);
    const next = await readGraphDiscs(page, hostSelector);
    const held =
      next.box && last.box && next.count === last.count &&
      next.box.every((v, i) => Math.abs(v - last.box[i]) <= 1);
    if (held) return next;
    if (Date.now() > deadline) throw new Error(`the graph's discs did not hold still in ${timeoutMs} ms: ${JSON.stringify(next)}`);
    last = next;
  }
}

/// Failures of a rooted graph: a disc for each of the `expected` nodes the
/// status line counts, every disc inside the canvas, and one of them on the
/// root's seat, halfway across and `ROOT_BOTTOM_MARGIN` above the bottom
/// edge, within `tolerance` device pixels. The workspace's drafts are drawn
/// and not counted, so more discs than `expected` is not a failure.
export function rootedFailures(read, expected, tolerance = 3) {
  if (!read.room || !read.rootOff) return [`nothing framed: ${JSON.stringify(read)}`];
  const failures = [];
  if (read.count < expected) failures.push(`${read.count} discs painted for ${expected} counted nodes`);
  for (const [side, px] of Object.entries(read.room)) {
    if (px < 0) failures.push(`a node is ${-px} px past the canvas's ${side === "left" || side === "right" ? side : side === "above" ? "top" : "bottom"} edge`);
  }
  const [across, down] = read.rootOff;
  if (Math.abs(across) > tolerance || Math.abs(down) > tolerance) {
    failures.push(`no node on the root's seat: the nearest is ${across} px across and ${down} px down from it`);
  }
  return failures;
}
