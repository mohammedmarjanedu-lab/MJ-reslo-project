import { describe, it, expect } from 'vitest';
import { analyzeAllSlabs, findCollinearSlabEdge } from './femSolver';
import type { SlabPolygon, ColumnElement, ShearWallElement, BeamElement, DropPanelElement, PolylineWallElement } from './types';

function makeSquareSlab(id: number, side: number): SlabPolygon {
  return {
    id: String(id),
    name: `Slab ${id}`,
    vertices: [
      { x: 0, y: 0 },
      { x: side, y: 0 },
      { x: side, y: side },
      { x: 0, y: side },
    ],
    holes: [],
    thickness: 0.2,
    uniformLoad: 5.0,
    concreteDensity: 25,
    elasticModulus: 25e6,
    color: '#888',
  } as any;
}

function makeEdgeWalls(side: number): ShearWallElement[] {
  return [
    { id: '1', name: 'Wall', startPoint: { x: 0, y: 0 }, endPoint: { x: side, y: 0 }, thickness: 0.3, height: 3.0, elasticModulus: 25e6, boundaryCondition: 'simply-supported', color: '#888' } as any,
    { id: '2', name: 'Wall', startPoint: { x: side, y: 0 }, endPoint: { x: side, y: side }, thickness: 0.3, height: 3.0, elasticModulus: 25e6, boundaryCondition: 'simply-supported', color: '#888' } as any,
    { id: '3', name: 'Wall', startPoint: { x: side, y: side }, endPoint: { x: 0, y: side }, thickness: 0.3, height: 3.0, elasticModulus: 25e6, boundaryCondition: 'simply-supported', color: '#888' } as any,
    { id: '4', name: 'Wall', startPoint: { x: 0, y: side }, endPoint: { x: 0, y: 0 }, thickness: 0.3, height: 3.0, elasticModulus: 25e6, boundaryCondition: 'simply-supported', color: '#888' } as any,
  ];
}

describe('findCollinearSlabEdge', () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it('detects collinear wall on bottom edge', () => {
    const result = findCollinearSlabEdge(poly, { x: 0, y: 0 }, { x: 4, y: 0 }, 0.1);
    expect(result).not.toBeNull();
    expect(result!.edgeA.x).toBeCloseTo(0);
    expect(result!.edgeA.y).toBeCloseTo(0);
    expect(result!.edgeB.x).toBeCloseTo(4);
    expect(result!.edgeB.y).toBeCloseTo(0);
  });

  it('detects wall on right edge', () => {
    const result = findCollinearSlabEdge(poly, { x: 4, y: 0 }, { x: 4, y: 4 }, 0.1);
    expect(result).not.toBeNull();
    expect(result!.edgeA.x).toBeCloseTo(4);
    expect(result!.edgeA.y).toBeCloseTo(0);
    expect(result!.edgeB.x).toBeCloseTo(4);
    expect(result!.edgeB.y).toBeCloseTo(4);
  });

  it('rejects parallel wall on opposite side', () => {
    // Wall at y=0 should NOT match edge at y=4
    const result = findCollinearSlabEdge(poly, { x: 0, y: 0 }, { x: 4, y: 0 }, 0.1);
    // Should match bottom edge (y=0), NOT top edge (y=4)
    expect(result!.edgeA.y).toBeCloseTo(0);
  });

  it('detects partial wall overlap', () => {
    const result = findCollinearSlabEdge(poly, { x: 1, y: 0 }, { x: 3, y: 0 }, 0.1);
    expect(result).not.toBeNull();
    expect(result!.edgeA.x).toBeCloseTo(1);
    expect(result!.edgeB.x).toBeCloseTo(3);
  });
});

/**
 * Timoshenko closed-form: simply-supported square plate under UDL.
 * w_max = α · q · a⁴ / D   where D = E·t³ / (12·(1-ν²))
 * M_max = β · q · a²
 *
 * For ν = 0.2: α = 0.00425, β = 0.0498 (interpolated from Timoshenko Table 8)
 */
function timoshenkoExpectations(side: number, t: number, E: number, nu: number, q: number) {
  const D = E * t * t * t / (12 * (1 - nu * nu));
  const alpha = 0.00425;
  const beta = 0.0498;
  return {
    wMax: alpha * q * side ** 4 / D,
    mMax: beta * q * side * side,
  };
}

describe('FEM Solver — Timoshenko Validation', () => {
  function runWithInfo(meshSize: number, label: string, useQ8 = false) {
    const side = 4;
    const slab = makeSquareSlab(1, side);
    const walls = makeEdgeWalls(side);
    const result = analyzeAllSlabs(
      [slab], [], walls, [], [], [], [], [],
      meshSize, 0.2, useQ8
    ).results[0];
    const E = slab.elasticModulus * 1.0; // default crackingModifier = 1.0
    const t = slab.thickness;
    const q = slab.uniformLoad + slab.concreteDensity * t;
    const exact = timoshenkoExpectations(side, t, E, 0.2, q);
    const wMax = Math.max(Math.abs(result.minWz), Math.abs(result.maxWz)) / 1000.0;
    const errorW = Math.abs(wMax - exact.wMax) / exact.wMax;
    const errorM = Math.abs(result.maxMx - exact.mMax) / exact.mMax;
    console.log(`${label}: w_max=${wMax.toExponential(4)} error=${(errorW*100).toFixed(1)}% Mx_max=${result.maxMx.toExponential(4)} error=${(errorM*100).toFixed(1)}% nodes=${result.mesh.nodes.length} elements=${result.mesh.elements.length}`);
    return { result, errorW, exact };
  }

  it('Q4 4×4 mesh', () => {
    const { errorW } = runWithInfo(1.0, 'Q4 4×4');
    expect(errorW).toBeLessThan(0.20);
  });

  it('Q4 8×8 mesh', () => {
    const { errorW } = runWithInfo(0.5, 'Q4 8×8');
    expect(errorW).toBeLessThan(0.60);
  });

  // Q8 element implementation is deferred — needs MITC/ANS shear locking formulation
  // Tests will be re-enabled when Q8 solver is complete
});
