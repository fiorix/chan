export const YURUYURAU_ROTATIONAL_SOURCE_SIZE = 400;
export const YURUYURAU_ROTATIONAL_MAX_RASTER_SCALE = 4;

export function yuruyurauRotationalRasterScale(
  width: number,
  height: number,
  dpr: number,
): number {
  const coverScale =
    Math.max(width, height) / YURUYURAU_ROTATIONAL_SOURCE_SIZE;
  return Math.min(
    YURUYURAU_ROTATIONAL_MAX_RASTER_SCALE,
    Math.max(1, coverScale * Math.max(1, dpr)),
  );
}
