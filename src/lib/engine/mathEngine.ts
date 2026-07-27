import type { Point2D, SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, BeamElement, GlobalMetrics, ElementStiffness, BoundingBox, SlabContribution, DropPanelElement, SharedNode } from './types';

export function polygonSignedArea(verts: Point2D[]): number {
  const n = verts.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += verts[i].x * verts[j].y;
    area -= verts[j].x * verts[i].y;
  }
  return area / 2;
}

export function polygonCentroid(verts: Point2D[]): Point2D {
  const n = verts.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { ...verts[0] };
  if (n === 2) return { x: (verts[0].x + verts[1].x) / 2, y: (verts[0].y + verts[1].y) / 2 };
  const A = polygonSignedArea(verts);
  if (Math.abs(A) < 1e-10) {
    return { x: verts.reduce((s, v) => s + v.x, 0) / n, y: verts.reduce((s, v) => s + v.y, 0) / n };
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = verts[i].x * verts[j].y - verts[j].x * verts[i].y;
    cx += (verts[i].x + verts[j].x) * cross;
    cy += (verts[i].y + verts[j].y) * cross;
  }
  const inv6A = 1 / (6 * A);
  return { x: cx * inv6A, y: cy * inv6A };
}

export function computeSlabContribution(slab: SlabPolygon): SlabContribution {
  const outerArea = Math.abs(polygonSignedArea(slab.vertices));
  const outerCentroid = polygonCentroid(slab.vertices);

  let netArea = outerArea;
  let cxSum = outerCentroid.x * outerArea;
  let cySum = outerCentroid.y * outerArea;

  for (const hole of slab.holes) {
    if (hole.length >= 3) {
      const holeArea = Math.abs(polygonSignedArea(hole));
      const holeCentroid = polygonCentroid(hole);
      netArea -= holeArea;
      cxSum -= holeCentroid.x * holeArea;
      cySum -= holeCentroid.y * holeArea;
    }
  }

  netArea = Math.max(0, netArea);
  const centroid = netArea > 1e-10
    ? { x: cxSum / netArea, y: cySum / netArea }
    : outerCentroid;

  const selfWeight = slab.concreteDensity * slab.thickness * netArea;
  const partitionLoad = (slab.partitionLoad ?? 0) * netArea;
  const imposedLoad = slab.uniformLoad * netArea + partitionLoad;
  const totalWeight = selfWeight + imposedLoad;
  return { area: netArea, centroid, selfWeight, imposedLoad, totalWeight };
}

export function computeColumnStiffness(col: ColumnElement): ElementStiffness {
  const { width: b, depth: h, height: H, elasticModulus: E, boundaryCondition, shape, diameter } = col;
  if (H <= 1e-10 || E <= 1e-10) {
    return { id: col.id, position: col.position, kx: 0, ky: 0, kxy: 0, weight: 0 };
  }

  let Ix = 0;
  let Iy = 0;
  let weight = 0;

  if (shape === 'circular') {
    const D = diameter || b || 0.5;
    if (D <= 1e-10) return { id: col.id, position: col.position, kx: 0, ky: 0, kxy: 0, weight: 0 };
    Ix = (Math.PI * Math.pow(D, 4)) / 64;
    Iy = Ix;
    const area = (Math.PI * D * D) / 4;
    weight = col.concreteDensity * area * H;
  } else {
    if (b <= 1e-10 || h <= 1e-10) return { id: col.id, position: col.position, kx: 0, ky: 0, kxy: 0, weight: 0 };
    Ix = (b * h * h * h) / 12;
    Iy = (h * b * b * b) / 12;
    weight = col.concreteDensity * b * h * H;
  }

  const H3 = H * H * H;
  const endFixity = boundaryCondition === 'fixed-free' ? 3 : 12;
  const kx = (endFixity * E * Iy) / H3;
  const ky = (endFixity * E * Ix) / H3;
  return { id: col.id, position: col.position, kx, ky, kxy: 0, weight };
}

