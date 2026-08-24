import { generateSlabMesh } from './meshGenerator';
import { pointInPolygon } from './mathEngine';

function getInitialApiBase(): string {
  if (typeof window !== 'undefined' && window.location) {
    try {
      const params = new URLSearchParams(window.location.search);
      const apiParam = params.get('api') || params.get('apiUrl');
      if (apiParam) return apiParam.replace(/\/$/, '');
      if ((window as any).__RESLO_API__) return (window as any).__RESLO_API__;

      const saved = localStorage.getItem('reslo_api_url');
      if (saved && saved.startsWith('http')) {
        if (!(window.location.protocol === 'https:' && saved.startsWith('http://'))) {
          return saved.replace(/\/$/, '');
        }
      }

      if (window.location.origin && !window.location.origin.includes(':5173')) {
        return window.location.origin.replace(/\/$/, '');
      }
    } catch (_) {}
  }
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:8000';
}

let API_BASE = getInitialApiBase();

function isNgrokUrl(url: string): boolean {
  return url ? url.includes('ngrok') : false;
}

export function setApiBase(url: string) {
  if (!url) return;
  API_BASE = url.replace(/localhost:8000/g, '127.0.0.1:8000').replace(/\/$/, '');
}
export function getApiBase() { return API_BASE; }

import { femState } from '../stores/femResults.svelte';
import { uiState } from '../stores/uiState.svelte';

export async function healthCheck(): Promise<boolean> {
  const candidates: string[] = [];
  if (API_BASE) candidates.push(API_BASE);
  if (typeof window !== 'undefined' && window.location.origin && !candidates.includes(window.location.origin)) {
    candidates.push(window.location.origin);
  }
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') {
    if (!candidates.includes('http://127.0.0.1:8000')) candidates.push('http://127.0.0.1:8000');
    if (!candidates.includes('http://localhost:8000')) candidates.push('http://localhost:8000');
  }

  for (const url of candidates) {
    if (!url) continue;
    try {
      const cleanUrl = url.replace(/\/$/, '');
      const res = await fetch(`${cleanUrl}/api/health`, {
        method: 'GET',
        headers: { 'Bypass-Tunnel-Reminder': 'true', 'ngrok-skip-browser-warning': 'true' }
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        API_BASE = cleanUrl;
        const solverLabel = data?.solver || 'PyNite FEModel3D';
        femState.solverName = solverLabel;
        femState.backendConnected = true;
        uiState.backendConnected = true;
        console.log(`%c[PyAPI Health Check] Connected to backend at ${API_BASE} (${solverLabel})`, 'color: #4caf50; font-weight: bold;');
        return true;
      }
    } catch (_) {}
  }
  femState.backendConnected = false;
  uiState.backendConnected = false;
  return false;
}

async function fetchApi(url: string, init?: RequestInit, timeoutMs: number = 120000): Promise<Response> {
  const tStart = performance.now();
  console.log(`%c[PyAPI Req] ${init?.method || 'GET'} ${url}`, 'color: #00bcd4; font-weight: bold;');

  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http://')) {
    const errStr = `Browser blocked unencrypted connection (${url}) from an HTTPS page (${window.location.origin}). ` +
      `Please open Reslo via http://localhost:5173 or provide a HTTPS backend API URL via ?api=https://...`;
    console.error(`%c[PyAPI Security Error]\n${errStr}`, 'color: #ff1744; font-weight: bold; font-size: 13px;');
    throw new PyApiError(errStr);
  }

  const headers = new Headers(init?.headers);
  headers.set('Bypass-Tunnel-Reminder', 'true');
  headers.set('ngrok-skip-browser-warning', 'true');

  let lastErr: any = null;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(`Request timeout after ${timeoutMs / 1000}s`), timeoutMs);
      
      let signal = controller.signal;
      if (init?.signal) {
        if (init.signal.aborted) {
          clearTimeout(timerId);
          throw new PyApiError('Request aborted before start');
        }
        init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason || 'Aborted'), { once: true });
      }

      const res = await fetch(url, { ...init, headers, signal });
      clearTimeout(timerId);
      const elapsed = Math.round(performance.now() - tStart);
      if (res.ok) {
        console.log(`%c[PyAPI Success] ${res.status} OK (${elapsed}ms) - ${url}`, 'color: #4caf50; font-weight: bold;');
        return res;
      }
      console.warn(`%c[PyAPI Status Warning] HTTP ${res.status} (${elapsed}ms) - ${url}`, 'color: #ff9800; font-weight: bold;');
      if (res.status >= 500 && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err: any) {
      lastErr = err;
      if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
        break;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  const elapsed = Math.round(performance.now() - tStart);
  const detail = lastErr?.message ? ` (${lastErr.message})` : '';
  const errorMsg = `Unable to reach FEA Backend API at ${API_BASE}${detail}. Please ensure the backend server is running and accessible.`;
  
  console.error(
    `%c[PyAPI Connection Error] (${elapsed}ms)\n` +
    `URL: ${url}\n` +
    `Reason: ${errorMsg}\n` +
    `Troubleshooting:\n` +
    ` 1. Is Python backend running at http://127.0.0.1:8000?\n` +
    ` 2. Check backend.log in your workspace.\n` +
    ` 3. Run .\\start_tunnel.ps1 to start the backend API.`,
    'color: #ff1744; font-weight: bold; font-size: 13px;'
  );

  throw new PyApiError(errorMsg);
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



export class PyApiError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PyApiError'; }
}

