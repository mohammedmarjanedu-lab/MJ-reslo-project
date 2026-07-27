import { describe, it, expect } from 'vitest';
import { analyzeAllSlabs } from './femSolver';
import type { SlabPolygon, ShearWallElement } from './types';

/**
 * T-junction continuity tests (ETABS-style automatic edge/line constraints).
 *
 * Slab A:  x∈0..4,  y∈0..4     (grid dy = 0.50 at meshSize 0.5)
 * Slab B:  x∈4..8,  y∈1.25..4.5 (grid dy ≈ 0.4643 at meshSize 0.5)
 *
 * The interface x=4, y∈1.25..4 has mostly NON-coincident boundary nodes
 * (misalignment up to ~0.19 m > mergeTol·½ at several stations). Without edge
 * constraints the joint tears; with them it must behave like one continuous slab.
 *
 * The union outline is a valid simple L-shaped polygon, so a monolithic
 * single-slab analysis provides the reference solution.
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

function slabUnion(): SlabPolygon {
  // L-shaped union outline of A + B as ONE monolithic slab
  return {
    id: 'U', label: 'Slab U',
    vertices: [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1.25 }, { x: 8, y: 1.25 },
      { x: 8, y: 4.5 }, { x: 4, y: 4.5 }, { x: 4, y: 4 }, { x: 0, y: 4 },
    ],
    holes: [], thickness: 0.2, uniformLoad: 10.0, partitionLoad: 0,
    concreteDensity: 25, elasticModulus: 25e6, concreteGrade: 'M30',
  };
}

// Simply-supported outer perimeter (w = 0) — continuous slabs keep C1 across the interface
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

/** Barycentric-interpolated deflection at an exact point (falls back to nearest node within 0.6 m) */
function sampleW(result: any, x: number, y: number): number | null {
  const nodesById = new Map<number, any>();
  for (const n of result.mesh.nodes) nodesById.set(n.id, n);
  const wById = new Map<number, number>();
  for (const d of result.nodeDeflections) wById.set(d.nodeId, d.wz);

  const bary = (px: number, py: number, a: any, b: any, c: any) => {
    const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(d) < 1e-14) return null;
    const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / d;
    const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / d;
    const l3 = 1 - l1 - l2;
    return { l1, l2, l3 };
  };

  for (const e of result.mesh.elements) {
    const pts = e.nodeIds.map((id: number) => nodesById.get(id));
    if (pts.some((p: any) => !p)) continue;
    // Fan-triangulate (works for T3 and Q4)
    for (let i = 1; i + 1 < pts.length; i++) {
      const bc = bary(x, y, pts[0], pts[i], pts[i + 1]);
      if (bc && bc.l1 >= -1e-6 && bc.l2 >= -1e-6 && bc.l3 >= -1e-6) {
        const w0 = wById.get(e.nodeIds[0]) ?? 0;
        const w1 = wById.get(e.nodeIds[i]) ?? 0;
        const w2 = wById.get(e.nodeIds[i + 1]) ?? 0;
        return bc.l1 * w0 + bc.l2 * w1 + bc.l3 * w2;
      }
    }
  }

  // Fallback: nearest node (handles points on element edges of neighboring slab)
  let best: { d: number; w: number } | null = null;
  for (const n of result.mesh.nodes) {
    const dd = Math.hypot(n.x - x, n.y - y);
    if ((!best || dd < best.d) && wById.has(n.id)) best = { d: dd, w: wById.get(n.id)! };
  }
  return best && best.d < 0.6 ? best.w : null;
}

describe('T-junction edge constraints (non-conformal multi-slab continuity)', () => {
  it('matches the monolithic single-slab solution along the joint', () => {
    // Continuous two-slab system (misaligned boundary meshes)
    const twoSlab = analyzeAllSlabs([slabA(), slabB()], [], outerWalls(), [], [], [], [], [], 0.5, 0.2).results;
    // Monolithic reference
    const mono = analyzeAllSlabs([slabUnion()], [], outerWalls(), [], [], [], [], [], 0.5, 0.2).results;

    expect(twoSlab.length).toBe(2);
    expect(mono.length).toBe(1);

    const rA = twoSlab.find(r => r.slabId === 'A')!;
    const rB = twoSlab.find(r => r.slabId === 'B')!;
    const rU = mono[0];

    // 1. Deflection continuity along the joint: A-side w ≈ B-side w at shared stations
    //    (stations clear of wall-end capture zones and disjoint endpoint corners)
    for (const y of [2.0, 2.5, 3.0, 3.5]) {
      const wA = sampleW(rA, 4, y);
      const wB = sampleW(rB, 4, y);
      expect(wA).not.toBeNull();
      expect(wB).not.toBeNull();
      // Tied within 15% of the largest joint deflection magnitude scale (mm-level slab)
      const scale = Math.max(Math.abs(wA!), Math.abs(wB!), 1e-4);
      expect(Math.abs(wA! - wB!) / scale).toBeLessThan(0.15);
    }

    // 2. Continuous two-slab system ≈ monolithic slab: pointwise error must be small
    //    relative to the structure's PEAK response (global energy scale, as used in
    //    ETABS parity comparisons). Non-conformal interfaces converge with refinement.
    let uMax = 0;
    for (const d of rU.nodeDeflections) uMax = Math.max(uMax, Math.abs(d.wz));
    expect(uMax).toBeGreaterThan(0);
    const probePts: [number, number][] = [[2, 2], [6, 2.5], [3.5, 2], [4.5, 3]];
    for (const [px, py] of probePts) {
      const wMono = sampleW(rU, px, py)!;
      const wTwo = px <= 4 ? sampleW(rA, px, py)! : sampleW(rB, px, py)!;
      expect(Math.abs(wMono - wTwo) / uMax).toBeLessThan(0.20);
    }

    // 3. Physics: hogging (negative) moment develops over the interface — continuity transfers moment
    expect(rA.minMx).toBeLessThan(0);
  });

  it('hinged interface ties deflection but releases moment transfer', () => {
    const cont = analyzeAllSlabs([slabA(), slabB(false)], [], outerWalls(), [], [], [], [], [], 0.5, 0.2).results;
    const disc = analyzeAllSlabs([slabA(), slabB(true)], [], outerWalls(), [], [], [], [], [], 0.5, 0.2).results;

    const rAc = cont.find(r => r.slabId === 'A')!;
    const rBc = cont.find(r => r.slabId === 'B')!;
    const rAd = disc.find(r => r.slabId === 'A')!;
    const rBd = disc.find(r => r.slabId === 'B')!;

    // Deflection still tied across the hinge
    for (const y of [2.0, 3.0]) {
      const wA = sampleW(rAd, 4, y)!;
      const wB = sampleW(rBd, 4, y)!;
      const scale = Math.max(Math.abs(wA), Math.abs(wB), 1e-4);
      expect(Math.abs(wA - wB) / scale).toBeLessThan(0.15);
    }

    // Releasing the rotational coupling must soften the system:
    // peak deflection of the hinged system ≥ continuous system (18% here)
    let maxCont = 0, maxDisc = 0;
    for (const r of [rAc, rBc]) for (const d of r.nodeDeflections) maxCont = Math.max(maxCont, Math.abs(d.wz));
    for (const r of [rAd, rBd]) for (const d of r.nodeDeflections) maxDisc = Math.max(maxDisc, Math.abs(d.wz));
    expect(maxDisc).toBeGreaterThan(maxCont * 1.05);
  });
});
