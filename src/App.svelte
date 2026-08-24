<script lang="ts">
  import WorkspaceCanvas from './lib/components/WorkspaceCanvas.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import MaterialProperty from './lib/components/MaterialProperty.svelte';
  import MetricsHUD from './lib/components/MetricsHUD.svelte';
  import LayersPanel from './lib/components/LayersPanel.svelte';
  import PropertiesPanel from './lib/components/PropertiesPanel.svelte';
  import ContextMenu from './lib/components/ContextMenu.svelte';
  import ImageUploader from './lib/components/ImageUploader.svelte';
  import GraphViewer from './lib/components/GraphViewer.svelte';
  import ColumnPlacementPanel from './lib/components/ColumnPlacementPanel.svelte';
  import ExportDialog from './lib/components/ExportDialog.svelte';
  import ParametricStudyDialog from './lib/components/ParametricStudyDialog.svelte';
  import ParametricLivePanel from './lib/components/ParametricLivePanel.svelte';
  import FEMControlPanel from './lib/components/FEMControlPanel.svelte';
  import ThreeViewport from './lib/components/ThreeViewport.svelte';
  import ColorLegend from './lib/components/ColorLegend.svelte';
  import ResultsTable from './lib/components/ResultsTable.svelte';
  import InsightPanel from './lib/ai/insightPanel.svelte';
  import { loopEngine } from './lib/ai/loopEngine.svelte';
  import { memoryStore } from './lib/ai/memoryStore.svelte';
  import { startPerfProbe, perfProbeStop } from './lib/ai/perfProbe';
  import { uiState } from './lib/stores/uiState.svelte';
  import { model } from './lib/stores/structuralModel.svelte';
  import { femState } from './lib/stores/femResults.svelte';
  import { graphStore } from './lib/stores/graphStore.svelte';
  import { floorLayers } from './lib/stores/floorLayers.svelte';
  import type { SlabFEMResult, SlabPolygon, ColumnElement, ShearWallElement, FEMWorkerInput, FEMWorkerOutput } from './lib/engine/types';
  import { meshAndAnalyze, meshAndAnalyzeAllSlabs, healthCheck, setApiBase, getApiBase, PyApiError } from './lib/engine/pyApi';
  import { checkGeometryConnections } from './lib/engine/geometryChecker';
  import { computeScaleLabel } from './lib/engine/scaleCalibrator';

  let worker: Worker | null = null;
  let femTimer: ReturnType<typeof setTimeout> | null = null;
  let apiAvailable = false;
  let healthInterval: ReturnType<typeof setInterval> | null = null;

  // Draggable Results Toolbar State
  let displayPosX = $state<number | null>(null);
  let displayPosY = $state<number | null>(null);
  let isDraggingDisplay = false;
  let dragOffset = { x: 0, y: 0 };

  function handleDisplayDragStart(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.closest('button')) return;
    
    e.preventDefault();
    const toolbar = target.closest('.display-toolbar') as HTMLElement;
    if (!toolbar) return;
    
    const rect = toolbar.getBoundingClientRect();
    dragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    
    isDraggingDisplay = true;
    window.addEventListener('mousemove', handleDisplayMouseMove);
    window.addEventListener('mouseup', handleDisplayMouseUp);
  }

  function handleDisplayMouseMove(e: MouseEvent) {
    if (!isDraggingDisplay) return;
    displayPosX = e.clientX - dragOffset.x;
    displayPosY = e.clientY - dragOffset.y;
  }

  function handleDisplayMouseUp() {
    isDraggingDisplay = false;
    window.removeEventListener('mousemove', handleDisplayMouseMove);
    window.removeEventListener('mouseup', handleDisplayMouseUp);
  }

  // Draggable Deflection Settings Panel State
  let deflectionPosX = $state<number | null>(null);
  let deflectionPosY = $state<number | null>(null);
  let isDraggingDeflection = false;
  let deflectionDragOffset = { x: 0, y: 0 };

  function handleDeflectionDragStart(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.closest('button, input, select')) return;
    
    e.preventDefault();
    const panel = target.closest('.deflection-settings-panel') as HTMLElement;
    if (!panel) return;
    
    const rect = panel.getBoundingClientRect();
    deflectionDragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    
    isDraggingDeflection = true;
    window.addEventListener('mousemove', handleDeflectionMouseMove);
    window.addEventListener('mouseup', handleDeflectionMouseUp);
  }

  function handleDeflectionMouseMove(e: MouseEvent) {
    if (!isDraggingDeflection) return;
    deflectionPosX = e.clientX - deflectionDragOffset.x;
    deflectionPosY = e.clientY - deflectionDragOffset.y;
  }

  function handleDeflectionMouseUp() {
    isDraggingDeflection = false;
    window.removeEventListener('mousemove', handleDeflectionMouseMove);
    window.removeEventListener('mouseup', handleDeflectionMouseUp);
  }

  $effect(() => {
    startPerfProbe((fps, frameTime) => {
      if (typeof window !== 'undefined') {
        (window as any).__resloPerf = { fps, frameTime, dirty: true };
      }
    });
    return () => { perfProbeStop(); };
  });

  const FALLBACK_LIVE_URL = (typeof window !== 'undefined' && window.location.protocol === 'https:') ? window.location.origin : 'http://127.0.0.1:8000';
  let isCheckingBackend = false;

  function checkBackend(url?: string) {
    if (isCheckingBackend) return;
    isCheckingBackend = true;
    const targetUrl = url || uiState.apiUrl || getApiBase() || FALLBACK_LIVE_URL;
    if (targetUrl) setApiBase(targetUrl);

    healthCheck().then(ok => {
      isCheckingBackend = false;
      uiState.backendConnected = ok;
      femState.backendConnected = ok;
      apiAvailable = ok;
      if (ok) {
        uiState.setStatusMessage(`🟢 ${femState.solverName} Backend Connected`);
      } else {
        uiState.setStatusMessage(`🔴 Solver Backend Disconnected`);
      }
    }).catch(() => {
      isCheckingBackend = false;
      uiState.backendConnected = false;
      femState.backendConnected = false;
      apiAvailable = false;
    });
  }


  $effect(() => {
    const url = uiState.apiUrl;
    const t = setTimeout(() => checkBackend(url), 10);
    if (healthInterval) clearInterval(healthInterval);
    healthInterval = setInterval(() => checkBackend(uiState.apiUrl), 15000);
    return () => { clearTimeout(t); if (healthInterval) clearInterval(healthInterval); };
  });

  let graphRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    model.columns; model.walls; model.polylineWalls; model.slabs; model.beams; model.dropPanels;
    model.pixelsPerMeter;
    if (graphRefreshTimer) clearTimeout(graphRefreshTimer);
    graphRefreshTimer = setTimeout(() => graphStore.refresh(), 300);
  });

  // Auto-save to localStorage on model changes
  $effect(() => {
    model.columns; model.walls; model.polylineWalls; model.slabs; model.beams; model.dropPanels;
    model.dimensions; model.hiddenElementIds;
    model.concreteGrade; model.rebarGrade;
    model.scheduleAutoSave();
  });

  // Apply deflectionType and crackedModifierValue to all slabs
  $effect(() => {
    const type = uiState.deflectionType;
    const val = uiState.crackedModifierValue;
    const targetVal = type === 'cracked' ? val : 1.0;
    const needsUpdate = model.slabs.some(s => s.crackingModifier !== targetVal);
    if (needsUpdate) {
      model.beginAction();
      for (const slab of model.slabs) {
        if (slab.crackingModifier !== targetVal) {
          model.updateSlab(slab.id, { crackingModifier: targetVal });
        }
      }
    }
  });

  let lastSolvedFingerprint = $state<string>('');

  $effect(() => {
    if (!femState.hasResults && femState.slabResults.size === 0) {
      lastSolvedFingerprint = '';
    }
  });

  function computeModelFingerprint(): string {
    const slabsStr = model.slabs.map(s =>
      `${s.id}:${s.vertices.map(v => `${v.x.toFixed(3)},${v.y.toFixed(3)}`).join(';')}:${s.thickness}:${s.uniformLoad}:${s.crackingModifier}:${s.concreteGrade}`
    ).join('|');

    const wallsStr = model.walls.map(w =>
      `${w.id}:${w.startPoint.x.toFixed(3)},${w.startPoint.y.toFixed(3)}->${w.endPoint.x.toFixed(3)},${w.endPoint.y.toFixed(3)}:${w.thickness}:${w.height}`
    ).join('|');

    const polyWallsStr = model.polylineWalls.map(pw =>
      `${pw.id}:${pw.vertices.map(v => `${v.x.toFixed(3)},${v.y.toFixed(3)}`).join(';')}:${pw.thickness}:${pw.height}`
    ).join('|');

    const colsStr = model.columns.map(c =>
      `${c.id}:${c.position.x.toFixed(3)},${c.position.y.toFixed(3)}:${c.width}:${c.depth}:${c.height}:${c.rotation}`
    ).join('|');

    const beamsStr = model.beams.map(b =>
      `${b.id}:${b.startPoint.x.toFixed(3)},${b.startPoint.y.toFixed(3)}->${b.endPoint.x.toFixed(3)},${b.endPoint.y.toFixed(3)}:${b.width}:${b.depth}`
    ).join('|');

    const dropPanelsStr = model.dropPanels.map(dp =>
      `${dp.id}:${dp.vertices.map(v => `${v.x.toFixed(3)},${v.y.toFixed(3)}`).join(';')}:${dp.drop}`
    ).join('|');

    const nonStructWallsStr = model.nonStructuralWalls.map(w =>
      `${w.id}:${w.startPoint.x.toFixed(3)},${w.startPoint.y.toFixed(3)}->${w.endPoint.x.toFixed(3)},${w.endPoint.y.toFixed(3)}:${w.partitionUnitWeight}`
    ).join('|');

    return `${slabsStr}#${wallsStr}#${polyWallsStr}#${colsStr}#${beamsStr}#${dropPanelsStr}#${nonStructWallsStr}#ms:${uiState.femMeshSize}#dt:${uiState.deflectionType}#cm:${uiState.crackedModifierValue}`;
  }

  $effect(() => {
    // Monitor deep properties to trigger debounced analysis on drags and edits
    model.columns.forEach(c => { c.position.x; c.position.y; c.width; c.depth; c.height; c.rotation; });
    model.walls.forEach(w => { w.startPoint.x; w.startPoint.y; w.endPoint.x; w.endPoint.y; w.thickness; w.height; });
    model.polylineWalls.forEach(pw => { pw.vertices.forEach(v => { v.x; v.y; }); pw.thickness; pw.height; });
    model.beams.forEach(b => { b.startPoint.x; b.startPoint.y; b.endPoint.x; b.endPoint.y; b.width; b.depth; b.height; });
    model.slabs.forEach(s => { s.vertices.forEach(v => { v.x; v.y; }); s.holes.forEach(h => h.forEach(v => { v.x; v.y; })); s.thickness; s.uniformLoad; s.crackingModifier; });
    model.dropPanels.forEach(dp => { dp.vertices.forEach(v => { v.x; v.y; }); dp.width; dp.depth; dp.drop; dp.rotation; });
    model.nonStructuralWalls.forEach(w => { w.startPoint.x; w.startPoint.y; w.endPoint.x; w.endPoint.y; w.thickness; w.height; w.partitionUnitWeight; });
    model.polylineNonStructuralWalls.forEach(pw => { pw.vertices.forEach(v => { v.x; v.y; }); pw.thickness; pw.height; pw.partitionUnitWeight; });
    uiState.femMeshSize;

    if (femTimer) clearTimeout(femTimer);

    // Suppress auto-triggering while loading/restoring a project
    if (model.isRestoring) return;

    if (uiState.femAutoCompute && model.slabs.length > 0) {
      const currentFingerprint = computeModelFingerprint();
      // Only schedule analysis if model geometry or parameters actually changed or no results exist
      if (currentFingerprint !== lastSolvedFingerprint || !femState.hasResults) {
        // Dynamic debounce based on canvas interaction and model scale
        const totalSlabArea = model.slabs.reduce((acc, s) => {
          if (s.vertices.length < 3) return acc;
          const xs = s.vertices.map(v => v.x);
          const ys = s.vertices.map(v => v.y);
          return acc + (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        }, 0);
        const isLargeModel = totalSlabArea > 400 || (model.columns.length + model.walls.length + model.beams.length) > 25;
        const debounceMs = uiState.isCanvasInteracting ? 1500 : (isLargeModel ? 900 : 400);
        femTimer = setTimeout(() => { triggerFEMAnalysis(); }, debounceMs);
      }
    }
  });

  function headroomColor(): string {
    switch (graphStore.report?.level) {
      case 'green': return 'bg-green-500';
      case 'yellow': return 'bg-yellow-500';
      case 'red': return 'bg-red-500';
      case 'critical': return 'bg-red-600';
      default: return 'bg-slate-600';
    }
  }

  function toFrontendResult(slabId: string, mesh: any, result: any, meshSize: number): SlabFEMResult {
    const nodeDeflections = result.nodeDeflections.map((d: any) => ({
      nodeId: d.nodeId, wz: d.wz,
      rx: d.rx ?? 0, ry: d.ry ?? 0
    }));
    const momentMx = result.elementMoments.map((m: any) => ({ elementId: m.elementId, value: m.mx }));
    const momentMy = result.elementMoments.map((m: any) => ({ elementId: m.elementId, value: m.my }));
    const momentMxy = result.elementMoments.map((m: any) => ({ elementId: m.elementId, value: m.mxy }));
    const stresses = (result.elementStresses || []).map((s: any) => ({
      elementId: s.elementId, s1: s.s1, s2: s.s2, angle: s.angle, vm: s.vm
    }));
    const shears = (result.elementShears || []).map((s: any) => ({
      elementId: s.elementId, vx: s.vx, vy: s.vy, v1: s.v1, angle: s.angle
    }));
    const membraneForces = (result.elementMembraneForces || []).map((m: any) => ({
      elementId: m.elementId, nx: m.nx, ny: m.ny, nxy: m.nxy, n1: m.n1, n2: m.n2, angle: m.angle
    }));
    const columnPunching = (result.columnPunching || []).map((p: any) => ({
      nodeId: p.nodeId, force_kN: p.force_kN, stress_MPa: p.stress_MPa,
      capacity_MPa: p.capacity_MPa, ratio: p.ratio, status: p.status
    }));

    // PERF: Safe min/max using loops — Math.min(...arr) stack overflows on large arrays
    function safeMin(arr: number[]): number {
      if (arr.length === 0) return 0;
      let m = arr[0];
      for (let i = 1; i < arr.length; i++) if (arr[i] < m) m = arr[i];
      return m;
    }
    function safeMax(arr: number[]): number {
      if (arr.length === 0) return 0;
      let m = arr[0];
      for (let i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
      return m;
    }

    const vxVals = shears.map((s: any) => s.vx);
    const vyVals = shears.map((s: any) => s.vy);
    const nxVals = membraneForces.map((m: any) => m.nx);
    const nyVals = membraneForces.map((m: any) => m.ny);
    const nxyVals = membraneForces.map((m: any) => m.nxy);
    const wzVals = nodeDeflections.map((d: any) => d.wz);
    const mxVals = momentMx.map((m: any) => m.value);
    const myVals = momentMy.map((m: any) => m.value);

    return {
      slabId,
      mesh: {
        nodes: mesh.nodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y })),
        elements: mesh.elements.map((e: any) => ({ id: e.id, nodeIds: e.nodeIds, area: e.area || 0 })),
        meshSize,
      },
      nodeDeflections, momentMx, momentMy, momentMxy, stresses, shears, membraneForces, columnPunching,
      minWz: safeMin(wzVals),
      maxWz: safeMax(wzVals),
      minMx: result.minMx ?? safeMin(mxVals),
      maxMx: result.maxMx ?? safeMax(mxVals),
      minMy: result.minMy ?? safeMin(myVals),
      maxMy: result.maxMy ?? safeMax(myVals),
      minVx: result.minVx ?? safeMin(vxVals),
      maxVx: result.maxVx ?? safeMax(vxVals),
      minVy: result.minVy ?? safeMin(vyVals),
      maxVy: result.maxVy ?? safeMax(vyVals),
      minNx: result.minNx ?? safeMin(nxVals),
      maxNx: result.maxNx ?? safeMax(nxVals),
      minNy: result.minNy ?? safeMin(nyVals),
      maxNy: result.maxNy ?? safeMax(nyVals),
      minNxy: result.minNxy ?? safeMin(nxyVals),
      maxNxy: result.maxNxy ?? safeMax(nxyVals),
      crX: result.crX,
      crY: result.crY,
    };
  }

  let femGen = 0;

  function currentSlabIds(): Set<string> {
    return new Set(model.slabs.filter(s => s.vertices.length >= 3).map(s => s.id));
  }

  async function triggerFEMAnalysis(force: boolean = false): Promise<void> {
    const validSlabs = model.slabs.filter((s: SlabPolygon) => s.vertices.length >= 3);
    if (validSlabs.length === 0) return;

    const currentFingerprint = computeModelFingerprint();
    if (!force && currentFingerprint === lastSolvedFingerprint && femState.hasResults) {
      // Model unchanged and already solved: display results without re-running FEM
      uiState.setShowFEMResults(true);
      femState.showFEMContour = true;
      return;
    }

    const gen = ++femGen;
    const slabIdsAtStart = currentSlabIds();

    femState.setComputing();
    uiState.setShowFEMResults(true);

    const columns = model.columns;
    const walls = [...model.walls, ...model.polylineWalls.map((pw: any) => {
      const segs: ShearWallElement[] = [];
      for (let i = 0; i < pw.vertices.length - 1; i++) {
        segs.push({
          id: `${pw.id}_${i}`, startPoint: pw.vertices[i], endPoint: pw.vertices[i + 1],
          thickness: pw.thickness, height: pw.height, elasticModulus: pw.elasticModulus,
          shearModulus: pw.shearModulus, concreteDensity: pw.concreteDensity,
          label: pw.label, boundaryCondition: pw.boundaryCondition
        });
      }
      return segs;
    }).flat()];

    const allWalls = walls.filter(w => w.startPoint && w.endPoint);
    let meshSize = uiState.femMeshSize;

    // Adaptive Node/Mesh Guard: clamp mesh size based on slab area to prevent solver timeouts
    const maxNodes = apiAvailable ? 15000 : 3500;
    for (const slab of validSlabs) {
      if (slab.vertices.length >= 3) {
        const xs = slab.vertices.map(v => v.x);
        const ys = slab.vertices.map(v => v.y);
        const bboxWidth = Math.max(...xs) - Math.min(...xs);
        const bboxHeight = Math.max(...ys) - Math.min(...ys);
        const slabArea = bboxWidth * bboxHeight;
        // Limit total estimated nodes = slabArea / (meshSize^2) to maxNodes
        const minSafeMeshSize = Math.max(0.15, Math.sqrt(slabArea / maxNodes));
        if (meshSize < minSafeMeshSize) {
          meshSize = minSafeMeshSize;
        }
      }
    }

    // Always check PyNite backend health dynamically before solving
    const isBackendReady = await healthCheck();
    apiAvailable = isBackendReady;
    femState.backendConnected = isBackendReady;
    uiState.backendConnected = isBackendReady;

    if (isBackendReady) {
      uiState.solverEngine = 'python_backend';
      femState.solverName = 'PyNite FEModel3D';
    }

    // ── Python PyNite FEModel3D Backend Solver (Primary) ──
    if (isBackendReady) {
      try {
        await runBackendSolver(validSlabs, allWalls, columns, meshSize, gen, slabIdsAtStart, currentFingerprint);
        if (gen !== femGen) return;
        return;
      } catch (e) {
        console.warn(`[Reslo] PyNite backend attempt failed, falling back to Web Worker solver:`, e);
      }
    }

    // ── TypeScript In-Browser Web Worker Solver (Fallback only) ──
    try {
      await runWorkerSolver(validSlabs, columns, allWalls, meshSize, gen, slabIdsAtStart, currentFingerprint);
      if (gen !== femGen) return;
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      femState.setError(`Solver failed: ${msg}`);
      uiState.setStatusMessage(`Solver error: ${msg}`);
      return;
    }
  }

  // Non-blocking backend upgrade: refines results with Kratos Multiphysics (kratos_solver.py) when available/fast.
  async function runBackendSolver(
    validSlabs: SlabPolygon[], allWalls: ShearWallElement[], columns: ColumnElement[],
    meshSize: number, gen: number, slabIdsAtStart: Set<string>, solvedFingerprint: string
  ): Promise<void> {
    // Step 1: Pre-Analysis Geometry Connection Check (< 2ms)
    femState.setProgress(0.05);
    uiState.setStatusMessage('Checking geometry connections...');
    const geoAudit = checkGeometryConnections(
      validSlabs, columns, allWalls, model.polylineWalls, model.beams, model.dropPanels
    );
    femState.disconnectedIds = new Set(geoAudit.disconnectedIds);
    if (geoAudit.warnings.length > 0) {
      console.warn('[Reslo Geometry Audit]\n' + geoAudit.warnings.join('\n'));
    }

    // Step 2: FEM Mesh & Analysis Execution
    femState.setProgress(0.1);
    femState.refreshTimeout();
    const primarySlab = validSlabs[0];
    const poissonRatio = 0.2;
    const res = await meshAndAnalyzeAllSlabs(
      validSlabs, allWalls, columns, meshSize, poissonRatio, model.beams, model.dropPanels,
      model.nonStructuralWalls, model.polylineNonStructuralWalls, []
    );
    femState.setProgress(1);
    if (gen !== femGen) return; // a newer analysis superseded this one
    const slabLabelsAtStart = new Set(model.slabs.filter(s => s.vertices.length >= 3).map(s => s.label));
    const stillValid = res.results.filter(r =>
      (slabIdsAtStart.has(r.slabId) || slabLabelsAtStart.has(r.slabId)) &&
      model.slabs.some(s => s.id === r.slabId || s.label === r.slabId)
    );
    if (stillValid.length === 0) throw new Error('No valid slab results returned from backend solver');
    femState.setResults(stillValid);
    lastSolvedFingerprint = solvedFingerprint;

    // Merge pre-analysis geometry warnings with backend warnings (non-blocking)
    const combinedWarnings = Array.from(new Set([...geoAudit.warnings, ...res.warnings]));
    femState.warnings = combinedWarnings;
    femState.disconnectedIds = new Set([...geoAudit.disconnectedIds, ...res.disconnectedIds]);

    const elemCount = stillValid.reduce((s, r) => s + r.mesh.elements.length, 0);
    uiState.setStatusMessage(`FEM (PyNite FEModel3D): ${stillValid.length} slab(s), ${elemCount} elements`);
    memoryStore.pushSolve({ solver: 'pynite', slabCount: stillValid.length, elementCount: elemCount, durationMs: 0, success: true, warnings: combinedWarnings });
  }


  function runWorkerSolver(validSlabs: SlabPolygon[], columns: ColumnElement[], walls: ShearWallElement[], meshSize: number, gen: number, slabIdsAtStart: Set<string>, solvedFingerprint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!worker) {
          worker = new Worker(new URL('./workers/fem.worker.ts', import.meta.url), { type: 'module' });
        }
        worker.onerror = (err) => {
          worker = null;
          const errMsg = err?.message || 'Web Worker script execution failed';
          reject(new Error(`Worker error: ${errMsg}`));
        };
        worker.onmessage = (event: MessageEvent<FEMWorkerOutput>) => {
          const data = event.data;
          if (data.type === 'PROGRESS') {
            femState.setProgress(data.progress ?? 0);
          } else if (data.type === 'RESULT') {
            if (gen !== femGen) { resolve(); return; }
            const results = (data.results ?? []).filter(r => slabIdsAtStart.has(r.slabId) && model.slabs.some(s => s.id === r.slabId || s.label === r.slabId));
            if (results.length === 0) {
              femState.clear();
              uiState.setStatusMessage('Analysis cleared - slab deleted');
              resolve();
              return;
            }
            femState.setResults(results);
            lastSolvedFingerprint = solvedFingerprint;
            const count = results.length;
            const elems = results.reduce((s, r) => s + r.mesh.elements.length, 0);
            uiState.setStatusMessage(`FEM (TS): ${count} slab(s), ${elems} elements`);
            memoryStore.pushSolve({ solver: 'worker', slabCount: count, elementCount: elems, durationMs: 0, success: true, warnings: [] });
            resolve();
          } else if (data.type === 'ERROR') {
            reject(new Error(data.error ?? 'Unknown worker error'));
          }
        };
        const primarySlab = validSlabs[0];
        const poissonRatio = (primarySlab?.concreteGrade === 'M30' || (primarySlab?.elasticModulus && primarySlab.elasticModulus > 26e6)) ? 0.16 : 0.2;
        const input: FEMWorkerInput = JSON.parse(JSON.stringify({
          type: 'ANALYZE', slabs: validSlabs, columns, walls,
          polylineWalls: model.polylineWalls, beams: model.beams, dropPanels: model.dropPanels,
          nonStructuralWalls: model.nonStructuralWalls, polylineNonStructuralWalls: model.polylineNonStructuralWalls,
          meshSize, poissonRatio, useQ8: false,
          designOptions: {
            concreteGrade: validSlabs[0]?.concreteGrade || 'M30',
            steelGrade: 'Fe 500',
            cover: 0.025,
            barDia: 12,
            exposureLimit: 0.3,
            longTermFactor: 2.0
          }
        }));
        worker.postMessage(input);
      } catch (e) { reject(e); }
    });
  }

  function handleRunFEM(): void { triggerFEMAnalysis(); }

  function toggleGraphViewer(): void {
    graphStore.showGraphViewer = !graphStore.showGraphViewer;
    if (graphStore.showGraphViewer) graphStore.refresh();
  }

  let calibDistance = $state('10');

  function submitCalibration(): void {
    const data = uiState.calibrationPendingData;
    if (!data) return;
    const len = parseFloat(calibDistance);
    if (isNaN(len) || len <= 0) {
      uiState.setStatusMessage('Invalid distance — enter a positive number');
      return;
    }
    try {
      model.calibrator.setFromTwoPoints(data.p1Screen, data.p2Screen, len, model.canvasZoom);
      model.setCalibrated();
      const ppm = model.calibrator.pixelsPerMeter;
      const scaleLabel = computeScaleLabel(ppm);
      uiState.setStatusMessage(`Calibrated: ${ppm.toFixed(2)} px/m (${scaleLabel})`);
      uiState.showCalibrationDialog = false;
      uiState.calibrationPendingData = null;
      uiState.setTool('select');
    } catch (err) {
      uiState.setStatusMessage(`Calibration error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  $effect(() => {
    if (typeof window !== 'undefined') {
      uiState.initPanels(window.innerWidth, window.innerHeight);
    }
  });

  // Apply theme class via direct DOM manipulation — avoids Svelte reactivity cascade
  $effect(() => {
    const t = uiState.theme;
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('light-theme', t === 'light');
      try { localStorage.setItem('reslo_theme', t); } catch {}
    }
  });

  // AI Loop Engine + Perf Probe
  $effect(() => {
    startPerfProbe((fps, frameTime) => {
      if (typeof window !== 'undefined') {
        (window as any).__resloPerf = { fps, frameTime, dirty: true };
      }
    });
    return () => { perfProbeStop(); };
  });

  function handleResize(): void {
    if (typeof window !== 'undefined') {
      uiState.initPanels(window.innerWidth, window.innerHeight);
    }
  }

  function copyShareLink(): void {
    const currentUrl = uiState.apiUrl;
    let shareUrl = 'https://reslo-eosin.vercel.app/';
    if (currentUrl && currentUrl.startsWith('https://')) {
      shareUrl += `?api=${encodeURIComponent(currentUrl)}`;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        uiState.setStatusMessage(`Share link copied to clipboard! 🔗`);
      }).catch(() => {
        uiState.setStatusMessage(`Share URL: ${shareUrl}`);
      });
    } else {
      uiState.setStatusMessage(`Share URL: ${shareUrl}`);
    }
  }
</script>

<div class="flex h-screen w-screen overflow-hidden bg-[#000000]">
  <div class="sidebar flex flex-col w-[220px] shrink-0 border-r border-[#222222] bg-[#000000]">
    <!-- Scrollable top section -->
    <div class="flex-1 flex flex-col gap-1.5 p-2 overflow-y-auto">
      <div class="text-sm font-bold text-[#D62430] tracking-tight mb-1 flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          <img src="/reslo-logo.png" alt="Reslo" class="h-6" />
          <button
            onclick={copyShareLink}
            class="text-slate-400 hover:text-white transition-colors p-0.5 rounded cursor-pointer text-[10px]"
            title="Copy Shareable Link"
          >
            🔗
          </button>
          <button
            onclick={() => { uiState.theme = uiState.theme === 'dark' ? 'light' : 'dark'; }}
            class="theme-toggle text-slate-400 hover:text-slate-200 transition-colors p-0.5 rounded cursor-pointer"
            title={uiState.theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            {#if uiState.theme === 'dark'}
              <svg class="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 2.293a1 1 0 011.414 0l.707.707a1 1 0 01-1.414 1.414l-.707-.707a1 1 0 010-1.414zm2.121 4.471a1 1 0 10-1.414 1.414l.707.707a1 1 0 001.414-1.414l-.707-.707zM10 14a4 4 0 100-8 4 4 0 000 8zm-7.071-7.07a1 1 0 011.414-1.414l.707.707A1 1 0 013.636 7.636l-.707-.707zM3 10a1 1 0 011-1h1a1 1 0 110 2H4a1 1 0 01-1-1zm2.293 4.293a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 0zM14 16.707a1 1 0 011.414-1.414l.707.707a1 1 0 01-1.414 1.414l-.707-.707zM8.94 13.06a1 1 0 011.414 0l.707.707a1 1 0 01-1.414 1.414l-.707-.707a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
            {:else}
              <svg class="w-3.5 h-3.5 text-slate-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
              </svg>
            {/if}
          </button>
        </div>
        <button
          class="rounded px-2 py-0.5 text-[9px] font-bold uppercase transition-colors cursor-pointer border
            {uiState.femAutoCompute 
              ? 'bg-[#D62430] border-[#D62430] text-white hover:bg-[#B01E28]' 
              : 'bg-[#1a1a1a] border-[#333333] text-[#ffffff] hover:bg-[#D62430]'}"
          class:active={uiState.femAutoCompute}
          onclick={() => { 
            uiState.femAutoCompute = !uiState.femAutoCompute;
            if (uiState.femAutoCompute) {
              triggerFEMAnalysis();
            } else {
              femState.clear();
              uiState.setShowFEMResults(false);
            }
          }}
        >
          {uiState.femAutoCompute ? '● Live On' : '○ Live Off'}
        </button>
      </div>
      <!-- Compact widget buttons: Reset View, Clear All, Save, Load -->
      <div class="flex gap-1">
        <button
          onclick={() => { model.resetView(); uiState.setStatusMessage('View reset'); }}
          class="flex-1 rounded bg-[#1a1a1a] py-1 text-[9px] text-[#ffffff] hover:bg-[#D62430] transition-colors cursor-pointer"
          title="Reset view zoom/pan"
        >Reset View</button>
        <button
          onclick={() => {
            model.resetModel();
            uiState.showParametricLivePanel = false;
            uiState.showParametricStudyDialog = false;
            uiState.setStatusMessage('Model cleared');
          }}
          class="flex-1 rounded bg-[#1a1a1a] py-1 text-[9px] text-[#ffffff] hover:bg-[#D62430] transition-colors cursor-pointer"
          title="Clear all elements"
        >Clear All</button>
        <button
          onclick={() => model.saveToFile()}
          class="flex-1 rounded bg-[#1a1a1a] py-1 text-[9px] text-[#ffffff] hover:bg-[#D62430] transition-colors cursor-pointer"
          title="Save project (Ctrl+S)"
        >Save</button>
        <button
          onclick={() => document.getElementById('project-file-input')?.click()}
          class="flex-1 rounded bg-[#1a1a1a] py-1 text-[9px] text-[#ffffff] hover:bg-[#D62430] transition-colors cursor-pointer"
          title="Open .9e project file"
        >Open</button>
      </div>
      <div class="flex items-center gap-1 px-1">
        <label class="text-[9px] text-[#888888] shrink-0">Project:</label>
        <input
          type="text"
          value={model.projectName}
          oninput={(e) => { model.projectName = (e.target as HTMLInputElement).value || 'project'; }}
          class="flex-1 rounded bg-[#1a1a1a] border border-[#333333] px-1.5 py-0.5 text-[10px] text-[#ffffff] focus:border-[#D62430] focus:outline-none"
          placeholder="Project name"
        />
      </div>
      <ImageUploader />
      <button
        onclick={() => uiState.showExportDialog = true}
        class="w-full rounded bg-[#D62430] py-1.5 text-xs text-white hover:bg-[#B01E28] transition-colors border border-[#D62430]"
      >Export</button>
      
      <!-- FEM Settings Panel (Mesh Size control) -->
      <div class="sidebar-panel flex flex-col gap-1.5 rounded-lg bg-[#1a1a1a] p-2 border border-[#333333] mt-0.5">
        <div class="text-[10px] font-bold text-[#ffffff] uppercase tracking-wider px-1">FEM Settings</div>
        <div class="flex items-center justify-between px-1">
          <label class="text-[9px] text-slate-400">Mesh Size:</label>
          <span class="text-[9px] font-mono text-white">{uiState.femMeshSize.toFixed(2)}m</span>
        </div>
        <input
          type="range"
          min="0.15"
          max="2.0"
          step="0.05"
          value={uiState.femMeshSize}
          oninput={(e) => { uiState.femMeshSize = parseFloat(e.currentTarget.value); if (uiState.femAutoCompute) triggerFEMAnalysis(); }}
          class="w-full accent-[#D62430] cursor-pointer h-1.5 bg-[#333333] rounded-lg appearance-none"
        />
      </div>

      <input
        id="project-file-input"
        type="file"
        accept=".9e,application/json"
        class="hidden"
        onchange={(e) => { const input = e.currentTarget as HTMLInputElement; const file = input.files?.[0]; if (file) { model.loadFromFile(file).then(() => { uiState.setStatusMessage('Project loaded'); }).catch(err => { uiState.setStatusMessage('Load error: ' + err.message); }); input.value = ''; } }}
      />
      {#if uiState.viewMode === '2d'}
        <Toolbar />
      {/if}
      {#if uiState.tool === 'column'}
        <ColumnPlacementPanel />
      {/if}
    </div>

    <!-- Fixed bottom section -->
    <div class="calculation-engine-panel p-2.5 border-t border-[#222222] bg-[#0c0c0c] flex flex-col gap-1 shrink-0">
      <div class="text-[10px] font-bold text-[#888888] uppercase tracking-wider px-1">Calculation Engine</div>
      <div class="flex items-center gap-1.5 px-1 py-0.5">
        <span class="w-1.5 h-1.5 rounded-full {uiState.solverEngine === 'ts_local' ? 'bg-indigo-500 shadow-[0_0_6px_#6366f1]' : uiState.backendConnected ? 'bg-green-500 shadow-[0_0_6px_#10b981]' : 'bg-yellow-500 shadow-[0_0_6px_#f59e0b]'}"></span>
        <span class="text-[9px] text-slate-300 font-medium">
          {uiState.solverEngine === 'ts_local' ? 'TypeScript In-Browser WebWorker' : uiState.backendConnected ? 'Python DKT Backend' : 'TypeScript Web Worker'}
        </span>
      </div>
    </div>
  </div>

  {#if uiState.viewMode === '3d'}
    {@const isLight = uiState.theme === 'light'}
    <div class="flex flex-1 flex-col min-w-0">
      <div class="relative flex-1 min-h-0 overflow-hidden rounded transition-colors {isLight ? 'bg-[#f0f2f5]' : 'bg-[#1a1a1a]'}">
        <ThreeViewport />
        <!-- 3D View Controls Overlay -->
        <div class="absolute top-3 left-3 z-20 flex flex-col gap-2">
          <div class="flex gap-1 items-center p-1.5 rounded-lg border backdrop-blur-md transition-colors {isLight ? 'border-slate-300 bg-white/90 text-slate-800 shadow-md' : 'border-slate-700/60 bg-slate-900/90 text-slate-200 shadow-xl'}">
            {#each [['top','Top'],['iso','Iso'],['front','Front'],['side','Side']] as [preset,label]}
              <button
                class="px-2 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer {uiState.viewPreset === preset ? 'bg-[#D62430] text-white font-bold' : isLight ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-slate-700/70 text-slate-200 hover:bg-slate-600'}"
                onclick={() => uiState.viewPreset = preset as any}
              >{label}</button>
            {/each}
            <div class="h-3 w-px mx-0.5 {isLight ? 'bg-slate-300' : 'bg-slate-700/80'}"></div>
            <button
              class="px-2 py-1 text-[10px] font-semibold rounded transition-colors cursor-pointer flex items-center gap-1 border {uiState.showGrid3D ? 'bg-[#D62430] text-white border-[#D62430]' : isLight ? 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200' : 'bg-slate-700/70 text-slate-200 border-slate-600 hover:bg-slate-600'}"
              onclick={() => uiState.showGrid3D = !uiState.showGrid3D}
              title="Toggle 3D Grid visibility"
            >
              <span>Grid</span>
              <span class="text-[9px] uppercase opacity-90">{uiState.showGrid3D ? 'ON' : 'OFF'}</span>
            </button>
          </div>
          <div class="flex items-center justify-between gap-3 p-1.5 rounded-lg border backdrop-blur-md text-[10px] transition-colors {isLight ? 'border-slate-300 bg-white/90 text-slate-800 shadow-md' : 'border-slate-700/60 bg-slate-900/90 text-slate-200 shadow-xl'}">
            <label class="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" bind:checked={uiState.femAnimationEnabled} class="accent-[#D62430]" /> Animate
            </label>
          </div>
          <div class="flex items-center gap-1.5 p-1.5 rounded-lg border backdrop-blur-md text-[10px] transition-colors {isLight ? 'border-slate-300 bg-white/90 text-slate-800 shadow-md' : 'border-slate-700/60 bg-slate-900/90 text-slate-200 shadow-xl'}">
            <span class={isLight ? 'text-slate-600 font-medium' : 'text-slate-300'}>Def. scale</span>
            <input type="range" min="5" max="300" bind:value={femState.deformedScale} class="w-20 accent-[#D62430] cursor-pointer" />
            <span class="font-mono font-bold {isLight ? 'text-slate-900' : 'text-white'}">{femState.deformedScale}×</span>
          </div>
        </div>
        {#if femState.showFEMContour}
          <ColorLegend
            resultType={femState.resultType}
            min={femState.contourCache.globalMin}
            max={femState.contourCache.globalMax}
            ramp={uiState.colorRamp}
          />
        {/if}
      </div>
      <div class="flex items-center justify-between px-4 py-1.5 border-t text-[11px] transition-colors {isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-[#1a1a1a] border-[#333333] text-[#ffffff]'}">
        <span>{uiState.statusMessage}</span>
        <span class="flex items-center gap-3 font-mono">
          <span class="text-[#D62430] font-bold">3D View</span>
          {#if femState.hasResults}
            <span>Max defl: <span class="text-[#D62430] font-bold">{Math.max(Math.abs(femState.globalMinWz), Math.abs(femState.globalMaxWz)).toFixed(2)} mm</span></span>
          {/if}
        </span>
      </div>
    </div>
  {:else}
    <div class="flex flex-1 flex-col relative">
      <WorkspaceCanvas />

      <div class="flex items-center justify-between px-4 py-1.5 bg-[#1a1a1a] border-t border-[#333333] text-[11px] text-[#ffffff] z-10">
        <span>{uiState.statusMessage}</span>
        <span class="flex items-center gap-3 font-mono">
          <button
            onclick={toggleGraphViewer}
            class="flex items-center gap-1.5 rounded bg-[#333333] px-2 py-1 hover:bg-[#D62430] transition-colors cursor-pointer"
            title="View graph state"
          >
            <span class="inline-block h-2 w-2 rounded-full {headroomColor()}"></span>
            <span>{graphStore.report?.tokens ?? '—'} tok</span>
            <span class="text-[10px] text-[#ffffff]">L{graphStore.report?.compression ?? 0}</span>
          </button>
          <span>{(model.canvasZoom * 100).toFixed(0)}%</span>
          <span>{model.calibrator.pixelsPerMeter.toFixed(1)} px/m</span>
        </span>
      </div>
    </div>

    {#if floorLayers.layers.length > 0}
      <LayersPanel />
    {/if}
    <PropertiesPanel />

    <ContextMenu />
    <GraphViewer />
  {/if}

  <div class="absolute right-3 top-3 flex flex-col gap-3 pointer-events-none z-10">
    <div class="pointer-events-auto"><MetricsHUD /></div>

    {#if uiState.femAutoCompute && uiState.viewMode === '2d'}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="deflection-settings-panel pointer-events-auto rounded-lg bg-slate-800/95 p-3 border border-slate-700 text-xs font-mono w-[220px] shadow-lg flex flex-col gap-2.5 cursor-move select-none"
        style={deflectionPosX !== null && deflectionPosY !== null ? `left: ${deflectionPosX}px; top: ${deflectionPosY}px; position: fixed; transform: none; z-index: 50;` : ''}
        onmousedown={handleDeflectionDragStart}
      >
        <div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Deflection Settings</div>
        
        <div class="flex flex-col gap-2">
          <label class="flex items-center gap-2 text-slate-200 cursor-pointer select-none">
            <input
              type="radio"
              name="deflectionType"
              value="uncracked"
              checked={uiState.deflectionType === 'uncracked'}
              onchange={() => { uiState.deflectionType = 'uncracked'; }}
              class="accent-[#D62430]"
            />
            <span>Uncracked Deflection</span>
          </label>
          
          <label class="flex items-center gap-2 text-slate-200 cursor-pointer select-none">
            <input
              type="radio"
              name="deflectionType"
              value="cracked"
              checked={uiState.deflectionType === 'cracked'}
              onchange={() => { uiState.deflectionType = 'cracked'; }}
              class="accent-[#D62430]"
            />
            <span>Cracked Deflection</span>
          </label>
        </div>

        {#if uiState.deflectionType === 'cracked'}
          <div class="flex flex-col gap-1.5 border-t border-slate-700/50 pt-2">
            <div class="flex items-center justify-between text-[10px] text-slate-400">
              <span>Crack Modifier:</span>
              <span class="font-bold text-indigo-400 font-mono">{uiState.crackedModifierValue.toFixed(2)}</span>
            </div>
            <div class="flex gap-1">
              <button
                class="flex-1 py-0.5 rounded text-[9px] font-semibold transition-colors border cursor-pointer text-center {uiState.crackedModifierValue === 0.25 ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-700/50 border-slate-600 text-slate-300 hover:bg-slate-700'}"
                onclick={() => { uiState.crackedModifierValue = 0.25; }}
              >0.25</button>
              <button
                class="flex-1 py-0.5 rounded text-[9px] font-semibold transition-colors border cursor-pointer text-center {uiState.crackedModifierValue === 0.50 ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-700/50 border-slate-600 text-slate-300 hover:bg-slate-700'}"
                onclick={() => { uiState.crackedModifierValue = 0.50; }}
              >0.50</button>
            </div>
            <div class="flex items-center gap-1.5 mt-0.5">
              <input
                type="range"
                min="0.10"
                max="0.90"
                step="0.05"
                bind:value={uiState.crackedModifierValue}
                class="w-full accent-indigo-500 cursor-pointer h-1 bg-slate-700 rounded-lg appearance-none"
              />
            </div>
          </div>
        {:else}
          <div class="text-[9px] text-slate-500 border-t border-slate-700/50 pt-2">
            Effective inertia is uncracked (I = Ig, modifier = 1.0).
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="absolute right-3 bottom-3 pointer-events-auto z-10">
    <InsightPanel />
  </div>

  <div class="absolute left-1/2 -translate-x-1/2 top-3 pointer-events-none z-20 flex gap-2">
    <div class="pointer-events-auto flex rounded-lg overflow-hidden border border-[#333333] shadow-lg">
      <button
        class="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer {uiState.viewMode === '2d' ? 'bg-[#D62430] text-white' : 'bg-[#1a1a1a] text-[#ffffff] hover:bg-[#333333]'}"
        onclick={() => uiState.viewMode = '2d'}
      >Plan</button>
      <button
        class="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer {uiState.viewMode === '3d' ? 'bg-[#D62430] text-white' : 'bg-[#1a1a1a] text-[#ffffff] hover:bg-[#333333]'}"
        onclick={() => uiState.viewMode = '3d'}
      >3D</button>
    </div>

    {#if femState.hasResults}
      <div class="pointer-events-auto flex rounded-lg overflow-hidden border border-[#333333] shadow-lg">
        <button
          class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all duration-200 cursor-pointer text-center
            {femState.showFEMContour && femState.resultType === 'deflection'
              ? 'bg-[#D62430] text-white'
              : 'bg-[#1a1a1a] text-[#ffffff] hover:bg-[#333333]'}"
          onclick={() => {
            if (femState.resultType === 'deflection') {
              femState.showFEMContour = !femState.showFEMContour;
            } else {
              femState.resultType = 'deflection';
              femState.showFEMContour = true;
            }
          }}
        >
          Deflection (mm)
        </button>
      </div>
    {/if}

    {#if uiState.viewMode === '3d' && model.planImage}
      <div class="pointer-events-auto flex rounded-lg overflow-hidden border border-[#333333] shadow-lg">
        <button
          class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer {uiState.show3DPlanOverlay ? 'bg-[#D62430] text-white' : 'bg-[#1a1a1a] text-[#ffffff] hover:bg-[#333333]'}"
          onclick={() => uiState.show3DPlanOverlay = !uiState.show3DPlanOverlay}
        >
          {uiState.show3DPlanOverlay ? 'Hide Tracing Plan' : 'Show Tracing Plan'}
        </button>
      </div>
    {/if}
  </div>
</div>

<svelte:window 
  onkeydown={(e) => { 
    if (e.key === 'Escape') {
      if (uiState.showExportDialog) uiState.showExportDialog = false;
      if (uiState.showParametricStudyDialog) uiState.showParametricStudyDialog = false;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); model.saveToFile(); } 
  }} 
  onresize={handleResize}
/>

{#if uiState.showCalibrationDialog && uiState.calibrationPendingData}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={() => { uiState.showCalibrationDialog = false; uiState.calibrationPendingData = null; }}
  >
    <div
      class="rounded-lg bg-[#1a1a1a] border border-[#333333] p-5 shadow-xl w-72"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="text-sm font-bold text-[#ffffff] mb-3">Calibration</div>
      <div class="text-xs text-[#ffffff] mb-3">Enter the actual distance between the two points you placed (in meters):</div>
      <form onsubmit={(e) => { e.preventDefault(); submitCalibration(); }} class="flex flex-col gap-3">
        <input
          type="number"
          step="any"
          min="0.001"
          bind:value={calibDistance}
          autofocus
          class="w-full rounded bg-[#333333] px-3 py-2 text-sm text-white border border-[#444444] focus:border-[#D62430] focus:outline-none"
          placeholder="Distance (m)"
        />
        <div class="flex gap-2">
          <button
            type="submit"
            class="flex-1 rounded bg-[#D62430] py-2 text-sm text-white hover:bg-[#B01E28] transition-colors"
          >Apply</button>
          <button
            type="button"
            onclick={() => { uiState.showCalibrationDialog = false; uiState.calibrationPendingData = null; }}
            class="flex-1 rounded bg-[#333333] py-2 text-sm text-white hover:bg-[#444444] transition-colors"
          >Cancel</button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if uiState.showExportDialog}
  <ExportDialog />
{/if}

{#if uiState.showParametricStudyDialog}
  <ParametricStudyDialog />
{/if}

{#if uiState.showParametricLivePanel}
  <ParametricLivePanel />
{/if}

{#if femState.isComputing}
  <div class="fem-progress-panel fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-[#333333] bg-[#141414] p-4 shadow-2xl flex items-center gap-3 text-left pointer-events-auto">
    <!-- Premium Spinner -->
    <div class="relative w-8 h-8 shrink-0">
      <div class="absolute inset-0 rounded-full border-3 border-[#222222]"></div>
      <div class="absolute inset-0 rounded-full border-3 border-t-[#D62430] animate-spin"></div>
    </div>
    <div class="flex-1 flex flex-col gap-0.5 overflow-hidden">
      <div class="text-[10px] font-bold text-white uppercase tracking-wider">Solving FEM Model</div>
      {#if femState.progress > 0}
        <div class="w-full flex items-center gap-1.5 mt-0.5">
          <div class="flex-1 h-1 rounded-full bg-[#222222] overflow-hidden">
            <div class="h-full bg-[#D62430] transition-all duration-300" style="width: {femState.progress * 100}%"></div>
          </div>
          <span class="text-[8px] font-mono text-slate-500 shrink-0">{(femState.progress * 100).toFixed(0)}%</span>
        </div>
      {:else}
        <div class="text-[9px] text-slate-400 truncate">Running analysis equations...</div>
      {/if}
    </div>
  </div>
{/if}

{#if femState.error}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div class="w-96 rounded-xl border border-red-950 bg-[#161011] p-6 shadow-2xl flex flex-col gap-4 text-center items-center">
      <!-- Warning Icon -->
      <div class="w-12 h-12 rounded-full bg-red-950/50 flex items-center justify-center border border-red-800 text-red-500">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <div class="flex flex-col gap-2 w-full">
        <div class="text-xs font-bold text-red-400 uppercase tracking-wider">Analysis Failed</div>
        <div class="text-[10px] text-slate-300 leading-relaxed font-medium bg-[#0f0a0a] p-3 rounded-lg border border-red-950/50 text-left max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
          {femState.error}
        </div>
      </div>
      <button
        onclick={() => { femState.error = null; }}
        class="w-full rounded bg-[#D62430] py-2 text-xs font-bold uppercase tracking-wider text-white hover:bg-[#B01E28] transition-colors cursor-pointer border border-[#D62430]"
      >
        Dismiss
      </button>
    </div>
  </div>
{/if}