function shearWallInPlaneStiffness(L: number, t: number, H: number, E: number, G: number, endFixity: number): number {
  const I = (t * L * L * L) / 12;
  const A_w = t * L;
  const delta_flex = (H * H * H) / (endFixity * E * I);
  const delta_shear = (1.2 * H) / (G * A_w);
  return 1 / (delta_flex + delta_shear);
}

function shearWallOutOfPlaneStiffness(L: number, t: number, H: number, E: number, endFixity: number, poissonRatio: number): number {
  const nu2 = poissonRatio * poissonRatio;
  const D = (E * t * t * t) / (12 * (1 - nu2));
  return (endFixity * D * L) / (H * H * H);
}

function shearModulusFallback(G: number, E: number): number {
  return G > 1e-10 ? G : E / 2.4;
}

/**
 * Rotate a 2×2 diagonal stiffness matrix {k_along, k_perp} from local
 * wall coordinates (along = wall-length direction, perp = normal to wall)
 * into global XY coordinates.
 */
function rotateWallStiffness(k_along: number, k_perp: number, alpha: number): { kx: number; ky: number; kxy: number } {
  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);
  let kxy = (k_along - k_perp) * sinA * cosA;
  if (Math.abs(kxy) < 1e-6) kxy = 0;
  return {
    kx: k_along * cosA * cosA + k_perp * sinA * sinA,
    ky: k_along * sinA * sinA + k_perp * cosA * cosA,
    kxy,
  };
}

export function computeShearWallStiffness(wall: ShearWallElement): ElementStiffness {
  const { thickness: t, height: H, elasticModulus: E, shearModulus: G_in, boundaryCondition } = wall;
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const L = Math.sqrt(dx * dx + dy * dy);
  const position: Point2D = { x: (wall.startPoint.x + wall.endPoint.x) / 2, y: (wall.startPoint.y + wall.endPoint.y) / 2 };
  const weight = wall.concreteDensity * t * L * H;
  if (L < 1e-10 || H < 1e-10 || E < 1e-10 || t < 1e-10) {
    return { id: wall.id, position, kx: 0, ky: 0, kxy: 0, weight };
  }
  const G = shearModulusFallback(G_in, E);
  const nu = wall.poissonRatio ?? 0.2;
  const alpha = Math.atan2(dy, dx);
  const k_in = shearWallInPlaneStiffness(L, t, H, E, G, 3);
  const k_out = shearWallOutOfPlaneStiffness(L, t, H, E, 3, nu);
  const { kx, ky, kxy } = rotateWallStiffness(k_in, k_out, alpha);
  return { id: wall.id, position, kx, ky, kxy, weight };
}

export function computePolylineWallStiffness(wall: PolylineWallElement): ElementStiffness {
  const totalLen = wall.vertices.reduce((s, _, i, arr) => {
    if (i === 0) return 0;
    const a = arr[i - 1], b = arr[i];
    return s + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  }, 0);
  const position: Point2D = wall.vertices.length > 0
    ? { x: wall.vertices.reduce((s, v) => s + v.x, 0) / wall.vertices.length, y: wall.vertices.reduce((s, v) => s + v.y, 0) / wall.vertices.length }
    : { x: 0, y: 0 };
  const weight = wall.concreteDensity * wall.thickness * totalLen * wall.height;
  if (wall.vertices.length < 2) {
    return { id: wall.id, position, kx: 0, ky: 0, kxy: 0, weight };
  }
  let kx = 0, ky = 0, kxy = 0;
  let wposX = 0, wposY = 0, wSum = 0;
  const G = shearModulusFallback(wall.shearModulus, wall.elasticModulus);
  const nu = wall.poissonRatio ?? 0.2;
  for (let i = 0; i < wall.vertices.length - 1; i++) {
    const a = wall.vertices[i];
    const b = wall.vertices[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-10) continue;
    const alpha = Math.atan2(dy, dx);
    const k_seg_in = shearWallInPlaneStiffness(L, wall.thickness, wall.height, wall.elasticModulus, G, 3);
    const k_seg_out = shearWallOutOfPlaneStiffness(L, wall.thickness, wall.height, wall.elasticModulus, 3, nu);
    const { kx: segKx, ky: segKy, kxy: segKxy } = rotateWallStiffness(k_seg_in, k_seg_out, alpha);
    kx += segKx;
    ky += segKy;
    kxy += segKxy;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const segK = Math.sqrt(segKx * segKx + segKy * segKy + 2 * segKxy * segKxy);
    wposX += midX * segK;
    wposY += midY * segK;
    wSum += segK;
  }
  return { id: wall.id, position: wSum > 1e-10 ? { x: wposX / wSum, y: wposY / wSum } : position, kx, ky, kxy, weight };
}

