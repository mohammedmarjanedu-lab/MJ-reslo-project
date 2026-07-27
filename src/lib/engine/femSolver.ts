import type {
  SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, BeamElement,
  DropPanelElement, Point2D, FEMNode, FEMMesh, FEMElement,
  SlabFEMResult, FEMStressResult, NonStructuralWallElement, PolylineNonStructuralWallElement,
  ColumnPunchingResult
} from './types';
import { generateSlabMesh } from './meshGenerator';
import { pointInPolygon, distance, polygonSignedArea, polygonCentroid } from './mathEngine';
import { runSlabDesign } from './is456Design';
import { computeDKTStiffness, computeDKTElementLoad } from './dktSolver';

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function pointToPolygonDist(p: Point2D, poly: Point2D[]): number {
  if (poly.length < 3) return Infinity;
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d = pointToSegmentDist(p, a, b);
    if (d < minD) minD = d;
  }
  return minD;
}

function findPolygonIntersectingSegments(poly: Point2D[], segmentA: Point2D, segmentB: Point2D): Point2D[] {
  const pts: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const inter = lineSegmentIntersection(poly[i], poly[j], segmentA, segmentB);
    if (inter) pts.push(inter);
  }
  return pts;
}

/**
 * Check if two slab polygons touch, overlap, or share an edge within tolerance.
 * Used to detect connected components for multi-slab analysis.
 */
function slabsTouch(a: Point2D[], b: Point2D[], tol = 0.75): boolean {
  if (a.length < 3 || b.length < 3) return false;
  // Quick bounding-box check
  const aMinX = Math.min(...a.map(v => v.x)), aMaxX = Math.max(...a.map(v => v.x));
  const aMinY = Math.min(...a.map(v => v.y)), aMaxY = Math.max(...a.map(v => v.y));
  const bMinX = Math.min(...b.map(v => v.x)), bMaxX = Math.max(...b.map(v => v.x));
  const bMinY = Math.min(...b.map(v => v.y)), bMaxY = Math.max(...b.map(v => v.y));
  if (aMinX > bMaxX + tol || aMaxX < bMinX - tol || aMinY > bMaxY + tol || aMaxY < bMinY - tol) {
    return false; // bounding boxes don't overlap
  }
  // Check direct vertex-to-vertex proximity
  for (const va of a) {
    for (const vb of b) {
      if (distance(va, vb) <= tol) return true;
    }
  }
  // Check if any vertex of a is inside b or within tol of an edge
  for (const v of a) {
    if (pointInPolygon(v, b)) return true;
    for (let i = 0; i < b.length; i++) {
      const j = (i + 1) % b.length;
      if (pointToSegmentDist(v, b[i], b[j]) < tol) return true;
    }
  }
  // Check if any vertex of b is inside a
  for (const v of b) {
    if (pointInPolygon(v, a)) return true;
  }
  // Check edge-edge intersections
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], aj = a[(i + 1) % a.length];
    for (let k = 0; k < b.length; k++) {
      const bk = b[k], bl = b[(k + 1) % b.length];
      const inter = lineSegmentIntersection(ai, aj, bk, bl);
      if (inter) return true;
    }
  }
  return false;
}

function projectPointOnSegment(p: Point2D, a: Point2D, b: Point2D): Point2D {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { ...a };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function lineSegmentIntersection(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: p1.x + t * d1x, y: p1.y + t * d1y };
  }
  return null;
}

// Shape functions and derivatives for Q4 (in parent coords ξ, η ∈ [-1,1])
function q4Shape(ξ: number, η: number): number[] {
  return [
    0.25 * (1 - ξ) * (1 - η),
    0.25 * (1 + ξ) * (1 - η),
    0.25 * (1 + ξ) * (1 + η),
    0.25 * (1 - ξ) * (1 + η),
  ];
}

function q4DShape(ξ: number, η: number): { dN_dξ: number[]; dN_dη: number[] } {
  return {
    dN_dξ: [
      -0.25 * (1 - η), 0.25 * (1 - η), 0.25 * (1 + η), -0.25 * (1 + η),
    ],
    dN_dη: [
      -0.25 * (1 - ξ), -0.25 * (1 + ξ), 0.25 * (1 + ξ), 0.25 * (1 - ξ),
    ],
  };
}

// Q8 serendipity shape functions and derivatives
function q8Shape(ξ: number, η: number): number[] {
  const n = [
    -0.25 * (1 - ξ) * (1 - η) * (1 + ξ + η),
    -0.25 * (1 + ξ) * (1 - η) * (1 - ξ + η),
    -0.25 * (1 + ξ) * (1 + η) * (1 - ξ - η),
    -0.25 * (1 - ξ) * (1 + η) * (1 + ξ - η),
    0.5 * (1 - ξ * ξ) * (1 - η),
    0.5 * (1 + ξ) * (1 - η * η),
    0.5 * (1 - ξ * ξ) * (1 + η),
    0.5 * (1 - ξ) * (1 - η * η),
  ];
  return n;
}

function q8DShape(ξ: number, η: number): { dN_dξ: number[]; dN_dη: number[] } {
  const dN_dξ: number[] = [];
  const dN_dη: number[] = [];
  const a = 1 - ξ, b = 1 + ξ, c = 1 - η, d = 1 + η;
  dN_dξ[0] = 0.25 * c * (2 * ξ + η);
  dN_dξ[1] = 0.25 * c * (2 * ξ - η);
  dN_dξ[2] = 0.25 * d * (2 * ξ + η);
  dN_dξ[3] = 0.25 * d * (2 * ξ - η);
  dN_dξ[4] = -ξ * c;
  dN_dξ[5] = 0.5 * (1 - η * η);
  dN_dξ[6] = -ξ * d;
  dN_dξ[7] = -0.5 * (1 - η * η);
  dN_dη[0] = 0.25 * a * (2 * η + ξ);
  dN_dη[1] = 0.25 * b * (2 * η - ξ);
  dN_dη[2] = 0.25 * b * (2 * η + ξ);
  dN_dη[3] = 0.25 * a * (2 * η - ξ);
  dN_dη[4] = -0.5 * (1 - ξ * ξ);
  dN_dη[5] = -η * b;
  dN_dη[6] = 0.5 * (1 - ξ * ξ);
  dN_dη[7] = -η * a;
  return { dN_dξ, dN_dη };
}

// Gauss points (2×2)
const G2 = [
  { ξ: -1 / Math.sqrt(3), η: -1 / Math.sqrt(3), w: 1 },
  { ξ: 1 / Math.sqrt(3), η: -1 / Math.sqrt(3), w: 1 },
  { ξ: 1 / Math.sqrt(3), η: 1 / Math.sqrt(3), w: 1 },
  { ξ: -1 / Math.sqrt(3), η: 1 / Math.sqrt(3), w: 1 },
];

// 1-point Gauss for shear
const G1 = [{ ξ: 0, η: 0, w: 4 }];

// Gauss points (3×3) for Q8 bending
const G3 = (() => {
  const s = Math.sqrt(0.6);
  const w5 = 25 / 81, w9 = 40 / 81;
  const pts = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const w = (i === 0 && j === 0) ? w9 : (i === 0 || j === 0) ? w5 : 64 / 81;
      pts.push({ ξ: i * s, η: j * s, w });
    }
  }
  return pts;
})();

