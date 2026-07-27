/**
 * Superconvergent Patch Recovery (SPR) — ETABS/SAFE-grade nodal contour smoothing.
 *
 * Element solvers report resultants (Mx, My, Mxy, shears, stresses, Ast, crack widths)
 * at element centroids. Contouring element values directly produces blocky "mosaic"
 * plots; contouring a plain incident-element average blurs peaks (ETABS never shows
 * either). SAFE/ETABS instead recover smooth nodal fields: for each node, fit a
 * least-squares plane  v = a + b·(x−x0) + c·(y−y0)  over the centroid values of the
 * incident-element patch (area-weighted), then evaluate the plane at the node (v = a).
 *
 * This module implements exactly that, with three production details:
 *  1. Cross-slab patches: nodes of different slabs at the SAME position (within 1 mm)
 *     share one patch → contours stay continuous across slab joints (SAFE behaviour).
 *  2. Hinge-aware segregation: a node marked hinged (on a discontinuous edge) does NOT
 *     share its patch with the other side of the hinge — moments/shears are physically
 *     discontinuous across articulated lines, so each side keeps its own patch.
 *  3. Robust fallback: patches with < 3 samples or a rank-deficient (collinear) patch
 *     fall back to the area-weighted mean — never singular, never NaN.
 */

export interface SprNodeGeom { id: number; x: number; y: number }
export interface SprElementGeom { id: number; nodeIds: number[]; area?: number }

export interface SprSlabInput {
  slabId: string;
  nodes: SprNodeGeom[];
  elements: SprElementGeom[];
  /** elementId -> centroid value for the field being smoothed */
  values: Map<number, number>;
  /** Local node ids lying on discontinuous (hinged) edges — patch segregation */
  hingedNodeIds?: number[] | Set<number>;
}

/** Spatial bucketing (1 mm) identical to the previous plain-averaging pass. */
export function sprPosKey(x: number, y: number): string {
  return Math.round(x * 1000) + '_' + Math.round(y * 1000);
}

interface Patch {
  xs: number[];
  ys: number[];
  vs: number[];
  ws: number[];
  added: Set<string>;
}

/** Solve 3×3 A·x = b by Gaussian elimination with scaled partial pivoting. */
function solve3x3(A: number[][], b: number[], x: number[]): boolean {
  const M: number[][] = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    let pivAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < 3; r++) {
      const a = Math.abs(M[r][col]);
      if (a > pivAbs) { pivAbs = a; piv = r; }
    }
    const rowScale = Math.max(Math.abs(M[piv][0]), Math.abs(M[piv][1]), Math.abs(M[piv][2]), 1e-300);
    if (pivAbs < 1e-10 * rowScale) return false; // (near-)singular / collinear patch
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
    for (let r = col + 1; r < 3; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= 3; c++) M[r][c] -= f * M[col][c];
    }
  }
  for (let r = 2; r >= 0; r--) {
    let s = M[r][3];
    for (let c = r + 1; c < 3; c++) s -= M[r][c] * x[c];
    if (Math.abs(M[r][r]) < 1e-300) return false;
    x[r] = s / M[r][r];
  }
  return true;
}

function weightedMean(p: Patch): number {
  let sv = 0, sw = 0;
  for (let i = 0; i < p.vs.length; i++) { sv += p.ws[i] * p.vs[i]; sw += p.ws[i]; }
  return sw > 0 ? sv / sw : 0;
}

/**
 * Least-squares plane  v = a + b·(x−x0) + c·(y−y0)  over the patch, area-weighted,
 * evaluated at the node (x0, y0) → returns the constant term a.
 * Falls back to the weighted mean for degenerate patches (never returns NaN).
 */
export function sprEvalPatch(p: { xs: number[]; ys: number[]; vs: number[]; ws: number[] }, x0: number, y0: number): number {
  const n = p.vs.length;
  if (n < 3) return weightedMean(p as Patch);

  let Sw = 0, Swx = 0, Swy = 0, Swxx = 0, Swxy = 0, Swyy = 0, Sv = 0, Svx = 0, Svy = 0;
  for (let i = 0; i < n; i++) {
    const dx = p.xs[i] - x0, dy = p.ys[i] - y0, w = p.ws[i], v = p.vs[i];
    Sw += w; Swx += w * dx; Swy += w * dy;
    Swxx += w * dx * dx; Swxy += w * dx * dy; Swyy += w * dy * dy;
    Sv += w * v; Svx += w * dx * v; Svy += w * dy * v;
  }
  const x: number[] = [0, 0, 0];
  const ok = solve3x3(
    [[Sw, Swx, Swy], [Swx, Swxx, Swxy], [Swy, Swxy, Swyy]],
    [Sv, Svx, Svy],
    x
  );
  if (!ok || !isFinite(x[0])) return weightedMean(p as Patch);
  return x[0];
}

