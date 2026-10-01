/**
 * Perceptual color blending for the text reveal.
 *
 * Mixing in raw sRGB bunches the visible change at one end of a fade: equal
 * steps in sRGB are not equal steps in perceived lightness. OKLab (Björn
 * Ottosson, 2020) is built so that its L axis tracks perceived lightness, so
 * interpolating there gives a fade whose brightness rises evenly frame to
 * frame. Matrices are Ottosson's published sRGB (D65) values.
 *
 * @module cli/smoke-reveal.oklab
 */

import type { Rgb } from './smoke-reveal.tones.js';

export type Lab = readonly [number, number, number];

function toLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function fromLinear(x: number): number {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, c * 255));
}

/** sRGB (0-255) to OKLab. */
export function rgbToOklab(rgb: Rgb): Lab {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to sRGB (0-255, clamped, unrounded). */
export function oklabToRgb(lab: Lab): Rgb {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Perceived lightness (OKLab L, 0-1) of an sRGB color. */
export function lightness(rgb: Rgb): number {
  return rgbToOklab(rgb)[0];
}

/** Blend two sRGB colors at `t` in [0, 1] through OKLab. */
export function mixOklab(a: Rgb, b: Rgb, t: number): Rgb {
  const c = Math.min(1, Math.max(0, t));
  if (c === 0) return a;
  if (c === 1) return b;
  const x = rgbToOklab(a);
  const y = rgbToOklab(b);
  return oklabToRgb([x[0] + (y[0] - x[0]) * c, x[1] + (y[1] - x[1]) * c, x[2] + (y[2] - x[2]) * c]);
}