// 2×2 Gauss for Q8 shear
const G2x2 = [
  { ξ: -1 / Math.sqrt(3), η: -1 / Math.sqrt(3), w: 1 },
  { ξ: 1 / Math.sqrt(3), η: -1 / Math.sqrt(3), w: 1 },
  { ξ: 1 / Math.sqrt(3), η: 1 / Math.sqrt(3), w: 1 },
  { ξ: -1 / Math.sqrt(3), η: 1 / Math.sqrt(3), w: 1 },
];

/**
 * Compute the 12×12 element stiffness matrix for a Mindlin-Reissner Q4 plate element.
 * DOF order per node: [w, θx, θy]
 * Uses 2×2 Gauss for bending, 1-point for shear (reduced integration).
 */
function computeQ4PlateStiffness(
  nodes: Point2D[],
  E: number, ν: number, t: number
): number[][] {
  const D = E * t * t * t / (12 * (1 - ν * ν));
  const Db = [
    [D, D * ν, 0],
    [D * ν, D, 0],
    [0, 0, D * (1 - ν) / 2],
  ];
  const Gmod = E / (2 * (1 + ν));
  const κ = 5 / 6;
  const Ds = Gmod * t * κ;

  const Ke: number[][] = Array.from({ length: 12 }, () => new Array(12).fill(0));

  for (const gp of G2) {
    const { dN_dξ, dN_dη } = q4DShape(gp.ξ, gp.η);
    const N = q4Shape(gp.ξ, gp.η);

    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let i = 0; i < 4; i++) {
      J11 += dN_dξ[i] * nodes[i].x;
      J12 += dN_dξ[i] * nodes[i].y;
      J21 += dN_dη[i] * nodes[i].x;
      J22 += dN_dη[i] * nodes[i].y;
    }
    const detJ = J11 * J22 - J12 * J21;
    if (detJ < 1e-15) continue;

    const invJ11 = J22 / detJ, invJ12 = -J12 / detJ;
    const invJ21 = -J21 / detJ, invJ22 = J11 / detJ;

    const dN_dx: number[] = [];
    const dN_dy: number[] = [];
    for (let i = 0; i < 4; i++) {
      dN_dx.push(invJ11 * dN_dξ[i] + invJ12 * dN_dη[i]);
      dN_dy.push(invJ21 * dN_dξ[i] + invJ22 * dN_dη[i]);
    }

    // Bending strain-displacement matrix B_b (3×12)
    // Standard Mindlin-Reissner curvature convention:
    //   κx =  ∂θx/∂x    κy =  ∂θy/∂y    κxy = ∂θx/∂y + ∂θy/∂x
    const Bb: number[][] = Array.from({ length: 3 }, () => new Array(12).fill(0));
    for (let i = 0; i < 4; i++) {
      const col = 3 * i;
      Bb[0][col + 1] = dN_dx[i];
      Bb[1][col + 2] = dN_dy[i];
      Bb[2][col + 1] = dN_dy[i];
      Bb[2][col + 2] = dN_dx[i];
    }

    // Ke += Bb^T * Db * Bb * detJ * w
    const temp = Array.from({ length: 3 }, () => new Array(12).fill(0));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 12; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += Db[r][k] * Bb[k][c];
        temp[r][c] = sum;
      }
    }
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += Bb[k][r] * temp[k][c];
        Ke[r][c] += sum * detJ * gp.w;
      }
    }
  }

  // Shear contribution (1-point reduced integration)
  for (const gp of G1) {
    const { dN_dξ, dN_dη } = q4DShape(gp.ξ, gp.η);
    const N = q4Shape(gp.ξ, gp.η);

    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let i = 0; i < 4; i++) {
      J11 += dN_dξ[i] * nodes[i].x;
      J12 += dN_dξ[i] * nodes[i].y;
      J21 += dN_dη[i] * nodes[i].x;
      J22 += dN_dη[i] * nodes[i].y;
    }
    const detJ = J11 * J22 - J12 * J21;
    if (detJ < 1e-15) continue;

    const invJ11 = J22 / detJ, invJ12 = -J12 / detJ;
    const invJ21 = -J21 / detJ, invJ22 = J11 / detJ;

    const dN_dx: number[] = [];
    const dN_dy: number[] = [];
    for (let i = 0; i < 4; i++) {
      dN_dx.push(invJ11 * dN_dξ[i] + invJ12 * dN_dη[i]);
      dN_dy.push(invJ21 * dN_dξ[i] + invJ22 * dN_dη[i]);
    }

    // Shear strain-displacement B_s (2×12)
    const Bs: number[][] = Array.from({ length: 2 }, () => new Array(12).fill(0));
    for (let i = 0; i < 4; i++) {
      const col = 3 * i;
      // γxz = dw/dx - θx
      Bs[0][col] = dN_dx[i];     // w contribution
      Bs[0][col + 1] = -N[i];     // θx contribution
      // γyz = dw/dy - θy
      Bs[1][col] = dN_dy[i];     // w contribution
      Bs[1][col + 2] = -N[i];     // θy contribution
    }

    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        let sum = 0;
        for (let k = 0; k < 2; k++) sum += Bs[k][r] * Ds * Bs[k][c];
        Ke[r][c] += sum * detJ * gp.w;
      }
    }
  }

  return Ke;
}

/**
 * Compute the 24×24 element stiffness matrix for a Q8 serendipity Mindlin-Reissner plate element.
 * 8 nodes × 3 DOF (w, θx, θy) = 24 DOF.
 * 3×3 Gauss for bending, 2×2 for shear.
 */
function computeQ8PlateStiffness(
  nodes: Point2D[],
  E: number, ν: number, t: number
): number[][] {
  const D = E * t * t * t / (12 * (1 - ν * ν));
  const Db = [
    [D, D * ν, 0],
    [D * ν, D, 0],
    [0, 0, D * (1 - ν) / 2],
  ];
  const Gmod = E / (2 * (1 + ν));
  const κ = 5 / 6;
  const Ds = Gmod * t * κ;

  const Ke: number[][] = Array.from({ length: 24 }, () => new Array(24).fill(0));

  // 2×2 Gauss for bending (same as Q4)
  for (const gp of G2) {
    const { dN_dξ, dN_dη } = q8DShape(gp.ξ, gp.η);
    const N = q8Shape(gp.ξ, gp.η);

    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let i = 0; i < 8; i++) {
      J11 += dN_dξ[i] * nodes[i].x;
      J12 += dN_dξ[i] * nodes[i].y;
      J21 += dN_dη[i] * nodes[i].x;
      J22 += dN_dη[i] * nodes[i].y;
    }
    const detJ = J11 * J22 - J12 * J21;
    if (detJ < 1e-15) continue;

    const invJ11 = J22 / detJ, invJ12 = -J12 / detJ;
    const invJ21 = -J21 / detJ, invJ22 = J11 / detJ;

    const dN_dx: number[] = [];
    const dN_dy: number[] = [];
    for (let i = 0; i < 8; i++) {
      dN_dx.push(invJ11 * dN_dξ[i] + invJ12 * dN_dη[i]);
      dN_dy.push(invJ21 * dN_dξ[i] + invJ22 * dN_dη[i]);
    }

    // Bending B_b (3×24)
    const Bb: number[][] = Array.from({ length: 3 }, () => new Array(24).fill(0));
    for (let i = 0; i < 8; i++) {
      const col = 3 * i;
      Bb[0][col + 1] = dN_dx[i];
      Bb[1][col + 2] = dN_dy[i];
      Bb[2][col + 1] = dN_dy[i];
      Bb[2][col + 2] = dN_dx[i];
    }

    const temp = Array.from({ length: 3 }, () => new Array(24).fill(0));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 24; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += Db[r][k] * Bb[k][c];
        temp[r][c] = sum;
      }
    }
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += Bb[k][r] * temp[k][c];
        Ke[r][c] += sum * detJ * gp.w;
      }
    }
  }

  // Shear contribution (2×2 reduced integration — prevents shear locking for Q8)
  for (const gp of G2x2) {
    const { dN_dξ, dN_dη } = q8DShape(gp.ξ, gp.η);
    const N = q8Shape(gp.ξ, gp.η);

    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let i = 0; i < 8; i++) {
      J11 += dN_dξ[i] * nodes[i].x;
      J12 += dN_dξ[i] * nodes[i].y;
      J21 += dN_dη[i] * nodes[i].x;
      J22 += dN_dη[i] * nodes[i].y;
    }
    const detJ = J11 * J22 - J12 * J21;
    if (detJ < 1e-15) continue;

    const invJ11 = J22 / detJ, invJ12 = -J12 / detJ;
    const invJ21 = -J21 / detJ, invJ22 = J11 / detJ;

    const dN_dx: number[] = [];
    const dN_dy: number[] = [];
    for (let i = 0; i < 8; i++) {
      dN_dx.push(invJ11 * dN_dξ[i] + invJ12 * dN_dη[i]);
      dN_dy.push(invJ21 * dN_dξ[i] + invJ22 * dN_dη[i]);
    }

    const Bs: number[][] = Array.from({ length: 2 }, () => new Array(24).fill(0));
    for (let i = 0; i < 8; i++) {
      const col = 3 * i;
      Bs[0][col] = dN_dx[i];
      Bs[0][col + 1] = -N[i];
      Bs[1][col] = dN_dy[i];
      Bs[1][col + 2] = -N[i];
    }

    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) {
        let sum = 0;
        for (let k = 0; k < 2; k++) sum += Bs[k][r] * Ds * Bs[k][c];
        Ke[r][c] += sum * detJ * gp.w;
      }
    }
  }

  return Ke;
}

