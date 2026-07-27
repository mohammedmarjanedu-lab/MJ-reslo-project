import { describe, it, expect } from 'vitest';
import { computeSprContour, type SprSlabInput } from './sprRecovery';

// ─── Helpers ─────────────────────────────────────────────────────────────────
interface Mesh { nodes: { id: number; x: number; y: number }[]; elements: { id: number; nodeIds: number[]; area: number }[] }

/** Structured triangular grid over [x0,x1]×[y0,y1] with nx×ny cells (1-indexed). */
function rectGrid(x0: number, x1: number, y0: number, y1: number, nx: number, ny: number): Mesh {
  const nodes: Mesh['nodes'] = [];
  const elements: Mesh['elements'] = [];
  const id = (i: number, j: number) => j * (nx + 1) + i + 1;
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++)
      nodes.push({ id: id(i, j), x: x0 + (i * (x1 - x0)) / nx, y: y0 + (j * (y1 - y0)) / ny });
  const dx = (x1 - x0) / nx, dy = (y1 - y0) / ny, area = (dx * dy) / 2;
  let eid = 1;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const n0 = id(i, j), n1 = id(i + 1, j), n2 = id(i + 1, j + 1), n3 = id(i, j + 1);
      elements.push({ id: eid++, nodeIds: [n0, n1, n2], area });
      elements.push({ id: eid++, nodeIds: [n0, n2, n3], area });
    }
  return { nodes, elements };
}

function centroid(mesh: Mesh, elem: Mesh['elements'][0]) {
  let cx = 0, cy = 0;
  for (const nid of elem.nodeIds) {
    const n = mesh.nodes.find(nn => nn.id === nid)!;
    cx += n.x; cy += n.y;
  }
  return { x: cx / elem.nodeIds.length, y: cy / elem.nodeIds.length };
}

