import type { SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, BeamElement, DropPanelElement } from './types';
import { pointInPolygon } from './mathEngine';

export interface GeometryCheckResult {
  hasDisconnectedElements: boolean;
  warnings: string[];
  disconnectedIds: string[];
}

/**
 * Pre-Analysis Geometry Connection Check.
 * Runs in < 2ms to audit structural element connectivity before FEM meshing & solving.
 * Returns non-blocking warnings and disconnected element IDs for visual canvas highlight.
 */
export function checkGeometryConnections(
  slabs: SlabPolygon[],
  columns: ColumnElement[],
  walls: ShearWallElement[],
  polylineWalls: PolylineWallElement[] = [],
  beams: BeamElement[] = [],
  dropPanels: DropPanelElement[] = []
): GeometryCheckResult {
  const warnings: string[] = [];
  const disconnectedIds: string[] = [];

  if (!slabs || slabs.length === 0) {
    return { hasDisconnectedElements: false, warnings: ['No slabs found in workspace.'], disconnectedIds: [] };
  }

  // 1. Column Connection Check
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const cx = col.position?.x ?? 0;
    const cy = col.position?.y ?? 0;
    const colId = col.id || `C${i + 1}`;
    const colLabel = col.label || `Column C${i + 1}`;

    let isConnected = false;
    for (const slab of slabs) {
      if (!slab.vertices || slab.vertices.length < 3) continue;
      // Point-in-polygon or proximity check (within 1.5m of slab boundary/interior)
      if (pointInPolygon({ x: cx, y: cy }, slab.vertices)) {
        isConnected = true;
        break;
      }
      // Check distance to slab edges
      for (let v = 0; v < slab.vertices.length; v++) {
        const v1 = slab.vertices[v];
        const v2 = slab.vertices[(v + 1) % slab.vertices.length];
        const dx = v2.x - v1.x, dy = v2.y - v1.y;
        const L2 = dx * dx + dy * dy;
        if (L2 < 1e-10) continue;
        const t = Math.max(0, Math.min(1, ((cx - v1.x) * dx + (cy - v1.y) * dy) / L2));
        const px = v1.x + t * dx, py = v1.y + t * dy;
        if (Math.hypot(cx - px, cy - py) <= 1.5) {
          isConnected = true;
          break;
        }
      }
      if (isConnected) break;
    }

    if (!isConnected) {
      disconnectedIds.push(colId);
      warnings.push(`Warning: ${colLabel} at (${cx.toFixed(1)}m, ${cy.toFixed(1)}m) is not connected to any slab.`);
    }
  }

  // 2. Straight Wall Connection Check
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const wId = w.id || `W${i + 1}`;
    const wLabel = w.label || `Wall W${i + 1}`;
    const p1 = w.startPoint, p2 = w.endPoint;

    if (!p1 || !p2) continue;

    let isConnected = false;
    for (const slab of slabs) {
      if (!slab.vertices || slab.vertices.length < 3) continue;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      if (
        pointInPolygon(p1, slab.vertices) ||
        pointInPolygon(p2, slab.vertices) ||
        pointInPolygon(mid, slab.vertices)
      ) {
        isConnected = true;
        break;
      }
      // Check edge proximity
      for (let v = 0; v < slab.vertices.length; v++) {
        const v1 = slab.vertices[v];
        const v2 = slab.vertices[(v + 1) % slab.vertices.length];
        const dx = v2.x - v1.x, dy = v2.y - v1.y;
        const L2 = dx * dx + dy * dy;
        if (L2 < 1e-10) continue;
        const t = Math.max(0, Math.min(1, ((mid.x - v1.x) * dx + (mid.y - v1.y) * dy) / L2));
        const px = v1.x + t * dx, py = v1.y + t * dy;
        if (Math.hypot(mid.x - px, mid.y - py) <= 1.5) {
          isConnected = true;
          break;
        }
      }
      if (isConnected) break;
    }

    if (!isConnected) {
      disconnectedIds.push(wId);
      warnings.push(`Warning: ${wLabel} from (${p1.x.toFixed(1)}m, ${p1.y.toFixed(1)}m) is not connected to any slab.`);
    }
  }

  // 3. Polyline Wall Connection Check
  for (let i = 0; i < polylineWalls.length; i++) {
    const pw = polylineWalls[i];
    const pwId = pw.id || `PW${i + 1}`;
    const pwLabel = pw.label || `Polyline Wall PW${i + 1}`;

    if (!pw.vertices || pw.vertices.length < 2) continue;

    let isConnected = false;
    for (const slab of slabs) {
      if (!slab.vertices || slab.vertices.length < 3) continue;
      for (const pt of pw.vertices) {
        if (pointInPolygon(pt, slab.vertices)) {
          isConnected = true;
          break;
        }
      }
      if (isConnected) break;
    }

    if (!isConnected) {
      disconnectedIds.push(pwId);
      warnings.push(`Warning: ${pwLabel} is not connected to any slab geometry.`);
    }
  }

  // 4. Beam Connection Check
  for (let i = 0; i < beams.length; i++) {
    const b = beams[i];
    const bId = b.id || `B${i + 1}`;
    const bLabel = b.label || `Beam B${i + 1}`;
    const p1 = b.startPoint, p2 = b.endPoint;

    if (!p1 || !p2) continue;

    let isConnected = false;
    for (const slab of slabs) {
      if (!slab.vertices || slab.vertices.length < 3) continue;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      if (
        pointInPolygon(p1, slab.vertices) ||
        pointInPolygon(p2, slab.vertices) ||
        pointInPolygon(mid, slab.vertices)
      ) {
        isConnected = true;
        break;
      }
    }

    if (!isConnected) {
      disconnectedIds.push(bId);
      warnings.push(`Warning: ${bLabel} is not spanning across any slab.`);
    }
  }

  // 5. Slab Support Check (Check if any slab group is completely unsupported)
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    const sId = s.id || `slab_${i}`;
    const sLabel = s.label || `Slab S-${String(i + 1).padStart(2, '0')}`;

    let hasSupports = false;
    // Check columns inside slab
    for (const c of columns) {
      if (pointInPolygon(c.position, s.vertices)) {
        hasSupports = true;
        break;
      }
    }
    // Check walls inside or near slab
    if (!hasSupports) {
      for (const w of walls) {
        if (pointInPolygon(w.startPoint, s.vertices) || pointInPolygon(w.endPoint, s.vertices)) {
          hasSupports = true;
          break;
        }
      }
    }

    if (!hasSupports) {
      warnings.push(`Warning: ${sLabel} has no direct column or wall supports — soft ground spring stabilization will be applied.`);
    }
  }

  return {
    hasDisconnectedElements: disconnectedIds.length > 0,
    warnings,
    disconnectedIds
  };
}
