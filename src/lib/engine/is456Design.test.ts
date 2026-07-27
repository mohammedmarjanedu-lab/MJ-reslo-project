import { describe, it, expect } from 'vitest';
import { analyzeAllSlabs } from './femSolver';
import { runSlabDesign, requiredAst } from './is456Design';
import type { SlabPolygon, ShearWallElement } from './types';

function makeSlab(): SlabPolygon {
  return {
    id: '1', label: 'Slab 1',
    vertices: [ { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 } ],
    holes: [], thickness: 0.2, uniformLoad: 5.0, partitionLoad: 1.0,
    concreteDensity: 25, elasticModulus: 25e6, concreteGrade: 'M30',
  } as SlabPolygon;
}

function makeWalls(): ShearWallElement[] {
  return [
    { id: '1', label: 'W1', startPoint: { x: 0, y: 0 }, endPoint: { x: 5, y: 0 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    { id: '2', label: 'W2', startPoint: { x: 5, y: 0 }, endPoint: { x: 5, y: 5 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    { id: '3', label: 'W3', startPoint: { x: 5, y: 5 }, endPoint: { x: 0, y: 5 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
    { id: '4', label: 'W4', startPoint: { x: 0, y: 5 }, endPoint: { x: 0, y: 0 }, thickness: 0.3, height: 3, elasticModulus: 25e6, concreteDensity: 25 } as ShearWallElement,
  ];
}

describe('IS 456 Design Suite', () => {
  it('produces design results (Wood-Armer, reinforcement, shear, crack, deflection)', () => {
    const slab = makeSlab();
    const walls = makeWalls();
    const { results } = analyzeAllSlabs(
      [slab], [], walls, [], [], [], [], [],
      0.5, 0.2, false, undefined,
      { concreteGrade: 'M30', steelGrade: 'Fe 500', cover: 0.025, barDia: 12, exposureLimit: 0.3, longTermFactor: 2.0 }
    );
    expect(results.length).toBe(1);
    const r = results[0];
    expect(r.woodArmer).toBeTruthy();
    expect(r.reinforcement).toBeTruthy();
    expect(r.shearDesign).toBeTruthy();
    expect(r.crackWidth).toBeTruthy();
    expect(r.deflectionCheck).toBeTruthy();
    const maxAst = Math.max(...r.reinforcement!.map(x => x.ast_x_top));
    expect(maxAst).toBeGreaterThan(0);
    expect(r.deflectionCheck!.spanRatio).toBeGreaterThan(0);
  });

  it('runSlabDesign standalone works', () => {
    const slab = makeSlab();
    const result = analyzeAllSlabs([slab], [], makeWalls(), [], [], [], [], [], 0.5, 0.2, false).results[0];
    const design = runSlabDesign(result, slab, { concreteGrade: 'M30', steelGrade: 'Fe 500' });
    expect(design.reinforcement.length).toBeGreaterThan(0);
  });

  it('requiredAst returns 0 for zero moment', () => {
    expect(requiredAst(0, 30, 500, 1, 0.175)).toBe(0);
  });

  it('requiredAst returns positive for non-zero moment', () => {
    const ast = requiredAst(10, 30, 500, 1, 0.175);
    expect(ast).toBeGreaterThan(0);
  });
});
