import type { SlabFEMResult, WoodArmerMoment } from './types';

/**
 * Wood-Armer moment transformation for slab design.
 * Resolves twisting moment Mxy into design moments for top and bottom
 * reinforcement in each direction, per IS 456:2000 practice.
 *
 * For bottom steel (tension at bottom, sagging positive):
 *   Mx* = Mx + |Mxy|  when Mx + |Mxy| > 0, else 0 (compression → no steel needed at bot)
 *   My* = My + |Mxy|  when My + |Mxy| > 0, else 0
 * For top steel (hogging, M negative):
 *   Mx* = Mx - |Mxy|  when Mx - |Mxy| < 0, else 0 (sagging → no top steel needed)
 *   My* = My - |Mxy|  when My - |Mxy| < 0, else 0
 */
export function computeWoodArmerMoments(result: SlabFEMResult): WoodArmerMoment[] {
  const out: WoodArmerMoment[] = [];
  for (const m of result.momentMx) {
    const myEntry = result.momentMy.find(e => e.elementId === m.elementId);
    const mxyEntry = result.momentMxy.find(e => e.elementId === m.elementId);
    if (!myEntry || !mxyEntry) continue;
    const Mx = m.value;
    const My = myEntry.value;
    const Mxy = mxyEntry.value;
    const am = Math.abs(Mxy);

    const mx_top = Mx - am;
    const my_top = My - am;
    const mx_bot = Mx + am;
    const my_bot = My + am;

    out.push({
      elementId: m.elementId,
      mx_top: mx_top < 0 ? mx_top : 0,
      my_top: my_top < 0 ? my_top : 0,
      mx_bot: mx_bot > 0 ? mx_bot : 0,
      my_bot: my_bot > 0 ? my_bot : 0,
    });
  }
  return out;
}