/**
 * Convert a mesh from the local TypeScript mesher into the backend's PyMesh shape.
 *
 * The TS mesher emits 0-indexed node/element ids; the Python solvers index nodes
 * from 1 (node id N maps to array row N-1). Without this remap every fallback
 * mesh is off by one node, which silently shifts supports and corrupts results.
 * Elements with fewer than 3 distinct nodes are dropped — degenerate elements
 * produce a zero-area Jacobian and make the stiffness matrix singular.
 */
function tsMeshToPyMesh(tsMesh: { nodes: { id: number; x: number; y: number }[]; elements: { id: number; nodeIds: number[]; area?: number }[]; unconnectedNodeIds?: number[] }): PyMesh {
  const idRemap = new Map<number, number>();
  const nodes: PyNode[] = tsMesh.nodes.map((n, i) => {
    idRemap.set(n.id, i + 1);
    return { id: i + 1, x: n.x, y: n.y };
  });

  const elements: PyElement[] = [];
  for (const el of tsMesh.elements) {
    const mapped = el.nodeIds.map(nid => idRemap.get(nid)).filter((v): v is number => v !== undefined);
    const distinct = [...new Set(mapped)];
    if (distinct.length < 3) continue;
    elements.push({ id: elements.length + 1, nodeIds: distinct, area: el.area ?? 0 });
  }

  const connected = new Set<number>();
  for (const el of elements) for (const nid of el.nodeIds) connected.add(nid);

  return {
    nodeCount: nodes.length,
    elementCount: elements.length,
    nodes,
    elements,
    minAngle: 30,
    maxAspectRatio: 1.5,
    meshQuality: 'fallback',
    unconnectedNodeIds: nodes.filter(n => !connected.has(n.id)).map(n => n.id),
  };
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

/**
 * 1-indexed ids of nodes lying on the mesh outer boundary.
 *
 * An edge referenced by exactly one element is on the perimeter; interior
 * edges are shared by two. Used as a fallback support set so a slab with no
 * connected columns/walls still solves instead of aborting the analysis.
 */
function perimeterNodeIds(mesh: { elements: { nodeIds: number[] }[] }): number[] {
  const edgeCount = new Map<string, number>();
  for (const el of mesh.elements) {
    const n = el.nodeIds;
    if (n.length < 3) continue;
    for (let i = 0; i < n.length; i++) {
      const a = n[i], b = n[(i + 1) % n.length];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  const boundary = new Set<number>();
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue;
    const [a, b] = key.split('_');
    boundary.add(Number(a));
    boundary.add(Number(b));
  }
  return [...boundary];
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
  if (!mesh || mesh.elementCount === 0) {
    throw new PyApiError(
      'Could not mesh this slab. The outline may be self-intersecting, too small ' +
      'relative to the mesh size, or have fewer than 3 distinct corners.'
    );
  }
  const pyMesh: PyMesh = mesh;
  const wallNodeIds: number[] = [];
  const wallNodesCount = new Array(walls.length).fill(0);
  
  // Pre-calculate wall segment vectors to avoid redundant math in inner loops
  const wallPrecalc = walls.map(w => {
    const dx = w.endPoint.x - w.startPoint.x;
    const dy = w.endPoint.y - w.startPoint.y;
    const len2 = dx * dx + dy * dy;
    return { w, dx, dy, len2 };
  });

  for (const n of pyMesh.nodes) {
    for (let wi = 0; wi < wallPrecalc.length; wi++) {
      const { w, dx, dy, len2 } = wallPrecalc[wi];
      if (len2 < 1e-12) continue;
      const t = ((n.x - w.startPoint.x) * dx + (n.y - w.startPoint.y) * dy) / len2;
      if (t >= -0.01 && t <= 1.01) {
        const px = w.startPoint.x + clampT * dx;
        const py = w.startPoint.y + clampT * dy;
        const dist2 = (n.x - px) ** 2 + (n.y - py) ** 2;
        const wallTol = Math.max(0.02, Math.min(0.06, meshSize * 0.08));
        const wallTolSq = wallTol * wallTol;
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
    let best = pyMesh.nodes[0], bestD2 = Infinity;
    for (const n of pyMesh.nodes) {
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

      for (const n of pyMesh.nodes) {
        const t = ((n.x - sx) * dx + (n.y - sy) * dy) / L2;
        if (t >= -0.01 && t <= 1.01) {
          const clampT = Math.max(0, Math.min(1, t));
          const px = sx + clampT * dx;
          const py = sy + clampT * dy;
          if (Math.hypot(n.x - px, n.y - py) <= beamTol) {
            n.x = px;
            n.y = py;
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
    wallBoundaryConditions: walls.map(w => w.boundaryCondition || 'fixed-fixed'),
    beamNodeIdA, beamNodeIdB, beamWidths, beamDepths, beamElasticModuli,
    dropPanels: dropPanels.map(dp => ({ vertices: dp.vertices, drop: dp.drop })),
    partitionWallSegments: computePartitionWallSegments(nonStructuralWalls, polylineNonStructuralWalls)
  };

  // ── Connectivity validation ──
  const warnings: string[] = [];

  // No support snapped to the mesh. Rather than aborting the whole analysis,
  // fall back to supporting the slab's outer boundary so the user still gets
  // deflections, and warn. Unconnected columns/walls are reported separately
  // below and highlighted on the canvas via disconnectedIds.
  if (colNodeIds.length === 0 && wallNodeIds.length === 0) {
    const boundaryNodeIds = perimeterNodeIds(pyMesh);
    if (boundaryNodeIds.length === 0) {
      throw new PyApiError(
        'No column or wall supports are connected to this slab, and its boundary ' +
        'could not be determined. Place at least one column or wall on the slab.'
      );
    }
    arBody.wallNodeIds = boundaryNodeIds;
    warnings.push(
      'No column or wall is connected to this slab. Analyzed with the slab edge ' +
      'treated as simply supported — results are indicative only. Move supports ' +
      'onto the slab for an accurate model.'
    );
  }
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

  if (pyMesh.unconnectedNodeIds && pyMesh.unconnectedNodeIds.length > 0) {
    warnings.push(`${pyMesh.unconnectedNodeIds.length} node${pyMesh.unconnectedNodeIds.length > 1 ? 's' : ''} (ID: ${pyMesh.unconnectedNodeIds.join(', ')}) in the mesh ${pyMesh.unconnectedNodeIds.length > 1 ? 'are' : 'is'} not connected to any slab elements. These nodes will be highlighted on the canvas in red and automatically constrained to prevent solver errors.`);
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

  return { mesh: pyMesh, result, slabId: slabPolygon.vertices.length > 0 ? `slab_${Date.now()}` : 'slab_0', warnings, disconnectedIds };
}

function safeArrayMin(arr: number[]): number {
  if (!arr || arr.length === 0) return 0;
  let min = arr[0];
  for (let i = 1; i < arr.length; i++) { if (arr[i] < min) min = arr[i]; }
  return min;
}

function safeArrayMax(arr: number[]): number {
  if (!arr || arr.length === 0) return 0;
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) { if (arr[i] > max) max = arr[i]; }
  return max;
}

function toFrontendResult(slabId: string, mesh: any, result: any): any {
  // Convert deflection wz from meters to millimeters (mm)
  const nodeDeflections = result.nodeDeflections.map((d: any) => ({
    nodeId: d.nodeId, wz: d.wz * 1000,
    rx: d.rx ?? 0, ry: d.ry ?? 0
  }));
  const momentMx: { elementId: number; value: number }[] = (result.elementMoments || []).map((m: any) => ({
    elementId: m.elementId,
    value: m.spr_mx ?? m.mx ?? 0
  }));
  const momentMy: { elementId: number; value: number }[] = (result.elementMoments || []).map((m: any) => ({
    elementId: m.elementId,
    value: m.spr_my ?? m.my ?? 0
  }));
  const momentMxy: { elementId: number; value: number }[] = (result.elementMoments || []).map((m: any) => ({
    elementId: m.elementId,
    value: m.spr_mxy ?? m.mxy ?? 0
  }));
  const stresses: any[] = result.elementStresses || [];
  const shears: any[] = result.elementShears || [];
  const membraneForces: any[] = result.elementMembraneForces || [];
  const columnPunching: any[] = result.columnPunching || [];

  const wzVals = nodeDeflections.map((d: any) => d.wz);
  const localMinWz = safeArrayMin(wzVals);
  const localMaxWz = safeArrayMax(wzVals);

  return {
    slabId,
    mesh: {
      nodes: mesh.nodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y })),
      elements: mesh.elements.map((e: any) => ({ id: e.id, nodeIds: e.nodeIds, area: e.area || 0 })),
      meshSize: 0,
      unconnectedNodeIds: mesh.unconnectedNodeIds || [],
    },
    nodeDeflections, momentMx, momentMy, momentMxy, stresses, shears, membraneForces, columnPunching,
    minWz: localMinWz,
    maxWz: localMaxWz,
    minMx: result.minMx ?? 0,
    maxMx: result.maxMx ?? 0,
    minMy: result.minMy ?? 0,
    maxMy: result.maxMy ?? 0,
    minVx: result.minVx ?? 0,
    maxVx: result.maxVx ?? 0,
    minVy: result.minVy ?? 0,
    maxVy: result.maxVy ?? 0,
    minNx: result.minNx ?? 0,
    maxNx: result.maxNx ?? 0,
    minNy: result.minNy ?? 0,
    maxNy: result.maxNy ?? 0,
    minNxy: result.minNxy ?? 0,
    maxNxy: result.maxNxy ?? 0,
    crX: result.crX,
    crY: result.crY,
  };
}


function flattenAllWalls(walls: any[], polylineWalls: any[] = []): any[] {
  const allWalls = [...(walls || [])];
  const COLLINEAR_TOL = 0.001745; // 0.1° — same tolerance as mathEngine.ts
  for (const pw of (polylineWalls || [])) {
    if (!pw || !pw.vertices || pw.vertices.length < 2) continue;
    const rawSegs: { x1: number; y1: number; x2: number; y2: number; alpha: number }[] = [];
    for (let i = 0; i < pw.vertices.length - 1; i++) {
      const a = pw.vertices[i], b = pw.vertices[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-10) continue;
      rawSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, alpha: Math.atan2(dy, dx) });
    }
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
        elasticModulus: pw.elasticModulus ?? 25e9,
        thickness: pw.thickness ?? 0.25,
        height: pw.height ?? 3.0,
        boundaryCondition: pw.boundaryCondition ?? 'fixed-fixed'
      });
      si = sj + 1;
    }
  }
  return allWalls;
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
  const allWalls = flattenAllWalls(walls, polylineWalls);
  const { mesh, result } = await meshAndAnalyze(slab, allWalls, columns, meshSize, poissonRatio, beams, dropPanels, nonStructuralWalls, polylineNonStructuralWalls);
  return toFrontendResult(slab.id || 'slab_0', mesh, result);
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
  polylineNonStructuralWalls: any[] = [],
  polylineWalls: any[] = []
): Promise<{ results: any[]; warnings: string[]; disconnectedIds: string[] }> {
  if (slabs.length === 0) return { results: [], warnings: [], disconnectedIds: [] };

  const allWalls = flattenAllWalls(walls, polylineWalls);

  // Attempt single-payload batch backend execution first (< 40ms single round-trip)
  try {
    const multiPayload = {
      slabs: slabs.map(slab => ({
        slabId: slab.id || 'slab_0',
        geometry: {
          vertices: slab.vertices,
          openings: (slab.openings || []).map((op: any) => ({ vertices: op.vertices })),
          walls: allWalls.map(w => ({ startPoint: w.startPoint, endPoint: w.endPoint })),
          beams: (beams || []).map(b => ({ startPoint: b.startPoint, endPoint: b.endPoint })),
          columns: columns.map(c => ({ position: c.position, width: c.width || 0.3, depth: c.depth || 0.3, height: c.height || 3.0 }))
        },
        meshSize,
        thickness: slab.thickness || 0.2,
        elasticModulus: (slab.elasticModulus ? (slab.elasticModulus < 1e8 ? slab.elasticModulus * 1000 : slab.elasticModulus) : 25e9) * (slab.crackingModifier ?? 1.0),
        poissonRatio,
        uniformLoad: (slab.uniformLoad || 5.0) + (slab.partitionLoad ?? 0),
        selfWeight: 25 * (slab.thickness || 0.2)
      })),
      walls: allWalls.map(w => ({
        startPoint: w.startPoint,
        endPoint: w.endPoint,
        thickness: w.thickness ?? 0.25,
        height: w.height ?? 3.0,
        elasticModulus: w.elasticModulus ? (w.elasticModulus < 1e8 ? w.elasticModulus * 1000 : w.elasticModulus) : 25e9,
        boundaryCondition: w.boundaryCondition ?? 'fixed-fixed'
      })),
      columns: columns.map(c => ({
        position: c.position,
        width: c.width || 0.3,
        depth: c.depth || 0.3,
        height: c.height || 3.0,
        elasticModulus: c.elasticModulus ? (c.elasticModulus < 1e8 ? c.elasticModulus * 1000 : c.elasticModulus) : 25e9,
        shape: c.shape || 'rectangular',
        diameter: (c.diameter || 500) / 1000,
        concreteGrade: c.concreteGrade || 'M25'
      })),
      beams: (beams || []).map(b => ({
        startPoint: b.startPoint,
        endPoint: b.endPoint,
        width: b.width || 0.3,
        depth: b.depth || 0.45,
        elasticModulus: b.elasticModulus ? (b.elasticModulus < 1e8 ? b.elasticModulus * 1000 : b.elasticModulus) : 25e9
      })),
      dropPanels: dropPanels.map(dp => ({ vertices: dp.vertices, drop: dp.drop })),
      partitionWallSegments: computePartitionWallSegments(nonStructuralWalls, polylineNonStructuralWalls),
      meshSize
    };

    console.log(`%c[PyAPI] Initiating multi-slab FEA solve (${slabs.length} slab(s), ${walls.length} wall(s), ${columns.length} column(s))...`, 'color: #2196f3; font-weight: bold;');

    const mr = await fetchApi(`${API_BASE}/api/analyze_multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(multiPayload)
    }, 300000); // 300s timeout for large multi-slab models

    if (mr.ok) {
      const data = await mr.json();
      if (data.success && data.results && data.results.length > 0) {
        console.log(`%c[PyAPI Success] Multi-slab FEM solve complete (${data.results.length} result(s))`, 'color: #4caf50; font-weight: bold;');
        const results = data.results.map((r: any) => toFrontendResult(r.slabId, r.mesh, r.result));
        return { results, warnings: data.warnings || [], disconnectedIds: data.disconnectedIds || [] };
      } else {
        const errMsg = data.error || 'Unknown backend solver error';
        console.error(
          `%c[PyAPI Backend Error] Backend solver returned failure status!\n` +
          `Error: ${errMsg}\n` +
          `Warnings: ${(data.warnings || []).join('\n')}`,
          'color: #ff1744; font-weight: bold; font-size: 13px;'
        );
        throw new PyApiError(`PyNite backend solver error: ${errMsg}`);
      }
    } else {
      const httpErr = `HTTP ${mr.status} ${mr.statusText} from /api/analyze_multi`;
      console.error(`%c[PyAPI HTTP Error] ${httpErr}`, 'color: #ff1744; font-weight: bold;');
      throw new PyApiError(`PyNite backend API error: ${httpErr}`);
    }
  } catch (err: any) {
    console.warn('[PyAPI] Single-payload multi-slab API attempt failed, falling back to sequential batching:\n' + (err?.message || err));
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
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for Gmsh Delaunay triangular meshing
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

  const mergeTol = Math.max(0.05, Math.min(0.20, meshSize * 0.25));
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
        // Merge coincident boundary nodes across adjacent slabs into a single node (different slabs only)
        if (node.slabId !== un.slabId && !isUnDiscont && Math.hypot(node.x - un.x, node.y - un.y) < mergeTol) {
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


  // Non-conformal multi-slab boundary segment coupling (C0 & C1 continuity for non-coincident boundary nodes).
  // Bucketed by a grid of cell size mergeTol so only genuinely nearby nodes are
  // compared. The previous all-pairs loop was O(n^2) and dominated wall-clock
  // time on multi-slab models (≈4.5M comparisons for 5 slabs at 3k nodes).
  {
    const cell = Math.max(mergeTol, 1e-9);
    const buckets = new Map<string, number[]>();
    const bucketKey = (x: number, y: number) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}`;

    for (let i = 0; i < uniqueNodes.length; i++) {
      const n = uniqueNodes[i];
      const k = bucketKey(n.x, n.y);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(i);
    }

    const seenPairs = new Set<string>();
    for (let i = 0; i < uniqueNodes.length; i++) {
      const nA = uniqueNodes[i];
      const cx = Math.floor(nA.x / cell);
      const cy = Math.floor(nA.y / cell);
      // A node within mergeTol can only fall in this cell or one of its 8 neighbours.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const neighbours = buckets.get(`${cx + ox}_${cy + oy}`);
          if (!neighbours) continue;
          for (const j of neighbours) {
            if (j <= i) continue;
            const nB = uniqueNodes[j];
            if (nA.slabId === nB.slabId || nA.id === nB.id) continue;
            if (Math.hypot(nA.x - nB.x, nA.y - nB.y) > mergeTol) continue;
            const pairKey = nA.id < nB.id ? `${nA.id}_${nB.id}` : `${nB.id}_${nA.id}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
            const discontA = discontNodeKeys.has(nA.slabId + '_' + nA.localId);
            const discontB = discontNodeKeys.has(nB.slabId + '_' + nB.localId);
            const isHinge = discontA || discontB;
            equalDofConstraints.push({
              nodeIdA: nA.id,
              nodeIdB: nB.id,
              dofs: isHinge ? [1, 2, 3, 6] : [1, 2, 3, 4, 5, 6]
            });
          }
        }
      }
    }
  }

  // Re-map slab elements to the global node IDs and collect per-element properties
  const globalElements: PyElement[] = [];
  const elementLoads: number[] = [];
  const elementThicknesses: number[] = [];
  const elementElasticModuli: number[] = [];
  let globalElemCounter = 1;

  // Group nodes by slab once, instead of re-filtering allNodes per slab (O(slabs x nodes)).
  const nodesBySlab = new Map<string, NodeRef[]>();
  for (const node of allNodes) {
    let arr = nodesBySlab.get(node.slabId);
    if (!arr) { arr = []; nodesBySlab.set(node.slabId, arr); }
    arr.push(node);
  }

  let droppedElements = 0;
  for (const sm of slabMeshes) {
    const nodeMapForSlab = new Map<number, number>();
    for (const node of nodesBySlab.get(sm.slab.id) ?? []) {
      if (node.globalIdx !== undefined) nodeMapForSlab.set(node.localId, node.globalIdx + 1); // 1-indexed
    }

    const t_s = sm.slab.thickness || 0.2;
    const e_s = (sm.slab.elasticModulus ? sm.slab.elasticModulus * 1000 : 25e9) * (sm.slab.crackingModifier ?? 1.0);
    const q_s = (sm.slab.uniformLoad || 5.0) + (sm.slab.partitionLoad ?? 0) + 25 * t_s;

    for (const elem of sm.mesh.elements) {
      // Drop elements whose nodes didn't map, or that collapsed to <3 distinct
      // nodes after merging. Passing `undefined` ids through here serializes as
      // null and corrupts the element on the backend.
      const mapped = elem.nodeIds
        .map(nid => nodeMapForSlab.get(nid))
        .filter((v): v is number => v !== undefined);
      const globalNodeIds = [...new Set(mapped)];
      if (globalNodeIds.length < 3) { droppedElements++; continue; }

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
  const wallTol = Math.max(0.02, Math.min(0.06, meshSize * 0.08));
  const wallNodeIds: number[] = [];
  const wallNodesCount = new Array(allWalls.length).fill(0);
  for (const n of uniqueNodes) {
    for (let wi = 0; wi < allWalls.length; wi++) {
      const w = allWalls[wi];
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
    }
  }


  const primarySlab = slabs[0];
  const slabThickness = primarySlab.thickness || 0.2;
  const selfWeight = 25 * slabThickness;

  // Beam data: snap and discretize all intermediate global mesh nodes along beam line segments
  const beamNodeIdA: number[] = [];
  const beamNodeIdB: number[] = [];
  const beamWidths: number[] = [];
  const beamDepths: number[] = [];
  const beamElasticModuli: number[] = [];
  for (const b of beams) {
    const sx = b.startPoint.x, sy = b.startPoint.y;
    const ex = b.endPoint.x, ey = b.endPoint.y;
    const dx = ex - sx, dy = ey - sy;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;

    const beamTol = Math.max(0.15, meshSize * 0.5);
    const nearNodes: { id: number; t: number }[] = [];

    for (const n of uniqueNodes) {
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
    wallStartPoints: allWalls.map(w => w.startPoint),
    wallEndPoints: allWalls.map(w => w.endPoint),
    wallThicknesses: allWalls.map(w => w.thickness ?? 0.25),
    wallHeights: allWalls.map(w => w.height ?? 3.0),
    wallElasticModuli: allWalls.map(w => w.elasticModulus ?? primarySlabE),
    columnNodeIds: colNodeIds,
    columnHeights: colHeights,
    columnStiffnesses: colStiffnesses,
    columnWidths: colWidths,
    columnDepths: colDepths,
    columnShapes: colShapes,
    columnDiameters: colDiameters,
    columnGrades: colGrades,
    columnBoundaryConditions: columns.map(c => c.boundaryCondition || 'fixed-fixed'),
    wallBoundaryConditions: allWalls.map(w => w.boundaryCondition || 'fixed-fixed'),
    beamNodeIdA,
    beamNodeIdB,
    beamWidths,
    beamDepths,
    beamElasticModuli,
    dropPanels: activeDropPanels,
    partitionWallSegments: computePartitionWallSegments(nonStructuralWalls, polylineNonStructuralWalls),
    equalDofConstraints
  };

  const warnings: string[] = [];
  if (skippedColumns.length > 0) {
    warnings.push(`Column${skippedColumns.length > 1 ? 's' : ''} ${skippedColumns.join(', ')} outside the slab mesh.`);
  }
  // Walls that matched no mesh node contribute no support. Report them so they
  // are highlighted on the canvas rather than silently ignored.
  const disconnectedWallIds: string[] = [];
  for (let wi = 0; wi < allWalls.length; wi++) {
    if (wallNodesCount[wi] === 0) {
      const wall = allWalls[wi] as any;
      disconnectedWallIds.push(wall.id || wall.label || `Wall ${wi + 1}`);
    }
  }
  if (disconnectedWallIds.length > 0) {
    warnings.push(
      `Wall${disconnectedWallIds.length > 1 ? 's' : ''} ${disconnectedWallIds.join(', ')} ` +
      `${disconnectedWallIds.length > 1 ? 'have' : 'has'} no mesh nodes along ${disconnectedWallIds.length > 1 ? 'their' : 'its'} length ` +
      `and provided no support. Analysis continued without ${disconnectedWallIds.length > 1 ? 'them' : 'it'}.`
    );
  }
  if (droppedElements > 0) {
    warnings.push(`${droppedElements} mesh element${droppedElements > 1 ? 's were' : ' was'} degenerate after node merging and excluded from the analysis.`);
  }
  if (globalElements.length === 0) {
    throw new PyApiError('No valid mesh elements remained after merging slabs. Check that the slab outlines are valid and not overlapping.');
  }

  // Same fallback as the single-slab path: if nothing snapped to a support,
  // hold the combined mesh boundary rather than sending an unsupported model
  // to the solver (which fails with a singular stiffness matrix).
  if (colNodeIds.length === 0 && wallNodeIds.length === 0) {
    const boundaryNodeIds = perimeterNodeIds(globalMesh);
    if (boundaryNodeIds.length === 0) {
      throw new PyApiError('No supports are connected to these slabs and the mesh boundary could not be determined.');
    }
    arBody.wallNodeIds = boundaryNodeIds;
    warnings.push(
      'No column or wall is connected to these slabs. Analyzed with the outer ' +
      'edge treated as simply supported — results are indicative only.'
    );
  }

  const analyzeController = new AbortController();
  const analyzeTimeout = setTimeout(() => analyzeController.abort(), 120000); // 120s timeout
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
    if (e.name === 'AbortError') throw new PyApiError('Analysis request timed out (120s). Try a coarser mesh size.');
    throw e;
  }

  // 4. Map global results back to individual SlabFEMResult outputs per slab
  const results: any[] = [];
  // Build the deflection lookup once — it is identical for every slab.
  const defMap = new Map<number, { wz: number; rx: number; ry: number }>();
  for (const d of (result.nodeDeflections || [])) {
    defMap.set(d.nodeId, { wz: d.wz, rx: d.rx ?? 0, ry: d.ry ?? 0 });
  }

  for (const sm of slabMeshes) {
    const localNodeMap = new Map<number, number>();
    for (const node of nodesBySlab.get(sm.slab.id) ?? []) {
      if (node.globalIdx !== undefined) localNodeMap.set(node.localId, node.globalIdx + 1); // 1-indexed
    }

    const nodeDeflections = sm.mesh.nodes.map(n => {
      const gNodeId = localNodeMap.get(n.id);
      const defData = gNodeId === undefined ? undefined : defMap.get(gNodeId);
      return {
        nodeId: n.id,
        wz: defData?.wz ?? 0,
        rx: defData?.rx ?? 0,
        ry: defData?.ry ?? 0
      };
    });

    const momentMx: { elementId: number; value: number }[] = (result.elementMoments || []).map((m: any) => ({
      elementId: m.elementId,
      value: m.spr_mx ?? m.mx ?? 0
    }));
    const momentMy: { elementId: number; value: number }[] = (result.elementMoments || []).map((m: any) => ({
      elementId: m.elementId,
      value: m.spr_my ?? m.my ?? 0
    }));
    const momentMxy: { elementId: number; value: number }[] = (result.elementMoments || []).map((m: any) => ({
      elementId: m.elementId,
      value: m.spr_mxy ?? m.mxy ?? 0
    }));
    const stresses: any[] = result.elementStresses || [];
    const shears: any[] = result.elementShears || [];
    const columnPunching: any[] = result.columnPunching || [];

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
      minWz: safeArrayMin(nodeDeflections.map(d => d.wz)),
      maxWz: safeArrayMax(nodeDeflections.map(d => d.wz)),
      minMx: result.minMx ?? 0,
      maxMx: result.maxMx ?? 0,
      minMy: result.minMy ?? 0,
      maxMy: result.maxMy ?? 0,
      minVx: result.minVx ?? 0,
      maxVx: result.maxVx ?? 0,
      minVy: result.minVy ?? 0,
      maxVy: result.maxVy ?? 0,
      crX: result.crX,
      crY: result.crY
    });
  }

  return { results, warnings, disconnectedIds: [...skippedColumnIds, ...disconnectedWallIds] };
}