function computeQ8ElementLoad(nodes: Point2D[], q: number): number[] {
  const fe = new Array(24).fill(0);
  for (const gp of G2) {
    const N = q8Shape(gp.ξ, gp.η);
    const { dN_dξ, dN_dη } = q8DShape(gp.ξ, gp.η);
    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let i = 0; i < 8; i++) {
      J11 += dN_dξ[i] * nodes[i].x;
      J12 += dN_dξ[i] * nodes[i].y;
      J21 += dN_dη[i] * nodes[i].x;
      J22 += dN_dη[i] * nodes[i].y;
    }
    const detJ = J11 * J22 - J12 * J21;
    if (detJ < 1e-15) continue;
    for (let i = 0; i < 8; i++) {
      fe[3 * i] += N[i] * q * detJ * gp.w;
    }
  }
  return fe;
}

function computeQ4ElementLoad(nodes: Point2D[], q: number): number[] {
  const fe = new Array(12).fill(0);
  for (const gp of G2) {
    const N = q4Shape(gp.ξ, gp.η);
    const { dN_dξ, dN_dη } = q4DShape(gp.ξ, gp.η);
    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let i = 0; i < 4; i++) {
      J11 += dN_dξ[i] * nodes[i].x;
      J12 += dN_dξ[i] * nodes[i].y;
      J21 += dN_dη[i] * nodes[i].x;
      J22 += dN_dη[i] * nodes[i].y;
    }
    const detJ = J11 * J22 - J12 * J21;
    if (detJ < 1e-15) continue;
    for (let i = 0; i < 4; i++) {
      fe[3 * i] += N[i] * q * detJ * gp.w;
    }
  }
  return fe;
}

/**
function computeT3PlateStiffness(
  nodes: Point2D[],
  E: number, ν: number, t: number
): number[][] {
  const x = [nodes[0].x, nodes[1].x, nodes[2].x];
  const y = [nodes[0].y, nodes[1].y, nodes[2].y];
  const D_coef = E * Math.pow(t, 3) / (12 * (1 - ν * ν));
  const D = [
    [D_coef, D_coef * ν, 0],
    [D_coef * ν, D_coef, 0],
    [0, 0, D_coef * (1 - ν) / 2]
  ];
  return computeDKTStiffness(x, y, D);
}

function computeT3ElementLoad(nodes: Point2D[], q: number): number[] {
  const x = [nodes[0].x, nodes[1].x, nodes[2].x];
  const y = [nodes[0].y, nodes[1].y, nodes[2].y];
  return computeDKTElementLoad(x, y, q);
}

function findClosestNode(nodes: FEMNode[], p: Point2D): number {
  let minD = Infinity, idx = -1;
  for (let i = 0; i < nodes.length; i++) {
    const d = distance(p, { x: nodes[i].x, y: nodes[i].y });
    if (d < minD) { minD = d; idx = i; }
  }
  return idx;
}

function findNodesOnSegment(nodes: FEMNode[], a: Point2D, b: Point2D, tolerance: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const d = pointToSegmentDist({ x: nodes[i].x, y: nodes[i].y }, a, b);
    if (d < tolerance) result.push(i);
  }
  return result;
}

export function pointToPolygonDist(p: Point2D, poly: Point2D[]): number {
  if (poly.length < 3) return Infinity;
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d = pointToSegmentDist(p, a, b);
    if (d < minD) minD = d;
  }
  return minD;
}

function findPolygonIntersectingSegments(poly: Point2D[], segmentA: Point2D, segmentB: Point2D): Point2D[] {
  const pts: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const inter = lineSegmentIntersection(poly[i], poly[j], segmentA, segmentB);
    if (inter) pts.push(inter);
  }
  return pts;
}

/** Check if segment (a,b) is collinear and overlapping with any slab edge. Returns the edge vertices or null. */
export function findCollinearSlabEdge(poly: Point2D[], a: Point2D, b: Point2D, tol: number): { edgeA: Point2D; edgeB: Point2D } | null {
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const p1 = poly[i], p2 = poly[j];
    const e_dx = p2.x - p1.x, e_dy = p2.y - p1.y;
    const e_len2 = e_dx * e_dx + e_dy * e_dy;
    if (e_len2 < 1e-12) continue;
    // Direction vectors must be parallel
    const cross = Math.abs((b.x - a.x) * e_dy - (b.y - a.y) * e_dx);
    if (cross > tol) continue;
    // Distance from point a to the line through (p1,p2) must be ~0 (same line)
    const distA = pointToSegmentDist(a, p1, p2);
    if (distA > tol) continue;
    // Project (a,b) onto (p1,p2) to find overlapping portion
    const t_a = ((a.x - p1.x) * e_dx + (a.y - p1.y) * e_dy) / e_len2;
    const t_b = ((b.x - p1.x) * e_dx + (b.y - p1.y) * e_dy) / e_len2;
    const t_min = Math.max(0, Math.min(t_a, t_b));
    const t_max = Math.min(1, Math.max(t_a, t_b));
    if (t_max - t_min > 1e-6) {
      return {
        edgeA: { x: p1.x + t_min * e_dx, y: p1.y + t_min * e_dy },
        edgeB: { x: p1.x + t_max * e_dx, y: p1.y + t_max * e_dy },
      };
    }
  }
  return null;
}

/**
 * Detect supports for a slab from columns, walls, polyline walls, and beams.
 * Returns a boolean array constrained[ndof] and known displacement array u_known[ndof].
 */
/**
 * Solve K*u = f using banded LDL^T factorization.
 * K is stored as lower banded matrix: K[i][j] for i-j >= 0, bandwidth bw.
 */
