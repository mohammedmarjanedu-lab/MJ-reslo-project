import { generateSlabMesh } from './meshGenerator';
import { pointInPolygon } from './mathEngine';
import { findCollinearSlabEdge, slabsTouch, computeHingedNodeIds } from './femSolver';

function getInitialApiBase(): string {
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      const apiParam = params.get('api');
      if (apiParam) return apiParam.replace(/\/$/, '');
      if ((window as any).__RESLO_API__) return (window as any).__RESLO_API__;
    } catch (_) {}
  }
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:8000';
}

let API_BASE = getInitialApiBase();

function tsMeshToPyMesh(tsMesh: import('./types').FEMMesh): PyMesh {
  return {
    nodeCount: tsMesh.nodes.length,
    elementCount: tsMesh.elements.length,
    nodes: tsMesh.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })),
    elements: tsMesh.elements.map(e => ({ id: e.id, nodeIds: e.nodeIds, area: e.area })),
    minAngle: 30,
    maxAspectRatio: 1.5,
    meshQuality: 'good',
    unconnectedNodeIds: tsMesh.unconnectedNodeIds
  };
}

export function setApiBase(url: string) { API_BASE = url; }
export function getApiBase() { return API_BASE; }

function isNgrokUrl(url: string) { return url.includes('ngrok'); }

async function fetchApi(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (isNgrokUrl(API_BASE)) headers.set('ngrok-skip-browser-warning', 'true');

  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 25000);
      const res = await fetch(url, { ...init, headers, signal: controller.signal });
      clearTimeout(id);
      if (res.ok) return res;
      if (res.status >= 500 && attempt < 2) {
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err: any) {
      lastErr = err;
      if (typeof window !== 'undefined' && (url.includes('.trycloudflare.com') || url.includes('.ngrok')) && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        const localUrl = url.replace(/https:\/\/[^/]+/, 'http://localhost:8000');
        try {
          const resLocal = await fetch(localUrl, { ...init, headers });
          if (resLocal.ok) return resLocal;
        } catch { /* ignore fallback error */ }
      }
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  if (lastErr?.name === 'TypeError' || lastErr?.message?.includes('fetch') || lastErr?.name === 'AbortError') {
    throw new PyApiError(
      `Unable to reach FEA Backend API at ${API_BASE}. ` +
      `Please ensure the backend server is running and accessible.`
    );
  }
  throw lastErr;
}

interface PyNode { id: number; x: number; y: number }
interface PyElement { id: number; nodeIds: number[]; area: number }
interface PyMesh { nodeCount: number; elementCount: number; nodes: PyNode[]; elements: PyElement[]; minAngle: number; maxAspectRatio: number; meshQuality: string; unconnectedNodeIds?: number[] }

interface PyNodeDeflection { nodeId: number; wz: number; rx: number; ry: number }
interface PyElementMoment {
  elementId: number; mx: number; my: number; mxy: number; m1: number; m2: number; angle: number;
  mxd_pos?: number; myd_pos?: number; mxd_neg?: number; myd_neg?: number;
  spr_mx?: number; spr_my?: number; spr_mxy?: number;
  ast_x_bot?: number; ast_y_bot?: number; ast_x_top?: number; ast_y_top?: number;
}
interface PyElementStress { elementId: number; s1: number; s2: number; vm: number; mx: number; my: number; mxy: number }

interface PyPunchingStress {
  nodeId: number; force_kN: number; stress_MPa: number;
  capacity_MPa: number; ratio: number; status: string;
  gamma_v?: number; Jc?: number; M_unbalanced?: number;
  v_u_direct?: number; v_u_eccentric?: number;
}

interface PyElementShear {
  elementId: number; vx: number; vy: number; v1: number; angle: number;
}

interface PyElementMembraneForce {
  elementId: number; nx: number; ny: number; nxy: number; n1: number; n2: number; angle: number;
}

interface PyAnalysisResult {
  success: boolean; nodeDeflections: PyNodeDeflection[]; elementMoments: PyElementMoment[];
  elementStresses: PyElementStress[]; elementShears?: PyElementShear[];
  elementMembraneForces?: PyElementMembraneForce[]; columnPunching?: PyPunchingStress[];
  minWz: number; maxWz: number;
  minMx: number; maxMx: number; minMy: number; maxMy: number;
  minVx?: number; maxVx?: number; minVy?: number; maxVy?: number;
  minNx?: number; maxNx?: number; minNy?: number; maxNy?: number; minNxy?: number; maxNxy?: number;
  crX?: number; crY?: number;
  zz_error_eta?: number; adaptive_iterations?: number; cracked_deflection_max?: number;
  error?: string;
}

export async function healthCheck(): Promise<boolean> {
  try {
    const r = await fetchApi(`${API_BASE}/api/health`);
    if (r.ok) return true;
  } catch (_) {}

  if (typeof window !== 'undefined' && API_BASE !== 'http://127.0.0.1:8000' && API_BASE !== 'http://localhost:8000') {
    try {
      const rLocal = await fetch('http://127.0.0.1:8000/api/health');
      if (rLocal.ok) {
        API_BASE = 'http://127.0.0.1:8000';
        return true;
      }
    } catch (_) {}
  }
  return false;
}

export class PyApiError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PyApiError'; }
}

function computePartitionWallSegments(
  nonStructuralWalls?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; thickness?: number; height?: number; partitionUnitWeight?: number }[],
  polylineNonStructuralWalls?: { vertices: { x: number; y: number }[]; thickness?: number; height?: number; partitionUnitWeight?: number }[]
): { startX: number; startY: number; endX: number; endY: number; lineLoad: number }[] {
  const segments: { startX: number; startY: number; endX: number; endY: number; lineLoad: number }[] = [];
  if (nonStructuralWalls) {
    for (const w of nonStructuralWalls) {
      const ll = (w.partitionUnitWeight ?? 25) * (w.thickness ?? 0.15) * (w.height ?? 3.0);
      segments.push({ startX: w.startPoint.x, startY: w.startPoint.y, endX: w.endPoint.x, endY: w.endPoint.y, lineLoad: ll });
    }
  }
  if (polylineNonStructuralWalls) {
    for (const pw of polylineNonStructuralWalls) {
      const ll = (pw.partitionUnitWeight ?? 25) * (pw.thickness ?? 0.15) * (pw.height ?? 3.0);
      for (let i = 0; i < pw.vertices.length - 1; i++) {
        segments.push({ startX: pw.vertices[i].x, startY: pw.vertices[i].y, endX: pw.vertices[i + 1].x, endY: pw.vertices[i + 1].y, lineLoad: ll });
      }
    }
  }
  return segments;
}

