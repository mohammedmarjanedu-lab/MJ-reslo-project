import { describe, it, expect } from 'vitest';
import { analyzeAllSlabs } from './femSolver';
import { computeSprContour, type SprSlabInput } from './sprRecovery';
import type { SlabPolygon, ShearWallElement, SlabFEMResult } from './types';

/**
 * End-to-end contour pipeline integration tests:
 *   model → global FE assembly (edge constraints) → element resultants
 *   → SPR nodal smoothing → ETABS-style continuous contours across slab joints.
 *
 * Geometry identical to tJunctionContinuity.test.ts:
 *   Slab A [0,4]×[0,4], Slab B [4,8]×[1.25,4.5], monolithic L-union reference.
 */

function slabA(): SlabPolygon {
  return {
    id: 'A', label: 'Slab A',
    vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
    holes: [], thickness: 0.2, uniformLoad: 10.0, partitionLoad: 0,
    concreteDensity: 25, elasticModulus: 25e6, concreteGrade: 'M30',
  };
}

function slabB(discontinuous = false): SlabPolygon {
  const s: SlabPolygon = {
    id: 'B', label: 'Slab B',
    vertices: [{ x: 4, y: 1.25 }, { x: 8, y: 1.25 }, { x: 8, y: 4.5 }, { x: 4, y: 4.5 }],
    holes: [], thickness: 0.2, uniformLoad: 10.0, partitionLoad: 0,
    concreteDensity: 25, elasticModulus: 25e6, concreteGrade: 'M30',
  };
  if (discontinuous) {
    s.discontinuousEdges = [
      { startPoint: { x: 4, y: 1.25 }, endPoint: { x: 4, y: 4.5 } },
    ];
  }
  return s;
}