function solveBanded(K: number[][], f: number[], bw: number): { u: number[]; warnings: string[] } {
  const n = f.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(bw).fill(0));
  const D = new Array(n).fill(0);
  const warnings: string[] = [];

  for (let i = 0; i < n; i++) {
    // LDL^T factorization
    for (let j = i; j < Math.min(i + bw, n); j++) {
      let sum = K[i][j - i]; // K[i][j] stored at offset (j-i)
      for (let k = Math.max(0, i - bw + 1, j - bw + 1); k < i; k++) {
        if (i - k < bw && j - k < bw) {
          sum -= L[i][i - k] * D[k] * L[j][j - k];
        }
      }
      if (i === j) {
        if (Math.abs(sum) < 1e-15) {
          warnings.push(`Singular DOF at index ${i} (pivot=${sum.toExponential(2)}) — structure may be unstable or unsupported.`);
          D[i] = 1e-15;
        } else D[i] = sum;
        L[i][0] = 1;
      } else {
        if (Math.abs(D[i]) < 1e-15) L[j][j - i] = 0;
        else L[j][j - i] = sum / D[i];
      }
    }
  }

  // Forward substitution: L * z = f
  const z = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = f[i];
    for (let j = Math.max(0, i - bw + 1); j < i; j++) {
      sum -= L[i][i - j] * z[j];
    }
    z[i] = sum;
  }

  // Back substitution: L^T * u = D^{-1} * z
  const u = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i] / D[i];
    for (let j = i + 1; j < Math.min(i + bw, n); j++) {
      sum -= L[j][j - i] * u[j];
    }
    u[i] = sum;
  }

  return { u, warnings };
}

/**
 * Analyze all slabs globally. Merges coincident nodes at shared boundaries (beams/walls)
 * so that adjacent slabs share DOFs and act continuously.
 */
