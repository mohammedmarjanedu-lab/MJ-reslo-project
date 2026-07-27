import type {
  SlabFEMResult, WoodArmerMoment, ReinforcementDesign, ShearDesign,
  CrackWidthResult, DeflectionCheckResult, SlabPolygon
} from './types';
import { computeWoodArmerMoments } from './designMoments';

/** IS 456:2000 concrete grade properties (characteristic compressive strength fck in MPa). */
export const CONCRETE_GRADES: Record<string, { fck: number; Ec: number }> = {
  'M15': { fck: 15, Ec: 22360 },
  'M20': { fck: 20, Ec: 25835 },
  'M25': { fck: 25, Ec: 28908 },
  'M30': { fck: 30, Ec: 31668 },
  'M35': { fck: 35, Ec: 34209 },
  'M40': { fck: 40, Ec: 36574 },
  'M45': { fck: 45, Ec: 38806 },
  'M50': { fck: 50, Ec: 40915 },
  'M55': { fck: 55, Ec: 42913 },
  'M60': { fck: 60, Ec: 44826 },
  'M65': { fck: 65, Ec: 46664 },
  'M70': { fck: 70, Ec: 48438 },
  'M75': { fck: 75, Ec: 50155 },
  'M80': { fck: 80, Ec: 51822 },
};

/** Steel grades (yield strength fy in MPa). */
export const STEEL_GRADES: Record<string, { fy: number; Es: number }> = {
  'Fe 250': { fy: 250, Es: 200000 },
  'Fe 415': { fy: 415, Es: 200000 },
  'Fe 500': { fy: 500, Es: 200000 },
  'Fe 550': { fy: 550, Es: 200000 },
  'Fe 600': { fy: 600, Es: 200000 },
};

/**
 * Calculate required area of tension steel (Ast) for a slab strip.
 * IS 456:2000 Clause 38.1 — Limit state of collapse (flexure).
 *   Mu = 0.87 * fy * Ast * d * (1 - (Ast * fy) / (fck * b * d))
 * Solved for Ast (limiting to balanced steel ratio).
 */
export function requiredAst(
  Mu: number, fck: number, fy: number, b: number, d: number
): number {
  if (Mu <= 0) return 0;
  // Mu in kN·m/m, convert to N·mm/mm = N/mm² * mm³ / mm = N·mm/mm
  const Mu_Nmm = Math.abs(Mu) * 1e6; // N·mm per meter width
  const b_mm = b * 1000; // mm
  const d_mm = d * 1000; // mm
  const k = Mu_Nmm / (fck * b_mm * d_mm * d_mm);
  // Ast = (0.5 * fck / fy) * [1 - sqrt(1 - 4.6 * k)] * b * d
  const term = 1 - 4.6 * k;
  const root = term > 0 ? Math.sqrt(term) : 0;
  const Ast = (0.5 * fck / fy) * (1 - root) * b_mm * d_mm; // mm² per meter
  return Ast; // mm²/m
}

/**
 * Minimum tension reinforcement (IS 456:2000 Clause 26.5.2.1).
 *   Ast_min = 0.12% of gross cross-sectional area for HYSD (Fe 415/500/550)
 *           = 0.15% for mild steel (Fe 250)
 */
export function minAst(D: number, fy: number): number {
  const pct = fy <= 250 ? 0.0015 : 0.0012;
  return pct * 1000 * D * 1000; // mm²/m (b=1000mm, D in m → *1000)
}

/** Maximum reinforcement (IS 456:2000 Clause 26.5.1.1) = 4% of gross area. */
export function maxAst(D: number): number {
  return 0.04 * 1000 * D * 1000;
}

/**
 * Bar spacing from required Ast and bar diameter.
 * Returns spacing in mm.
 */
export function barSpacing(Ast_mm2_per_m: number, barDia: number): number {
  const abar = Math.PI * barDia * barDia / 4; // mm²
  if (abar <= 0) return Infinity;
  return (abar * 1000) / Ast_mm2_per_m; // mm (bars per meter * 1000)
}

/**
 * Full reinforcement design per element using Wood-Armer moments.
 */
