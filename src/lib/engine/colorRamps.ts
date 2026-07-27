import type { ColorRampName } from './types';

export interface ColorStop {
  t: number; // 0..1
  r: number; g: number; b: number; // 0..255
}

export const COLOR_RAMPS: Record<ColorRampName, ColorStop[]> = {
  jet: [
    { t: 0.0, r: 0, g: 0, b: 131 },
    { t: 0.125, r: 0, g: 60, b: 255 },
    { t: 0.375, r: 0, g: 255, b: 255 },
    { t: 0.625, r: 255, g: 255, b: 0 },
    { t: 0.875, r: 255, g: 0, b: 0 },
    { t: 1.0, r: 128, g: 0, b: 0 },
  ],
  viridis: [
    { t: 0.0, r: 68, g: 1, b: 84 },
    { t: 0.25, r: 59, g: 82, b: 139 },
    { t: 0.5, r: 33, g: 145, b: 140 },
    { t: 0.75, r: 94, g: 201, b: 98 },
    { t: 1.0, r: 253, g: 231, b: 37 },
  ],
  diverging: [
    { t: 0.0, r: 5, g: 48, b: 97 },
    { t: 0.5, r: 247, g: 247, b: 247 },
    { t: 1.0, r: 103, g: 0, b: 31 },
  ],
  thermal: [
    { t: 0.0, r: 0, g: 0, b: 0 },
    { t: 0.3, r: 120, g: 0, b: 0 },
    { t: 0.6, r: 255, g: 80, b: 0 },
    { t: 0.85, r: 255, g: 220, b: 0 },
    { t: 1.0, r: 255, g: 255, b: 255 },
  ],
  cool_warm: [
    { t: 0.0, r: 59, g: 76, b: 192 },
    { t: 0.5, r: 221, g: 221, b: 221 },
    { t: 1.0, r: 180, g: 4, b: 38 },
  ],
};

export function sampleRamp(ramp: ColorRampName, t: number): [number, number, number] {
  const stops = COLOR_RAMPS[ramp];
  const tt = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (tt >= stops[i].t && tt <= stops[i + 1].t) {
      const f = (tt - stops[i].t) / (stops[i + 1].t - stops[i].t || 1);
      return [
        Math.round(stops[i].r + f * (stops[i + 1].r - stops[i].r)),
        Math.round(stops[i].g + f * (stops[i + 1].g - stops[i].g)),
        Math.round(stops[i].b + f * (stops[i + 1].b - stops[i].b)),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last.r, last.g, last.b];
}

export function rampCssGradient(ramp: ColorRampName): string {
  const stops = COLOR_RAMPS[ramp];
  const parts = stops.map(s => `rgb(${s.r},${s.g},${s.b}) ${(s.t * 100).toFixed(0)}%`);
  return `linear-gradient(to top, ${parts.join(', ')})`;
}

export function rampNameLabel(ramp: ColorRampName): string {
  return ramp.charAt(0).toUpperCase() + ramp.slice(1).replace('_', '-');
}
