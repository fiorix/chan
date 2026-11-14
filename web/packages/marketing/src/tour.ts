import { anchorOpeningBeat, beatIndex, beatPosition, moveProgress } from "./tourProgress";

// A tour walks one drawn scene through a pose per beat. This script only
// publishes where the reader is; what the scene does with it is the page's CSS:
//
//   --k1 .. --kN     eased progress of the move from beat N to beat N+1
//   --fit            scale that fits the scene's reference box in the stage
//   data-current     name of the current beat, on the tour
//   aria-current     on that beat
//   .is-on           on an element from its data-from beat onward
//   .is-at           on an element during the beats its data-at lists
//
// A tour moves by scroll: its stage is pinned and each beat is a block of copy
// that scrolls past. A stepped figure (data-tour="steps") moves by its own
// controls: each beat is a step with a button, and the figure plays through
// them while it is on screen until the reader picks one. Without the script
// either is a still scene beside its beats.

/** Time constant of the glide toward the scrolled position, so a wheel notch lands as one move. */
const FOLLOW_MS = 110;
/** The same for a stepped figure, where one step is one whole move. */
const STEP_FOLLOW_MS = 260;
/** How long a stepped figure rests on a step while it plays. */
const STEP_REST_MS = 3400;
/** How long a beat's pose rests on either side of its centre, in beats. */
const HOLD = 0.2;
/** The same for the beat a page opens on: nobody is scrolling past it, so the scene answers the first scroll. */
const OPENING_HOLD = 0.02;