export function designReinforcement(
  result: SlabFEMResult,
  woodArmer: WoodArmerMoment[],
  slab: SlabPolygon,
  fck: number,
  fy: number,
  cover: number,
  barDia: number
): ReinforcementDesign[] {
  const D = slab.thickness;
  const d = Math.max(0.05, D - cover - barDia / 2 / 1000); // effective depth in m
  const out: ReinforcementDesign[] = [];
  for (const wa of woodArmer) {
    const ast_xt = requiredAst(wa.mx_top, fck, fy, 1, d);
    const ast_yt = requiredAst(wa.my_top, fck, fy, 1, d);
    const ast_xb = requiredAst(wa.mx_bot, fck, fy, 1, d);
    const ast_yb = requiredAst(wa.my_bot, fck, fy, 1, d);

    const amin = minAst(D, fy);
    const amax = maxAst(D);

    const c_xt = Math.max(ast_xt, amin);
    const c_yt = Math.max(ast_yt, amin);
    const c_xb = Math.max(ast_xb, amin);
    const c_yb = Math.max(ast_yb, amin);

    const fails = [c_xt, c_yt, c_xb, c_yb].some(a => a > amax);

    out.push({
      elementId: wa.elementId,
      ast_x_top: Math.round(c_xt),
      ast_y_top: Math.round(c_yt),
      ast_x_bot: Math.round(c_xb),
      ast_y_bot: Math.round(c_yb),
      ast_x_top_spacing: Math.round(barSpacing(c_xt, barDia)),
      ast_y_top_spacing: Math.round(barSpacing(c_yt, barDia)),
      ast_x_bot_spacing: Math.round(barSpacing(c_xb, barDia)),
      ast_y_bot_spacing: Math.round(barSpacing(c_yb, barDia)),
      bar_dia: barDia,
      status: fails ? 'FAIL' : Math.max(c_xt, c_yt, c_xb, c_yb) > amin * 1.5 ? 'WARNING' : 'OK',
    });
  }
  return out;
}

/**
 * One-way (beam) shear design per element (IS 456:2000 Clause 40).
 * Shear at critical section d from support face. Here we use element-level
 * average shear from FEM results.
 */
export function designShear(
  result: SlabFEMResult,
  slab: SlabPolygon,
  fck: number,
  fy: number,
  cover: number,
  barDia: number
): ShearDesign[] {
  const D = slab.thickness;
  const d = Math.max(0.05, D - cover - barDia / 2 / 1000);
  const out: ShearDesign[] = [];
  for (const s of (result.shears || [])) {
    const v1 = s.v1; // kN/m (per unit width)
    const tau_v = v1 / (1 * d); // N/mm² = MPa (b=1000mm, d in m)
    // tau_c from IS 456 Table 19 — interpolate by pt% (using 0.3% as default)
    const pt = 0.3;
    const tau_c = tauCFromTable(fck, pt);
    const ratio = tau_c > 0 ? tau_v / tau_c : 0;
    const requireShearReinforcement = tau_v > tau_c;
    out.push({
      elementId: s.elementId,
      tau_v: Math.round(tau_v * 1000) / 1000,
      tau_c: Math.round(tau_c * 1000) / 1000,
      ratio: Math.round(ratio * 100) / 100,
      status: ratio < 0.7 ? 'OK' : ratio < 1.0 ? 'WARNING' : 'FAIL',
      requireShearReinforcement,
    });
  }
  return out;
}

/** IS 456 Table 19 — permissible shear stress τc (MPa) by fck and pt%. */
export function tauCFromTable(fck: number, pt: number): number {
  const table: Record<number, number[]> = {
    20: [0.34, 0.42, 0.48, 0.53, 0.57, 0.60, 0.64, 0.66, 0.69, 0.71, 0.73, 0.75],
    25: [0.37, 0.46, 0.53, 0.58, 0.63, 0.67, 0.71, 0.74, 0.77, 0.79, 0.82, 0.84],
    30: [0.40, 0.50, 0.57, 0.63, 0.68, 0.73, 0.77, 0.80, 0.84, 0.87, 0.89, 0.92],
    35: [0.43, 0.53, 0.61, 0.68, 0.73, 0.78, 0.83, 0.86, 0.90, 0.94, 0.96, 0.99],
    40: [0.46, 0.57, 0.65, 0.72, 0.78, 0.83, 0.88, 0.92, 0.96, 1.00, 1.03, 1.06],
  };
  const ptVals = [0.15, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50, 1.75, 2.00, 2.25, 2.50, 3.00];
  const row = table[fck];
  if (!row) return 0.40; // fallback
  // linear interpolation over pt
  let lower = ptVals[0], upper = ptVals[ptVals.length - 1];
  let li = 0, ui = ptVals.length - 1;
  for (let i = 0; i < ptVals.length - 1; i++) {
    if (pt >= ptVals[i] && pt <= ptVals[i + 1]) { li = i; ui = i + 1; break; }
  }
  const frac = (pt - ptVals[li]) / (ptVals[ui] - ptVals[li]);
  return row[li] + frac * (row[ui] - row[li]);
}

/**
 * Crack width check (IS 456:2000 Clause 35.3.2 / Annex F).
 *   w = 3 * acr * εm / [1 + 2(acr - Cmin)/(h - x)]
 * where x is neutral axis depth.
 */
