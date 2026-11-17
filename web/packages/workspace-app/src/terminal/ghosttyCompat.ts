export type CellDimensions = {
  width: number;
  height: number;
};

type FontMeasurement = {
  width: number;
  height: number;
};

type GhosttyScrollbarClickSource = {
  handlePointerDown?: (event: PointerEvent) => void;
  scrollbarOpacity?: number;
};

const XTERM_DOM_MEASURE_REPETITIONS = 32;

/// Reproduce xterm.js's device-pixel cell rounding from an already measured
/// "W". Keeping this pure makes the renderer alignment independently testable.
export function xtermCellDimensionsFromMeasurement(
  measurement: FontMeasurement,
  devicePixelRatio: number,
  lineHeight: number,
): CellDimensions | null {
  if (
    !Number.isFinite(measurement.width) ||
    !Number.isFinite(measurement.height) ||
    !Number.isFinite(devicePixelRatio) ||
    !Number.isFinite(lineHeight) ||
    measurement.width <= 0 ||
    measurement.height <= 0 ||
    devicePixelRatio <= 0 ||
    lineHeight < 1
  ) {
    return null;
  }

  const deviceCharWidth = Math.floor(
    measurement.width * devicePixelRatio,
  );
  const deviceCharHeight = Math.ceil(
    measurement.height * devicePixelRatio,
  );
  const deviceCellHeight = Math.floor(deviceCharHeight * lineHeight);
  if (deviceCharWidth <= 0 || deviceCellHeight <= 0) return null;

  return {
    width: deviceCharWidth / devicePixelRatio,
    height: deviceCellHeight / devicePixelRatio,
  };
}

/// Measure the same glyph, font box, and fallback DOM span used by xterm.js.
/// Ghostty measures "M" ink bounds and adds two pixels; that produces a
/// different grid even when both terminals receive the same font options.
export function measureXtermCellDimensions(
  parent: HTMLElement,
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
): CellDimensions | null {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const canvasMeasurement = measureWithTextMetrics(fontFamily, fontSize);
  if (canvasMeasurement) {
    return xtermCellDimensionsFromMeasurement(
      canvasMeasurement,
      devicePixelRatio,
      lineHeight,
    );
  }

  const span = document.createElement("span");
  span.classList.add("xterm-char-measure-element");
  span.textContent = "W".repeat(XTERM_DOM_MEASURE_REPETITIONS);
  span.setAttribute("aria-hidden", "true");
  span.style.whiteSpace = "pre";
  span.style.fontKerning = "none";
  span.style.fontFamily = fontFamily;
  span.style.fontSize = `${fontSize}px`;
  parent.appendChild(span);
  try {
    return xtermCellDimensionsFromMeasurement(
      {
        width: span.offsetWidth / XTERM_DOM_MEASURE_REPETITIONS,
        height: span.offsetHeight,
      },
      devicePixelRatio,
      lineHeight,
    );
  } finally {
    span.remove();
  }
}



/// ghostty-web claims pointerdown across its overlay scrollbar strip whenever
/// the buffer holds scrollback rather than while the overlay is visible, and
/// stops immediate propagation, so nothing downstream can recover the event.
/// Those pixels are content under chan's full-width grid, so an invisible
/// overlay would swallow a press meant to place a selection in the last
/// columns. Bind ghostty's own handler behind its own opacity, the same state
/// that decides whether the user can see a scrollbar to aim at; a second copy
/// of the fade timing would be a second answer to when a press means scroll.
/// The handler does nothing outside the strip, so gating the whole listener
/// costs no other behavior. Returns the listener cleanup, or null if the
/// pinned build stops exposing the handler or the opacity, in which case its
/// hidden press region stays live.
export function gateGhosttyScrollbarClicks(
  terminal: object,
  host: HTMLElement,
): (() => void) | null {
  const source = terminal as GhosttyScrollbarClickSource;
  const claimStrip = source.handlePointerDown;
  if (
    typeof claimStrip !== "function" ||
    !Object.prototype.hasOwnProperty.call(terminal, "scrollbarOpacity")
  ) {
    return null;
  }

  const gated = (event: PointerEvent): void => {
    if ((source.scrollbarOpacity ?? 0) > 0) claimStrip(event);
  };
  // Upstream registers its own listener in open() with capture, so the removal
  // has to match those options for the gate to be the only claimant.
  host.removeEventListener("pointerdown", claimStrip, true);
  host.addEventListener("pointerdown", gated, true);
  return () => host.removeEventListener("pointerdown", gated, true);
}

function measureWithTextMetrics(
  fontFamily: string,
  fontSize: number,
): FontMeasurement | null {
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    const context = new OffscreenCanvas(100, 100).getContext("2d");
    if (!context) return null;
    const supportProbe = context.measureText("W");
    if (
      !("fontBoundingBoxAscent" in supportProbe) ||
      !("fontBoundingBoxDescent" in supportProbe)
    ) {
      return null;
    }
    context.font = `${fontSize}px ${fontFamily}`;
    const metrics = context.measureText("W");
    return {
      width: metrics.width,
      height:
        metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
    };
  } catch {
    return null;
  }
}
