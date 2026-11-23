/** sRGB components with straight alpha. */
export type Color = readonly [number, number, number, number];

/** Hex and numeric rgb/rgba, including the transparent terminal backdrop. */
export function parseColor(css: string | undefined): Color | undefined {
  if (!css) return undefined;
  if (css.trim() === 'transparent') return [0, 0, 0, 0];
  const hex = css.trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    const bytes = digits.match(/../g)!.map(c => Number.parseInt(c, 16));
    return [bytes[0], bytes[1], bytes[2], (bytes[3] ?? 255) / 255];
  }
  const rgb = css.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!rgb) return undefined;
  const values = rgb.slice(1, 4).map(Number);
  const alpha = Number(rgb[4] ?? 1);
  if (values.some(c => !Number.isFinite(c) || c < 0 || c > 255) || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return undefined;
  return [values[0], values[1], values[2], alpha];
}

export function rgbColor(rgb: number): Color {
  return [(rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255, 1];
}

/** The renderer composites selection/highlights directly onto the row fill. */
export function compositeColor(over: Color, under: Color | undefined): Color {
  if (over[3] === 1) return over;
  const base = under ?? [0, 0, 0, 0];
  const alpha = over[3] + base[3] * (1 - over[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (i: number) => (over[i] * over[3] + base[i] * base[3] * (1 - over[3])) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

function luminance(color: Color): number {
  const linear = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** Move ink toward the higher-contrast endpoint, only as far as needed. */
export function contrastingColor(foreground: number, background: Color, ratio: number): number {
  const ink = rgbColor(foreground);
  const bg = luminance(background);
  const contrast = (color: Color) => {
    const fg = luminance(color);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  };
  if (contrast(ink) >= ratio) return foreground;
  const target = (bg + 0.05) / 0.05 >= 1.05 / (bg + 0.05) ? 0 : 255;
  const endpoint: Color = [target, target, target, 1];
  // Some backgrounds cannot meet the requested ratio with any sRGB ink.
  if (contrast(endpoint) < ratio) return target === 0 ? 0 : 0xffffff;
  const at = (t: number): Color => [
    Math.round(ink[0] + (target - ink[0]) * t),
    Math.round(ink[1] + (target - ink[1]) * t),
    Math.round(ink[2] + (target - ink[2]) * t), 1,
  ];
  let low = 0, high = 1;
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2;
    if (contrast(at(middle)) >= ratio) high = middle;
    else low = middle;
  }
  const result = at(high);
  return (result[0] << 16) | (result[1] << 8) | result[2];
}