export function computeGlobalMetrics(
  slabs: SlabPolygon[],
  columns: ColumnElement[],
  walls: ShearWallElement[],
  polylineWalls?: PolylineWallElement[],
  beams?: BeamElement[],
  dropPanels?: DropPanelElement[],
  backendCR?: Point2D,
  liveLoadMassFactor = 0.25,
  nonStructuralWalls?: import('./types').NonStructuralWallElement[],
  polylineNonStructuralWalls?: import('./types').PolylineNonStructuralWallElement[]
): GlobalMetrics {
  let slabGravity = 0;       // full gravity weight (for reporting)
  let cmNumX = 0, cmNumY = 0, cmDen = 0;
  let allSlabVerts: Point2D[] = [];
  for (const slab of slabs) {
    if (slab.vertices.length >= 3) {
      const sc = computeSlabContribution(slab);
      slabGravity += sc.totalWeight;
      // Load-weighted CM: weight by total load (self-weight + live + SIDL)
      cmNumX += sc.totalWeight * sc.centroid.x;
      cmNumY += sc.totalWeight * sc.centroid.y;
      cmDen += sc.totalWeight;
      allSlabVerts = allSlabVerts.concat(slab.vertices);
    }
  }
  // Drop panel additional dead load contributes to CM
  if (dropPanels) {
    for (const dp of dropPanels) {
      if (dp.vertices.length >= 3 && dp.drop > 0) {
        const dpArea = Math.abs(polygonSignedArea(dp.vertices));
        const dpCentroid = polygonCentroid(dp.vertices);
        const dpDensity = dp.concreteDensity ?? 25; // kN/m³
        const dpWeight = dpArea * dp.drop * dpDensity;
        cmNumX += dpWeight * dpCentroid.x;
        cmNumY += dpWeight * dpCentroid.y;
        cmDen += dpWeight;
        slabGravity += dpWeight;
      }
    }
  }
  // Partition wall line loads contribute to CM (only if inside a slab)
  if (nonStructuralWalls) {
    for (const w of nonStructuralWalls) {
      const dx = w.endPoint.x - w.startPoint.x;
      const dy = w.endPoint.y - w.startPoint.y;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 0.001) continue;
      // Check if wall midpoint is inside any slab
      const mx = (w.startPoint.x + w.endPoint.x) / 2;
      const my = (w.startPoint.y + w.endPoint.y) / 2;
      const insideSlab = slabs.some(s => s.vertices.length >= 3 && pointInPolygon({ x: mx, y: my }, s.vertices));
      if (!insideSlab) continue;
      const lineLoad = (w.partitionUnitWeight ?? 25) * w.thickness * w.height;
      const totalW = lineLoad * L;
      cmNumX += totalW * mx;
      cmNumY += totalW * my;
      cmDen += totalW;
    }
  }
  if (polylineNonStructuralWalls) {
    for (const pw of polylineNonStructuralWalls) {
      if (pw.vertices.length < 2) continue;
      // Check if wall midpoint is inside any slab
      let totalLen = 0;
      let weightedX = 0, weightedY = 0;
      for (let i = 0; i < pw.vertices.length - 1; i++) {
        const a = pw.vertices[i], b = pw.vertices[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const segLen = Math.sqrt(dx * dx + dy * dy);
        totalLen += segLen;
        weightedX += segLen * (a.x + b.x) / 2;
        weightedY += segLen * (a.y + b.y) / 2;
      }
      if (totalLen < 0.001) continue;
      const pmx = weightedX / totalLen;
      const pmy = weightedY / totalLen;
      const insideSlab = slabs.some(s => s.vertices.length >= 3 && pointInPolygon({ x: pmx, y: pmy }, s.vertices));
      if (!insideSlab) continue;
      const lineLoad = (pw.partitionUnitWeight ?? 25) * pw.thickness * pw.height;
      const totalW = lineLoad * totalLen;
      cmNumX += totalW * pmx;
      cmNumY += totalW * pmy;
      cmDen += totalW;
    }
  }
  const colStiff = columns.map(computeColumnStiffness);
  const wallStiff = walls.map(computeShearWallStiffness);
  const pwallStiff = (polylineWalls || []).flatMap(pw => {
    const segs: ElementStiffness[] = [];
    if (pw.vertices.length < 2) return segs;
    const G = shearModulusFallback(pw.shearModulus, pw.elasticModulus);
    const nu = pw.poissonRatio ?? 0.2;

    // ─── Pier merging: consecutive collinear segments are merged into one ───
    // ETABS treats each continuous planar pier as a single unit. Since shear wall
    // in-plane stiffness is cubic in pier length (I ∝ L³), splitting one 15m pier
    // into three 5m segments gives wrong stiffness (ratio ≈ 1.72× error).
    // We merge collinear segments (direction within ±0.1°) into a single pier.
    const COLLINEAR_TOL = 0.001745; // 0.1° in radians

    // Build raw segment list with direction angles
    interface RawSeg { x1: number; y1: number; x2: number; y2: number; alpha: number; L: number; }
    const rawSegs: RawSeg[] = [];
    for (let i = 0; i < pw.vertices.length - 1; i++) {
      const a = pw.vertices[i], b = pw.vertices[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-10) continue;
      rawSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, alpha: Math.atan2(dy, dx), L });
    }

    // Merge collinear runs into piers
    const piers: { x1: number; y1: number; x2: number; y2: number; alpha: number }[] = [];
    let i = 0;
    while (i < rawSegs.length) {
      let pierStart = { x: rawSegs[i].x1, y: rawSegs[i].y1 };
      let alpha0 = rawSegs[i].alpha;
      let j = i;
      // Extend pier while segments remain collinear (same direction ± tolerance)
      while (j + 1 < rawSegs.length) {
        const da = Math.abs(rawSegs[j + 1].alpha - alpha0);
        const daNorm = Math.min(da, Math.PI - da); // handle ±π wrap
        if (daNorm > COLLINEAR_TOL) break;
        j++;
      }
      piers.push({ x1: pierStart.x, y1: pierStart.y, x2: rawSegs[j].x2, y2: rawSegs[j].y2, alpha: alpha0 });
      i = j + 1;
    }

    // Compute stiffness for each pier using its full length
    for (let p = 0; p < piers.length; p++) {
      const pier = piers[p];
      const dx = pier.x2 - pier.x1, dy = pier.y2 - pier.y1;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-10) continue;
      const alpha = Math.atan2(dy, dx);
      const k_seg_in = shearWallInPlaneStiffness(L, pw.thickness, pw.height, pw.elasticModulus, G, 3);
      const k_seg_out = shearWallOutOfPlaneStiffness(L, pw.thickness, pw.height, pw.elasticModulus, 3, nu);
      const { kx, ky, kxy } = rotateWallStiffness(k_seg_in, k_seg_out, alpha);
      const position = { x: (pier.x1 + pier.x2) / 2, y: (pier.y1 + pier.y2) / 2 };
      const weight = pw.concreteDensity * pw.thickness * L * pw.height;
      segs.push({
        id: `${pw.id}_pier_${p}`,
        position,
        kx,
        ky,
        kxy,
        weight
      });
    }
    return segs;
  });
  let allStiff = [...colStiff, ...wallStiff, ...pwallStiff];
  let W_total = slabGravity;
  for (const s of allStiff) {
    W_total += s.weight;
  }
  if (beams) {
    for (const b of beams) {
      const len = Math.sqrt((b.endPoint.x - b.startPoint.x) ** 2 + (b.endPoint.y - b.startPoint.y) ** 2);
      W_total += b.concreteDensity * b.width * b.depth * len;
    }
  }
  if (dropPanels) {
    for (const dp of dropPanels) {
      if (dp.vertices.length >= 3) {
        const area = Math.abs(polygonSignedArea(dp.vertices));
        const parentSlab = slabs.find(s => pointInPolygon(dp.center, s.vertices)) ?? slabs[0];
        const slabThickness = parentSlab ? parentSlab.thickness : 0;
        const netThickness = Math.max(0, dp.drop - slabThickness);
        W_total += dp.concreteDensity * netThickness * area;
      }
    }
  }
  if (nonStructuralWalls) {
    for (const w of nonStructuralWalls) {
      const dx = w.endPoint.x - w.startPoint.x;
      const dy = w.endPoint.y - w.startPoint.y;
      const L = Math.sqrt(dx * dx + dy * dy);
      W_total += (w.partitionUnitWeight ?? 25) * w.thickness * L * w.height;
    }
  }
  if (polylineNonStructuralWalls) {
    for (const pw of polylineNonStructuralWalls) {
      const totalLen = pw.vertices.reduce((s, _, i, arr) => {
        if (i === 0) return 0;
        const a = arr[i - 1], b = arr[i];
        return s + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      }, 0);
      W_total += (pw.partitionUnitWeight ?? 25) * pw.thickness * totalLen * pw.height;
    }
  }
  const cm: Point2D = cmDen > 1e-10
    ? { x: cmNumX / cmDen, y: cmNumY / cmDen }
    : { x: 0, y: 0 };

  // ─── CR by stiffness-weighted centroid (no kθ coupling) ───
  //   Xcr = Σ(x·ky) / Σ(ky)
  //   Ycr = Σ(y·kx) / Σ(kx)
  let sumKx = 0, sumKy = 0, sumKxY = 0, sumKyX = 0;
  for (const s of allStiff) {
    sumKx += s.kx;
    sumKy += s.ky;
    sumKxY += s.kx * s.position.y;
    sumKyX += s.ky * s.position.x;
  }
  let cr: Point2D;
  if (sumKy > 1e-10 && sumKx > 1e-10) {
    cr = { x: sumKyX / sumKy, y: sumKxY / sumKx };
  } else {
    cr = { ...cm };
  }

  const staticCr = { ...cr };
  const usingBackend = !!backendCR;
  if (backendCR) {
    cr = backendCR;
  }

  const ex = Math.abs(cm.x - cr.x);
  const ey = Math.abs(cm.y - cr.y);

  if (typeof console !== 'undefined') {
    const detailRows = allStiff.map(s =>
      `  ${s.id.padEnd(12)} pos=(${s.position.x.toFixed(3)},${s.position.y.toFixed(3)})  kx=${s.kx.toExponential(3)}  ky=${s.ky.toExponential(3)}  kxy=${s.kxy.toExponential(3)}`
    ).join('\n');
    const label = usingBackend ? '3D Finite Element (Kratos Multiphysics)' : 'Weighted-Centroid (no kθ)';
    console.log(
      `%c[CR Debug]%c Center-of-Rigidity calculation\n` +
      `─ Method ─────────────────────────────────────\n` +
      `  Using ${label}\n` +
      `  Xcr = Σ(x·ky) / Σ(ky)\n` +
      `  Ycr = Σ(y·kx) / Σ(kx)\n` +
      `─ Elements ───────────────────────────────────\n${detailRows}\n` +
      `─ Weighted Sums ────────────────────────────\n` +
      `  Σkx = ${sumKx.toExponential(4)}   Σky = ${sumKy.toExponential(4)}\n` +
      `─ CR Result ───────────────────────────────\n` +
      `  CR  = (${staticCr.x.toFixed(4)}, ${staticCr.y.toFixed(4)})\n` +
      `─ Final Results ─────────────────────────────\n` +
      `  CR  = (${cr.x.toFixed(4)}, ${cr.y.toFixed(4)})\n` +
      `  CM  = (${cm.x.toFixed(4)}, ${cm.y.toFixed(4)})\n` +
      `  ex  = ${ex.toFixed(4)}   ey   = ${ey.toFixed(4)}`,
      'color:#6366f1;font-weight:700', 'color:inherit;font-weight:400'
    );
  }

  const slabBbox = allSlabVerts.length >= 3 ? computeBoundingBox(allSlabVerts) : null;
  const planDimX = slabBbox ? slabBbox.width : 1;
  const planDimY = slabBbox ? slabBbox.height : 1;
  // Per IS 1893 (Part 1): 2016 §7.9.2 design eccentricity = (eccentricity ± 0.05 · L_d)
  // We report both the pure and the amplified torsional ratios for the user to evaluate.
  const accidentalX = 0.05 * planDimY;
  const accidentalY = 0.05 * planDimX;
  const torsionalRatioX = slabBbox ? ex / planDimY : 0;
  const torsionalRatioY = slabBbox ? ey / planDimX : 0;
  const torsionalRatioWithAccidentalX = slabBbox ? (ex + accidentalX) / planDimY : 0;
  const torsionalRatioWithAccidentalY = slabBbox ? (ey + accidentalY) / planDimX : 0;
  return {
    cm, cr, ex, ey, totalWeight: W_total,
    torsionalRatioX, torsionalRatioY,
    torsionalRatioWithAccidentalX, torsionalRatioWithAccidentalY,
    // IS 1893 / common engineering practice: plan eccentricity > 0.10b (irregular), > 0.30b (severe)
    hasTorsionalIrregularity: torsionalRatioX > 0.10 || torsionalRatioY > 0.10,
    hasExtremeTorsionalIrregularity: torsionalRatioX > 0.30 || torsionalRatioY > 0.30,
    liveLoadMassFactor,
  };
}

