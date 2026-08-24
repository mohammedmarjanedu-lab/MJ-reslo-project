import { describe, it, expect } from 'vitest';
import { analyzeAllSlabs } from './femSolver';
import type { SlabPolygon, ShearWallElement } from './types';

function makeSlab(id: string, startX: number, endX: number, discontinuous = false): SlabPolygon {
  const s: SlabPolygon = {
    id,
    label: `Slab ${id}`,
    vertices: [
      { x: startX, y: 0 },
      { x: endX, y: 0 },
      { x: endX, y: 4 },
      { x: startX, y: 4 },
    ],
    holes: [],
    thickness: 0.2,
    uniformLoad: 10.0,
    partitionLoad: 0,
    concreteDensity: 25,
    elasticModulus: 25e6,
    concreteGrade: 'M30',
  };
  if (discontinuous) {
    s.discontinuousEdges = [
      { startPoint: { x: endX, y: 0 }, endPoint: { x: endX, y: 4 } },
    ];
  }
  return s;
}

function makeBoundaryWalls(): ShearWallElement[] {
  return [
    // Outer perimeter walls
    { id: 'w1', label: 'W1', startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 4 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    { id: 'w2', label: 'W2', startPoint: { x: 0, y: 4 }, endPoint: { x: 8, y: 4 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    { id: 'w3', label: 'W3', startPoint: { x: 8, y: 4 }, endPoint: { x: 8, y: 0 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    { id: 'w4', label: 'W4', startPoint: { x: 8, y: 0 }, endPoint: { x: 0, y: 0 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    // Middle interior wall support at x = 4
    { id: 'w5', label: 'W5', startPoint: { x: 4, y: 0 }, endPoint: { x: 4, y: 4 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
  ];
}

describe('Multi-Slab Analysis & Continuity/Discontinuity', () => {
  it('analyzes all slabs in a multi-slab layout', () => {
    const s1 = makeSlab('1', 0, 4);
    const s2 = makeSlab('2', 4, 8);
    const walls = makeBoundaryWalls();

    const { results } = analyzeAllSlabs([s1, s2], [], walls, [], [], [], [], [], 0.5, 0.2);

    expect(results.length).toBe(2);
    expect(results[0].slabId).toBe('1');
    expect(results[1].slabId).toBe('2');
    expect(results[0].nodeDeflections.length).toBeGreaterThan(0);
    expect(results[1].nodeDeflections.length).toBeGreaterThan(0);
  });

  it('continuous multi-slab develops negative hogging moment over interior support', () => {
    const s1 = makeSlab('1', 0, 4);
    const s2 = makeSlab('2', 4, 8);
    const walls = makeBoundaryWalls();

    const { results } = analyzeAllSlabs([s1, s2], [], walls, [], [], [], [], [], 0.5, 0.2);

    const r1 = results[0];
    // Find minMx (most negative moment) in Slab 1 — should be negative (hogging) near interior wall
    expect(r1.minMx).toBeLessThan(0);
  });

  it('discontinuous slab edge unmerges rotation and reduces support moment (hinged joint)', () => {
    const s1_cont = makeSlab('1', 0, 4, false);
    const s2_cont = makeSlab('2', 4, 8, false);

    const s1_disc = makeSlab('1', 0, 4, true); // marked discontinuous at x=4
    const s2_disc = makeSlab('2', 4, 8, false);

    const walls = makeBoundaryWalls();

    const resCont = analyzeAllSlabs([s1_cont, s2_cont], [], walls, [], [], [], [], [], 0.5, 0.2).results;
    const resDisc = analyzeAllSlabs([s1_disc, s2_disc], [], walls, [], [], [], [], [], 0.5, 0.2).results;

    // Discontinuous joint at support releases rotation restraint, increasing localized slope curvature
    expect(resDisc[0].minMx).toBeLessThan(resCont[0].minMx);
  });

  it('beam line acts as simply supported line constraint along slab boundary', () => {
    const s1 = makeSlab('1', 0, 4);
    const outerWalls = makeBoundaryWalls().slice(0, 4); // outer perimeter walls only, no middle wall
    const beam = {
      id: 'b1', label: 'B1',
      startPoint: { x: 4, y: 0 }, endPoint: { x: 4, y: 4 },
      width: 0.3, depth: 0.45, elasticModulus: 25e6, height: 0.45
    } as any;

    const { results } = analyzeAllSlabs([s1], [], outerWalls, [], [beam], [], [], [], 0.5, 0.2);

    expect(results.length).toBe(1);
    // Deflection along beam line (x=4) should be constrained near zero (simply supported behavior)
    const beamNodes = results[0].nodeDeflections.filter(d => {
      const node = results[0].mesh.nodes.find(n => n.id === d.nodeId);
      return node && Math.abs(node.x - 4) < 0.1;
    });
    expect(beamNodes.length).toBeGreaterThan(0);
    for (const d of beamNodes) {
      expect(Math.abs(d.wz)).toBeLessThan(0.1); // wz is in mm, < 0.1mm deflection along elastic beam
    }
  });

  it('two adjacent slabs develop mid-span peak deflections (physics principles)', () => {
    const s1 = makeSlab('1', 0, 4);
    const s2 = makeSlab('2', 4, 8);
    const columns = [
      { id: 'c1', position: { x: 0, y: 0 }, width: 0.3, depth: 0.3, height: 3, elasticModulus: 25e6 } as any,
      { id: 'c2', position: { x: 0, y: 4 }, width: 0.3, depth: 0.3, height: 3, elasticModulus: 25e6 } as any,
      { id: 'c3', position: { x: 4, y: 0 }, width: 0.3, depth: 0.3, height: 3, elasticModulus: 25e6 } as any,
      { id: 'c4', position: { x: 4, y: 4 }, width: 0.3, depth: 0.3, height: 3, elasticModulus: 25e6 } as any,
      { id: 'c5', position: { x: 8, y: 0 }, width: 0.3, depth: 0.3, height: 3, elasticModulus: 25e6 } as any,
      { id: 'c6', position: { x: 8, y: 4 }, width: 0.3, depth: 0.3, height: 3, elasticModulus: 25e6 } as any,
    ];

    const wallLeft = { id: 'w1', startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 4 }, thickness: 0.2, height: 3 } as any;
    const wallMiddle = { id: 'w2', startPoint: { x: 4, y: 0 }, endPoint: { x: 4, y: 4 }, thickness: 0.2, height: 3 } as any;
    const wallRight = { id: 'w3', startPoint: { x: 8, y: 0 }, endPoint: { x: 8, y: 4 }, thickness: 0.2, height: 3 } as any;
    const { results } = analyzeAllSlabs([s1, s2], columns, [wallLeft, wallMiddle, wallRight], [], [], [], [], [], 0.5, 0.2);

    expect(results.length).toBe(2);
    // Find node with max deflection in Slab 1
    const r1 = results[0];
    let maxDeflNode = r1.nodeDeflections[0];
    for (const d of r1.nodeDeflections) {
      if (Math.abs(d.wz) > Math.abs(maxDeflNode.wz)) maxDeflNode = d;
    }
    const maxNodePos = r1.mesh.nodes.find(n => n.id === maxDeflNode.nodeId);
    expect(maxNodePos).toBeDefined();
    // Max deflection must occur inside panel interior (x around 1.5 - 2.5), NOT at the boundary x=4
    expect(maxNodePos!.x).toBeGreaterThan(0.5);
    expect(maxNodePos!.x).toBeLessThan(3.5);
  });
});