export async function meshAndAnalyze(
  slabPolygon: { vertices: { x: number; y: number }[]; thickness: number; uniformLoad: number; partitionLoad: number; elasticModulus: number; crackingModifier?: number },
  walls: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; elasticModulus?: number; thickness?: number; height?: number; boundaryCondition?: string }[],
  columns: { position: { x: number; y: number }; width: number; depth: number; height: number; elasticModulus: number; shape?: 'rectangular' | 'circular'; diameter?: number; boundaryCondition?: string }[],
  meshSize: number, poissonRatio: number,
  beams?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; width: number; depth: number; elasticModulus: number }[],
  dropPanels: { vertices: { x: number; y: number }[]; drop: number }[] = [],
  nonStructuralWalls?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; thickness?: number; height?: number; partitionUnitWeight?: number }[],
  polylineNonStructuralWalls?: { vertices: { x: number; y: number }[]; thickness?: number; height?: number; partitionUnitWeight?: number }[]
): Promise<{ mesh: { nodes: PyNode[]; elements: PyElement[] }; result: PyAnalysisResult; slabId: string; warnings: string[]; disconnectedIds: string[] }> {
  const geometry: any = {
    vertices: slabPolygon.vertices,
    walls: walls.map(w => ({ startPoint: w.startPoint, endPoint: w.endPoint })),
    beams: (beams || []).map(b => ({ startPoint: b.startPoint, endPoint: b.endPoint })),
    columns: columns.map(c => ({ position: c.position, width: c.width || 0.3, depth: c.depth || 0.3, height: c.height || 3.0 }))
  };

  let mesh: PyMesh | null = null;
  try {
    const meshReq = { geometry, meshSize };
    const mr = await fetchApi(`${API_BASE}/api/mesh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meshReq)
    });
    if (mr.ok) {
      const meshData = await mr.json();
      if (meshData.success && meshData.mesh && meshData.mesh.elementCount > 0) {
        mesh = meshData.mesh;
      }
    }
  } catch (err) {
    console.warn(`[PyAPI] Backend mesh request failed, using TS mesher fallback:`, err);
  }

  if (!mesh) {
    const tsMesh = generateSlabMesh(slabPolygon as any, meshSize, false);
    mesh = tsMeshToPyMesh(tsMesh);
  }
  const wallNodeIds: number[] = [];
  const wallNodesCount = new Array(walls.length).fill(0);
  
  // Pre-calculate wall segment vectors to avoid redundant math in inner loops
  const wallPrecalc = walls.map(w => {
    const dx = w.endPoint.x - w.startPoint.x;
    const dy = w.endPoint.y - w.startPoint.y;
    const len2 = dx * dx + dy * dy;
    return { w, dx, dy, len2 };
  });

  for (const n of mesh.nodes) {
    for (let wi = 0; wi < wallPrecalc.length; wi++) {
      const { w, dx, dy, len2 } = wallPrecalc[wi];
      if (len2 < 1e-12) continue;
      const t = ((n.x - w.startPoint.x) * dx + (n.y - w.startPoint.y) * dy) / len2;
      if (t >= -0.01 && t <= 1.01) {
        const clampT = t < 0 ? 0 : (t > 1 ? 1 : t);
        const px = w.startPoint.x + clampT * dx;
        const py = w.startPoint.y + clampT * dy;
        const dist2 = (n.x - px) * (n.x - px) + (n.y - py) * (n.y - py);
        const wallTolSq = Math.max(0.0625, (meshSize * 0.5) * (meshSize * 0.5)); // 0.25m tolerance squared for robust boundary capture
        if (dist2 <= wallTolSq) {
          wallNodeIds.push(n.id);
          wallNodesCount[wi]++;
        }
      }
    }
  }

  const colNodeIds: number[] = [];
  const colHeights: number[] = [];
  const colStiffnesses: number[] = [];
  const colWidths: number[] = [];
  const colDepths: number[] = [];
  const colShapes: string[] = [];
  const colDiameters: number[] = [];
  const colGrades: string[] = [];
  const COL_SNAP_TOL = Math.max(0.85, meshSize * 1.25);
  const COL_SNAP_TOL_SQ = COL_SNAP_TOL * COL_SNAP_TOL;
  const skippedColumns: number[] = [];
  const skippedColumnIds: string[] = [];

  for (let ci = 0; ci < columns.length; ci++) {
    const c = columns[ci] as any;
    const isInside = pointInPolygon(c.position, slabPolygon.vertices);
    let best = mesh.nodes[0], bestD2 = Infinity;
    for (const n of mesh.nodes) {
      const d2 = (n.x - c.position.x) * (n.x - c.position.x) + (n.y - c.position.y) * (n.y - c.position.y);
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    // Allow snapping if node is within snap tolerance even if pointInPolygon boundary check returns false
    if (!isInside && bestD2 > COL_SNAP_TOL_SQ) {
      skippedColumns.push(ci + 1);
      skippedColumnIds.push(c.id || `Column ${ci + 1}`);
      continue;
    }

    if (best) {
      colNodeIds.push(best.id);
      colHeights.push(c.height || 3);
      const w = c.width || 0.3;
      const dp = c.depth || 0.3;
      colWidths.push(w);
      colDepths.push(dp);
      const Ix = dp * w**3 / 12;
      const Iy = w * dp**3 / 12;
      const I = (Ix + Iy) / 2;
      const E_col = (c.elasticModulus || 25e6) * 1000; // kPa → Pa
      const H = c.height || 3.0;
      colStiffnesses.push(4 * E_col * I / H);
      colShapes.push(c.shape || 'rectangular');
      colDiameters.push((c.diameter || 500) / 1000);
      colGrades.push(c.concreteGrade || 'M25');
    }
  }

  const concreteDensity = 25; // kN/m³
  const slabThickness = slabPolygon.thickness || 0.2;
  const selfWeight = concreteDensity * slabThickness;

  // Beam data: snap all intermediate mesh nodes along beam line segment
  const beamNodeIdA: number[] = [];
  const beamNodeIdB: number[] = [];
  const beamWidths: number[] = [];
  const beamDepths: number[] = [];
  const beamElasticModuli: number[] = [];
  if (beams) {
    for (const b of beams) {
      const sx = b.startPoint.x, sy = b.startPoint.y;
      const ex = b.endPoint.x, ey = b.endPoint.y;
      const dx = ex - sx, dy = ey - sy;
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-12) continue;

      const beamTol = Math.max(0.15, meshSize * 0.5);
      const nearNodes: { id: number; t: number }[] = [];

      for (const n of mesh.nodes) {
        const t = ((n.x - sx) * dx + (n.y - sy) * dy) / L2;
        if (t >= -0.01 && t <= 1.01) {
          const clampT = Math.max(0, Math.min(1, t));
          const px = sx + clampT * dx;
          const py = sy + clampT * dy;
          if (Math.hypot(n.x - px, n.y - py) <= beamTol) {
            nearNodes.push({ id: n.id, t: clampT });
          }
        }
      }

      nearNodes.sort((a, b) => a.t - b.t);

      // Filter out duplicate or extremely close nodes
      const filtered: typeof nearNodes = [];
      for (const item of nearNodes) {
        if (!filtered.length || Math.abs(item.t - filtered[filtered.length - 1].t) * Math.sqrt(L2) > 0.05) {
          filtered.push(item);
        }
      }

      for (let i = 0; i < filtered.length - 1; i++) {
        beamNodeIdA.push(filtered[i].id);
        beamNodeIdB.push(filtered[i + 1].id);
        beamWidths.push(b.width || 0.3);
        beamDepths.push(b.depth || 0.45);
        beamElasticModuli.push((b.elasticModulus || 25e6) * 1000);
      }
    }
  }

  const slabE = (slabPolygon.elasticModulus ? slabPolygon.elasticModulus * 1000 : 25e9) * (slabPolygon.crackingModifier ?? 1.0);
  const arBody: any = {
    mesh, thickness: slabThickness,
    elasticModulus: slabE, poissonRatio,
    uniformLoad: (slabPolygon.uniformLoad || 5.0) + (slabPolygon.partitionLoad ?? 0), selfWeight,
    wallNodeIds: [...new Set(wallNodeIds)],
    wallStartPoints: walls.map(w => w.startPoint),
    wallEndPoints: walls.map(w => w.endPoint),
    wallThicknesses: walls.map(w => w.thickness ?? 0.25),
    wallHeights: walls.map(w => w.height ?? 3.0),
    wallElasticModuli: walls.map(w => w.elasticModulus ?? slabE),
    columnNodeIds: colNodeIds,
    columnHeights: colHeights, columnStiffnesses: colStiffnesses,
    columnWidths: colWidths, columnDepths: colDepths,
    columnShapes: colShapes, columnDiameters: colDiameters,
    columnGrades: colGrades,
    columnBoundaryConditions: columns.map(c => c.boundaryCondition || 'fixed-fixed'),
    wallBoundaryConditions: walls.map(w => w.boundaryCondition || 'fixed-free'),
    beamNodeIdA, beamNodeIdB, beamWidths, beamDepths, beamElasticModuli,
    dropPanels: dropPanels.map(dp => ({ vertices: dp.vertices, drop: dp.drop })),
    partitionWallSegments: computePartitionWallSegments(nonStructuralWalls, polylineNonStructuralWalls)
  };

  if (colNodeIds.length === 0 && wallNodeIds.length === 0) {
    throw new PyApiError(
      'No column or wall supports found on the slab mesh. ' +
      'Please place at least one column or wall INSIDE the slab polygon, then re-run the analysis.'
    );
  }

  // ── Connectivity validation ──
  const warnings: string[] = [];
  if (skippedColumns.length > 0) {
    warnings.push(`Column${skippedColumns.length > 1 ? 's' : ''} ${skippedColumns.join(', ')} ${skippedColumns.length > 1 ? 'are' : 'is'} outside the slab mesh (>${COL_SNAP_TOL}m away) and ${skippedColumns.length > 1 ? 'were' : 'was'} skipped.`);
  }

  const disconnectedWallIds: string[] = [];
  for (let wi = 0; wi < walls.length; wi++) {
    if (wallNodesCount[wi] === 0) {
      const wall = walls[wi] as any;
      const lbl = wall.label || `Wall ${wi + 1}`;
      disconnectedWallIds.push(wall.id || lbl);
    }
  }
  if (disconnectedWallIds.length > 0) {
    warnings.push(`Wall${disconnectedWallIds.length > 1 ? 's' : ''} ${disconnectedWallIds.join(', ')} ${disconnectedWallIds.length > 1 ? 'have' : 'has'} no mesh nodes along its length — it may be outside the slab.`);
  }

  if (mesh.unconnectedNodeIds && mesh.unconnectedNodeIds.length > 0) {
    warnings.push(`${mesh.unconnectedNodeIds.length} node${mesh.unconnectedNodeIds.length > 1 ? 's' : ''} (ID: ${mesh.unconnectedNodeIds.join(', ')}) in the mesh ${mesh.unconnectedNodeIds.length > 1 ? 'are' : 'is'} not connected to any slab elements. These nodes will be highlighted on the canvas in red and automatically constrained to prevent solver errors.`);
  }

  const disconnectedIds = [...skippedColumnIds, ...disconnectedWallIds];

  if (warnings.length > 0) {
    console.warn('[Reslo FEM] Connectivity warnings:\n' + warnings.join('\n'));
  }

  const ar = await fetchApi(`${API_BASE}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(arBody)
  });
  if (!ar.ok) throw new PyApiError(`Analyze API ${ar.status}`);
  const result: PyAnalysisResult = await ar.json();
  if (!result.success) throw new PyApiError(`Analysis failed: ${result.error}`);

  return { mesh, result, slabId: slabPolygon.vertices.length > 0 ? `slab_${Date.now()}` : 'slab_0', warnings, disconnectedIds };
}