export function designCrackWidth(
  result: SlabFEMResult,
  slab: SlabPolygon,
  fck: number,
  fy: number,
  cover: number,
  barDia: number,
  exposureLimit: number
): CrackWidthResult[] {
  const D = slab.thickness;
  const d = Math.max(0.05, D - cover - barDia / 2 / 1000);
  const out: CrackWidthResult[] = [];
  for (const wa of result.woodArmer || []) {
    const maxMoment = Math.max(
      Math.abs(wa.mx_top), Math.abs(wa.my_top),
      Math.abs(wa.mx_bot), Math.abs(wa.my_bot)
    );
    const Ast = requiredAst(maxMoment, fck, fy, 1, d);
    if (Ast <= 0) {
      out.push({ elementId: wa.elementId, crackWidth: 0, limit: exposureLimit, status: 'OK' });
      continue;
    }
    // Neutral axis depth x (simplified): from Ast and balanced condition
    const x = (Ast * fy) / (0.36 * fck * 1000); // mm
    const acr = cover * 1000 + barDia / 2; // mm
    const h = D * 1000;
    // Strain in tension steel (simplified)
    const fs = Math.min(fy, (Ast * fy) / Math.max(Ast, 1));
    const eps = fs / (fy / 1.15) * 0.0008; // approx strain
    const w = 3 * acr * eps / (1 + 2 * (acr - cover * 1000) / (h - x));
    const finalW = Math.max(0, w / 1000); // mm
    out.push({
      elementId: wa.elementId,
      crackWidth: Math.round(finalW * 1000) / 1000,
      limit: exposureLimit,
      status: finalW <= exposureLimit ? 'OK' : finalW <= exposureLimit * 1.5 ? 'WARNING' : 'FAIL',
    });
  }
  return out;
}

/**
 * Deflection serviceability check (IS 456:2000 Clause 23.2).
 * Short-term: span/250 (total) or span/350 (after partition/finishes).
 * Long-term: includes creep & shrinkage multiplier (Clause 23.2.1).
 */
export function checkDeflection(
  result: SlabFEMResult,
  slab: SlabPolygon,
  fck: number,
  fy: number,
  cover: number,
  longTermFactor: number
): DeflectionCheckResult {
  let maxDefl = 0;
  for (const d of result.nodeDeflections) {
    const abs = Math.abs(d.wz * 1000); // mm
    if (abs > maxDefl) maxDefl = abs;
  }
  // Determine effective span: longest clear span of the slab
  const xs = slab.vertices.map(v => v.x);
  const ys = slab.vertices.map(v => v.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const span = Math.max(w, h) * 1000; // mm

  const limitRatio = 250;
  const spanRatio = span / Math.max(maxDefl, 1e-6);

  const longTermDeflection = maxDefl * longTermFactor;
  const longTermRatio = span / Math.max(longTermDeflection, 1e-6);

  return {
    slabId: slab.id,
    maxDeflection: Math.round(maxDefl * 100) / 100,
    span: Math.round(span),
    spanRatio: Math.round(spanRatio * 10) / 10,
    limitRatio,
    shortTermStatus: spanRatio >= limitRatio ? 'OK' : spanRatio >= limitRatio * 0.8 ? 'WARNING' : 'FAIL',
    longTermDeflection: Math.round(longTermDeflection * 100) / 100,
    longTermRatio: Math.round(longTermRatio * 10) / 10,
    longTermStatus: longTermRatio >= limitRatio ? 'OK' : longTermRatio >= limitRatio * 0.8 ? 'WARNING' : 'FAIL',
  };
}

/**
 * Run full IS 456:2000 design suite on a slab result.
 */
export function runSlabDesign(
  result: SlabFEMResult,
  slab: SlabPolygon,
  options: {
    concreteGrade?: string;
    steelGrade?: string;
    cover?: number;
    barDia?: number;
    exposureLimit?: number;
    longTermFactor?: number;
  } = {}
): {
  woodArmer: WoodArmerMoment[];
  reinforcement: ReinforcementDesign[];
  shearDesign: ShearDesign[];
  crackWidth: CrackWidthResult[];
  deflectionCheck: DeflectionCheckResult;
} {
  const cg = CONCRETE_GRADES[options.concreteGrade || 'M30'] || CONCRETE_GRADES['M30'];
  const sg = STEEL_GRADES[options.steelGrade || 'Fe 500'] || STEEL_GRADES['Fe 500'];
  const cover = options.cover ?? 0.025;
  const barDia = options.barDia ?? 12;
  const exposureLimit = options.exposureLimit ?? 0.3;
  const longTermFactor = options.longTermFactor ?? 2.0;

  const woodArmer = computeWoodArmerMoments(result);
  const reinforcement = designReinforcement(result, woodArmer, slab, cg.fck, sg.fy, cover, barDia);
  const shearDesign = designShear(result, slab, cg.fck, sg.fy, cover, barDia);
  const crackWidth = designCrackWidth(result, slab, cg.fck, sg.fy, cover, barDia, exposureLimit);
  const deflectionCheck = checkDeflection(result, slab, cg.fck, sg.fy, cover, longTermFactor);

  return { woodArmer, reinforcement, shearDesign, crackWidth, deflectionCheck };
}
