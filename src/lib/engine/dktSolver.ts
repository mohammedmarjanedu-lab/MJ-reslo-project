/**
 * RESLO Pure TypeScript Discrete Kirchhoff Triangle (DKT) Solver Engine
 * 
 * Implements high-precision 18-DOF Discrete Kirchhoff Triangle (DKT) thin-to-moderately-thick
 * plate bending & CST membrane shell elements matching Python DKT & ETABS physics exactly.
 */

export interface DKTNode {
  id: number;
  x: number;
  y: number;
}

export interface DKTElement {
  id: number;
  nodeIds: [number, number, number];
}

const GAUSS_PTS = [
  { L1: 1 / 6, L2: 1 / 6, L3: 2 / 3, w: 1 / 3 },
  { L1: 1 / 6, L2: 2 / 3, L3: 1 / 6, w: 1 / 3 },
  { L1: 2 / 3, L2: 1 / 6, L3: 1 / 6, w: 1 / 3 },
];

function dshapeN6(L1: number, L2: number, L3: number): number[][] {
  return [
    [4 * L1 - 1, 0],
    [0, 4 * L2 - 1],
    [-4 * L3 + 1, -4 * L3 + 1],
    [4 * L2, 4 * L1],
    [-4 * L2, 4 * (L3 - L2)],
    [4 * (L3 - L1), -4 * L1]
  ];
}

/**
 * Compute 9x9 DKT bending stiffness matrix for a 3-node triangle.
 * DOFs: [w1, rx1, ry1, w2, rx2, ry2, w3, rx3, ry3]
 */
export function computeDKTStiffness(x: number[], y: number[], D: number[][]): number[][] {
  const A = 0.5 * Math.abs((x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]));
  if (A < 1e-15) {
    return Array(9).fill(0).map(() => Array(9).fill(0));
  }

  const edges = [
    { i: 0, j: 1 },
    { i: 1, j: 2 },
    { i: 2, j: 0 }
  ];

  const edgeInfo = edges.map(({ i, j }) => {
    const dx = x[j] - x[i];
    const dy = y[j] - y[i];
    const L = Math.hypot(dx, dy) || 1e-15;
    return { tx: dx / L, ty: dy / L, L, i, j };
  });

  const detJ = (x[0] - x[2]) * (y[1] - y[2]) - (x[1] - x[2]) * (y[0] - y[2]);
  if (Math.abs(detJ) < 1e-15) {
    return Array(9).fill(0).map(() => Array(9).fill(0));
  }

  const invJ = [
    [(y[1] - y[2]) / detJ, -(x[1] - x[2]) / detJ],
    [-(y[0] - y[2]) / detJ, (x[0] - x[2]) / detJ]
  ];

  // 12x9 Transformation matrix T
  const T = Array(12).fill(0).map(() => Array(9).fill(0));
  for (let n = 0; n < 3; n++) {
    T[2 * n][3 * n + 1] = 1.0;
    T[2 * n + 1][3 * n + 2] = 1.0;
  }

  for (let k = 0; k < 3; k++) {
    const { i, j, tx, ty, L: Lk } = edgeInfo[k];
    const r6 = 6 + 2 * k;
    const r7 = 6 + 2 * k + 1;
    const c = 3 / (2 * Lk);

    T[r6][3 * i] = -tx * c;
    T[r7][3 * i] = -ty * c;
    T[r6][3 * j] = tx * c;
    T[r7][3 * j] = ty * c;

    const c1 = 0.5 * ty * ty - 0.25 * tx * tx;
    const c2 = -0.75 * tx * ty;
    const c3 = -0.75 * tx * ty;
    const c4 = 0.5 * tx * tx - 0.25 * ty * ty;

    for (const idx of [i, j]) {
      T[r6][3 * idx + 1] = c1;
      T[r6][3 * idx + 2] = c2;
      T[r7][3 * idx + 1] = c3;
      T[r7][3 * idx + 2] = c4;
    }
  }

  // Integrate K12 (12x12)
  const K12 = Array(12).fill(0).map(() => Array(12).fill(0));
  for (const { L1, L2, L3, w } of GAUSS_PTS) {
    const dN = dshapeN6(L1, L2, L3);
    const dNdx = new Float64Array(6);
    const dNdy = new Float64Array(6);
    for (let m = 0; m < 6; m++) {
      dNdx[m] = dN[m][0] * invJ[0][0] + dN[m][1] * invJ[1][0];
      dNdy[m] = dN[m][0] * invJ[0][1] + dN[m][1] * invJ[1][1];
    }

    const B = Array(3).fill(0).map(() => Array(12).fill(0));
    for (let m = 0; m < 6; m++) {
      B[0][2 * m] = dNdx[m];
      B[1][2 * m + 1] = dNdy[m];
      B[2][2 * m] = dNdy[m];
      B[2][2 * m + 1] = dNdx[m];
    }

    // B^T * D * B * w * A
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        let DB_0 = D[0][0] * B[0][c] + D[0][1] * B[1][c] + D[0][2] * B[2][c];
        let DB_1 = D[1][0] * B[0][c] + D[1][1] * B[1][c] + D[1][2] * B[2][c];
        let DB_2 = D[2][0] * B[0][c] + D[2][1] * B[1][c] + D[2][2] * B[2][c];
        K12[r][c] += (B[0][r] * DB_0 + B[1][r] * DB_1 + B[2][r] * DB_2) * w * A;
      }
    }
  }

  // K9 = T^T * K12 * T
  const K9 = Array(9).fill(0).map(() => Array(9).fill(0));
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        if (T[i][r] === 0) continue;
        for (let j = 0; j < 12; j++) {
          if (T[j][c] === 0) continue;
          sum += T[i][r] * K12[i][j] * T[j][c];
        }
      }
      K9[r][c] = sum;
    }
  }

  // Enforce symmetry
  for (let r = 0; r < 9; r++) {
    for (let c = r + 1; c < 9; c++) {
      const avg = (K9[r][c] + K9[c][r]) / 2;
      K9[r][c] = avg;
      K9[c][r] = avg;
    }
  }

  return K9;
}