function toFrontendResult(slabId: string, mesh: any, result: any, hingedNodeIds?: number[]): any {
  // Convert deflection wz from meters to millimeters (mm)
  const nodeDeflections = result.nodeDeflections.map((d: any) => ({
    nodeId: d.nodeId, wz: d.wz * 1000,
    rx: d.rx ?? 0, ry: d.ry ?? 0
  }));
  // Moments, stresses, shears, membrane forces, and punching are stripped from solver output.
  // Provide empty arrays so the SlabFEMResult shape is satisfied.
  const momentMx: { elementId: number; value: number }[] = [];
  const momentMy: { elementId: number; value: number }[] = [];
  const momentMxy: { elementId: number; value: number }[] = [];
  const stresses: any[] = [];
  const shears: any[] = [];
  const membraneForces: any[] = [];
  const columnPunching: any[] = [];

  // Prefer server-provided global min/max (correct for unified multi-slab groups).
  // Fall back to local recalculation only when server doesn't supply the value. (all in mm)
  const localMinWz = nodeDeflections.length ? Math.min(...nodeDeflections.map((d: any) => d.wz)) : 0;
  const localMaxWz = nodeDeflections.length ? Math.max(...nodeDeflections.map((d: any) => Math.abs(d.wz))) : 0;

  return {
    slabId,
    mesh: {
      nodes: mesh.nodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y })),
      elements: mesh.elements.map((e: any) => ({ id: e.id, nodeIds: e.nodeIds, area: e.area || 0 })),
      meshSize: 0,
      unconnectedNodeIds: mesh.unconnectedNodeIds || [],
    },
    nodeDeflections, momentMx, momentMy, momentMxy, stresses, shears, membraneForces, columnPunching,
    hingedNodeIds,
    // Use server min/max (global for unified slabs) converted to mm when provided; fall back to local (mm)
    minWz: result.minWz !== undefined ? result.minWz * 1000 : localMinWz,
    maxWz: result.maxWz !== undefined ? result.maxWz * 1000 : localMaxWz,
    minMx: 0,
    maxMx: 0,
    minMy: 0,
    maxMy: 0,
    minVx: 0,
    maxVx: 0,
    minVy: 0,
    maxVy: 0,
    minNx: 0,
    maxNx: 0,
    minNy: 0,
    maxNy: 0,
    minNxy: 0,
    maxNxy: 0,
    crX: result.crX,
    crY: result.crY,
  };
}


