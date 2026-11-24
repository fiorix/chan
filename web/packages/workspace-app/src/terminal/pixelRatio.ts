/// What the watch needs of a window. Injectable so a test changes the ratio
/// without a display.
export type PixelRatioHost = {
  devicePixelRatio: number;
  matchMedia?: (query: string) => Pick<MediaQueryList, "addEventListener" | "removeEventListener">;
};

/// Calls `changed` each time the window's device pixel ratio changes: a move
/// to a display of another density, or a zoom. The widget measures its cell
/// again at the new ratio, which resizes its canvas while the host element
/// keeps its size, so no ResizeObserver fires and the grid has to be fitted
/// again from here. A resolution query matches one ratio, so each change
/// arms a query for the ratio it led to. Returns the function that stops it.
export function watchDevicePixelRatio(changed: () => void, host: PixelRatioHost = window): () => void {
  let stop = (): void => {};
  const arm = (): void => {
    const query = host.matchMedia?.(`(resolution: ${host.devicePixelRatio}dppx)`);
    if (!query) return;
    const onChange = (): void => {
      stop();
      arm();
      changed();
    };
    query.addEventListener("change", onChange);
    stop = () => query.removeEventListener("change", onChange);
  };
  arm();
  return () => {
    stop();
    stop = () => {};
  };
}