export function computeBoundingBox(verts: Point2D[]): BoundingBox {
  if (verts.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = verts[0].x, maxX = verts[0].x;
  let minY = verts[0].y, maxY = verts[0].y;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function distance(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pointOnEdge(p: Point2D, verts: Point2D[]): boolean {
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) continue;
    const t = ((p.x - xi) * dx + (p.y - yi) * dy) / len2;
    if (t >= 0 && t <= 1) {
      const dist = Math.abs(dy * p.x - dx * p.y - xi * yj + yi * xj) / Math.sqrt(len2);
      if (dist < 1e-9) return true;
    }
  }
  return false;
}

export function pointInPolygon(point: Point2D, vertices: Point2D[]): boolean {
  if (pointOnEdge(point, vertices)) return true;
  let inside = false;
  const n = vertices.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    if ((yi > point.y) !== (yj > point.y) &&
        point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointToSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function extractSharedNodes(
  columns: ColumnElement[],
  walls: ShearWallElement[],
  polylineWalls: PolylineWallElement[],
  beams: BeamElement[],
  tolerance = 0.05
): SharedNode[] {
  const nodeMap = new Map<string, SharedNode>();
  let nextId = 1;

  function addPoint(p: Point2D, elemId: string) {
    const rx = Math.round(p.x / tolerance) * tolerance;
    const ry = Math.round(p.y / tolerance) * tolerance;
    const key = `${rx},${ry}`;
    const existing = nodeMap.get(key);
    if (existing) {
      if (!existing.connectedElements.includes(elemId)) {
        existing.connectedElements.push(elemId);
      }
    } else {
      nodeMap.set(key, {
        id: `N${nextId++}`,
        point: { x: rx, y: ry },
        connectedElements: [elemId],
      });
    }
  }

  for (const col of columns) addPoint(col.position, col.id);
  for (const w of walls) {
    addPoint(w.startPoint, w.id);
    addPoint(w.endPoint, w.id);
  }
  for (const pw of polylineWalls) {
    for (const v of pw.vertices) addPoint(v, pw.id);
  }
  for (const b of beams) {
    addPoint(b.startPoint, b.id);
    addPoint(b.endPoint, b.id);
  }

  return Array.from(nodeMap.values());
}