export async function analyzeSlabViaApi(
  slab: { id?: string; vertices: { x: number; y: number }[]; thickness: number; uniformLoad: number; partitionLoad: number; elasticModulus: number; crackingModifier?: number },
  columns: { position: { x: number; y: number }; width: number; depth: number; height: number; elasticModulus: number; shape?: 'rectangular' | 'circular'; diameter?: number; boundaryCondition?: string }[],
  walls: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; elasticModulus: number; thickness?: number; height?: number; boundaryCondition?: string }[],
  polylineWalls: { vertices: { x: number; y: number }[]; thickness: number; height: number; elasticModulus: number; shearModulus?: number; concreteDensity?: number; boundaryCondition?: string }[],
  meshSize: number, poissonRatio: number,
  beams: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; width: number; depth: number; elasticModulus: number }[] = [],
  dropPanels: { vertices: { x: number; y: number }[]; drop: number }[] = [],
  nonStructuralWalls: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; thickness?: number; height?: number; partitionUnitWeight?: number }[] = [],
  polylineNonStructuralWalls: { vertices: { x: number; y: number }[]; thickness?: number; height?: number; partitionUnitWeight?: number }[] = []
): Promise<any> {
  const allWalls = [...walls];
  const COLLINEAR_TOL = 0.001745; // 0.1° — same tolerance as mathEngine.ts
  for (const pw of polylineWalls) {
    // Build raw segment list (filter zero-length)
    const rawSegs: { x1: number; y1: number; x2: number; y2: number; alpha: number }[] = [];
    for (let i = 0; i < pw.vertices.length - 1; i++) {
      const a = pw.vertices[i], b = pw.vertices[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-10) continue;
      rawSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, alpha: Math.atan2(dy, dx) });
    }
    // Merge collinear runs into piers (matches mathEngine.ts pier logic)
    let si = 0;
    while (si < rawSegs.length) {
      const alpha0 = rawSegs[si].alpha;
      const pierX1 = rawSegs[si].x1, pierY1 = rawSegs[si].y1;
      let sj = si;
      while (sj + 1 < rawSegs.length) {
        const da = Math.abs(rawSegs[sj + 1].alpha - alpha0);
        if (Math.min(da, Math.PI - da) > COLLINEAR_TOL) break;
        sj++;
      }
      allWalls.push({
        startPoint: { x: pierX1, y: pierY1 },
        endPoint: { x: rawSegs[sj].x2, y: rawSegs[sj].y2 },
        elasticModulus: pw.elasticModulus,
        thickness: pw.thickness, height: pw.height,
        boundaryCondition: pw.boundaryCondition
      } as any);
      si = sj + 1;
    }
  }
  const { mesh, result } = await meshAndAnalyze(slab, allWalls, columns, meshSize, poissonRatio, beams, dropPanels, nonStructuralWalls, polylineNonStructuralWalls);
  return toFrontendResult(slab.id || 'slab_0', mesh, result, computeHingedNodeIds(slab as any, mesh.nodes, meshSize));
}