/**
 * Build SPR-smoothed nodal values for every slab.
 * Returns Map: slabId -> (local nodeId -> smoothed value). Nodes whose incident
 * elements carry no data are absent from the inner map (callers default to 0,
 * matching the previous behaviour).
 */
export function computeSprContour(slabs: SprSlabInput[]): Map<string, Map<number, number>> {
  const patches = new Map<string, Patch>();

  // Phase 1 — accumulate centroid samples into spatial patches (hinge-aware).
  for (const r of slabs) {
    const nodeById = new Map(r.nodes.map(n => [n.id, n]));
    const posKeyById = new Map(r.nodes.map(n => [n.id, sprPosKey(n.x, n.y)]));
    const hinged = r.hingedNodeIds instanceof Set ? r.hingedNodeIds : new Set(r.hingedNodeIds ?? []);

    // Incident-element map per node, used for the one-ring patch expansion:
    // a node's patch = elements incident to it PLUS elements incident to its
    // connected neighbours. Zienkiewicz–Zhu/SAFE practice — a bare incident-element
    // patch has only 1–2 samples at boundary/corner nodes, which forces a biased
    // mean fallback; the expanded patch always supports a full plane fit.
    const elemsByNode = new Map<number, number[]>();
    for (let ei = 0; ei < r.elements.length; ei++) {
      for (const nid of r.elements[ei].nodeIds) {
        let arr = elemsByNode.get(nid);
        if (!arr) { arr = []; elemsByNode.set(nid, arr); }
        arr.push(ei);
      }
    }

    for (const elem of r.elements) {
      const v = r.values.get(elem.id);
      if (v === undefined || !isFinite(v)) continue;
      let cx = 0, cy = 0, cnt = 0;
      for (const nid of elem.nodeIds) {
        const n = nodeById.get(nid);
        if (!n) break;
        cx += n.x; cy += n.y; cnt++;
      }
      if (cnt !== elem.nodeIds.length || cnt === 0) continue;
      cx /= cnt; cy /= cnt;
      const w = (elem.area && elem.area > 0 && isFinite(elem.area)) ? elem.area : 1;
      const token = r.slabId + ':' + elem.id;

      // Target nodes: own nodes + one-ring neighbours (same slab — a hinged node's
      // segregated patch can never be contaminated by the other side of the hinge).
      const targetNids = new Set<number>();
      for (const nid of elem.nodeIds) {
        targetNids.add(nid);
        const inc = elemsByNode.get(nid);
        if (inc) for (const ei of inc) for (const nid2 of r.elements[ei].nodeIds) targetNids.add(nid2);
      }

      for (const nid of targetNids) {
        const baseKey = posKeyById.get(nid);
        if (!baseKey) continue;
        const key = hinged.has(nid) ? baseKey + '|' + r.slabId : baseKey;
        let p = patches.get(key);
        if (!p) {
          p = { xs: [], ys: [], vs: [], ws: [], added: new Set() };
          patches.set(key, p);
        }
        if (p.added.has(token)) continue; // same element once per patch
        p.added.add(token);
        p.xs.push(cx); p.ys.push(cy); p.vs.push(v); p.ws.push(w);
      }
    }
  }

  // Phase 2 — evaluate the recovered plane at every node.
  const out = new Map<string, Map<number, number>>();
  for (const r of slabs) {
    const hinged = r.hingedNodeIds instanceof Set ? r.hingedNodeIds : new Set(r.hingedNodeIds ?? []);
    const m = new Map<number, number>();
    for (const n of r.nodes) {
      const baseKey = sprPosKey(n.x, n.y);
      const key = hinged.has(n.id) ? baseKey + '|' + r.slabId : baseKey;
      const p = patches.get(key);
      if (!p || p.vs.length === 0) continue;
      const val = sprEvalPatch(p, n.x, n.y);
      if (isFinite(val)) m.set(n.id, val);
    }
    out.set(r.slabId, m);
  }
  return out;
}