function outerWalls(): ShearWallElement[] {
  const mk = (id: string, a: [number, number], b: [number, number]) =>
    ({ id, label: id, startPoint: { x: a[0], y: a[1] }, endPoint: { x: b[0], y: b[1] }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement);
  return [
    mk('w1', [0, 0], [4, 0]),
    mk('w2', [4, 1.25], [8, 1.25]),
    mk('w3', [8, 1.25], [8, 4.5]),
    mk('w4', [8, 4.5], [4, 4.5]),
    mk('w5', [4, 4], [0, 4]),
    mk('w6', [0, 4], [0, 0]),
  ];
}

function sprInput(r: SlabFEMResult, key: 'momentMx' | 'momentMy'): SprSlabInput {
  return {
    slabId: r.slabId,
    nodes: r.mesh.nodes,
    elements: r.mesh.elements,
    values: new Map(r[key].map(m => [m.elementId, m.value])),
    hingedNodeIds: r.hingedNodeIds,
  };
}

describe('Contour pipeline integration (solver → edge constraints → SPR)', () => {
  it('produces ETABS-style continuous Mx contours across a continuous T-joint', () => {
    const res = analyzeAllSlabs([slabA(), slabB(false)], [], outerWalls(), [], [], [], [], [], 0.5, 0.2).results;
    const rA = res.find(r => r.slabId === 'A')!;
    const rB = res.find(r => r.slabId === 'B')!;

    const spr = computeSprContour([sprInput(rA, 'momentMx'), sprInput(rB, 'momentMx')]);
    const sA = spr.get('A')!;
    const sB = spr.get('B')!;

    // Peak moment scale for relative checks
    let mxPeak = 0;
    for (const m of [...rA.momentMx, ...rB.momentMx]) mxPeak = Math.max(mxPeak, Math.abs(m.value));
    expect(mxPeak).toBeGreaterThan(0);

    // For every A interface node, compare against the geometrically nearest B
    // interface node — the contour across the joint must be C0 within the
    // discretization budget (positions differ by ≤ 0.143 m along the joint).
    // Nodes within ~0.5·meshSize of the wall-vertex corner of the L (y > 3.75) are
    // excluded: that corner is a moment singularity where even ETABS shows a
    // one-element discontinuity — not a joint-continuity defect.
    const bIface = rB.mesh.nodes.filter(n => Math.abs(n.x - 4) < 1e-6);
    const aIface = rA.mesh.nodes.filter(n => Math.abs(n.x - 4) < 1e-6 && n.y >= 1.25 && n.y <= 3.75);
    expect(aIface.length).toBeGreaterThan(0);

    for (const na of aIface) {
      let best: typeof bIface[0] | null = null;
      let bestD = Infinity;
      for (const nb of bIface) {
        const d = Math.hypot(na.x - nb.x, na.y - nb.y);
        if (d < bestD) { bestD = d; best = nb; }
      }
      if (!best || bestD > 0.2) continue;
      const va = sA.get(na.id)!;
      const vb = sB.get(best.id)!;
      expect(isFinite(va)).toBe(true);
      expect(isFinite(vb)).toBe(true);
      const disc = Math.abs(va - vb);
      console.log(`  joint y=${na.y.toFixed(3)} (Δ${bestD.toFixed(3)}m): mx_A=${va.toFixed(3)}, mx_B=${vb.toFixed(3)}, disc=${disc.toFixed(3)} (${(disc / mxPeak * 100).toFixed(1)}% peak)`);
      expect(disc).toBeLessThan(0.25 * mxPeak);
    }
  });

  it('marks hinged nodes in results and keeps hinge-side patches segregated', () => {
    const res = analyzeAllSlabs([slabA(), slabB(true)], [], outerWalls(), [], [], [], [], [], 0.5, 0.2).results;
    const rA = res.find(r => r.slabId === 'A')!;
    const rB = res.find(r => r.slabId === 'B')!;

    // B's discontinuous edge is its left edge x=4 → all B interface nodes flagged
    expect(rB.hingedNodeIds!.length).toBeGreaterThan(0);
    for (const nid of rB.hingedNodeIds!) {
      const n = rB.mesh.nodes.find(nn => nn.id === nid)!;
      expect(Math.abs(n.x - 4)).toBeLessThan(1e-6);
    }

    // SPR stays finite everywhere; no NaN/contamination across the hinge line
    const spr = computeSprContour([sprInput(rA, 'momentMx'), sprInput(rB, 'momentMx')]);
    for (const m of spr.values()) for (const v of m.values()) expect(isFinite(v)).toBe(true);
  });
});

/**
 * Analytical benchmark: centre moment of a simply-supported square plate,
 * Kirchhoff–Navier series, compared against the SPR-smoothed nodal contour —
 * proves the smoothing does not distort design magnitudes.
 */
describe('Analytical moment benchmark (SSSS plate, Navier series)', () => {
  it('SPR centre Mx matches the Kirchhoff–Navier analytical solution', () => {
    const a = 6.0;           // plate 6×6 m
    const h = 0.2, E = 25e6; // kN/m² (25 GPa), kN units
    const nu = 0.2;
    const q = 15.0;          // kN/m² (10 imposed + 5 self-weight, as assembled)

    const slab: SlabPolygon = {
      id: 'S', label: 'Plate',
      vertices: [{ x: 0, y: 0 }, { x: a, y: 0 }, { x: a, y: a }, { x: 0, y: a }],
      holes: [], thickness: h, uniformLoad: 10.0, partitionLoad: 0,
      concreteDensity: 25, elasticModulus: E, concreteGrade: 'M30',
    };
    const walls: ShearWallElement[] = [
      { id: 'w1', label: 'w1', startPoint: { x: 0, y: 0 }, endPoint: { x: a, y: 0 }, thickness: 0.3, height: 3, elasticModulus: E, concreteDensity: 25 },
      { id: 'w2', label: 'w2', startPoint: { x: a, y: 0 }, endPoint: { x: a, y: a }, thickness: 0.3, height: 3, elasticModulus: E, concreteDensity: 25 },
      { id: 'w3', label: 'w3', startPoint: { x: a, y: a }, endPoint: { x: 0, y: a }, thickness: 0.3, height: 3, elasticModulus: E, concreteDensity: 25 },
      { id: 'w4', label: 'w4', startPoint: { x: 0, y: a }, endPoint: { x: 0, y: 0 }, thickness: 0.3, height: 3, elasticModulus: E, concreteDensity: 25 },
    ] as ShearWallElement[];

    const res = analyzeAllSlabs([slab], [], walls, [], [], [], [], [], 0.5, nu).results;
    const rS = res[0];

    // Navier series for SSSS square plate (odd harmonics only):
    //   w = Σ_wm,n sin(mπx/a) sin(nπy/a), w_mn = 16q a⁴ / (π⁶ D m n (m²+n²)²)
    //   Mx = D(κx + νκy), κx = −w,xx
    const D = E * Math.pow(h, 3) / (12 * (1 - nu * nu));
    let mxC = 0;
    for (let m = 1; m < 40; m += 2) {
      for (let n = 1; n < 40; n += 2) {
        const wmn = 16 * q * Math.pow(a, 4) / (Math.pow(Math.PI, 6) * D * m * n * Math.pow(m * m + n * n, 2));
        const sm = Math.sin(m * Math.PI / 2), sn = Math.sin(n * Math.PI / 2);
        mxC += D * wmn * (Math.PI / a) ** 2 * (m * m + nu * n * n) * sm * sn;
      }
    }

    // SPR-smoothed Mx at the node nearest the centre
    const spr = computeSprContour([sprInput(rS, 'momentMx')]).get('S')!;
    let cBest = rS.mesh.nodes[0], dBest = Infinity;
    for (const n of rS.mesh.nodes) {
      const d = Math.hypot(n.x - a / 2, n.y - a / 2);
      if (d < dBest) { dBest = d; cBest = n; }
    }
    const mxFE = spr.get(cBest.id)!;

    console.log(`  Navier mx_center = ${mxC.toFixed(3)} kN·m/m | SPR mx_center(node ${cBest.id}) = ${mxFE.toFixed(3)} | err = ${(Math.abs(mxFE - mxC) / mxC * 100).toFixed(1)}%`);
    expect(mxFE).toBeGreaterThan(0); // sagging must dominate at centre
    expect(Math.abs(mxFE - mxC) / mxC).toBeLessThan(0.15);
  });
});