/**
 * Compute 6x6 CST membrane stiffness matrix for a 3-node triangle.
 * DOFs: [u1, v1, u2, v2, u3, v3]
 */
export function computeCSTStiffness(x: number[], y: number[], E: number, nu: number, t: number): number[][] {
  const A = 0.5 * Math.abs((x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]));
  if (A < 1e-15) return Array(6).fill(0).map(() => Array(6).fill(0));

  const b1 = y[1] - y[2], b2 = y[2] - y[0], b3 = y[0] - y[1];
  const c1 = x[2] - x[1], c2 = x[0] - x[2], c3 = x[1] - x[0];
  const det2 = 2 * A;

  const B = [
    [b1 / det2, 0, b2 / det2, 0, b3 / det2, 0],
    [0, c1 / det2, 0, c2 / det2, 0, c3 / det2],
    [c1 / det2, b1 / det2, c2 / det2, b2 / det2, c3 / det2, b3 / det2]
  ];

  const coef = (E * t) / (1 - nu * nu);
  const D = [
    [coef, coef * nu, 0],
    [coef * nu, coef, 0],
    [0, 0, coef * (1 - nu) / 2]
  ];

  const K6 = Array(6).fill(0).map(() => Array(6).fill(0));
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      let DB_0 = D[0][0] * B[0][c] + D[0][1] * B[1][c] + D[0][2] * B[2][c];
      let DB_1 = D[1][0] * B[0][c] + D[1][1] * B[1][c] + D[1][2] * B[2][c];
      let DB_2 = D[2][0] * B[0][c] + D[2][1] * B[1][c] + D[2][2] * B[2][c];
      K6[r][c] = (B[0][r] * DB_0 + B[1][r] * DB_1 + B[2][r] * DB_2) * A;
    }
  }

  return K6;
}

/**
 * Consistent load vector (9,) for uniform pressure q (N/m²).
 */
export function computeDKTElementLoad(x: number[], y: number[], q: number): number[] {
  const A = 0.5 * Math.abs((x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]));
  const f = new Array(9).fill(0);
  f[0] = q * A / 3;
  f[1] = q * A * (x[1] + x[2] - 2 * x[0]) / 24;
  f[2] = q * A * (y[1] + y[2] - 2 * y[0]) / 24;

  f[3] = q * A / 3;
  f[4] = q * A * (x[2] + x[0] - 2 * x[1]) / 24;
  f[5] = q * A * (y[2] + y[0] - 2 * y[1]) / 24;

  f[6] = q * A / 3;
  f[7] = q * A * (x[0] + x[1] - 2 * x[2]) / 24;
  f[8] = q * A * (y[0] + y[1] - 2 * y[2]) / 24;
  return f;
}