function startTour(tour: HTMLElement): void {
  const stage = tour.querySelector<HTMLElement>(".tour-stage");
  const beats = Array.from(tour.querySelectorAll<HTMLElement>("[data-beat]"));
  if (!stage || beats.length < 2) return;

  const stepped = tour.dataset.tour === "steps";
  const names = beats.map((beat) => beat.dataset.beat ?? "");
  const fromMarks = Array.from(tour.querySelectorAll<HTMLElement>("[data-from]"));
  const atMarks = Array.from(tour.querySelectorAll<HTMLElement>("[data-at]"));
  const parts = Array.from(stage.querySelectorAll<HTMLAnchorElement>("a[data-part]"));
  const callout = stage.querySelector<HTMLElement>(".tour-callout");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const followMs = stepped ? STEP_FOLLOW_MS : FOLLOW_MS;

  let centers: number[] = [];
  let opensPage = false;
  let focus = 0;
  let target = 0;
  let shown = Number.NaN;
  let current = -1;
  let frame = 0;
  let lastFrame = 0;
  let awake: HTMLAnchorElement | null = null;

  // A part wakes under the pointer or at a first tap: it lights up and the
  // callout says what it is. Only a part that is already awake follows its link.
  function wake(part: HTMLAnchorElement | null): void {
    awake?.classList.remove("is-awake");
    awake = part;
    part?.classList.add("is-awake");
    if (!callout) return;
    callout.hidden = !part;
    if (!part) return;
    const [title, line, link] = [callout.querySelector("b"), callout.querySelector("span"), callout.querySelector("a")];
    if (title) title.textContent = part.dataset.part ?? "";
    if (line) line.textContent = part.dataset.line ?? "";
    if (link) link.href = part.href;
  }

  function setBeat(index: number): void {
    current = index;
    tour.dataset.current = names[index];
    beats.forEach((beat, at) => (at === index ? beat.setAttribute("aria-current", "step") : beat.removeAttribute("aria-current")));
    for (const mark of fromMarks) mark.classList.toggle("is-on", index >= names.indexOf(mark.dataset.from ?? ""));
    for (const mark of atMarks) mark.classList.toggle("is-at", (mark.dataset.at ?? "").split(/\s+/).includes(names[index]));
    wake(null);
  }

  function apply(position: number): void {
    for (let move = 0; move < beats.length - 1; move += 1) {
      const holdStart = move === 0 && opensPage ? OPENING_HOLD : HOLD;
      tour.style.setProperty(`--k${move + 1}`, moveProgress(position, move, holdStart, HOLD).toFixed(4));
    }
    const index = beatIndex(position, beats.length);
    if (index !== current) setBeat(index);
  }

  function step(now: number): void {
    frame = 0;
    const elapsed = Math.min(64, now - lastFrame);
    lastFrame = now;
    if (Number.isNaN(shown)) shown = target;
    else if (reducedMotion.matches) shown = beatIndex(target, beats.length);
    else shown += (target - shown) * (1 - Math.exp(-elapsed / followMs));
    if (Math.abs(target - shown) < 0.0005) shown = target;
    apply(shown);
    if (shown !== target && !reducedMotion.matches) schedule();
  }

  function schedule(): void {
    if (frame) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(step);
  }

  function fit(): void {
    const style = getComputedStyle(tour);
    const number = (name: string, fallback: number) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
    focus = window.innerHeight * number("--tour-focus", 0.5);
    const scale = Math.min(stage!.clientWidth / number("--scene-w", stage!.clientWidth), stage!.clientHeight / number("--scene-h", stage!.clientHeight));
    tour.style.setProperty("--fit", scale.toFixed(4));
  }

  function followScroll(): void {
    const scroll = () => {
      target = beatPosition(centers, window.scrollY + focus);
      schedule();
    };
    const measure = () => {
      fit();
      const boxes = beats.map((beat) => beat.getBoundingClientRect());
      ({ centers, opensPage } = anchorOpeningBeat(
        boxes.map((box) => box.top + window.scrollY + box.height / 2),
        boxes[0].top + window.scrollY,
        focus,
      ));
      scroll();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(tour);
    observer.observe(stage!);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", scroll, { passive: true });
    reducedMotion.addEventListener("change", scroll);
    measure();
  }

  function followSteps(): void {
    const play = tour.querySelector<HTMLButtonElement>("[data-tour-play]");
    // It plays until the reader picks a step, and rests while the pointer or the focus is on it.
    let playing = !reducedMotion.matches;
    let visible = false;
    let attended = false;
    let timer = 0;

    const rest = () => {
      window.clearTimeout(timer);
      if (play) {
        play.textContent = playing ? "Pause" : "Play";
        play.setAttribute("aria-pressed", String(playing));
      }
      if (!playing || !visible || attended || reducedMotion.matches) return;
      timer = window.setTimeout(() => {
        target = (Math.round(target) + 1) % beats.length;
        schedule();
        rest();
      }, STEP_REST_MS);
    };
    const pick = (index: number) => {
      playing = false;
      target = index;
      schedule();
      rest();
    };

    beats.forEach((beat, index) => {
      beat.querySelector<HTMLButtonElement>("button.tour-step")?.addEventListener("click", () => pick(index));
    });
    play?.addEventListener("click", () => {
      playing = !playing;
      rest();
    });
    for (const [on, off] of [["pointerenter", "pointerleave"], ["focusin", "focusout"]] as const) {
      tour.addEventListener(on, () => {
        attended = true;
        rest();
      });
      tour.addEventListener(off, () => {
        attended = tour.matches(":hover, :focus-within");
        rest();
      });
    }
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        rest();
      },
      { threshold: 0.5 },
    ).observe(stage!);
    new ResizeObserver(fit).observe(stage!);
    reducedMotion.addEventListener("change", rest);
    fit();
    schedule();
    rest();
  }

  for (const part of parts) {
    part.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") wake(part);
    });
    part.addEventListener("click", (event) => {
      if (awake === part) return;
      event.preventDefault();
      wake(part);
    });
  }

  tour.classList.add("tour-live");
  if (stepped) followSteps();
  else followScroll();
}

document.querySelectorAll<HTMLElement>("[data-tour]").forEach(startTour);