export function analyzeAllSlabs(
  slabs: SlabPolygon[],
  columns: ColumnElement[],
  walls: ShearWallElement[],
  polylineWalls: PolylineWallElement[],
  beams: BeamElement[],
  dropPanels: DropPanelElement[],
  nonStructuralWalls: NonStructuralWallElement[],
  polylineNonStructuralWalls: PolylineNonStructuralWallElement[],
  meshSize: number,
  poissonRatio: number,
  useQ8 = false,
  onProgress?: (pct: number, slabId?: string) => void,
  designOptions?: {
    concreteGrade?: string;
    steelGrade?: string;
    cover?: number;
    barDia?: number;
    exposureLimit?: number;
    longTermFactor?: number;
  }
): { results: SlabFEMResult[]; warnings: string[] } {
  onProgress?.(0.05);

  // 1. Mesh all slabs individually
  const slabMeshes: { slab: SlabPolygon; mesh: FEMMesh }[] = [];
  for (const slab of slabs) {
    const mesh = generateSlabMesh(slab, meshSize, useQ8);
    if (mesh.nodes.length >= 4 && mesh.elements.length >= 1) {
      slabMeshes.push({ slab, mesh });
    }
  }

  if (slabMeshes.length === 0) return { results: [], warnings: [] };
  onProgress?.(0.10);

  // 1b. Detect disconnected slab groups — solve each independently
  const groups: { slab: SlabPolygon; mesh: FEMMesh }[][] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < slabMeshes.length; i++) {
    if (assigned.has(i)) continue;
    const group: typeof slabMeshes = [slabMeshes[i]];
    assigned.add(i);
    // Find all slabs that touch this group (transitive closure)
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < slabMeshes.length; j++) {
        if (assigned.has(j)) continue;
        if (group.some(g => slabsTouch(g.slab.vertices, slabMeshes[j].slab.vertices, Math.max(0.75, meshSize * 1.5)))) {
          group.push(slabMeshes[j]);
          assigned.add(j);
          changed = true;
        }
      }
    }
    groups.push(group);
  }

  if (groups.length > 1) {
    // Multiple disconnected groups — solve each independently and merge
    const allResults: SlabFEMResult[] = [];
    const allWarnings: string[] = [];
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const grpSlabs = grp.map(sm => sm.slab);
      // Filter columns to those near this group's slabs
      const grpColumns = columns.filter(col =>
        grp.some(({ slab }) => pointInPolygon(col.position, slab.vertices) ||
          pointToPolygonDist(col.position, slab.vertices) < Math.max(0.75, meshSize * 1.5))
      );
      // Solve this group via recursion (re-meshes, but that's fast and avoids duplicating 700 lines)
      const grpResult = analyzeAllSlabs(grpSlabs, grpColumns, walls, polylineWalls, beams,
        dropPanels, nonStructuralWalls, polylineNonStructuralWalls,
        meshSize, poissonRatio, useQ8, undefined, designOptions);
      allResults.push(...grpResult.results);
      allWarnings.push(...grpResult.warnings);
    }
    return { results: allResults, warnings: allWarnings };
  }

  // 2. Build global nodes and merge coincident nodes (within tolerance)
  interface NodeRef {
    slabId: string;
    localId: number;
    x: number;
    y: number;
    globalIdx?: number;
  }
  const allNodes: NodeRef[] = [];
  for (const { slab, mesh } of slabMeshes) {
    for (const node of mesh.nodes) {
      allNodes.push({ slabId: slab.id, localId: node.id, x: node.x, y: node.y });
    }
  }

  // Sort nodes along the X-axis to group coincident nodes together
  allNodes.sort((a, b) => a.x - b.x);

  const mergeTol = Math.max(0.12, meshSize * 0.35);
  const mergeTolSq = mergeTol * mergeTol;
  interface UniqueNodeRef extends FEMNode {
    slabId: string;
  }
  const uniqueNodes: UniqueNodeRef[] = [];

  // Spatial grid for O(n) node merging instead of O(n²)
  const gridSize = Math.max(mergeTol, 0.5);
  const grid = new Map<string, number[]>(); // "gx,gy" -> indices into uniqueNodes

  for (const node of allNodes) {
    let foundIdx = -1;

    // Check only nearby grid cells (3x3 neighborhood)
    const gx = Math.floor(node.x / gridSize);
    const gy = Math.floor(node.y / gridSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = (gx + dx) + ',' + (gy + dy);
        const cell = grid.get(key);
        if (cell) {
          for (const ui of cell) {
            const un = uniqueNodes[ui];
            const distSq = (node.x - un.x) ** 2 + (node.y - un.y) ** 2;
            if (distSq < mergeTolSq) {
              foundIdx = ui;
              break;
            }
          }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx >= 0) break;
    }

    if (foundIdx >= 0) {
      node.globalIdx = foundIdx;
    } else {
      const newIdx = uniqueNodes.length;
      uniqueNodes.push({ id: newIdx, x: node.x, y: node.y, slabId: node.slabId });
      node.globalIdx = newIdx;
      const gk = gx + ',' + gy;
      let cell = grid.get(gk);
      if (!cell) { cell = []; grid.set(gk, cell); }
      cell.push(newIdx);
    }
  }

  const globalNodes: FEMNode[] = uniqueNodes;

  // Re-map each slab's local node IDs to the sorted global node indices
  const nodeMap = new Map<string, Map<number, number>>();
  for (const { slab } of slabMeshes) {
    nodeMap.set(slab.id, new Map<number, number>());
  }
  for (const node of allNodes) {
    nodeMap.get(node.slabId)!.set(node.localId, node.globalIdx!);
  }

  // Build unmerged rotational DOFs map for discontinuous slab edges (hinged joints)
  const unmergedRotMap = new Map<string, { rx: number; ry: number }>();
  let nextExtraDof = globalNodes.length * 3;

  for (const { slab, mesh } of slabMeshes) {
    if (slab.discontinuousEdges && slab.discontinuousEdges.length > 0) {
      const tol = meshSize * 0.2;
      for (const n of mesh.nodes) {
        let isDiscont = false;
        for (const seg of slab.discontinuousEdges) {
          if (pointToSegmentDist({ x: n.x, y: n.y }, seg.startPoint, seg.endPoint) < tol) {
            isDiscont = true;
            break;
          }
        }
        if (isDiscont) {
          const key = slab.id + '_' + n.id;
          unmergedRotMap.set(key, { rx: nextExtraDof, ry: nextExtraDof + 1 });
          nextExtraDof += 2;
        }
      }
    }
  }

  function getNodeDofs(slabId: string, localNodeId: number, gNodeIdx: number): [number, number, number] {
    const key = slabId + '_' + localNodeId;
    const rot = unmergedRotMap.get(key);
    if (rot) {
      return [gNodeIdx * 3, rot.rx, rot.ry];
    }
    return [gNodeIdx * 3, gNodeIdx * 3 + 1, gNodeIdx * 3 + 2];
  }

  const ndof = nextExtraDof;
  if (ndof === 0) return { results: [], warnings: [] };
  
  onProgress?.(0.15);

  // 3. Compute bandwidth considering all element DOFs (including unmerged rotational DOFs)
  let maxDiff = 0;
  for (const { slab, mesh } of slabMeshes) {
    const localMap = nodeMap.get(slab.id)!;
    for (const elem of mesh.elements) {
      const elemDofs: number[] = [];
      for (const nid of elem.nodeIds) {
        const gIdx = localMap.get(nid)!;
        elemDofs.push(...getNodeDofs(slab.id, nid, gIdx));
      }
      const minD = Math.min(...elemDofs);
      const maxD = Math.max(...elemDofs);
      const diff = maxD - minD;
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  const bw = Math.min(maxDiff + 1, ndof);
  
  const K_band: number[][] = Array.from({ length: ndof }, () => new Array(bw).fill(0));
  const f_global = new Array(ndof).fill(0);

  // 4. Assemble global K and f
  function nodesPerElem(elem: FEMElement): number {
    const len = elem.nodeIds.length;
    return len === 8 ? 8 : len === 3 ? 3 : 4;
  }

  for (const { slab, mesh } of slabMeshes) {
    const localMap = nodeMap.get(slab.id)!;
    let E = slab.elasticModulus * (slab.crackingModifier ?? 1.0);
    if (E > 1e8) E /= 1000.0; // Normalize Pa to kPa
    const ν = poissonRatio;
    const t = slab.thickness;
    const q = slab.uniformLoad + (slab.partitionLoad ?? 0) + slab.concreteDensity * t;
    
    for (const elem of mesh.elements) {
      const npe = nodesPerElem(elem);
      const elemNodes: Point2D[] = elem.nodeIds.map(nid => {
        const ni = mesh.nodes.find(n => n.id === nid);
        return { x: ni ? ni.x : 0, y: ni ? ni.y : 0 };
      });

      let t_elem = t;
      let q_elem = q;
      const centroid = {
        x: elemNodes.reduce((sum, n) => sum + n.x, 0) / npe,
        y: elemNodes.reduce((sum, n) => sum + n.y, 0) / npe,
      };
      const activeDP = dropPanels.find(dp => dp.vertices.length >= 3 && pointInPolygon(centroid, dp.vertices));
      if (activeDP) {
        t_elem = activeDP.drop;
        q_elem = q + activeDP.concreteDensity * (activeDP.drop - t);
      }

      let Ke: number[][];
      let fe: number[];
      if (npe === 8) {
        Ke = computeQ8PlateStiffness(elemNodes, E, ν, t_elem);
        fe = computeQ8ElementLoad(elemNodes, q_elem);
      } else if (npe === 3) {
        const x = [elemNodes[0].x, elemNodes[1].x, elemNodes[2].x];
        const y = [elemNodes[0].y, elemNodes[1].y, elemNodes[2].y];
        const D_coef = E * Math.pow(t_elem, 3) / (12 * (1 - ν * ν));
        const D = [
          [D_coef, D_coef * ν, 0],
          [D_coef * ν, D_coef, 0],
          [0, 0, D_coef * (1 - ν) / 2]
        ];
        Ke = computeDKTStiffness(x, y, D);
        fe = computeDKTElementLoad(x, y, q_elem);
      } else {
        Ke = computeQ4PlateStiffness(elemNodes, E, ν, t_elem);
        fe = computeQ4ElementLoad(elemNodes, q_elem);
      }

      for (let a = 0; a < npe; a++) {
        const gRowNode = localMap.get(elem.nodeIds[a])!;
        const rowDofs = getNodeDofs(slab.id, elem.nodeIds[a], gRowNode);
        f_global[rowDofs[0]] += fe[3 * a];
        f_global[rowDofs[1]] += fe[3 * a + 1];
        f_global[rowDofs[2]] += fe[3 * a + 2];

        for (let b = 0; b < npe; b++) {
          const gColNode = localMap.get(elem.nodeIds[b])!;
          const colDofs = getNodeDofs(slab.id, elem.nodeIds[b], gColNode);
          for (let dofA = 0; dofA < 3; dofA++) {
            for (let dofB = 0; dofB < 3; dofB++) {
              const r = rowDofs[dofA];
              const c = colDofs[dofB];
              const k_val = Ke[3 * a + dofA][3 * b + dofB];
              if (r <= c && (c - r) < bw) {
                K_band[r][c - r] += k_val;
              }
            }
          }
        }
      }
    }
  }

  onProgress?.(0.35);

  // 5. Partition wall loads globally
  const segments: { sx: number; sy: number; ex: number; ey: number; lineLoad: number }[] = [];
  for (const w of nonStructuralWalls) {
    const lineLoad = (w.partitionUnitWeight ?? 25) * w.thickness * w.height;
    segments.push({ sx: w.startPoint.x, sy: w.startPoint.y, ex: w.endPoint.x, ey: w.endPoint.y, lineLoad });
  }
  for (const pw of polylineNonStructuralWalls) {
    const lineLoad = (pw.partitionUnitWeight ?? 25) * pw.thickness * pw.height;
    for (let i = 0; i < pw.vertices.length - 1; i++) {
      const a = pw.vertices[i], b = pw.vertices[i + 1];
      segments.push({ sx: a.x, sy: a.y, ex: b.x, ey: b.y, lineLoad });
    }
  }

  for (const seg of segments) {
    const dx = seg.ex - seg.sx, dy = seg.ey - seg.sy;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen < 0.001) continue;
    const nx = -dy / segLen, ny = dx / segLen;

    const nearNodes: { nodeIdx: number; t: number }[] = [];
    for (let i = 0; i < globalNodes.length; i++) {
      const nd = globalNodes[i];
      const px = nd.x - seg.sx, py = nd.y - seg.sy;
      const t = (px * dx + py * dy) / (segLen * segLen);
      if (t < -0.01 || t > 1.01) continue;
      const cross = px * ny - py * nx;
      if (Math.abs(cross) < 0.15) { // 0.15 tolerance for partition walls
        nearNodes.push({ nodeIdx: i, t: Math.max(0, Math.min(1, t)) });
      }
    }
    
    if (nearNodes.length === 0) {
      // Fallback: Apply to closest node to midpoint
      const mx = (seg.sx + seg.ex) / 2.0;
      const my = (seg.sy + seg.ey) / 2.0;
      let minD = Infinity;
      let bestIdx = 0;
      for (let i = 0; i < globalNodes.length; i++) {
        const d = Math.hypot(globalNodes[i].x - mx, globalNodes[i].y - my);
        if (d < minD) {
          minD = d;
          bestIdx = i;
        }
      }
      const force = seg.lineLoad * segLen;
      f_global[bestIdx * 3] += force;
      continue;
    }
    
    if (nearNodes.length === 1) {
      // Apply total segment load to that single node
      const force = seg.lineLoad * segLen;
      f_global[nearNodes[0].nodeIdx * 3] += force;
      continue;
    }
    
    // Mathematically exact partition using telescoping midpoints (conserves 100% load)
    nearNodes.sort((a, b) => a.t - b.t);
    for (let i = 0; i < nearNodes.length; i++) {
      const left = i === 0 ? 0.0 : (nearNodes[i].t + nearNodes[i - 1].t) / 2.0;
      const right = i === nearNodes.length - 1 ? 1.0 : (nearNodes[i].t + nearNodes[i + 1].t) / 2.0;
      
      const tribLen = (right - left) * segLen;
      const force = seg.lineLoad * tribLen;
      f_global[nearNodes[i].nodeIdx * 3] += force; // Apply to 'w' DOF
    }
  }

  onProgress?.(0.40);

  // 6. Support conditions (applied to global nodes)
  const bc = new Array(ndof).fill(false);
  const searchTol = meshSize * 0.6;
  const colTol = meshSize * 1.2;

  // Point supports (columns) — Model as elastic column springs matching Kratos Multiphysics & ETABS
  const columnPunchingMap = new Map<string, { K_z: number; col: ColumnElement; nodeIdx: number }>();

  for (const col of columns) {
    let nearSlab = false;
    for (const { slab } of slabMeshes) {
      if (pointInPolygon(col.position, slab.vertices) || pointToPolygonDist(col.position, slab.vertices) < Math.max(0.75, meshSize * 1.5)) {
        nearSlab = true;
        break;
      }
    }
    if (nearSlab) {
      let matchedCount = 0;
      for (let i = 0; i < globalNodes.length; i++) {
        const d = distance(col.position, globalNodes[i]);
        if (d < colTol) {
          matchedCount++;
          const wcol = col.width || 0.3;
          const dcol = col.depth || 0.3;
          const Hcol = col.height || 3.0;
          let E_col = col.elasticModulus || 25e6; // kPa
          if (E_col > 1e8) E_col /= 1000.0;

          let A_col = wcol * dcol;
          let Ix = wcol * Math.pow(dcol, 3) / 12.0;
          let Iy = dcol * Math.pow(wcol, 3) / 12.0;
          if (col.shape === 'circular') {
            const diam = col.diameter || 0.5;
            A_col = Math.PI * Math.pow(diam, 2) / 4.0;
            Ix = Math.PI * Math.pow(diam, 4) / 64.0;
            Iy = Ix;
          }

          const K_z = E_col * A_col / Hcol;
          const K_rx = 4.0 * E_col * Ix / Hcol;
          const K_ry = 4.0 * E_col * Iy / Hcol;

          const r_w = i * 3;
          const r_rx = i * 3 + 1;
          const r_ry = i * 3 + 2;

          K_band[r_w][0] += K_z;
          K_band[r_rx][0] += K_rx;
          K_band[r_ry][0] += K_ry;

          columnPunchingMap.set(col.id, { K_z, col, nodeIdx: i });
        }
      }

      if (matchedCount === 0 && globalNodes.length > 0) {
        let minD = Infinity;
        let bestIdx = 0;
        for (let i = 0; i < globalNodes.length; i++) {
          const d = distance(col.position, globalNodes[i]);
          if (d < minD) { minD = d; bestIdx = i; }
        }
        if (minD < Math.max(1.0, meshSize * 2.0)) {
          const wcol = col.width || 0.3;
          const dcol = col.depth || 0.3;
          const Hcol = col.height || 3.0;
          let E_col = col.elasticModulus || 25e6;
          if (E_col > 1e8) E_col /= 1000.0;

          let A_col = wcol * dcol;
          let Ix = wcol * Math.pow(dcol, 3) / 12.0;
          let Iy = dcol * Math.pow(wcol, 3) / 12.0;
          if (col.shape === 'circular') {
            const diam = col.diameter || 0.5;
            A_col = Math.PI * Math.pow(diam, 2) / 4.0;
            Ix = Math.PI * Math.pow(diam, 4) / 64.0;
            Iy = Ix;
          }

          const K_z = E_col * A_col / Hcol;
          const K_rx = 4.0 * E_col * Ix / Hcol;
          const K_ry = 4.0 * E_col * Iy / Hcol;

          const r_w = bestIdx * 3;
          const r_rx = bestIdx * 3 + 1;
          const r_ry = bestIdx * 3 + 2;

          K_band[r_w][0] += K_z;
          K_band[r_rx][0] += K_rx;
          K_band[r_ry][0] += K_ry;

          columnPunchingMap.set(col.id, { K_z, col, nodeIdx: bestIdx });
        }
      }
    }
  }

  function constrainGlobalSegment(a: Point2D, b: Point2D) {
    let foundCollinear = false;
    for (const { slab } of slabMeshes) {
      const collinear = findCollinearSlabEdge(slab.vertices, a, b, searchTol);
      if (collinear) {
        foundCollinear = true;
        for (let i = 0; i < globalNodes.length; i++) {
          if (pointToSegmentDist(globalNodes[i], collinear.edgeA, collinear.edgeB) < searchTol) {
            bc[i * 3] = true;
          }
        }
      }
    }
    if (foundCollinear) return;

    for (const { slab } of slabMeshes) {
      const intersectPts = findPolygonIntersectingSegments(slab.vertices, a, b);
      if (intersectPts.length >= 2) {
        for (let i = 0; i < globalNodes.length; i++) {
          if (pointToSegmentDist(globalNodes[i], intersectPts[0], intersectPts[1]) < searchTol) {
            bc[i * 3] = true;
          }
        }
      } else {
        for (const dp of [a, b]) {
          if (pointInPolygon(dp, slab.vertices) || distance(dp, slab.vertices[0]) < searchTol) {
            let minD = Infinity; let ni = -1;
            for (let i = 0; i < globalNodes.length; i++) {
              const d = distance(dp, globalNodes[i]);
              if (d < minD) { minD = d; ni = i; }
            }
            if (ni >= 0 && minD < searchTol) {
              bc[ni * 3] = true;
            }
          }
        }
      }
    }
  }

  for (const wall of walls) constrainGlobalSegment(wall.startPoint, wall.endPoint);
  for (const pwall of polylineWalls) {
    for (let i = 0; i < pwall.vertices.length - 1; i++) {
      constrainGlobalSegment(pwall.vertices[i], pwall.vertices[i + 1]);
    }
  }
  for (const beam of beams) constrainGlobalSegment(beam.startPoint, beam.endPoint);

  onProgress?.(0.50);

  let supportCount = 0;
  for (let i = 0; i < ndof; i++) {
    if (bc[i]) {
      for (let j = Math.max(0, i - bw + 1); j < i; j++) {
        if ((i - j) < bw) K_band[j][i - j] = 0;
      }
      for (let j = i; j < Math.min(ndof, i + bw); j++) {
        if ((j - i) < bw) K_band[i][j - i] = (i === j) ? 1 : 0;
      }
      f_global[i] = 0;
      supportCount++;
    }
  }

  if (supportCount === 0 && columnPunchingMap.size === 0) return { results: [], warnings: [] }; // Unstable structure

  // 7. Solve Global System
  const { u: u_global, warnings: solverWarnings } = solveBanded(K_band, f_global, bw);

  onProgress?.(0.70);

  // 8. Extract results per slab
  const results: SlabFEMResult[] = [];
  
  for (let sIdx = 0; sIdx < slabMeshes.length; sIdx++) {
    const { slab, mesh } = slabMeshes[sIdx];
    const localMap = nodeMap.get(slab.id)!;
    const E = slab.elasticModulus * (slab.crackingModifier ?? 1.0);
    const ν = poissonRatio;
    const t = slab.thickness;
    
    const nodeDeflections = mesh.nodes.map(n => {
      const gIdx = localMap.get(n.id)!;
      const wz = u_global[gIdx * 3];
      return { nodeId: n.id, wz: isFinite(wz) ? -wz : 0 };
    });

    const momentMx: { elementId: number; value: number }[] = [];
    const momentMy: { elementId: number; value: number }[] = [];
    const momentMxy: { elementId: number; value: number }[] = [];
    const stresses: FEMStressResult[] = [];
    const shears: { elementId: number; vx: number; vy: number; v1: number; angle: number }[] = [];
    
    for (const elem of mesh.elements) {
      const npe = nodesPerElem(elem);
      const elemNodes: Point2D[] = elem.nodeIds.map(nid => {
        const ni = mesh.nodes.find(n => n.id === nid)!;
        return { x: ni.x, y: ni.y };
      });

      const centroid = {
        x: elemNodes.reduce((sum, n) => sum + n.x, 0) / npe,
        y: elemNodes.reduce((sum, n) => sum + n.y, 0) / npe,
      };
      const activeDP = dropPanels.find(dp => dp.vertices.length >= 3 && pointInPolygon(centroid, dp.vertices));
      const t_elem = activeDP ? activeDP.drop : t;

      const u_e: number[] = [];
      for (const nid of elem.nodeIds) {
        const gIdx = localMap.get(nid)!;
        const dofs = getNodeDofs(slab.id, nid, gIdx);
        u_e.push(u_global[dofs[0]], u_global[dofs[1]], u_global[dofs[2]]);
      }

      const D = E * t_elem * t_elem * t_elem / (12 * (1 - ν * ν));
      const Dmat = [
        [D, D * ν, 0],
        [D * ν, D, 0],
        [0, 0, D * (1 - ν) / 2],
      ];

      let dN_dx: number[], dN_dy: number[], N_centroid: number[];

      if (npe === 3) {
        const x1 = elemNodes[0].x, y1 = elemNodes[0].y;
        const x2 = elemNodes[1].x, y2 = elemNodes[1].y;
        const x3 = elemNodes[2].x, y3 = elemNodes[2].y;
        const detJtri = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
        if (Math.abs(detJtri) < 1e-15) continue;
        dN_dx = [(y2 - y3) / detJtri, (y3 - y1) / detJtri, (y1 - y2) / detJtri];
        dN_dy = [(x3 - x2) / detJtri, (x1 - x3) / detJtri, (x2 - x1) / detJtri];
        N_centroid = [1 / 3, 1 / 3, 1 / 3];
      } else if (npe === 8) {
        const { dN_dξ, dN_dη } = q8DShape(0, 0);
        N_centroid = q8Shape(0, 0);
        let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
        for (let i = 0; i < 8; i++) {
          J11 += dN_dξ[i] * elemNodes[i].x;
          J12 += dN_dξ[i] * elemNodes[i].y;
          J21 += dN_dη[i] * elemNodes[i].x;
          J22 += dN_dη[i] * elemNodes[i].y;
        }
        const detJ8 = J11 * J22 - J12 * J21;
        if (detJ8 < 1e-15) continue;
        const invJ11 = J22 / detJ8, invJ12 = -J12 / detJ8;
        const invJ21 = -J21 / detJ8, invJ22 = J11 / detJ8;
        dN_dx = []; dN_dy = [];
        for (let i = 0; i < 8; i++) {
          dN_dx.push(invJ11 * dN_dξ[i] + invJ12 * dN_dη[i]);
          dN_dy.push(invJ21 * dN_dξ[i] + invJ22 * dN_dη[i]);
        }
      } else {
        const { dN_dξ, dN_dη } = q4DShape(0, 0);
        N_centroid = q4Shape(0, 0);
        let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
        for (let i = 0; i < 4; i++) {
          J11 += dN_dξ[i] * elemNodes[i].x;
          J12 += dN_dξ[i] * elemNodes[i].y;
          J21 += dN_dη[i] * elemNodes[i].x;
          J22 += dN_dη[i] * elemNodes[i].y;
        }
        const detJ4 = J11 * J22 - J12 * J21;
        if (detJ4 < 1e-15) continue;
        const invJ11 = J22 / detJ4, invJ12 = -J12 / detJ4;
        const invJ21 = -J21 / detJ4, invJ22 = J11 / detJ4;
        dN_dx = []; dN_dy = [];
        for (let i = 0; i < 4; i++) {
          dN_dx.push(invJ11 * dN_dξ[i] + invJ12 * dN_dη[i]);
          dN_dy.push(invJ21 * dN_dξ[i] + invJ22 * dN_dη[i]);
        }
      }

      let κx = 0, κy = 0, κxy = 0;
      for (let i = 0; i < npe; i++) {
        const theta_x = u_e[3 * i + 1]; // Rotation about X (d_w / d_y)
        const theta_y = u_e[3 * i + 2]; // Rotation about Y (-d_w / d_x)
        κx += dN_dx[i] * theta_y;  // d^2_w / d_x^2
        κy += dN_dy[i] * theta_x;  // d^2_w / d_y^2
        κxy += dN_dx[i] * theta_x + dN_dy[i] * theta_y; // 2 * d^2_w / (dx dy)
      }

      const mx = (Dmat[0][0] * κx + Dmat[0][1] * κy);
      const my = (Dmat[1][0] * κx + Dmat[1][1] * κy);
      const mxy = (Dmat[2][2] * κxy);

      momentMx.push({ elementId: elem.id, value: mx });
      momentMy.push({ elementId: elem.id, value: my });
      momentMxy.push({ elementId: elem.id, value: mxy });

      const z_h = t_elem / 2;
      const Iz = t_elem * t_elem * t_elem / 12;
      const σx = mx * z_h / Iz;
      const σy = my * z_h / Iz;
      const τxy = mxy * z_h / Iz;

      const avg = (σx + σy) / 2;
      const rad = Math.sqrt(((σx - σy) / 2) ** 2 + τxy ** 2);
      const s1 = avg + rad;
      const s2 = avg - rad;
      const angle = (Math.abs(σx - σy) > 1e-10) ? 0.5 * Math.atan2(2 * τxy, σx - σy) : 0;
      const vm = Math.sqrt(s1 * s1 + s2 * s2 - s1 * s2);

      stresses.push({ elementId: elem.id, s1, s2, angle, vm });

      const Gmod = E / (2 * (1 + ν));
      const κ = 5 / 6;
      const Ds = Gmod * t_elem * κ;
      let γxz = 0, γyz = 0;
      for (let i = 0; i < npe; i++) {
        γxz += dN_dx[i] * u_e[3 * i] - N_centroid[i] * u_e[3 * i + 1];
        γyz += dN_dy[i] * u_e[3 * i] - N_centroid[i] * u_e[3 * i + 2];
      }
      const vx = Ds * γxz;
      const vy = Ds * γyz;
      const v1 = Math.sqrt(vx * vx + vy * vy);
      const s_angle = (Math.abs(vx) > 1e-10 || Math.abs(vy) > 1e-10) ? Math.atan2(vy, vx) * 180 / Math.PI : 0;
      shears.push({ elementId: elem.id, vx, vy, v1, angle: s_angle });
    }

    // Compute column punching shear stresses (IS 456 / ETABS standard)
    const columnPunching: ColumnPunchingResult[] = [];
    const cover = 0.025;
    const d_eff = Math.max(0.05, t - cover - 0.012);

    for (const [colId, info] of columnPunchingMap) {
      const { K_z, col, nodeIdx } = info;
      const wz_col = Math.abs(u_global[nodeIdx * 3]);
      const V_col = K_z * wz_col; // kN
      const force_kN = V_col;
      const V_col_N = V_col * 1000.0;

      const wcol = col.width || 0.3;
      const dcol = col.depth || 0.3;
      let b0 = 2.0 * (wcol + dcol + 2.0 * d_eff);
      if (col.shape === 'circular') {
        const diam = col.diameter || 0.5;
        b0 = Math.PI * (diam + d_eff);
      }

      const v_u_Pa = (b0 > 0 && d_eff > 0) ? V_col_N / (b0 * d_eff) : 0;
      const v_u_MPa = v_u_Pa / 1e6;

      let fck_MPa = 30.0;
      if (col.concreteGrade && col.concreteGrade.startsWith('M')) {
        fck_MPa = parseFloat(col.concreteGrade.replace('M', '')) || 30.0;
      }
      const beta_c = Math.max(wcol / dcol, dcol / wcol);
      const ks = Math.min(1.0, 0.5 + beta_c);
      const v_c_MPa = ks * 0.25 * Math.sqrt(fck_MPa);

      const ratio = v_c_MPa > 0 ? v_u_MPa / v_c_MPa : 0;
      const status = ratio < 0.7 ? 'OK' : ratio < 1.0 ? 'WARNING' : 'FAIL';

      columnPunching.push({
        nodeId: nodeIdx,
        force_kN: Math.round(force_kN * 100) / 100,
        stress_MPa: Math.round(v_u_MPa * 1000) / 1000,
        capacity_MPa: Math.round(v_c_MPa * 1000) / 1000,
        ratio: Math.round(ratio * 1000) / 1000,
        status
      });
    }

    let minWz = Infinity, maxWz = -Infinity;
    let minMx = Infinity, maxMx = -Infinity;
    let minMy = Infinity, maxMy = -Infinity;
    let minMxy = Infinity, maxMxy = -Infinity;
    let minVx = Infinity, maxVx = -Infinity;
    let minVy = Infinity, maxVy = -Infinity;

    for (const d of nodeDeflections) {
      const v = d.wz; if (isFinite(v)) { if (v < minWz) minWz = v; if (v > maxWz) maxWz = v; }
    }
    for (const m of momentMx) {
      const v = m.value; if (isFinite(v)) { if (v < minMx) minMx = v; if (v > maxMx) maxMx = v; }
    }
    for (const m of momentMy) {
      const v = m.value; if (isFinite(v)) { if (v < minMy) minMy = v; if (v > maxMy) maxMy = v; }
    }
    for (const m of momentMxy) {
      const v = m.value; if (isFinite(v)) { if (v < minMxy) minMxy = v; if (v > maxMxy) maxMxy = v; }
    }
    for (const s of shears) {
      if (isFinite(s.vx)) { if (s.vx < minVx) minVx = s.vx; if (s.vx > maxVx) maxVx = s.vx; }
      if (isFinite(s.vy)) { if (s.vy < minVy) minVy = s.vy; if (s.vy > maxVy) maxVy = s.vy; }
    }

    // ─── IS 456:2000 Design Suite ───
    const design = designOptions ? runSlabDesign({
      slabId: slab.id, mesh, nodeDeflections, momentMx, momentMy, momentMxy, stresses, shears, columnPunching
    } as SlabFEMResult, slab, designOptions) : null;

    let minAstXTop = Infinity, maxAstXTop = -Infinity;
    let minAstYTop = Infinity, maxAstYTop = -Infinity;
    let minAstXBot = Infinity, maxAstXBot = -Infinity;
    let minAstYBot = Infinity, maxAstYBot = -Infinity;
    let minCrack = Infinity, maxCrack = -Infinity;

    if (design) {
      for (const r of design.reinforcement) {
        if (r.ast_x_top < minAstXTop) minAstXTop = r.ast_x_top;
        if (r.ast_x_top > maxAstXTop) maxAstXTop = r.ast_x_top;
        if (r.ast_y_top < minAstYTop) minAstYTop = r.ast_y_top;
        if (r.ast_y_top > maxAstYTop) maxAstYTop = r.ast_y_top;
        if (r.ast_x_bot < minAstXBot) minAstXBot = r.ast_x_bot;
        if (r.ast_x_bot > maxAstXBot) maxAstXBot = r.ast_x_bot;
        if (r.ast_y_bot < minAstYBot) minAstYBot = r.ast_y_bot;
        if (r.ast_y_bot > maxAstYBot) maxAstYBot = r.ast_y_bot;
      }
      for (const c of design.crackWidth) {
        if (c.crackWidth < minCrack) minCrack = c.crackWidth;
        if (c.crackWidth > maxCrack) maxCrack = c.crackWidth;
      }
    }

    results.push({
      slabId: slab.id,
      mesh,
      nodeDeflections,
      momentMx, momentMy, momentMxy,
      stresses, shears, columnPunching,
      woodArmer: design?.woodArmer,
      reinforcement: design?.reinforcement,
      shearDesign: design?.shearDesign,
      crackWidth: design?.crackWidth,
      deflectionCheck: design?.deflectionCheck,
      minWz: isFinite(minWz) ? minWz : 0,
      maxWz: isFinite(maxWz) ? maxWz : 0,
      minMx: isFinite(minMx) ? minMx : 0,
      maxMx: isFinite(maxMx) ? maxMx : 0,
      minMy: isFinite(minMy) ? minMy : 0,
      maxMy: isFinite(maxMy) ? maxMy : 0,
      minMxy: isFinite(minMxy) ? minMxy : 0,
      maxMxy: isFinite(maxMxy) ? maxMxy : 0,
      minVx: isFinite(minVx) ? minVx : 0,
      maxVx: isFinite(maxVx) ? maxVx : 0,
      minVy: isFinite(minVy) ? minVy : 0,
      maxVy: isFinite(maxVy) ? maxVy : 0,
      minAstXTop: isFinite(minAstXTop) ? minAstXTop : 0,
      maxAstXTop: isFinite(maxAstXTop) ? maxAstXTop : 0,
      minAstYTop: isFinite(minAstYTop) ? minAstYTop : 0,
      maxAstYTop: isFinite(maxAstYTop) ? maxAstYTop : 0,
      minAstXBot: isFinite(minAstXBot) ? minAstXBot : 0,
      maxAstXBot: isFinite(maxAstXBot) ? maxAstXBot : 0,
      minAstYBot: isFinite(minAstYBot) ? minAstYBot : 0,
      maxAstYBot: isFinite(maxAstYBot) ? maxAstYBot : 0,
      minCrack: isFinite(minCrack) ? minCrack : 0,
      maxCrack: isFinite(maxCrack) ? maxCrack : 0,
    });
  }

  onProgress?.(1.0);
  return { results, warnings: solverWarnings };
}