/** Plain (old) incident-element average at a node — the pre-SPR behaviour. */
function plainAverage(mesh: Mesh, values: Map<number, number>, nodeId: number): number {
  const inc: number[] = [];
  for (const e of mesh.elements) {
    if (e.nodeIds.includes(nodeId)) {
      const v = values.get(e.id);
      if (v !== undefined) inc.push(v);
    }
  }
  return inc.reduce((a, b) => a + b, 0) / inc.length;
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('SPR contour smoothing', () => {
  it('recovers an exact linear field at every node (incl. boundary/corner nodes)', () => {
    // v(x,y) = 2 + 3x − 4y sampled at element centroids; LSQ planes must reproduce
    // the plane exactly (this is the property that makes contours ETABS-smooth).
    const mesh = rectGrid(0, 5, 0, 5, 5, 5);
    const f = (x: number, y: number) => 2 + 3 * x - 4 * y;
    const values = new Map<number, number>();
    for (const e of mesh.elements) {
      const c = centroid(mesh, e);
      values.set(e.id, f(c.x, c.y));
    }

    const out = computeSprContour([{ slabId: 'A', ...mesh, values }]).get('A')!;

    for (const n of mesh.nodes) {
      expect(out.get(n.id)).toBeCloseTo(f(n.x, n.y), 8);
    }

    // Contrast with the old plain average: at corner node 1 (= (0,0)) the plain
    // incident-element average is biased toward the patch centroid.
    const plain = plainAverage(mesh, values, 1);
    expect(Math.abs(plain - f(0, 0))).toBeGreaterThan(0.25); // plain IS biased
    expect(Math.abs(out.get(1)! - f(0, 0))).toBeLessThan(1e-8); // SPR is exact
  });

  it('keeps cross-slab contours continuous at coincident nodes (shared patch)', () => {
    // Two slabs sharing the interface x=3 with EXACTLY coincident boundary nodes.
    const A = rectGrid(0, 3, 0, 3, 3, 3);
    const B = rectGrid(3, 6, 0, 3, 3, 3);
    const f = (x: number, y: number) => 1 + 2 * x + 0.5 * y;
    const vA = new Map(A.elements.map(e => [e.id, f(centroid(A, e).x, centroid(A, e).y)]));
    const vB = new Map(B.elements.map(e => [e.id, f(centroid(B, e).x, centroid(B, e).y)]));

    const out = computeSprContour([
      { slabId: 'A', ...A, values: vA },
      { slabId: 'B', ...B, values: vB },
    ]);

    const aNodes = A.nodes.filter(n => Math.abs(n.x - 3) < 1e-9);
    const bNodes = B.nodes.filter(n => Math.abs(n.x - 3) < 1e-9);
    expect(aNodes.map(n => n.y)).toEqual(bNodes.map(n => n.y));

    for (let i = 0; i < aNodes.length; i++) {
      const va = out.get('A')!.get(aNodes[i].id)!;
      const vb = out.get('B')!.get(bNodes[i].id)!;
      expect(Math.abs(va - vb)).toBeLessThan(1e-8); // identical position → identical value
      expect(Math.abs(va - f(3, aNodes[i].y))).toBeLessThan(1e-8);
    }
  });

  it('segregates patches across hinged (discontinuous) interface nodes', () => {
    // Same position on the interface, different physical fields per side:
    // a hinge must show the moment JUMP, not a blended value.
    const A = rectGrid(0, 3, 0, 3, 3, 3);
    const B = rectGrid(3, 6, 0, 3, 3, 3);
    const vA = new Map(A.elements.map(e => [e.id, 100]));
    const vB = new Map(B.elements.map(e => [e.id, 200]));
    const hingedA = A.nodes.filter(n => Math.abs(n.x - 3) < 1e-9).map(n => n.id);

    const out = computeSprContour([
      { slabId: 'A', ...A, values: vA, hingedNodeIds: hingedA },
      { slabId: 'B', ...B, values: vB },
    ]);

    for (const nid of hingedA) {
      const nA = A.nodes.find(nn => nn.id === nid)!;
      const nB = B.nodes.find(nn => Math.abs(nn.x - nA.x) < 1e-9 && Math.abs(nn.y - nA.y) < 1e-9)!;
      expect(out.get('A')!.get(nid)).toBeCloseTo(100, 9);   // own side only
      expect(out.get('B')!.get(nB.id)).toBeCloseTo(200, 9);  // other side unaffected
    }
  });

  it('falls back to the weighted mean for degenerate patches (never NaN)', () => {
    // Rectangle cut into exactly 2 triangles: every (one-ring-expanded) patch has only
    // the same 2 samples (< 3) → the plane fit must not run; the area-weighted mean
    // (equal areas → 15) must be returned at every node, with no NaN.
    const mesh = rectGrid(0, 2, 0, 2, 1, 1);
    const values = new Map<number, number>([[1, 10], [2, 20]]);
    const out = computeSprContour([{ slabId: 'A', ...mesh, values }]).get('A')!;
    for (const n of mesh.nodes) {
      const v = out.get(n.id)!;
      expect(isFinite(v)).toBe(true);
      expect(v).toBeCloseTo(15, 9);
    }
  });

  it('is robust to collinear patch samples (rank-deficient) without NaN', () => {
    // Synthetic patch with 3 collinear centroid samples → plane fit singular →
    // weighted mean fallback.
    const mesh: Mesh = {
      nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 3, y: 0 }, { id: 3, x: 0, y: 3 }],
      elements: [{ id: 1, nodeIds: [1, 2, 3], area: 4.5 }],
    };
    const values = new Map<number, number>([[1, 7.5]]);
    const out = computeSprContour([{ slabId: 'A', ...mesh, values }]).get('A')!;
    for (const n of mesh.nodes) {
      expect(out.get(n.id)).toBeCloseTo(7.5, 12);
    }
  });

  it('keeps quadratic-field recovery bounded and smooth (robustness envelope)', () => {
    // For curved fields the recovered value is second-order accurate. The pointwise
    // error stays within ~1.5% of the field range over the interior — the property
    // that matters for display-quality contours (no gross over/under-shoot, no NaN).
    const mesh = rectGrid(0, 4, 0, 4, 6, 6);
    const f = (x: number, y: number) => 0.1 * x * x + 0.2 * x * y + 0.05 * y * y + x + 2;
    const values = new Map<number, number>();
    for (const e of mesh.elements) {
      const c = centroid(mesh, e);
      values.set(e.id, f(c.x, c.y));
    }
    const out = computeSprContour([{ slabId: 'A', ...mesh, values }]).get('A')!;
    const range = f(4, 4) - f(0, 0); // ≈ 9.6
    let maxErr = 0;
    for (const n of mesh.nodes) {
      const v = out.get(n.id)!;
      expect(isFinite(v)).toBe(true);
      const isBoundary = n.x === 0 || n.y === 0 || n.x === 4 || n.y === 4;
      if (!isBoundary) maxErr = Math.max(maxErr, Math.abs(v - f(n.x, n.y)));
    }
    expect(maxErr).toBeLessThan(0.015 * range);
  });
});
