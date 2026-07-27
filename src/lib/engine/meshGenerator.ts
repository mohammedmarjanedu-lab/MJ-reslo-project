import type { Point2D, SlabPolygon, FEMNode, FEMElement, FEMMesh } from './types';

const EPS = 1e-9;

function pointOnEdge(p: Point2D, polygon: Point2D[]): boolean {
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) continue;
    const t = ((p.x - xi) * dx + (p.y - yi) * dy) / len2;
    if (t >= 0 && t <= 1) {
      const dist = Math.abs(dy * p.x - dx * p.y - xi * yj + yi * xj) / Math.sqrt(len2);
      if (dist < EPS) return true;
    }
  }
  return false;
}

function pointInPolygon(p: Point2D, polygon: Point2D[]): boolean {
  if (pointOnEdge(p, polygon)) return true;
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInAnyHole(p: Point2D, holes: Point2D[][]): boolean {
  for (const hole of holes) {
    if (hole.length >= 3 && pointInPolygon(p, hole)) return true;
  }
  return false;
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

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(pts: Point2D[]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return area / 2;
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function dedupPoints(pts: Point2D[]): Point2D[] {
  const result: Point2D[] = [];
  for (const p of pts) {
    if (!result.some(r => dist(r, p) < EPS)) result.push(p);
  }
  return result;
}

function cellSlabIntersection(
  x0: number, y0: number, x1: number, y1: number,
  slabVerts: Point2D[]
): Point2D[] {
  const cellCorners: Point2D[] = [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  const pts: Point2D[] = [];

  for (const c of cellCorners) {
    if (pointInPolygon(c, slabVerts)) pts.push(c);
  }

  for (let ci = 0; ci < 4; ci++) {
    const cj = (ci + 1) % 4;
    for (let si = 0; si < slabVerts.length; si++) {
      const sj = (si + 1) % slabVerts.length;
      const inter = lineSegmentIntersection(cellCorners[ci], cellCorners[cj], slabVerts[si], slabVerts[sj]);
      if (inter) pts.push(inter);
    }
  }

  for (const v of slabVerts) {
    if (v.x >= x0 - EPS && v.x <= x1 + EPS && v.y >= y0 - EPS && v.y <= y1 + EPS) {
      pts.push(v);
    }
  }

  const unique = dedupPoints(pts);
  if (unique.length < 3) return [];

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  unique.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  if (polygonArea(unique) < 0) unique.reverse();
  return unique;
}

function triangulatePolygon(pts: Point2D[]): number[][] {
  const n = pts.length;
  if (n === 3) return [[0, 1, 2]];

  let idx = pts.map((_, i) => i);
  const tris: number[][] = [];

  while (idx.length > 3) {
    let found = false;
    for (let i = 0; i < idx.length && !found; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      const cross = (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
      if (cross <= 0) continue;
      let isEar = true;
      for (let j = 0; j < idx.length; j++) {
        if (idx[j] === a || idx[j] === b || idx[j] === c) continue;
        if (pointInTriangle(pts[idx[j]], pts[a], pts[b], pts[c])) { isEar = false; break; }
      }
      if (isEar) { tris.push([a, b, c]); idx.splice(i, 1); found = true; }
    }
    if (!found) { tris.push([idx[0], idx[1], idx[2]]); break; }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function elementCenterInHole(
  elemPts: Point2D[],
  holes: Point2D[][]
): boolean {
  const cx = elemPts.reduce((s, p) => s + p.x, 0) / elemPts.length;
  const cy = elemPts.reduce((s, p) => s + p.y, 0) / elemPts.length;
  return pointInAnyHole({ x: cx, y: cy }, holes);
}

export function generateSlabMesh(slab: SlabPolygon, meshSize: number, useQ8 = false): FEMMesh {
  const verts = slab.vertices;
  const holes = slab.holes;
  if (verts.length < 3) return { nodes: [], elements: [], meshSize };

  let minX = verts[0].x, maxX = verts[0].x;
  let minY = verts[0].y, maxY = verts[0].y;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  const nx = Math.ceil((maxX - minX) / meshSize) + 1;
  const ny = Math.ceil((maxY - minY) / meshSize) + 1;
  const dx = (maxX - minX) / (nx - 1);
  const dy = (maxY - minY) / (ny - 1);

  const nodeGrid: (number | null)[][] = Array.from({ length: ny }, () => new Array(nx).fill(null));
  const nodeRefs: FEMNode[] = [];
  const nodes: FEMNode[] = [];
  let nodeId = 0;

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = minX + ix * dx;
      const y = minY + iy * dy;
      nodeGrid[iy][ix] = nodeId;
      const nd: FEMNode = { id: nodeId, x, y };
      nodes.push(nd);
      nodeRefs.push(nd);
      nodeId++;
    }
  }

  const elements: FEMElement[] = [];
  let elemId = 0;
  const midNodeMap = new Map<string, number>();

  function edgeKey(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  function getOrCreateMidNode(ni: number, nj: number): number {
    const key = edgeKey(ni, nj);
    const existing = midNodeMap.get(key);
    if (existing !== undefined) return existing;
    const ax = nodeRefs[ni].x, ay = nodeRefs[ni].y;
    const bx = nodeRefs[nj].x, by = nodeRefs[nj].y;
    const nd: FEMNode = { id: nodeId++, x: (ax + bx) / 2, y: (ay + by) / 2 };
    nodes.push(nd);
    midNodeMap.set(key, nd.id);
    return nd.id;
  }

  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const n0 = nodeGrid[iy][ix]!;
      const n1 = nodeGrid[iy][ix + 1]!;
      const n2 = nodeGrid[iy + 1][ix + 1]!;
      const n3 = nodeGrid[iy + 1][ix]!;

      const x0 = nodeRefs[n0].x, y0 = nodeRefs[n0].y;
      const x1 = nodeRefs[n1].x, y1 = nodeRefs[n1].y;

      // Check which corners are inside the slab
      const c0 = pointInPolygon({ x: x0, y: y0 }, verts);
      const c1 = pointInPolygon({ x: x1, y: y0 }, verts);
      const c2 = pointInPolygon({ x: x1, y: y1 }, verts);
      const c3 = pointInPolygon({ x: x0, y: y1 }, verts);

      const insideCount = (c0 ? 1 : 0) + (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0);

      if (insideCount === 4) {
        // Fully inside — create Q4 (or Q8 if useQ8)
        if (!elementCenterInHole(
          [nodeRefs[n0], nodeRefs[n1], nodeRefs[n2], nodeRefs[n3]], holes
        )) {
          if (useQ8) {
            const m0 = getOrCreateMidNode(n0, n1);
            const m1 = getOrCreateMidNode(n1, n2);
            const m2 = getOrCreateMidNode(n2, n3);
            const m3 = getOrCreateMidNode(n3, n0);
            elements.push({
              id: elemId++, nodeIds: [n0, n1, n2, n3, m0, m1, m2, m3], area: dx * dy,
            });
          } else {
            elements.push({ id: elemId++, nodeIds: [n0, n1, n2, n3], area: dx * dy });
          }
        }
      } else if (insideCount > 0) {
        // Partial cell — clip to slab polygon and triangulate
        const inter = cellSlabIntersection(x0, y0, x1, y1, verts);
        if (inter.length >= 3) {
          // Create new nodes for intersection polygon vertices
          const localNodes: FEMNode[] = [];
          const localIndices: number[] = [];
          for (const p of inter) {
            // Check if this point matches an existing grid node
            const matched = nodeRefs.find(n => dist({ x: n.x, y: n.y }, p) < EPS);
            if (matched) {
              localIndices.push(matched.id);
              localNodes.push(matched);
            } else {
              const nd: FEMNode = { id: nodeId++, x: p.x, y: p.y };
              nodes.push(nd);
              nodeRefs.push(nd);
              localIndices.push(nd.id);
              localNodes.push(nd);
            }
          }

          // Check against holes
          if (!elementCenterInHole(localNodes, holes)) {
            const tris = triangulatePolygon(localNodes);
            for (const tri of tris) {
              const triNodes = [localNodes[tri[0]], localNodes[tri[1]], localNodes[tri[2]]];
              if (!elementCenterInHole(triNodes, holes)) {
                const triArea = Math.abs(polygonArea(triNodes));
                elements.push({
                  id: elemId++, nodeIds: [localIndices[tri[0]], localIndices[tri[1]], localIndices[tri[2]]],
                  area: triArea,
                });
              }
            }
          }
        }
      }
    }
  }

  // Filter out unused nodes (nodes not connected to any 2D element)
  const usedNodeIds = new Set<number>();
  for (const elem of elements) {
    for (const nid of elem.nodeIds) usedNodeIds.add(nid);
  }

  const finalNodes: FEMNode[] = [];
  const oldToNewMap = new Map<number, number>();
  for (const n of nodes) {
    if (usedNodeIds.has(n.id)) {
      const newId = finalNodes.length;
      oldToNewMap.set(n.id, newId);
      finalNodes.push({ id: newId, x: n.x, y: n.y });
    }
  }

  for (const elem of elements) {
    elem.nodeIds = elem.nodeIds.map(id => oldToNewMap.get(id)!);
  }

  return { nodes: finalNodes, elements, meshSize };
}
