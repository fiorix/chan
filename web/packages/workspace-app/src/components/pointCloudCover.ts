export interface PointCloudBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface PointCloudCoverTransform {
  centerX: number;
  centerY: number;
  sourceCenterX: number;
  sourceCenterY: number;
  scale: number;
}

export function fitPointCloudCover(
  width: number,
  height: number,
  bounds: PointCloudBounds,
): PointCloudCoverTransform {
  const sourceWidth = Math.max(Number.EPSILON, bounds.maxX - bounds.minX);
  const sourceHeight = Math.max(Number.EPSILON, bounds.maxY - bounds.minY);

  return {
    centerX: width / 2,
    centerY: height / 2,
    sourceCenterX: (bounds.minX + bounds.maxX) / 2,
    sourceCenterY: (bounds.minY + bounds.maxY) / 2,
    scale: Math.max(width / sourceWidth, height / sourceHeight),
  };
}