export async function meshAndAnalyzeAllSlabs(
  slabs: any[],
  walls: any[],
  columns: any[],
  meshSize: number,
  poissonRatio: number,
  beams: any[] = [],
  dropPanels: any[] = [],
  nonStructuralWalls: any[] = [],
  polylineNonStructuralWalls: any[] = []
): Promise<{ results: any[]; warnings: string[]; disconnectedIds: string[] }> {
  if (slabs.length === 0) return { results: [], warnings: [], disconnectedIds: [] };

  // Attempt single-payload batch backend execution first (< 40ms single round-trip)
  try {
    const multiPayload = {
      slabs: slabs.map(slab => ({
        slabId: slab.id || 'slab_0',
        geometry: {
          vertices: slab.vertices,
          openings: (slab.openings || []).map((op: any) => ({ vertices: op.vertices })),
          walls: walls.map(w => ({ startPoint: w.startPoint, endPoint: w.endPoint })),
          beams: (beams || []).map(b => ({ startPoint: b.startPoint, endPoint: b.endPoint })),
          columns: columns.map(c => ({ position: c.position, width: c.width || 0.3, depth: c.depth || 0.3, height: c.height || 3.0 }))
        },
        meshSize,
        thickness: slab.thickness || 0.2,
        elasticModulus: (slab.elasticModulus ? slab.elasticModulus * 1000 : 25e9) * (slab.crackingModifier ?? 1.0),
        poissonRatio,
        uniformLoad: (slab.uniformLoad || 5.0) + (slab.partitionLoad ?? 0),
        selfWeight: 25 * (slab.thickness || 0.2),
        discontinuousEdges: (slab.discontinuousEdges || []).map((e: any) => ({ startPoint: e.startPoint, endPoint: e.endPoint }))
      })),
      walls: walls.map(w => ({ startPoint: w.startPoint, endPoint: w.endPoint, thickness: w.thickness ?? 0.25, height: w.height ?? 3.0, elasticModulus: w.elasticModulus || 25e9 })),
      columns: columns.map(c => ({ position: c.position, width: c.width || 0.3, depth: c.depth || 0.3, height: c.height || 3.0, elasticModulus: (c.elasticModulus || 25e6) * 1000, shape: c.shape || 'rectangular', diameter: (c.diameter || 500) / 1000, concreteGrade: c.concreteGrade || 'M25' })),
      beams: (beams || []).map(b => ({ startPoint: b.startPoint, endPoint: b.endPoint, width: b.width || 0.3, depth: b.depth || 0.45, elasticModulus: (b.elasticModulus || 25e6) * 1000 })),
      dropPanels: dropPanels.map(dp => ({ vertices: dp.vertices, drop: dp.drop })),
      partitionWallSegments: computePartitionWallSegments(nonStructuralWalls, polylineNonStructuralWalls),
      meshSize
    };

    const mr = await fetchApi(`${API_BASE}/api/analyze_multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(multiPayload)
    });

    if (mr.ok) {
      const data = await mr.json();
      if (data.success && data.results && data.results.length > 0) {
        const results = data.results.map((r: any) => {
          const slab = slabs.find(s => (s.id || 'slab_0') === r.slabId);
          const hinged = slab ? computeHingedNodeIds(slab, r.mesh.nodes, meshSize) : [];
          return toFrontendResult(r.slabId, r.mesh, r.result, hinged);
        });
        return { results, warnings: data.warnings || [], disconnectedIds: data.disconnectedIds || [] };
      }
    }
  } catch (err) {
    console.warn('[PyAPI] Single-payload multi-slab API attempt failed, falling back to sequential batching:', err);
  }

  // 1. Mesh all slabs sequentially (Fallback)
  interface SlabMeshData {
    slab: any;
    mesh: PyMesh;
  }
  const slabMeshes: SlabMeshData[] = [];
  for (const slab of slabs) {
    const geometry = {
      vertices: slab.vertices,
      walls: walls.map(w => ({ startPoint: w.startPoint, endPoint: w.endPoint })),
      beams: beams.map(b => ({ startPoint: b.startPoint, endPoint: b.endPoint })),
      columns: columns.map(c => ({ position: c.position, width: c.width || 0.3, depth: c.depth || 0.3, height: c.height || 3.0 }))
    };
    const meshReq = { geometry, meshSize };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // 25s timeout for Gmsh Delaunay triangular meshing
    let meshAcquired = false;
    try {
      const mr = await fetchApi(`${API_BASE}/api/mesh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meshReq),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (mr.ok) {
        const meshData = await mr.json();
        if (meshData.success && meshData.mesh && meshData.mesh.elementCount > 0) {
          slabMeshes.push({ slab, mesh: meshData.mesh });
          meshAcquired = true;
        }
      }
    } catch (e: any) {
      clearTimeout(timeout);
      console.warn(`[PyAPI] Backend meshing timed out/failed for slab ${slab.label || slab.id}, falling back to TS mesher:`, e);
    }

    if (!meshAcquired) {
      // Instant local fallback using TS Delaunay/Ear-Clipping mesher
      try {
        const fallbackMesh = generateSlabMesh(slab, meshSize, false);
        slabMeshes.push({ slab, mesh: tsMeshToPyMesh(fallbackMesh) });
      } catch (fbErr) {
        console.error(`[PyAPI] Local mesh fallback failed for slab ${slab.label || slab.id}:`, fbErr);
      }
    }
  }

  if (slabMeshes.length === 0) {
    return { results: [], warnings: ['No slabs could be meshed.'], disconnectedIds: [] };
  }

  // 2. Merge coincident nodes globally (identical tolerance to TypeScript solver)
  interface NodeRef {
    slabId: string;
    localId: number;
    x: number;
    y: number;
    globalIdx?: number;
  }
  const allNodes: NodeRef[] = [];
  for (const sm of slabMeshes) {
    for (const node of sm.mesh.nodes) {
      allNodes.push({ slabId: sm.slab.id, localId: node.id, x: node.x, y: node.y });
    }
  }

  allNodes.sort((a, b) => a.x - b.x);

  const mergeTol = Math.max(0.12, meshSize * 0.35);
  interface UniquePyNodeRef extends PyNode {
    slabId: string;
    localId: number;
  }
  const uniqueNodes: UniquePyNodeRef[] = [];

  function pointToSegmentDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
  }

  // Identify nodes that fall on a discontinuous edge for each slab
  const discontNodeKeys = new Set<string>();
  const tolDiscont = meshSize * 0.35;
  for (const sm of slabMeshes) {
    if (sm.slab.discontinuousEdges && sm.slab.discontinuousEdges.length > 0) {
      for (const n of sm.mesh.nodes) {
        for (const seg of sm.slab.discontinuousEdges) {
          if (pointToSegmentDist({ x: n.x, y: n.y }, seg.startPoint, seg.endPoint) < tolDiscont) {
            discontNodeKeys.add(sm.slab.id + '_' + n.id);
            break;
          }
        }
      }
    }
  }

  const equalDofConstraints: { nodeIdA: number; nodeIdB: number; dofs: number[] }[] = [];

  for (const node of allNodes) {
    const isNodeDiscont = discontNodeKeys.has(node.slabId + '_' + node.localId);
    let foundIdx = -1;

    if (!isNodeDiscont) {
      for (let u = uniqueNodes.length - 1; u >= 0; u--) {
        const un = uniqueNodes[u];
        const isUnDiscont = discontNodeKeys.has(un.slabId + '_' + un.localId);
        // Merge coincident boundary nodes across adjacent slabs into a single node
        if (!isUnDiscont && Math.hypot(node.x - un.x, node.y - un.y) < mergeTol) {
          foundIdx = u;
          break;
        }
      }
    }

    if (foundIdx >= 0) {
      node.globalIdx = foundIdx;
    } else {
      // Find coincident node to link via equalDOF constraint if one is on a discontinuous edge
      let pairIdx = -1;
      for (let u = uniqueNodes.length - 1; u >= 0; u--) {
        const un = uniqueNodes[u];
        if (Math.hypot(node.x - un.x, node.y - un.y) < mergeTol) {
          pairIdx = u;
          break;
        }
      }

      const newIdx = uniqueNodes.length;
      uniqueNodes.push({ id: newIdx + 1, x: node.x, y: node.y, slabId: node.slabId, localId: node.localId }); // 1-indexed for backend
      node.globalIdx = newIdx;

      if (pairIdx >= 0 && uniqueNodes[pairIdx].id !== newIdx + 1) {
        // Constrain translations (Ux, Uy, Uz) and bending rotations (Rx, Ry, Rz) for continuous multi-slab joint (C0 & C1)
        const dofsToCouple = isNodeDiscont ? [1, 2, 3, 6] : [1, 2, 3, 4, 5, 6];
        equalDofConstraints.push({
          nodeIdA: uniqueNodes[pairIdx].id,
          nodeIdB: newIdx + 1,
          dofs: dofsToCouple
        });
      }


    }
  }


  // Non-conformal multi-slab boundary segment coupling (C0 & C1 continuity for non-coincident boundary nodes)
  for (let i = 0; i < uniqueNodes.length; i++) {
    const nA = uniqueNodes[i];
    for (let j = i + 1; j < uniqueNodes.length; j++) {
      const nB = uniqueNodes[j];
      if (nA.slabId !== nB.slabId) {
        const d = Math.hypot(nA.x - nB.x, nA.y - nB.y);
        if (d <= mergeTol && nA.id !== nB.id) {
          const discontA = discontNodeKeys.has(nA.slabId + '_' + nA.localId);
          const discontB = discontNodeKeys.has(nB.slabId + '_' + nB.localId);
          const isHinge = discontA || discontB;
          const dofsToCouple = isHinge ? [1, 2, 3, 6] : [1, 2, 3, 4, 5, 6];
          equalDofConstraints.push({
            nodeIdA: nA.id,
            nodeIdB: nB.id,
            dofs: dofsToCouple
          });
        }
      }
    }
  }

  // ── ETABS-style edge (line) constraints: T-junction MPC ties across non-conformal joints ──
  // Mirrors femSolver.ts §2b and backend kratos_solver._detect_interface_constraints
  // (identical bipartite rule so all three solver paths converge to the same behavior).
  // Slab meshes are generated independently, so boundary nodes along a shared edge do
  // not always coincide (offset grids, T-junctions). Merging + near-pair equalDOF above
  // would leave those nodes untied, visibly tearing the joint in contours. For every
  // unshared boundary node of the sparser side lying on the denser side's boundary
  // segment, tie it by linear interpolation of the two bracketing master nodes:
  //   u_slave − (1−t)·u_M1 − t·u_M2 = 0   (weighted multi-master MPC, backend 1..6 DOFs)
  // Nodes already coupled by equalDOF (coincident twins) are never made slaves again
  // (a DOF can be a slave only once), and tying is ONE direction per interface pair so
  // no circular slave↔master webs can form. Hinged joints tie translations (W) only.
  interface PyMpcTerm { nodeId: number; weight: number }
  interface PyMpcConstraint { slaveNodeId: number; slaveDof: number; masters: PyMpcTerm[] }
  const mpcConstraints: PyMpcConstraint[] = [];
  {
    // Unique-node ownership: uniqueId (1-indexed) -> original (slabId, localId) exemplars
    const owners = new Map<number, { slabId: string; localId: number }[]>();
    for (const n of allNodes) {
      if (n.globalIdx === undefined) continue;
      const g = n.globalIdx + 1;
      let arr = owners.get(g);
      if (!arr) { arr = []; owners.set(g, arr); }
      arr.push({ slabId: n.slabId, localId: n.localId });
    }
    const ownedBySlab = new Map<string, Set<number>>();
    for (const [g, arr] of owners) {
      for (const o of arr) {
        let s = ownedBySlab.get(o.slabId);
        if (!s) { s = new Set(); ownedBySlab.set(o.slabId, s); }
        s.add(g);
      }
    }
    const nodeById = new Map<number, UniquePyNodeRef>(uniqueNodes.map(n => [n.id, n]));
    const edgeTol = Math.max(mergeTol, meshSize * 0.45);
    const tiedSlaves = new Set<number>();

    // Nodes already translation/rotation-coupled by equalDOF pairs: never MPC slaves
    const eqPaired = new Set<number>();
    for (const c of equalDofConstraints) {
      eqPaired.add(c.nodeIdA);
      eqPaired.add(c.nodeIdB);
    }

    const isPointDiscontinuous = (slabId: string, p: { x: number; y: number }, tol: number): boolean => {
      const s = slabMeshes.find(sm => sm.slab.id === slabId)?.slab;
      if (!s || !s.discontinuousEdges) return false;
      for (const seg of s.discontinuousEdges) {
        if (pointToSegmentDist(p, seg.startPoint, seg.endPoint) < tol) return true;
      }
      return false;
    };

    interface PyInterfaceSeg {
      p: { x: number; y: number }; q: { x: number; y: number };
      param: (n: { x: number; y: number }) => number;
      onSeg: (n: { x: number; y: number }) => boolean;
    }

    for (let ia = 0; ia < slabMeshes.length; ia++) {
      const slabA = slabMeshes[ia].slab;
      for (let ib = ia + 1; ib < slabMeshes.length; ib++) {
        const slabB = slabMeshes[ib].slab;
        if (!slabsTouch(slabA.vertices, slabB.vertices, Math.max(0.75, meshSize * 1.5))) continue;
        const bOwned = ownedBySlab.get(slabB.id) ?? new Set<number>();
        const aOwned = ownedBySlab.get(slabA.id) ?? new Set<number>();

        // 1. Interface overlaps (deduped — shared segment appears as an edge of both polygons)
        const segs: PyInterfaceSeg[] = [];
        const seenSegKeys = new Set<string>();
        for (const [sv, dv] of [[slabA.vertices, slabB.vertices], [slabB.vertices, slabA.vertices]] as const) {
          for (let ei = 0; ei < sv.length; ei++) {
            const a1 = sv[ei], a2 = sv[(ei + 1) % sv.length];
            const col = findCollinearSlabEdge(dv, a1, a2, edgeTol);
            if (!col) continue;
            const p = col.edgeA, q = col.edgeB;
            const sdx = q.x - p.x, sdy = q.y - p.y;
            const slen2 = sdx * sdx + sdy * sdy;
            if (slen2 < 1e-12) continue;
            const k1 = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
            const k2 = `${Math.round(q.x * 1000)},${Math.round(q.y * 1000)}`;
            const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
            if (seenSegKeys.has(key)) continue;
            seenSegKeys.add(key);
            const ws = Math.sqrt(slen2);
            const param = (n: { x: number; y: number }) => ((n.x - p.x) * sdx + (n.y - p.y) * sdy) / slen2;
            const onSeg = (n: { x: number; y: number }) => {
              const s = param(n);
              if (s < -edgeTol * 1.01 / ws - 0.01 || s > 1.01) return false;
              return pointToSegmentDist(n, p, q) < edgeTol;
            };
            segs.push({ p, q, param, onSeg });
          }
        }
        if (segs.length === 0) continue;

        // 2. Per-segment node sets
        interface PySegData {
          seg: PyInterfaceSeg;
          aOn: { g: number; s: number }[];
          bOn: { g: number; s: number }[];
          aFree: { g: number; s: number }[];
          bFree: { g: number; s: number }[];
        }
        const segData: PySegData[] = [];
        let aTotal = 0, bTotal = 0;
        for (const seg of segs) {
          const aOn: { g: number; s: number }[] = [];
          for (const g of aOwned) {
            const n = nodeById.get(g);
            if (n && seg.onSeg(n)) aOn.push({ g, s: seg.param(n) });
          }
          aOn.sort((u, v) => u.s - v.s);
          const bOn: { g: number; s: number }[] = [];
          for (const g of bOwned) {
            const n = nodeById.get(g);
            if (n && seg.onSeg(n)) bOn.push({ g, s: seg.param(n) });
          }
          bOn.sort((u, v) => u.s - v.s);
          const aFree = aOn.filter(e => !bOwned.has(e.g) && !tiedSlaves.has(e.g) && !eqPaired.has(e.g));
          const bFree = bOn.filter(e => !aOwned.has(e.g) && !tiedSlaves.has(e.g) && !eqPaired.has(e.g));
          aTotal += aOn.length;
          bTotal += bOn.length;
          segData.push({ seg, aOn, bOn, aFree, bFree });
        }

        // 3. ONE direction per pair: sparser side slaves to the denser side
        //    (equal counts: lower-index side slaves).
        const aSlavesToB = aTotal <= bTotal;

        for (const { seg, aOn, bOn, aFree, bFree } of segData) {
          const masterCand = aSlavesToB ? bOn : aOn;
          const slavePool = aSlavesToB ? aFree : bFree;
          if (masterCand.length < 2 || slavePool.length === 0) continue;

          for (const { g, s: sA } of slavePool) {
            const n = nodeById.get(g)!;

            // Find bracketing master nodes around sA
            let lo = -1, hi = -1;
            for (let k = 0; k < masterCand.length; k++) {
              if (masterCand[k].s <= sA + 1e-9) lo = k;
              if (hi < 0 && masterCand[k].s >= sA - 1e-9) hi = k;
            }
            if (lo < 0 || hi < 0) {
              lo = sA < masterCand[0].s ? 0 : masterCand.length - 2;
              hi = lo + 1;
            }
            if (lo === hi) { lo = Math.max(0, lo - 1); hi = lo + 1; }
            if (lo < 0 || hi >= masterCand.length || masterCand[lo].g === masterCand[hi].g) continue;
            const s1 = masterCand[lo].s, s2 = masterCand[hi].s;
            if (s2 - s1 < 1e-9) continue;
            let t = (sA - s1) / (s2 - s1);
            t = Math.max(0, Math.min(1, t));

            // Skip near-coincident cases that merging/equalDOF coupling already handles
            const nM1 = nodeById.get(masterCand[lo].g)!, nM2 = nodeById.get(masterCand[hi].g)!;
            if (Math.hypot(n.x - nM1.x, n.y - nM1.y) < mergeTol || Math.hypot(n.x - nM2.x, n.y - nM2.y) < mergeTol) continue;

            // Hinge if either side marks this joint discontinuous
            const hinge = isPointDiscontinuous(slabA.id, n, edgeTol) || isPointDiscontinuous(slabB.id, n, edgeTol);

            // Backend DOF numbering (1..6): W=3, RX=4, RY=5 — shell bending set
            const dofs = hinge ? [3] : [3, 4, 5];
            for (const d of dofs) {
              mpcConstraints.push({
                slaveNodeId: g,
                slaveDof: d,
                masters: [
                  { nodeId: masterCand[lo].g, weight: 1 - t },
                  { nodeId: masterCand[hi].g, weight: t },
                ],
              });
            }
            tiedSlaves.add(g);
          }
        }
      }
    }
    if (mpcConstraints.length > 0) {
      console.log(`[Reslo FEM] Edge constraints: ${tiedSlaves.size} interface node-DOFs tied across slab joints (continuous mesh tying, ${mpcConstraints.length} MPCs)`);
    }
  }

  // Re-map slab elements to the global node IDs and collect per-element properties
  const globalElements: PyElement[] = [];
  const elementLoads: number[] = [];
  const elementThicknesses: number[] = [];
  const elementElasticModuli: number[] = [];
  let globalElemCounter = 1;

  for (const sm of slabMeshes) {
    const nodeMapForSlab = new Map<number, number>();
    for (const node of allNodes.filter(n => n.slabId === sm.slab.id)) {
      nodeMapForSlab.set(node.localId, node.globalIdx! + 1); // 1-indexed
    }

    const t_s = sm.slab.thickness || 0.2;
    const e_s = (sm.slab.elasticModulus ? sm.slab.elasticModulus * 1000 : 25e9) * (sm.slab.crackingModifier ?? 1.0);
    const q_s = (sm.slab.uniformLoad || 5.0) + (sm.slab.partitionLoad ?? 0) + 25 * t_s;

    for (const elem of sm.mesh.elements) {
      const globalNodeIds = elem.nodeIds.map(nid => nodeMapForSlab.get(nid)!);
      const globalElemId = globalElemCounter++;
      globalElements.push({
        id: globalElemId,
        nodeIds: globalNodeIds,
        area: elem.area || 0
      });

      elementThicknesses.push(t_s);
      elementElasticModuli.push(e_s);
      elementLoads.push(q_s);
    }
  }

  const globalMesh = {
    nodeCount: uniqueNodes.length,
    elementCount: globalElements.length,
    nodes: uniqueNodes,
    elements: globalElements,
    minAngle: 30,
    maxAspectRatio: 1.5,
    meshQuality: 'High'
  };

  // 3. Support mapping on the global mesh (multi-slab node coupling)
  const wallTol = Math.max(0.12, meshSize * 0.35);
  const wallNodeIds: number[] = [];
  const wallNodesCount = new Array(walls.length).fill(0);
  for (const n of uniqueNodes) {
    for (let wi = 0; wi < walls.length; wi++) {
      const w = walls[wi];
      const dx = w.endPoint.x - w.startPoint.x, dy = w.endPoint.y - w.startPoint.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue;
      const t = ((n.x - w.startPoint.x) * dx + (n.y - w.startPoint.y) * dy) / len2;
      if (t >= -0.01 && t <= 1.01) {
        const px = w.startPoint.x + Math.max(0, Math.min(1, t)) * dx;
        const py = w.startPoint.y + Math.max(0, Math.min(1, t)) * dy;
        if (Math.hypot(n.x - px, n.y - py) < wallTol) {
          wallNodeIds.push(n.id);
          wallNodesCount[wi]++;
        }
      }
    }
  }

  const colNodeIds: number[] = [];
  const colHeights: number[] = [];
  const colStiffnesses: number[] = [];
  const colWidths: number[] = [];
  const colDepths: number[] = [];
  const colShapes: string[] = [];
  const colDiameters: number[] = [];
  const colGrades: string[] = [];
  const COL_SNAP_TOL = 0.5;
  const skippedColumns: number[] = [];
  const skippedColumnIds: string[] = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const c = columns[ci] as any;
    const w = c.width || 0.3;
    const dp = c.depth || 0.3;
    const isInside = slabs.some(s => s.vertices && s.vertices.length >= 3 && pointInPolygon(c.position, s.vertices));
    let best = uniqueNodes[0], bestD = Infinity;
    for (const n of uniqueNodes) {
      const d = Math.hypot(n.x - c.position.x, n.y - c.position.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    // Only skip column if it is outside all slab polygons AND further than COL_SNAP_TOL
    if (!isInside && bestD > COL_SNAP_TOL) {
      skippedColumns.push(ci + 1);
      skippedColumnIds.push(c.id || `Column ${ci + 1}`);
      continue;
    }

    const Ix = dp * w**3 / 12;
    const Iy = w * dp**3 / 12;
    const I = (Ix + Iy) / 2;
    const E_col = (c.elasticModulus || 25e6) * 1000; // kPa → Pa
    const H = c.height || 3.0;

    if (best) {
      colNodeIds.push(best.id);
      colHeights.push(c.height || 3);
      colWidths.push(w);
      colDepths.push(dp);
      colStiffnesses.push(4 * E_col * I / H);
      colShapes.push(c.shape || 'rectangular');
      colDiameters.push((c.diameter || 500) / 1000);
      colGrades.push(c.concreteGrade || 'M25');

      // Tie all nodes within column capital footprint across all slabs to master column node
      const colSnapRadius = Math.max(0.35, Math.hypot(w, dp) * 0.7, meshSize * 0.5);
      const matchingNodes = uniqueNodes.filter(n => Math.hypot(n.x - c.position.x, n.y - c.position.y) <= colSnapRadius);
      for (const mNode of matchingNodes) {
        if (mNode.id !== best.id) {
          equalDofConstraints.push({
            nodeIdA: best.id,
            nodeIdB: mNode.id,
            dofs: [1, 2, 3, 4, 5, 6]
          });
        }
      }
    }
  }


  const primarySlab = slabs[0];
  const slabThickness = primarySlab.thickness || 0.2;
  const selfWeight = 25 * slabThickness;

  // Beam endpoints to global nodes
  const beamNodeIdA: number[] = [];
  const beamNodeIdB: number[] = [];
  const beamWidths: number[] = [];
  const beamDepths: number[] = [];
  const beamElasticModuli: number[] = [];
  for (const b of beams) {
    let bestA = uniqueNodes[0], bestDA = Infinity;
    let bestB = uniqueNodes[0], bestDB = Infinity;
    for (const n of uniqueNodes) {
      const dA = Math.hypot(n.x - b.startPoint.x, n.y - b.startPoint.y);
      const dB = Math.hypot(n.x - b.endPoint.x, n.y - b.endPoint.y);
      if (dA < bestDA) { bestDA = dA; bestA = n; }
      if (dB < bestDB) { bestDB = dB; bestB = n; }
    }
    if (bestA.id !== bestB.id) {
      beamNodeIdA.push(bestA.id);
      beamNodeIdB.push(bestB.id);
      beamWidths.push(b.width || 0.3);
      beamDepths.push(b.depth || 0.45);
      beamElasticModuli.push((b.elasticModulus || 25e6) * 1000);
    }
  }

  // Build drop panel list from actual panels + other slabs to support varying thickness in the global mesh
  const activeDropPanels = [...dropPanels.map(dp => ({ vertices: dp.vertices, drop: dp.drop }))];
  for (let i = 1; i < slabs.length; i++) {
    const s = slabs[i];
    activeDropPanels.push({
      vertices: s.vertices,
      drop: s.thickness
    });
  }

  const primarySlabE = (primarySlab.elasticModulus ? primarySlab.elasticModulus * 1000 : 25e9) * (primarySlab.crackingModifier ?? 1.0);
  const arBody: any = {
    mesh: globalMesh,
    thickness: slabThickness,
    elasticModulus: primarySlabE,
    poissonRatio,
    uniformLoad: (primarySlab.uniformLoad || 5.0) + (primarySlab.partitionLoad ?? 0),
    selfWeight: 0,
    elementThicknesses,
    elementElasticModuli,
    elementLoads,
    wallNodeIds: [...new Set(wallNodeIds)],
    wallStartPoints: walls.map(w => w.startPoint),
    wallEndPoints: walls.map(w => w.endPoint),
    wallThicknesses: walls.map(w => w.thickness ?? 0.25),
    wallHeights: walls.map(w => w.height ?? 3.0),
    wallElasticModuli: walls.map(w => w.elasticModulus ?? primarySlabE),
    columnNodeIds: colNodeIds,
    columnHeights: colHeights,
    columnStiffnesses: colStiffnesses,
    columnWidths: colWidths,
    columnDepths: colDepths,
    columnShapes: colShapes,
    columnDiameters: colDiameters,
    columnGrades: colGrades,
    columnBoundaryConditions: columns.map(c => c.boundaryCondition || 'fixed-fixed'),
    wallBoundaryConditions: walls.map(w => w.boundaryCondition || 'fixed-free'),
    beamNodeIdA,
    beamNodeIdB,
    beamWidths,
    beamDepths,
    beamElasticModuli,
    dropPanels: activeDropPanels,
    partitionWallSegments: computePartitionWallSegments(nonStructuralWalls, polylineNonStructuralWalls),
    equalDofConstraints,
    mpcConstraints
  };

  const warnings: string[] = [];
  if (skippedColumns.length > 0) {
    warnings.push(`Column${skippedColumns.length > 1 ? 's' : ''} ${skippedColumns.join(', ')} outside the slab mesh.`);
  }

  const analyzeController = new AbortController();
  const analyzeTimeout = setTimeout(() => analyzeController.abort(), 60000); // 60s timeout
  let result: PyAnalysisResult;
  try {
    const ar = await fetchApi(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arBody),
      signal: analyzeController.signal
    });
    clearTimeout(analyzeTimeout);
    if (!ar.ok) throw new PyApiError(`Analyze API failed: ${ar.status}`);
    result = await ar.json();
    if (!result.success) throw new PyApiError(`Analysis failed: ${result.error}`);
  } catch (e: any) {
    clearTimeout(analyzeTimeout);
    if (e.name === 'AbortError') throw new PyApiError('Analysis request timed out (60s). Try a coarser mesh size.');
    throw e;
  }

  // 4. Map global results back to individual SlabFEMResult outputs per slab
  const results: any[] = [];
  for (const sm of slabMeshes) {
    const localNodeMap = new Map<number, number>();
    for (const node of allNodes.filter(n => n.slabId === sm.slab.id)) {
      localNodeMap.set(node.localId, node.globalIdx! + 1); // 1-indexed
    }

    const defMap = new Map<number, { wz: number; rx: number; ry: number }>();
    for (const d of (result.nodeDeflections || [])) {
      defMap.set(d.nodeId, { wz: d.wz, rx: d.rx ?? 0, ry: d.ry ?? 0 });
    }

    const nodeDeflections = sm.mesh.nodes.map(n => {
      const gNodeId = localNodeMap.get(n.id)!;
      const defData = defMap.get(gNodeId);
      return {
        nodeId: n.id,
        wz: defData?.wz ?? 0,
        rx: defData?.rx ?? 0,
        ry: defData?.ry ?? 0
      };
    });

    // Moments, stresses, shears, membrane forces, and punching are stripped from solver output.
    // Provide empty arrays so the SlabFEMResult shape is satisfied.
    const momentMx: { elementId: number; value: number }[] = [];
    const momentMy: { elementId: number; value: number }[] = [];
    const momentMxy: { elementId: number; value: number }[] = [];
    const stresses: any[] = [];
    const shears: any[] = [];
    const columnPunching: any[] = [];

    results.push({
      slabId: sm.slab.id,
      mesh: {
        nodes: sm.mesh.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })),
        elements: sm.mesh.elements.map(e => ({ id: e.id, nodeIds: e.nodeIds, area: e.area || 0 })),
        meshSize: 0,
        unconnectedNodeIds: sm.mesh.unconnectedNodeIds || [],
      },
      nodeDeflections,
      momentMx,
      momentMy,
      momentMxy,
      stresses,
      shears,
      columnPunching,
      hingedNodeIds: computeHingedNodeIds(sm.slab, sm.mesh.nodes, meshSize),
      minWz: nodeDeflections.length ? Math.min(...nodeDeflections.map(d => d.wz)) : 0,
      maxWz: nodeDeflections.length ? Math.max(...nodeDeflections.map(d => d.wz)) : 0,
      minMx: 0,
      maxMx: 0,
      minMy: 0,
      maxMy: 0,
      minVx: 0,
      maxVx: 0,
      minVy: 0,
      maxVy: 0,
      crX: result.crX,
      crY: result.crY
    });
  }

  return { results, warnings, disconnectedIds: skippedColumnIds };
}

