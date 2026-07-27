<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { model } from '../stores/structuralModel.svelte';
  import { uiState } from '../stores/uiState.svelte';
  import { femState } from '../stores/femResults.svelte';
  import { drawBackground, drawPlanImage, drawGrid, drawAxes, drawSlabs, drawColumn, drawColumnSelected, drawColumnDisconnected, drawShearWall, drawShearWallSelected, drawShearWallDisconnected, drawPolylineWall, drawPolylineWallSelected, drawNonStructuralWall, drawNonStructuralWallSelected, drawNonStructuralPolylineWall, drawNonStructuralPolylineWallSelected, drawNonStructuralWallPreview, drawBeam, drawBeamSelected, drawDropPanel, drawDropPanelSelected, drawDropPanelPreview, drawCMmarker, drawCRmarker, drawEccentricityVector, drawCalibrationLine, drawColumnPreview, drawWallPreview, drawBeamPreview, drawSelectionRect, drawDimensionLabel, drawMeasureLine, drawDimensions, drawFEMContour, drawFEMMesh, drawColorLegend, drawDeformedShape, sampleFEMResultAtPoint, drawPunchingMarkers, drawSnapCoordinateLabel, drawElementLabels, drawUnconnectedJointNode } from '../canvas/renderer';
  import { hitTestColumns, hitTestWalls, hitTestPolylineWalls, hitTestNonStructuralWalls, hitTestPolylineNonStructuralWalls, hitTestBeams, hitTestSlabs, hitTestDropPanels, hitTestDimensions } from '../canvas/hitTester';
  import { distance, pointInPolygon, pointToSegmentDistance, computeGlobalMetrics } from '../engine/mathEngine';
  import { floorLayers } from '../stores/floorLayers.svelte';
  import { loadPlanFile, loadPDFPages } from '../imageUploader';
  import type { Point2D } from '../engine/types';

  let canvasEl: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let containerEl: HTMLDivElement;
  let width = $state(800);
  let height = $state(600);
  let animId: number;
  let cursorValue = $state<{ x: number; y: number; text: string } | null>(null);
  let dirty = true;

  // ─── Cached expensive computations (only recompute when model changes, not every frame) ───
  let _cachedUnconnectedJoints: { x: number; y: number; elementId: string }[] = [];
  let _cachedMetrics: { cm: { x: number; y: number }; cr: { x: number; y: number }; ex: number; ey: number } | null = null;
  let _metricsGen = 0;
  let _jointsGen = 0;
  let _modelGen = 0;

  function bumpModelGen() { _modelGen++; }

  // ─── P1: Cache joint positions (data, not canvas) — drawn with theme color each frame ───
  interface JointDot { x: number; y: number; }
  interface JointDiamond { x: number; y: number; }
  let _cachedDots: JointDot[] = [];
  let _cachedDiamonds: JointDiamond[] = [];
  let _jointDataKey = '';

  function buildJointData(): void {
    const key = `${_modelGen}`;
    if (_jointDataKey === key) return;
    _jointDataKey = key;

    const dots: JointDot[] = [];
    const diamonds: JointDiamond[] = [];
    const mid = (a: Point2D, b: Point2D) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    for (const c of model.columns) dots.push({ x: c.position.x, y: c.position.y });
    for (const w of model.walls) {
      dots.push({ x: w.startPoint.x, y: w.startPoint.y });
      dots.push({ x: w.endPoint.x, y: w.endPoint.y });
      const m = mid(w.startPoint, w.endPoint);
      diamonds.push({ x: m.x, y: m.y });
    }
    for (const pw of model.polylineWalls) {
      for (const v of pw.vertices) dots.push({ x: v.x, y: v.y });
      for (let i = 0; i < pw.vertices.length - 1; i++) { const m = mid(pw.vertices[i], pw.vertices[i + 1]); diamonds.push({ x: m.x, y: m.y }); }
    }
    for (const b of model.beams) {
      dots.push({ x: b.startPoint.x, y: b.startPoint.y });
      dots.push({ x: b.endPoint.x, y: b.endPoint.y });
      const mb = mid(b.startPoint, b.endPoint);
      diamonds.push({ x: mb.x, y: mb.y });
    }
    for (const slab of model.slabs) {
      for (const v of slab.vertices) dots.push({ x: v.x, y: v.y });
      for (let i = 0; i < slab.vertices.length; i++) { const m = mid(slab.vertices[i], slab.vertices[(i + 1) % slab.vertices.length]); diamonds.push({ x: m.x, y: m.y }); }
      for (const hole of slab.holes) for (let i = 0; i < hole.length; i++) { const m = mid(hole[i], hole[(i + 1) % hole.length]); diamonds.push({ x: m.x, y: m.y }); }
    }
    for (const dp of model.dropPanels) {
      for (let i = 0; i < dp.vertices.length; i++) { const m = mid(dp.vertices[i], dp.vertices[(i + 1) % dp.vertices.length]); diamonds.push({ x: m.x, y: m.y }); }
    }

    _cachedDots = dots;
    _cachedDiamonds = diamonds;
  }

  function drawJointCache(ctx2: CanvasRenderingContext2D): void {
    const isLight = uiState.theme === 'light';
    const dotColor = isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.6)';
    const jointRadius = 0.06;
    const midRadius = 0.04;

    ctx2.fillStyle = dotColor;
    for (const d of _cachedDots) { ctx2.beginPath(); ctx2.arc(d.x, d.y, jointRadius, 0, Math.PI * 2); ctx2.fill(); }
    for (const d of _cachedDiamonds) {
      ctx2.save(); ctx2.translate(d.x, d.y); ctx2.rotate(Math.PI / 4);
      ctx2.fillRect(-midRadius, -midRadius, midRadius * 2, midRadius * 2);
      ctx2.restore();
    }
  }

  function getCachedUnconnectedJoints(): { x: number; y: number; elementId: string }[] {
    if (_jointsGen === _modelGen) return _cachedUnconnectedJoints;
    _jointsGen = _modelGen;
    _cachedUnconnectedJoints = getUnconnectedJoints(model);
    return _cachedUnconnectedJoints;
  }

  function getCachedMetrics() {
    if (_metricsGen === _modelGen && _cachedMetrics) return _cachedMetrics;
    _metricsGen = _modelGen;
    _cachedMetrics = computeGlobalMetrics(model.slabs, model.columns, model.walls, model.polylineWalls, model.beams, model.dropPanels, undefined, 0.25, model.nonStructuralWalls, model.polylineNonStructuralWalls);
    return _cachedMetrics;
  }

  $effect(() => {
    model.columns;
    model.beams;
    model.walls;
    model.polylineWalls;
    model.slabs;
    model.dropPanels;
    model.nonStructuralWalls;
    model.polylineNonStructuralWalls;
    model.dimensions;
    model.canvasZoom;
    model.canvasViewOffsetX;
    model.canvasViewOffsetY;
    model.hiddenElementIds;
    uiState.selectedElementIds;
    uiState.selectedHoleIndex;
    uiState.showSlabs;
    uiState.showColumns;
    uiState.showWalls;
    uiState.showBeams;
    uiState.showDropPanels;
    uiState.showNonStructuralWalls;
    femState.slabResults;
    femState.resultType;
    femState.deformedScale;
    floorLayers.layers;
    floorLayers.activeLayerId;
    model.planImage;
    model.pixelsPerMeter;
    bumpModelGen();
    dirty = true;
  });

  interface JointNode {
    x: number;
    y: number;
    elementId: string;
    type: string;
  }

  function getUnconnectedJoints(model: any): { x: number; y: number; elementId: string }[] {
    const joints: JointNode[] = [];
    
    // 1. Columns
    for (const c of model.columns) {
      if (model.isHidden(c.id)) continue;
      joints.push({ x: c.position.x, y: c.position.y, elementId: c.id, type: 'column' });
    }
    
    // 2. Beams
    for (const b of model.beams) {
      if (model.isHidden(b.id)) continue;
      joints.push({ x: b.startPoint.x, y: b.startPoint.y, elementId: b.id, type: 'beam_start' });
      joints.push({ x: b.endPoint.x, y: b.endPoint.y, elementId: b.id, type: 'beam_end' });
    }
    
    // 3. Walls
    for (const w of model.walls) {
      if (model.isHidden(w.id)) continue;
      joints.push({ x: w.startPoint.x, y: w.startPoint.y, elementId: w.id, type: 'wall_start' });
      joints.push({ x: w.endPoint.x, y: w.endPoint.y, elementId: w.id, type: 'wall_end' });
    }
    
    // 4. Polyline walls
    for (const pw of model.polylineWalls) {
      if (model.isHidden(pw.id)) continue;
      for (let i = 0; i < pw.vertices.length; i++) {
        joints.push({ x: pw.vertices[i].x, y: pw.vertices[i].y, elementId: pw.id, type: `polyline_wall_vertex_${i}` });
      }
    }

    const unconnected: { x: number; y: number; elementId: string }[] = [];
    const TOL = 0.05; // 5 cm tolerance

    for (let i = 0; i < joints.length; i++) {
      const j1 = joints[i];
      let connected = false;

      // Check if joint is inside or near any slab polygon
      for (const s of model.slabs) {
        if (model.isHidden(s.id)) continue;
        if (s.vertices && s.vertices.length >= 3) {
          if (pointInPolygon({ x: j1.x, y: j1.y }, s.vertices)) {
            connected = true;
            break;
          }
          for (let v = 0; v < s.vertices.length; v++) {
            const v1 = s.vertices[v];
            const v2 = s.vertices[(v + 1) % s.vertices.length];
            if (pointToSegmentDistance({ x: j1.x, y: j1.y }, v1, v2) < 0.20) {
              connected = true;
              break;
            }
          }
          if (connected) break;
        }
      }

      if (!connected) {
        for (let k = 0; k < joints.length; k++) {
          if (i === k) continue;
          const j2 = joints[k];
          if (j1.elementId !== j2.elementId) {
            const dist = Math.hypot(j1.x - j2.x, j1.y - j2.y);
            if (dist < TOL) {
              connected = true;
              break;
            }
          }
        }
      }

      if (!connected) {
        unconnected.push({ x: j1.x, y: j1.y, elementId: j1.elementId });
      }
    }
    return unconnected;
  }

  function drawImageTinted(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement | ImageBitmap, tintColor: string, opacity: number) {
    if (tintColor === 'none' || !tintColor) {
      ctx.globalAlpha = opacity;
      ctx.drawImage(img, 0, 0);
      return;
    }
    const colorMap: Record<string, string> = {
      cyan: '#00FFFF',
      magenta: '#FF00FF',
      yellow: '#FFFF00',
      green: '#00FF00',
      red: '#FF0000'
    };
    const fillStyleColor = colorMap[tintColor] || tintColor;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    const tCtx = tempCanvas.getContext('2d')!;

    tCtx.drawImage(img, 0, 0);
    tCtx.globalCompositeOperation = 'source-atop';
    tCtx.fillStyle = fillStyleColor;
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    ctx.globalAlpha = opacity;
    ctx.drawImage(tempCanvas, 0, 0);
  }

  type LocalDragState =
    | { type: 'idle' }
    | { type: 'pendingColumn'; id: string; offset: Point2D; startScreen: Point2D }
    | { type: 'pendingWall'; id: string; hitType: 'wallStart' | 'wallEnd' | 'wallMid'; offset: Point2D; startScreen: Point2D }
    | { type: 'pendingBeam'; id: string; hitType: 'beamStart' | 'beamEnd' | 'beamMid'; offset: Point2D; startScreen: Point2D }
    | { type: 'pendingSlab'; id: string; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingSlabVertex'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingSlabEdge'; id: string; edgeIndex: number; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingSlabHole'; id: string; holeIndex: number; startMouse: Point2D; startHoleVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingSlabHoleEdge'; id: string; holeIndex: number; edgeIndex: number; startMouse: Point2D; startHoleVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingSlabHoleVertex'; id: string; holeIndex: number; vertexIndex: number; startMouse: Point2D; startHoleVerts: Point2D[]; startScreen: Point2D }
    | { type: 'draggingColumn'; id: string; offset: Point2D; historyPushed: boolean }
    | { type: 'draggingWallBody'; id: string; offset: Point2D; historyPushed: boolean }
    | { type: 'draggingWallStart'; id: string; historyPushed: boolean }
    | { type: 'draggingWallEnd'; id: string; historyPushed: boolean }
    | { type: 'draggingBeamBody'; id: string; offset: Point2D; historyPushed: boolean }
    | { type: 'draggingBeamStart'; id: string; historyPushed: boolean }
    | { type: 'draggingBeamEnd'; id: string; historyPushed: boolean }
    | { type: 'pendingPolylineWallVertex'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'draggingPolylineWallVertex'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingSlab'; id: string; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingSlabVertex'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingSlabEdge'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingSlabHole'; id: string; holeIndex: number; startMouse: Point2D; startHoleVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingSlabHoleEdge'; id: string; holeIndex: number; vertexIndex: number; startMouse: Point2D; startHoleVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingSlabHoleVertex'; id: string; holeIndex: number; vertexIndex: number; startMouse: Point2D; startHoleVerts: Point2D[]; historyPushed: boolean }
    | { type: 'measuring'; point1Screen: Point2D; point1World: Point2D }
    | { type: 'drawingWall'; start: Point2D }
    | { type: 'drawingWallPolyline'; verts: Point2D[] }
    | { type: 'drawingNonStructuralWall'; start: Point2D }
    | { type: 'drawingNonStructuralWallPolyline'; verts: Point2D[] }
    | { type: 'drawingBeam'; start: Point2D }
    | { type: 'drawingSlabRect'; start: Point2D }
    | { type: 'drawingHoleRect'; slabId: string; start: Point2D }
    | { type: 'tracingSlab'; verts: Point2D[] }
    | { type: 'tracingHole'; slabId: string; verts: Point2D[] }
    | { type: 'pendingDropPanel'; id: string; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingDropPanelVertex'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'pendingDropPanelEdge'; id: string; edgeIndex: number; startMouse: Point2D; startVerts: Point2D[]; startScreen: Point2D }
    | { type: 'draggingDropPanel'; id: string; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingDropPanelVertex'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'draggingDropPanelEdge'; id: string; vertexIndex: number; startMouse: Point2D; startVerts: Point2D[]; historyPushed: boolean }
    | { type: 'panning'; last: Point2D }
    | { type: 'selectingRect'; startScreen: Point2D; startWorld: Point2D }
    | { type: 'pendingMulti'; startScreen: Point2D; startWorld: Point2D }
    | { type: 'draggingMulti'; startWorld: Point2D; historyPushed: boolean };

  let localDrag: LocalDragState = { type: 'idle' };
  let savedDrag: LocalDragState | null = null;
  let multiDragOriginals = new Map<string, any>();
  let mouseWorld = $state<Point2D>({ x: 0, y: 0 });
  let mouseScreen = $state<Point2D>({ x: 0, y: 0 });
  let selectionRectEnd = $state<Point2D | null>(null);
  let isSnapped = $state(false);
  let snapPoint = $state<Point2D | null>(null);
  let snapTypeName = $state<string | null>(null);
  const DRAG_THRESHOLD_PX = 5;
  let hiddenIds = $derived(new Set(model.hiddenElementIds));
  let lockedIds = $derived(new Set(model.lockedElementIds));
  let blockedIds = $derived(new Set([...model.hiddenElementIds, ...model.lockedElementIds]));

  function isDrawingType(t: LocalDragState): boolean {
    return t.type === 'drawingWall' || t.type === 'drawingWallPolyline' || t.type === 'drawingNonStructuralWall' || t.type === 'drawingNonStructuralWallPolyline' || t.type === 'drawingBeam' ||
      t.type === 'drawingSlabRect' || t.type === 'drawingHoleRect' ||
      t.type === 'tracingSlab' || t.type === 'tracingHole' ||
      t.type === 'measuring';
  }

  $effect(() => {
    uiState.isDrawing = isDrawingType(localDrag);
  });

  $effect(() => {
    uiState.cancelDrawing = () => {
      if (localDrag.type === 'drawingWall' || localDrag.type === 'drawingWallPolyline' ||
          localDrag.type === 'drawingNonStructuralWall' || localDrag.type === 'drawingNonStructuralWallPolyline' ||
          localDrag.type === 'drawingBeam' || localDrag.type === 'drawingSlabRect' ||
          localDrag.type === 'drawingHoleRect' || localDrag.type === 'tracingSlab' ||
          localDrag.type === 'tracingHole' || localDrag.type === 'measuring') {
        localDrag = { type: 'idle' };
        canvasEl.style.cursor = 'default';
        uiState.setStatusMessage('Drawing cancelled');
      }
    };
  });

  function screenToWorld(sx: number, sy: number): Point2D {
    const ppm = model.pixelsPerMeter;
    const z = model.canvasZoom;
    if (ppm < 0.001 || z < 0.001) return { x: 0, y: 0 };
    return {
      x: (sx - model.canvasViewOffsetX) / (ppm * z),
      y: -(sy - model.canvasViewOffsetY) / (ppm * z),
    };
  }

  function worldToScreen(wx: number, wy: number): Point2D {
    const ppm = model.pixelsPerMeter;
    const z = model.canvasZoom;
    return {
      x: wx * ppm * z + model.canvasViewOffsetX,
      y: -wy * ppm * z + model.canvasViewOffsetY,
    };
  }

  function isSelected(id: string): boolean {
    return uiState.isSelected(id);
  }

  let shiftHeld = $state(false);
  let contextHoleInfo: { slabId: string; holeIndex: number } | null = $state(null);
  let canvasDragFileOver = $state(false);
  let lastMouseEvent: MouseEvent | null = null;

  function orthoPoint(start: Point2D, mouse: Point2D, shift: boolean): Point2D {
    if (!shift) return { ...mouse };
    const dx = mouse.x - start.x;
    const dy = mouse.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { ...mouse };
    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4; // 45-degree angle snapping (0°, 45°, 90°, 135°, 180°, etc.)
    const snappedAngle = Math.round(angle / step) * step;
    return {
      x: start.x + dist * Math.cos(snappedAngle),
      y: start.y + dist * Math.sin(snappedAngle)
    };
  }

  function orthoVector(dx: number, dy: number, shift: boolean): { dx: number; dy: number } {
    if (!shift) return { dx, dy };
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { dx, dy };
    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4; // 45-degree angle snapping
    const snappedAngle = Math.round(angle / step) * step;
    return {
      dx: dist * Math.cos(snappedAngle),
      dy: dist * Math.sin(snappedAngle)
    };
  }

  // --- Snap geometry helpers (AutoCAD-style) ---

  /** Closest point on line segment AB to point P */
  function closestPointOnSegment(p: Point2D, a: Point2D, b: Point2D): Point2D {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return { ...a };
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return { x: a.x + t * dx, y: a.y + t * dy };
  }

  /** Intersection of two line segments. Returns null if parallel or don't intersect within segment bounds. */
  function segmentIntersection(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null {
    const dax = a2.x - a1.x, day = a2.y - a1.y;
    const dbx = b2.x - b1.x, dby = b2.y - b1.y;
    const denom = dax * dby - day * dbx;
    if (Math.abs(denom) < 1e-12) return null;
    const inv = 1 / denom;
    const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) * inv;
    const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) * inv;
    if (t < 1e-6 || t > 1 - 1e-6 || u < 1e-6 || u > 1 - 1e-6) return null; // at endpoint — handled by endpoint snap
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { x: a1.x + t * dax, y: a1.y + t * day };
    }
    return null;
  }

  // ─── Cached snap geometry (P2): rebuild only when model changes, not per frame ───
  let _cachedEdges: { a: Point2D; b: Point2D }[] = [];
  let _cachedEndpoints: Point2D[] = [];
  let _snapGen = -1;

  function ensureSnapCache(): void {
    if (_snapGen === _modelGen) return;
    _snapGen = _modelGen;
    _cachedEdges = buildAllEdges();
    _cachedEndpoints = buildAllEndpoints();
  }

  /** Collect all edges from model elements + active drag vertices */
  function buildAllEdges(): { a: Point2D; b: Point2D }[] {
    const edges: { a: Point2D; b: Point2D }[] = [];
    for (const wall of model.walls) { if (hiddenIds.has(wall.id)) continue; edges.push({ a: wall.startPoint, b: wall.endPoint }); }
    for (const pwall of model.polylineWalls) {
      if (hiddenIds.has(pwall.id)) continue;
      for (let i = 0; i < pwall.vertices.length - 1; i++)
        edges.push({ a: pwall.vertices[i], b: pwall.vertices[i + 1] });
    }
    for (const beam of model.beams) { if (hiddenIds.has(beam.id)) continue; edges.push({ a: beam.startPoint, b: beam.endPoint }); }
    for (const slab of model.slabs) {
      if (hiddenIds.has(slab.id)) continue;
      for (let i = 0; i < slab.vertices.length; i++)
        edges.push({ a: slab.vertices[i], b: slab.vertices[(i + 1) % slab.vertices.length] });
      for (const hole of slab.holes)
        for (let i = 0; i < hole.length; i++)
          edges.push({ a: hole[i], b: hole[(i + 1) % hole.length] });
    }
    for (const nsw of model.nonStructuralWalls) {
      if (hiddenIds.has(nsw.id)) continue;
      edges.push({ a: nsw.startPoint, b: nsw.endPoint });
    }
    for (const pnsw of model.polylineNonStructuralWalls) {
      if (hiddenIds.has(pnsw.id)) continue;
      for (let i = 0; i < pnsw.vertices.length - 1; i++)
        edges.push({ a: pnsw.vertices[i], b: pnsw.vertices[i + 1] });
    }
    for (const dp of model.dropPanels) {
      if (hiddenIds.has(dp.id)) continue;
      for (let i = 0; i < dp.vertices.length; i++)
        edges.push({ a: dp.vertices[i], b: dp.vertices[(i + 1) % dp.vertices.length] });
    }
    if (localDrag) {
      if ((localDrag.type === 'tracingSlab' || localDrag.type === 'tracingHole') && localDrag.verts.length > 1) {
        for (let i = 0; i < localDrag.verts.length - 1; i++)
          edges.push({ a: localDrag.verts[i], b: localDrag.verts[i + 1] });
      } else if ((localDrag.type === 'drawingWallPolyline' || localDrag.type === 'drawingNonStructuralWallPolyline') && localDrag.verts.length > 1) {
        for (let i = 0; i < localDrag.verts.length - 1; i++)
          edges.push({ a: localDrag.verts[i], b: localDrag.verts[i + 1] });
      }
    }
    return edges;
  }

  /** Collect all endpoint candidates from model + active drag */
  function buildAllEndpoints(): Point2D[] {
    const pts: Point2D[] = [];
    for (const col of model.columns) { if (!hiddenIds.has(col.id)) pts.push(col.position); }
    for (const wall of model.walls) { if (!hiddenIds.has(wall.id)) { pts.push(wall.startPoint); pts.push(wall.endPoint); } }
    for (const pwall of model.polylineWalls) { if (!hiddenIds.has(pwall.id)) { for (const v of pwall.vertices) pts.push(v); } }
    for (const beam of model.beams) { if (!hiddenIds.has(beam.id)) { pts.push(beam.startPoint); pts.push(beam.endPoint); } }
    for (const slab of model.slabs) {
      if (hiddenIds.has(slab.id)) continue;
      for (const v of slab.vertices) pts.push(v);
      for (const hole of slab.holes) for (const v of hole) pts.push(v);
    }
    for (const nsw of model.nonStructuralWalls) { if (!hiddenIds.has(nsw.id)) { pts.push(nsw.startPoint); pts.push(nsw.endPoint); } }
    for (const pnsw of model.polylineNonStructuralWalls) { if (!hiddenIds.has(pnsw.id)) { for (const v of pnsw.vertices) pts.push(v); } }
    for (const dp of model.dropPanels) { if (!hiddenIds.has(dp.id)) { for (const v of dp.vertices) pts.push(v); } }
    if (localDrag) {
      if ((localDrag.type === 'tracingSlab' || localDrag.type === 'tracingHole') && localDrag.verts.length > 1) {
        for (const v of localDrag.verts) pts.push(v);
      } else if ((localDrag.type === 'drawingWallPolyline' || localDrag.type === 'drawingNonStructuralWallPolyline') && localDrag.verts.length > 1) {
        for (const v of localDrag.verts) pts.push(v);
      }
    }
    return pts;
  }

  function getSnappedPoint(mouse: Point2D, start?: Point2D, applyOrtho = false, snapTolerance = 0.35): Point2D {
    snapTypeName = null;
    let bestSnap: Point2D = { ...mouse };
    let minDist = snapTolerance;
    let snapped = false;

    // Use cached snap geometry (rebuilt only when model changes, not per frame)
    ensureSnapCache();
    const endpoints = _cachedEndpoints;
    const edges = _cachedEdges;

    // Priority 1: Endpoint snap
    for (const ep of endpoints) {
      const d = distance(mouse, ep);
      if (d < minDist) { minDist = d; bestSnap = { ...ep }; snapTypeName = 'Endpoint'; snapped = true; }
    }

    // Priority 2: Midpoint snap (only if not already closer to an endpoint)
    for (const edge of edges) {
      const mid = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
      const d = distance(mouse, mid);
      if (d < minDist) { minDist = d; bestSnap = mid; snapTypeName = 'Midpoint'; snapped = true; }
    }

    // Priority 3: Intersection snap (with spatial bounding-box filter for high performance)
    if (edges.length < 300) {
      const SEARCH_R = 2.5; // 2.5m spatial bounding box
      for (let i = 0; i < edges.length; i++) {
        const e1 = edges[i];
        const m1x = (e1.a.x + e1.b.x) / 2, m1y = (e1.a.y + e1.b.y) / 2;
        if (Math.abs(m1x - mouse.x) > SEARCH_R || Math.abs(m1y - mouse.y) > SEARCH_R) continue;
        for (let j = i + 1; j < edges.length; j++) {
          const e2 = edges[j];
          const m2x = (e2.a.x + e2.b.x) / 2, m2y = (e2.a.y + e2.b.y) / 2;
          if (Math.abs(m2x - mouse.x) > SEARCH_R || Math.abs(m2y - mouse.y) > SEARCH_R) continue;
          const inter = segmentIntersection(e1.a, e1.b, e2.a, e2.b);
          if (inter) {
            const d = distance(mouse, inter);
            if (d < minDist) { minDist = d; bestSnap = { ...inter }; snapTypeName = 'Intersection'; snapped = true; }
          }
        }
      }
    }

    // Priority 4: Nearest-on-edge snap (fallback — closest point on any edge)
    if (!snapped) {
      for (const edge of edges) {
        const nearest = closestPointOnSegment(mouse, edge.a, edge.b);
        const d = distance(mouse, nearest);
        if (d < minDist) { minDist = d; bestSnap = { ...nearest }; snapTypeName = 'Nearest'; snapped = true; }
      }
    }

    // Priority 5: Grid snap (if enabled) — always applies, no tolerance gate
    if (uiState.snapToGrid && uiState.gridSize > 0) {
      const gs = uiState.gridSize;
      const gridX = Math.round(mouse.x / gs) * gs;
      const gridY = Math.round(mouse.y / gs) * gs;
      const dGrid = distance(mouse, { x: gridX, y: gridY });
      if (!snapped || dGrid < minDist) {
        minDist = dGrid; bestSnap = { x: gridX, y: gridY }; snapTypeName = 'Grid'; snapped = true;
      }
    }

    // Apply ortho constraint AFTER grid snap (overrides snapped point with orthogonal projection)
    if (applyOrtho && start) {
      bestSnap = orthoPoint(start, bestSnap, true);
      snapTypeName = snapTypeName ? snapTypeName + ' (Ortho)' : 'Ortho';
    }

    isSnapped = snapped;
    snapPoint = snapped ? { ...bestSnap } : null;
    uiState.snappedPoint = { x: bestSnap.x, y: bestSnap.y, active: snapped };

    return bestSnap;
  }

  function handleEscape(): void {
    if (localDrag.type === 'measuring') {
      localDrag = { type: 'idle' };
      uiState.setStatusMessage('Measurement cancelled');
      return;
    }
    if (localDrag.type !== 'idle') {
      localDrag = { type: 'idle' };
      canvasEl.style.cursor = 'default';
      selectionRectEnd = null;
    }
    uiState.setSelectedElements([]);
    uiState.selectElement(null, null);
    uiState.selectedHoleIndex = null;
    uiState.setTool('select');
    uiState.setCalibrationPoint1(null);
    uiState.setStatusMessage('Ready');
  }

  function render(): void {
    try {
    if (!ctx) { animId = requestAnimationFrame(render); return; }
    if (!dirty) { animId = requestAnimationFrame(render); return; }
    dirty = false;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    drawBackground(ctx, W, H);
    isSnapped = false;
    snapPoint = null;

    const ppm = model.pixelsPerMeter;
    const z = model.canvasZoom;
    const ox = model.canvasViewOffsetX;
    const oy = model.canvasViewOffsetY;

    // Render base floor plan and overlays
    if (model.planImage) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      
      // 1. Draw the active base layer
      ctx.globalAlpha = 0.35;
      ctx.drawImage(model.planImage, ox, oy, model.imageNaturalWidth * z, model.imageNaturalHeight * z);
      ctx.globalAlpha = 1;

      // 2. Draw other visible floor layers as overlays
      for (const layer of floorLayers.layers) {
        if (layer.visible && layer.id !== floorLayers.activeLayerId) {
          ctx.save();
          // Position relative to base plan screen coordinates
          ctx.translate(ox, oy);
          ctx.scale(z, z);
          
          // Apply overlay translation, rotation, and scaling
          ctx.translate(layer.offset.x, layer.offset.y);
          ctx.rotate(layer.rotation);
          ctx.scale(layer.scale, layer.scale);

          // Draw the image with selected opacity and color tint
          drawImageTinted(ctx, layer.image, layer.colorTint, layer.opacity);

          ctx.restore();
        }
      }
      ctx.restore();
    }

    // Render alignment wizard indicators (in screen coordinates)
    if (floorLayers.alignmentState && floorLayers.alignmentState.active) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      
      const drawMarker = (pt: { x: number; y: number }, label: string, color: string) => {
        const sx = ox + pt.x * z;
        const sy = oy + pt.y * z;
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = uiState.theme === 'light' ? '#000000' : '#FFFFFF';
        ctx.shadowColor = '#000000';
        ctx.shadowBlur = 4;
        ctx.fillText(label, sx + 12, sy + 3);
        ctx.shadowBlur = 0;
      };

      const state = floorLayers.alignmentState;
      const layer = floorLayers.layers.find(l => l.id === state.layerId);

      if (state.base1) drawMarker(state.base1, 'Base Pt 1', '#3B82F6');
      if (state.base2) drawMarker(state.base2, 'Base Pt 2', '#3B82F6');

      if (layer) {
        if (state.overlay1) {
          // Re-map overlay image coordinate back to base image coordinate space to draw it
          const cos = Math.cos(layer.rotation);
          const sin = Math.sin(layer.rotation);
          const scaledX = state.overlay1.x * layer.scale;
          const scaledY = state.overlay1.y * layer.scale;
          const mapX = layer.offset.x + (scaledX * cos - scaledY * sin);
          const mapY = layer.offset.y + (scaledX * sin + scaledY * cos);
          drawMarker({ x: mapX, y: mapY }, 'Overlay Pt 1', '#EC4899');
        }
        if (state.overlay2) {
          const cos = Math.cos(layer.rotation);
          const sin = Math.sin(layer.rotation);
          const scaledX = state.overlay2.x * layer.scale;
          const scaledY = state.overlay2.y * layer.scale;
          const mapX = layer.offset.x + (scaledX * cos - scaledY * sin);
          const mapY = layer.offset.y + (scaledX * sin + scaledY * cos);
          drawMarker({ x: mapX, y: mapY }, 'Overlay Pt 2', '#EC4899');
        }
      }
      ctx.restore();
    }

    ctx.setTransform(ppm * z, 0, 0, -ppm * z, ox, oy);

    if (uiState.showGrid) {
      drawGrid(ctx, uiState.gridSize);
    }
    drawAxes(ctx);

    if (uiState.showSlabs && model.slabs.length > 0) {
      const activeHoleIdx = (uiState.selectedElementType === 'opening' && uiState.selectedElementId)
        ? uiState.selectedHoleIndex
        : null;
      drawSlabs(ctx, model.slabs.filter(s => !model.isHidden(s.id)), uiState.selectedElementIds, activeHoleIdx, uiState.vertexEditTarget);
    }

    // FEM Contour overlay (after slab base, before support elements)
    if (femState.showFEMContour && femState.hasResults) {
      // P3: use derived contour cache — recomputed only when results/resultType change, not per frame
      const cache = femState.contourCache;
      let globalMin = cache.globalMin;
      let globalMax = cache.globalMax;
      const unitMap: Record<string, string> = {
        deflection: 'mm', mx: 'kN·m/m', my: 'kN·m/m', mxy: 'kN·m/m',
        stress_s1: 'kPa', stress_s2: 'kPa', stress_vm: 'kPa',
      };

      // Determine visibility set once to avoid repeated model.slabs.some() calls
      const visibleSlabIds = new Set<string>();
      for (const s of model.slabs) {
        if (!model.isHidden(s.id)) visibleSlabIds.add(s.id);
      }

      // 2. Render each active slab's contour using the unified global scale
      for (const [slabId, result] of femState.slabResults) {
        const slab = model.slabs.find(s => s.id === slabId || s.label === slabId);
        if (!slab || (model.isHidden(slab.id))) continue;
        const nodeValues = cache.perSlab.get(slabId)?.nodeValues ?? new Map<number, number>();

        ctx.save();
        ctx.beginPath();
        if (slab.vertices.length >= 3) {
          ctx.moveTo(slab.vertices[0].x, slab.vertices[0].y);
          for (let i = 1; i < slab.vertices.length; i++) ctx.lineTo(slab.vertices[i].x, slab.vertices[i].y);
          ctx.closePath();
        }
        for (const hole of slab.holes) {
          if (hole.length >= 3) {
            ctx.moveTo(hole[0].x, hole[0].y);
            for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
            ctx.closePath();
          }
        }
        ctx.clip('evenodd');

        if (globalMax !== globalMin) {
          drawFEMContour(ctx, result.mesh, nodeValues, globalMin, globalMax, 0.75, 3, false);
        }
        if (femState.resultType === 'punching' && result.columnPunching && result.columnPunching.length > 0) {
          drawPunchingMarkers(ctx, result.mesh, model.columns, result.columnPunching);
        }
        drawFEMMesh(ctx, result.mesh);
        ctx.restore();
      }

      // 3. Draw color legend (screen space) using the same unified scale — horizontal at bottom center
      if (femState.slabResults.size > 0) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const legendW = 300;
        const legendH = 12;
        const legendX = (W - legendW) / 2;
        const legendY = H - 60;

        const label = 'Deflection (mm)';

        if (globalMax !== globalMin) {
          drawColorLegend(ctx, legendX, legendY, legendW, legendH, globalMin, globalMax, label, undefined, false);
        }

        ctx.setTransform(ppm * z, 0, 0, -ppm * z, ox, oy);
      }
    }

    // Slabs drawn above with visibility check
    if (uiState.showWalls) {
    for (const w of model.walls) {
      if (model.isHidden(w.id)) continue;
      if (femState.disconnectedIds.has(w.id)) drawShearWallDisconnected(ctx, w);
      else if (isSelected(w.id)) drawShearWallSelected(ctx, w);
      else drawShearWall(ctx, w);
    }

    for (const pw of model.polylineWalls) {
      if (model.isHidden(pw.id)) continue;
      if (isSelected(pw.id)) drawPolylineWallSelected(ctx, pw, uiState.vertexEditTarget);
      else drawPolylineWall(ctx, pw);
    }
    }
    if (uiState.showNonStructuralWalls) {
    for (const w of model.nonStructuralWalls) {
      if (model.isHidden(w.id)) continue;
      if (isSelected(w.id)) drawNonStructuralWallSelected(ctx, w);
      else drawNonStructuralWall(ctx, w);
    }
    for (const pw of model.polylineNonStructuralWalls) {
      if (model.isHidden(pw.id)) continue;
      if (isSelected(pw.id)) drawNonStructuralPolylineWallSelected(ctx, pw, uiState.vertexEditTarget);
      else drawNonStructuralPolylineWall(ctx, pw);
    }
    }
    if (uiState.showBeams) {
    for (const b of model.beams) {
      if (model.isHidden(b.id)) continue;
      if (isSelected(b.id)) drawBeamSelected(ctx, b);
      else drawBeam(ctx, b);
    }
    }
    if (uiState.showColumns) {
    for (const c of model.columns) {
      if (model.isHidden(c.id)) continue;
      if (femState.disconnectedIds.has(c.id)) drawColumnDisconnected(ctx, c);
      else if (isSelected(c.id)) drawColumnSelected(ctx, c);
      else drawColumn(ctx, c);
    }
    }
    if (uiState.showDropPanels) {
    for (const dp of model.dropPanels) {
      if (model.isHidden(dp.id)) continue;
      if (isSelected(dp.id)) drawDropPanelSelected(ctx, dp, uiState.vertexEditTarget);
      else drawDropPanel(ctx, dp);
    }
    }

    if (model.dimensions.length > 0) {
      drawDimensions(ctx, model.dimensions, uiState.selectedElementIds, ppm, z, ox, oy);
    }

    if (uiState.showLabels) {
      drawElementLabels(ctx, model.columns, model.walls, model.polylineWalls, model.beams, model.slabs, model.dropPanels, model.nonStructuralWalls, model.polylineNonStructuralWalls, model.hiddenElementIds);
    }

    // Permanent joint dots for snapping visibility — cached positions, drawn with theme color (P1)
    buildJointData();
    drawJointCache(ctx);

    // Draw unconnected joints warnings (cached — only recomputed when model changes)
    const unconnectedJoints = getCachedUnconnectedJoints();
    for (const joint of unconnectedJoints) {
      drawUnconnectedJointNode(ctx, joint.x, joint.y);
    }

    ctx.fillStyle = '';

    if (localDrag.type === 'tracingSlab' && localDrag.verts.length > 0) {
      const verts = localDrag.verts;
      const currentMouseWorld = getSnappedPoint(mouseWorld, verts[verts.length - 1], shiftHeld);
      ctx.strokeStyle = '#60A5FA'; ctx.lineWidth = 0.04;
      ctx.setLineDash([0.12, 0.08]);
      ctx.beginPath();
      ctx.moveTo(verts[0].x, verts[0].y);
      for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
      ctx.lineTo(currentMouseWorld.x, currentMouseWorld.y);
      ctx.stroke(); ctx.setLineDash([]);
      for (const v of verts) {
        ctx.beginPath(); ctx.arc(v.x, v.y, 0.08, 0, Math.PI * 2);
        ctx.fillStyle = '#60A5FA'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(currentMouseWorld.x, currentMouseWorld.y, 0.06, 0, Math.PI * 2);
      ctx.strokeStyle = '#60A5FA'; ctx.lineWidth = 0.03; ctx.stroke();
      if (verts.length >= 2 && distance(currentMouseWorld, verts[0]) < 0.5) {
        ctx.beginPath(); ctx.arc(verts[0].x, verts[0].y, 0.15, 0, Math.PI * 2);
        ctx.strokeStyle = '#10B981'; ctx.lineWidth = 0.05; ctx.stroke();
        drawDimensionLabel(ctx, verts[0], 'Close (click or double-click)');
      }
    }

    if (localDrag.type === 'tracingHole' && localDrag.verts.length > 0) {
      const verts = localDrag.verts;
      const currentMouseWorld = getSnappedPoint(mouseWorld, verts[verts.length - 1], shiftHeld);
      ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 0.04;
      ctx.setLineDash([0.12, 0.08]);
      ctx.beginPath();
      ctx.moveTo(verts[0].x, verts[0].y);
      for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
      ctx.lineTo(currentMouseWorld.x, currentMouseWorld.y);
      ctx.stroke(); ctx.setLineDash([]);
      for (const v of verts) {
        ctx.beginPath(); ctx.arc(v.x, v.y, 0.08, 0, Math.PI * 2);
        ctx.fillStyle = '#F59E0B'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(currentMouseWorld.x, currentMouseWorld.y, 0.06, 0, Math.PI * 2);
      ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 0.03; ctx.stroke();
      if (verts.length >= 2 && distance(currentMouseWorld, verts[0]) < 0.5) {
        ctx.beginPath(); ctx.arc(verts[0].x, verts[0].y, 0.15, 0, Math.PI * 2);
        ctx.strokeStyle = '#10B981'; ctx.lineWidth = 0.05; ctx.stroke();
        drawDimensionLabel(ctx, verts[0], 'Close opening (click or double-click)');
      }
    }

    if (localDrag.type === 'drawingWall') {
      const currentMouseWorld = getSnappedPoint(mouseWorld, localDrag.start, shiftHeld);
      drawWallPreview(ctx, localDrag.start, currentMouseWorld, uiState.wallThickness / 1000);
      const wallLen = distance(localDrag.start, currentMouseWorld);
      const midX = (localDrag.start.x + currentMouseWorld.x) / 2;
      const midY = (localDrag.start.y + currentMouseWorld.y) / 2;
      const angle = Math.atan2(currentMouseWorld.y - localDrag.start.y, currentMouseWorld.x - localDrag.start.x) * 180 / Math.PI;
      drawDimensionLabel(ctx, { x: midX, y: midY - 0.3 }, `L=${wallLen.toFixed(2)}m  ${angle.toFixed(1)}°`);
    }

    if (localDrag.type === 'drawingNonStructuralWall') {
      const currentMouseWorld = getSnappedPoint(mouseWorld, localDrag.start, shiftHeld);
      drawNonStructuralWallPreview(ctx, localDrag.start, currentMouseWorld, uiState.wallThickness / 1000);
      const wallLen = distance(localDrag.start, currentMouseWorld);
      const midX = (localDrag.start.x + currentMouseWorld.x) / 2;
      const midY = (localDrag.start.y + currentMouseWorld.y) / 2;
      const angle = Math.atan2(currentMouseWorld.y - localDrag.start.y, currentMouseWorld.x - localDrag.start.x) * 180 / Math.PI;
      drawDimensionLabel(ctx, { x: midX, y: midY - 0.3 }, `L=${wallLen.toFixed(2)}m  ${angle.toFixed(1)}°`);
    }

    if ((localDrag.type === 'drawingWallPolyline' || localDrag.type === 'drawingNonStructuralWallPolyline') && localDrag.verts.length > 0) {
      const startPt = localDrag.verts[localDrag.verts.length - 1];
      const currentMouseWorld = getSnappedPoint(mouseWorld, startPt, shiftHeld);
      const isNSW = localDrag.type === 'drawingNonStructuralWallPolyline';
      const color = isNSW ? '#f97316' : '#EF4444';
      ctx.strokeStyle = color; ctx.lineWidth = 0.03;
      ctx.setLineDash([0.08, 0.06]);
      ctx.beginPath();
      ctx.moveTo(localDrag.verts[0].x, localDrag.verts[0].y);
      for (let i = 1; i < localDrag.verts.length; i++) ctx.lineTo(localDrag.verts[i].x, localDrag.verts[i].y);
      ctx.lineTo(currentMouseWorld.x, currentMouseWorld.y);
      ctx.stroke(); ctx.setLineDash([]);
      for (const v of localDrag.verts) {
        ctx.beginPath(); ctx.arc(v.x, v.y, 0.06, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
      }
      const d = distance(startPt, currentMouseWorld);
      drawDimensionLabel(ctx, { x: (startPt.x + currentMouseWorld.x) / 2, y: (startPt.y + currentMouseWorld.y) / 2 - 0.3 }, `L=${d.toFixed(2)}m`);
    }

    if (localDrag.type === 'drawingBeam') {
      const currentMouseWorld = getSnappedPoint(mouseWorld, localDrag.start, shiftHeld);
      drawBeamPreview(ctx, localDrag.start, currentMouseWorld, uiState.beamWidth / 1000);
      const beamLen = distance(localDrag.start, currentMouseWorld);
      const midX = (localDrag.start.x + currentMouseWorld.x) / 2;
      const midY = (localDrag.start.y + currentMouseWorld.y) / 2;
      drawDimensionLabel(ctx, { x: midX, y: midY - 0.3 }, `L=${beamLen.toFixed(2)}m`);
    }

    if (localDrag.type === 'drawingSlabRect') {
      const p1 = localDrag.start;
      const p2 = getSnappedPoint(mouseWorld, p1, shiftHeld);
      ctx.strokeStyle = '#60A5FA'; ctx.lineWidth = 0.04;
      ctx.setLineDash([0.12, 0.08]);
      ctx.beginPath();
      ctx.rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.stroke(); ctx.setLineDash([]);
      const corners = [p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }];
      for (const p of corners) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 0.08, 0, Math.PI * 2);
        ctx.fillStyle = '#60A5FA'; ctx.fill();
      }
      const width = Math.abs(p2.x - p1.x);
      const height = Math.abs(p2.y - p1.y);
      drawDimensionLabel(ctx, { x: (p1.x + p2.x) / 2, y: Math.min(p1.y, p2.y) - 0.3 }, `W=${width.toFixed(2)}m, H=${height.toFixed(2)}m`);
    }

    if (localDrag.type === 'drawingHoleRect') {
      const p1 = localDrag.start;
      const p2 = getSnappedPoint(mouseWorld, p1, shiftHeld);
      ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 0.04;
      ctx.setLineDash([0.12, 0.08]);
      ctx.beginPath();
      ctx.rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.stroke(); ctx.setLineDash([]);
      const corners = [p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }];
      for (const p of corners) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 0.08, 0, Math.PI * 2);
        ctx.fillStyle = '#F59E0B'; ctx.fill();
      }
      const width = Math.abs(p2.x - p1.x);
      const height = Math.abs(p2.y - p1.y);
      drawDimensionLabel(ctx, { x: (p1.x + p2.x) / 2, y: Math.min(p1.y, p2.y) - 0.3 }, `W=${width.toFixed(2)}m, H=${height.toFixed(2)}m`);
    }

    if (uiState.tool === 'column' && localDrag.type === 'idle') {
      const snappedColWorld = getSnappedPoint(mouseWorld, undefined, false);
      const w = uiState.columnShape === 'circular' ? uiState.placementDiameter / 1000 : uiState.placementWidth / 1000;
      const d = uiState.columnShape === 'circular' ? uiState.placementDiameter / 1000 : uiState.placementDepth / 1000;
      drawColumnPreview(ctx, snappedColWorld, w, d, uiState.columnShape);
    }

    if (uiState.tool === 'dropPanel' && localDrag.type === 'idle') {
      const hitCol = hitTestColumns(mouseWorld, model.columns, blockedIds);
      if (hitCol) {
        const col = model.columns.find(c => c.id === hitCol.id);
        if (col) {
          const dpW = uiState.dropPanelWidth / 1000;
          const dpD = uiState.dropPanelDepth / 1000;
          drawDropPanelPreview(ctx, col.position, dpW, dpD, col.rotation);
        }
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (uiState.calibrationPoint1) {
      const snappedSecond = getSnappedPoint(mouseWorld, uiState.calibrationPoint1, shiftHeld);
      const p1Screen = worldToScreen(uiState.calibrationPoint1.x, uiState.calibrationPoint1.y);
      const p2Screen = worldToScreen(snappedSecond.x, snappedSecond.y);
      const calibLabel = `Distance: ${Math.sqrt(
        (p2Screen.x - p1Screen.x) ** 2 +
        (p2Screen.y - p1Screen.y) ** 2
      ).toFixed(1)} px`;
      drawCalibrationLine(ctx, p1Screen, p2Screen, calibLabel);
    }

    if (localDrag.type === 'measuring') {
      const currentMouseWorld = getSnappedPoint(mouseWorld, localDrag.point1World, shiftHeld);
      const dist = distance(localDrag.point1World, currentMouseWorld);
      const p1Screen = worldToScreen(localDrag.point1World.x, localDrag.point1World.y);
      const mouseScreenOrtho = worldToScreen(currentMouseWorld.x, currentMouseWorld.y);
      drawMeasureLine(ctx, p1Screen, mouseScreenOrtho, dist);
    }

    if (localDrag.type === 'idle') {
      if (['wall', 'nonStructuralWall', 'beam', 'slab', 'opening', 'calibrate', 'measure'].includes(uiState.tool)) {
        getSnappedPoint(mouseWorld, undefined, false);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (isSnapped && snapPoint) {
      const snap = snapPoint;
      const sp = worldToScreen(snap.x, snap.y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = '#22C55E';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#22C55E';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = uiState.theme === 'light' ? '#000000' : '#FFFFFF';
      ctx.fill();
      drawSnapCoordinateLabel(ctx, sp.x, sp.y, snap.x, snap.y, snapTypeName);
    }

    if (localDrag.type === 'selectingRect' && selectionRectEnd) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawSelectionRect(ctx, localDrag.startScreen, selectionRectEnd);
    }

    if (model.slabs.length > 0 || model.dropPanels.length > 0 || model.columns.length > 0 || model.walls.length > 0 || model.polylineWalls.length > 0 || model.beams.length > 0) {
      const metrics = getCachedMetrics();
      if (metrics) {
        const cmS = worldToScreen(metrics.cm.x, metrics.cm.y);
        const crS = worldToScreen(metrics.cr.x, metrics.cr.y);
        drawCMmarker(ctx, cmS.x, cmS.y);
        drawCRmarker(ctx, crS.x, crS.y);
        drawEccentricityVector(ctx, cmS.x, cmS.y, crS.x, crS.y, metrics.ex, metrics.ey);
      }
    }
    } catch (err) { console.error('[render]', err); }
    animId = requestAnimationFrame(render);
  }

  function takeMultiDragSnapshot(): Map<string, any> {
    const map = new Map();
    for (const id of uiState.selectedElementIds) {
      const col = model.columns.find(c => c.id === id);
      if (col) { map.set(id, { type: 'column', position: { x: col.position.x, y: col.position.y } }); continue; }
      const wall = model.walls.find(w => w.id === id);
      if (wall) { map.set(id, { type: 'wall', startPoint: { x: wall.startPoint.x, y: wall.startPoint.y }, endPoint: { x: wall.endPoint.x, y: wall.endPoint.y } }); continue; }
      const pwall = model.polylineWalls.find(w => w.id === id);
      if (pwall) { map.set(id, { type: 'polylineWall', vertices: pwall.vertices.map(v => ({ x: v.x, y: v.y })) }); continue; }
      const beam = model.beams.find(b => b.id === id);
      if (beam) { map.set(id, { type: 'beam', startPoint: { x: beam.startPoint.x, y: beam.startPoint.y }, endPoint: { x: beam.endPoint.x, y: beam.endPoint.y } }); continue; }
      const slab = model.slabs.find(s => s.id === id);
      if (slab) { map.set(id, { type: 'slab', vertices: slab.vertices.map(v => ({ x: v.x, y: v.y })) }); continue; }
      const dp = model.dropPanels.find(d => d.id === id);
      if (dp) { map.set(id, { type: 'dropPanel', center: { x: dp.center.x, y: dp.center.y }, vertices: dp.vertices.map(v => ({ x: v.x, y: v.y })) }); continue; }
    }
    return map;
  }

  function handleMouseDown(e: MouseEvent): void {
    try {
    dirty = true;
    const rect = canvasEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    canvasEl.focus();

    if (floorLayers.alignmentState && floorLayers.alignmentState.active) {
      if (e.button === 0) {
        const ox = model.canvasViewOffsetX;
        const oy = model.canvasViewOffsetY;
        const z = model.canvasZoom;
        const pBaseImg = {
          x: (sx - ox) / z,
          y: (sy - oy) / z
        };
        floorLayers.addAlignmentPoint(pBaseImg);
        const state = floorLayers.alignmentState;
        if (state) {
          if (state.step === 'base2') uiState.setStatusMessage('Wizard: Click Grid Ref 2 on BASE floor plan');
          else if (state.step === 'overlay1') uiState.setStatusMessage('Wizard: Click Grid Ref 1 on OVERLAY floor plan');
          else if (state.step === 'overlay2') uiState.setStatusMessage('Wizard: Click Grid Ref 2 on OVERLAY floor plan');
        } else {
          uiState.setStatusMessage('Floor plans aligned successfully!');
        }
        return;
      }
    }

    if (e.button === 1) {
      e.preventDefault();
      if (localDrag.type !== 'idle' && localDrag.type !== 'panning') {
        savedDrag = localDrag;
      }
      localDrag = { type: 'panning', last: { x: sx, y: sy } };
      canvasEl.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 2) {
      const hitCol = hitTestColumns(world, model.columns, blockedIds);
      const hitWall = !hitCol ? hitTestWalls(world, model.walls, blockedIds) : null;
      const hitPW = !hitCol && !hitWall ? hitTestPolylineWalls(world, model.polylineWalls, blockedIds) : null;
      const hitNSW = !hitCol && !hitWall && !hitPW ? hitTestNonStructuralWalls(world, model.nonStructuralWalls, blockedIds) : null;
      const hitNSPW = !hitCol && !hitWall && !hitPW && !hitNSW ? hitTestPolylineNonStructuralWalls(world, model.polylineNonStructuralWalls, blockedIds) : null;
      const hitBeam = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW ? hitTestBeams(world, model.beams, blockedIds) : null;
      const hitDp = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam ? hitTestDropPanels(world, model.dropPanels, blockedIds) : null;
      const hitSlabRes = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam && !hitDp ? hitTestSlabs(world, model.slabs, blockedIds) : null;
      const hitDim = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam && !hitDp && !hitSlabRes ? hitTestDimensions(world, model.dimensions) : null;
      if (hitCol) { uiState.selectElement(hitCol.id, 'column'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitWall) { uiState.selectElement(hitWall.id, 'wall'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitPW) { uiState.selectElement(hitPW.id, 'wall'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitNSW) { uiState.selectElement(hitNSW.id, 'nonStructuralWall'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitNSPW) { uiState.selectElement(hitNSPW.id, 'nonStructuralWall'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitBeam) { uiState.selectElement(hitBeam.id, 'beam'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitDp) { uiState.selectElement(hitDp.id, 'dropPanel'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else if (hitSlabRes) {
        if (hitSlabRes.type === 'slabHoleEdge' || hitSlabRes.type === 'slabHoleVertex' || hitSlabRes.type === 'slabHole') {
          uiState.selectedHoleIndex = hitSlabRes.holeIndex!;
          uiState.selectElement(hitSlabRes.id, 'opening');
          contextHoleInfo = { slabId: hitSlabRes.id, holeIndex: hitSlabRes.holeIndex! };
        } else {
          uiState.selectElement(hitSlabRes.id, 'slab');
          contextHoleInfo = null;
        }
        uiState.setContextMenu({ x: e.clientX, y: e.clientY });
      }
      else if (hitDim) { uiState.selectElement(hitDim.id, 'dimension'); uiState.setContextMenu({ x: e.clientX, y: e.clientY }); contextHoleInfo = null; }
      else { contextHoleInfo = null; }
      return;
    }

    if (e.button !== 0) return;
    uiState.setContextMenu(null);

    if (uiState.tool === 'select') {
      const hitCol = hitTestColumns(world, model.columns, blockedIds);
      const hitWall = !hitCol ? hitTestWalls(world, model.walls, blockedIds) : null;
      const hitPW = !hitCol && !hitWall ? hitTestPolylineWalls(world, model.polylineWalls, blockedIds) : null;
      const hitNSW = !hitCol && !hitWall && !hitPW ? hitTestNonStructuralWalls(world, model.nonStructuralWalls, blockedIds) : null;
      const hitNSPW = !hitCol && !hitWall && !hitPW && !hitNSW ? hitTestPolylineNonStructuralWalls(world, model.polylineNonStructuralWalls, blockedIds) : null;
      const hitBeam = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW ? hitTestBeams(world, model.beams, blockedIds) : null;
      const hitDp = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam ? hitTestDropPanels(world, model.dropPanels, blockedIds) : null;
      const hitSlabRes = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam && !hitDp ? hitTestSlabs(world, model.slabs, blockedIds) : null;
      if (e.shiftKey && (hitCol || hitWall || hitPW || hitNSW || hitNSPW || hitBeam)) {
        const hitId = hitCol ? hitCol.id : hitWall ? hitWall.id : hitPW ? hitPW.id : hitNSW ? hitNSW.id : hitNSPW ? hitNSPW.id : hitBeam!.id;
        const ids = uiState.selectedElementIds.includes(hitId)
          ? uiState.selectedElementIds.filter(id => id !== hitId)
          : [...uiState.selectedElementIds, hitId];
        uiState.setSelectedElements(ids);
        if (hitCol) uiState.selectedElementType = 'column';
        else if (hitWall) uiState.selectedElementType = 'wall';
        else if (hitPW) uiState.selectedElementType = 'wall';
        else if (hitNSW) uiState.selectedElementType = 'nonStructuralWall';
        else if (hitNSPW) uiState.selectedElementType = 'nonStructuralWall';
        else uiState.selectedElementType = 'beam';
        if (hitCol) {
          localDrag = { type: 'pendingColumn', id: hitCol.id, offset: { x: world.x - hitCol.point.x, y: world.y - hitCol.point.y }, startScreen: { x: sx, y: sy } };
        } else if (hitWall) {
          localDrag = { type: 'pendingWall', id: hitWall.id, hitType: hitWall.type as 'wallStart' | 'wallEnd' | 'wallMid', offset: { x: world.x - hitWall.point.x, y: world.y - hitWall.point.y }, startScreen: { x: sx, y: sy } };
        } else if (hitPW) {
          // just select, no dragging for polyline wall vertices for now
        } else if (hitNSW) {
          localDrag = { type: 'pendingWall', id: hitNSW.id, hitType: hitNSW.type.replace('nonStructuralWall', 'wall') as 'wallStart' | 'wallEnd' | 'wallMid', offset: { x: world.x - hitNSW.point.x, y: world.y - hitNSW.point.y }, startScreen: { x: sx, y: sy } };
        } else if (hitNSPW) {
          // just select for polyline non-structural wall vertices
        } else if (hitBeam) {
          localDrag = { type: 'pendingBeam', id: hitBeam.id, hitType: hitBeam.type as 'beamStart' | 'beamEnd' | 'beamMid', offset: { x: world.x - hitBeam.point.x, y: world.y - hitBeam.point.y }, startScreen: { x: sx, y: sy } };
        }
        return;
      }
      // Multi-drag: non-shift click on already-selected element body while multi-selected
      if (hitCol && uiState.isSelected(hitCol.id) && uiState.selectedElementIds.length > 1) {
        multiDragOriginals = takeMultiDragSnapshot();
        localDrag = { type: 'pendingMulti', startScreen: { x: sx, y: sy }, startWorld: world };
        return;
      }
      if (hitWall && hitWall.type === 'wallMid' && uiState.isSelected(hitWall.id) && uiState.selectedElementIds.length > 1) {
        multiDragOriginals = takeMultiDragSnapshot();
        localDrag = { type: 'pendingMulti', startScreen: { x: sx, y: sy }, startWorld: world };
        return;
      }
      if (hitPW && hitPW.type === 'polylineWall' && uiState.isSelected(hitPW.id) && uiState.selectedElementIds.length > 1) {
        multiDragOriginals = takeMultiDragSnapshot();
        localDrag = { type: 'pendingMulti', startScreen: { x: sx, y: sy }, startWorld: world };
        return;
      }
      if (hitBeam && hitBeam.type === 'beamMid' && uiState.isSelected(hitBeam.id) && uiState.selectedElementIds.length > 1) {
        multiDragOriginals = takeMultiDragSnapshot();
        localDrag = { type: 'pendingMulti', startScreen: { x: sx, y: sy }, startWorld: world };
        return;
      }
      if (hitDp && hitDp.type === 'dropPanel' && uiState.isSelected(hitDp.id) && uiState.selectedElementIds.length > 1) {
        multiDragOriginals = takeMultiDragSnapshot();
        localDrag = { type: 'pendingMulti', startScreen: { x: sx, y: sy }, startWorld: world };
        return;
      }
      if (hitSlabRes && hitSlabRes.type === 'slab' && uiState.isSelected(hitSlabRes.id) && uiState.selectedElementIds.length > 1) {
        multiDragOriginals = takeMultiDragSnapshot();
        localDrag = { type: 'pendingMulti', startScreen: { x: sx, y: sy }, startWorld: world };
        return;
      }
      if (hitCol) {
        uiState.selectElement(hitCol.id, 'column');
        localDrag = { type: 'pendingColumn', id: hitCol.id, offset: { x: world.x - hitCol.point.x, y: world.y - hitCol.point.y }, startScreen: { x: sx, y: sy } };
        return;
      }
      if (hitWall) {
        uiState.selectElement(hitWall.id, 'wall');
        localDrag = { type: 'pendingWall', id: hitWall.id, hitType: hitWall.type as 'wallStart' | 'wallEnd' | 'wallMid', offset: { x: world.x - hitWall.point.x, y: world.y - hitWall.point.y }, startScreen: { x: sx, y: sy } };
        return;
      }
      if (hitPW) {
        uiState.selectElement(hitPW.id, 'wall');
        if (hitPW.type === 'polylineWallVertex' && hitPW.vertexIndex !== undefined) {
          const pwall = model.polylineWalls.find(w => w.id === hitPW.id);
          if (pwall) {
            localDrag = { type: 'pendingPolylineWallVertex', id: hitPW.id, vertexIndex: hitPW.vertexIndex, startMouse: { ...world }, startVerts: pwall.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
          }
        }
        return;
      }
      if (hitNSW) {
        uiState.selectElement(hitNSW.id, 'nonStructuralWall');
        localDrag = { type: 'pendingWall', id: hitNSW.id, hitType: hitNSW.type.replace('nonStructuralWall', 'wall') as 'wallStart' | 'wallEnd' | 'wallMid', offset: { x: world.x - hitNSW.point.x, y: world.y - hitNSW.point.y }, startScreen: { x: sx, y: sy } };
        return;
      }
      if (hitNSPW) {
        uiState.selectElement(hitNSPW.id, 'nonStructuralWall');
        if (hitNSPW.type === 'polylineNonStructuralWallVertex' && hitNSPW.vertexIndex !== undefined) {
          const nspwall = model.polylineNonStructuralWalls.find(w => w.id === hitNSPW.id);
          if (nspwall) {
            localDrag = { type: 'pendingPolylineWallVertex', id: hitNSPW.id, vertexIndex: hitNSPW.vertexIndex, startMouse: { ...world }, startVerts: nspwall.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
          }
        }
        return;
      }
      if (hitBeam) {
        uiState.selectElement(hitBeam.id, 'beam');
        localDrag = { type: 'pendingBeam', id: hitBeam.id, hitType: hitBeam.type as 'beamStart' | 'beamEnd' | 'beamMid', offset: { x: world.x - hitBeam.point.x, y: world.y - hitBeam.point.y }, startScreen: { x: sx, y: sy } };
        return;
      }
      if (hitDp) {
        uiState.selectElement(hitDp.id, 'dropPanel');
        const dp = model.dropPanels.find(d => d.id === hitDp.id);
        if (dp) {
          if (hitDp.type === 'dropPanelEdge' && uiState.edgeNodeInsertionEnabled) {
            localDrag = { type: 'pendingDropPanelEdge', id: hitDp.id, edgeIndex: hitDp.vertexIndex!, startMouse: { ...world }, startVerts: dp.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
          } else if (hitDp.type === 'dropPanelVertex') {
            localDrag = { type: 'pendingDropPanelVertex', id: hitDp.id, vertexIndex: hitDp.vertexIndex!, startMouse: { ...world }, startVerts: dp.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
          } else {
            localDrag = { type: 'pendingDropPanel', id: hitDp.id, startMouse: { ...world }, startVerts: dp.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
          }
        }
        return;
      }
      if (hitSlabRes) {
        const hitSlab = model.slabs.find(s => s.id === hitSlabRes.id);
        if (hitSlab) {
          if (hitSlabRes.type === 'slabHoleVertex') {
            const hi = hitSlabRes.holeIndex!;
            const vi = hitSlabRes.vertexIndex!;
            uiState.selectedHoleIndex = hi;
            uiState.selectElement(hitSlab.id, 'opening');
            localDrag = { type: 'pendingSlabHoleVertex', id: hitSlab.id, holeIndex: hi, vertexIndex: vi, startMouse: { ...world }, startHoleVerts: hitSlab.holes[hi].map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
            uiState.setStatusMessage('Drag hole vertex to reshape opening');
          } else if (hitSlabRes.type === 'slabHoleEdge' && uiState.edgeNodeInsertionEnabled) {
            const hi = hitSlabRes.holeIndex!;
            uiState.selectedHoleIndex = hi;
            uiState.selectElement(hitSlab.id, 'opening');
            localDrag = { type: 'pendingSlabHoleEdge', id: hitSlab.id, holeIndex: hi, edgeIndex: hitSlabRes.vertexIndex!, startMouse: { ...world }, startHoleVerts: hitSlab.holes[hi].map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
            uiState.setStatusMessage('Opening selected — drag edge to add vertex');
          } else if (hitSlabRes.type === 'slabHole') {
            const hi = hitSlabRes.holeIndex!;
            uiState.selectedHoleIndex = hi;
            uiState.selectElement(hitSlab.id, 'opening');
            localDrag = { type: 'pendingSlabHole', id: hitSlab.id, holeIndex: hi, startMouse: { ...world }, startHoleVerts: hitSlab.holes[hi].map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
            uiState.setStatusMessage('Opening selected — drag to move');
          } else {
            uiState.selectElement(hitSlab.id, 'slab');
            if (hitSlabRes.type === 'slabEdge' && uiState.edgeNodeInsertionEnabled) {
              localDrag = { type: 'pendingSlabEdge', id: hitSlab.id, edgeIndex: hitSlabRes.vertexIndex!, startMouse: { ...world }, startVerts: hitSlab.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
            } else if (hitSlabRes.type === 'slabVertex') {
              localDrag = { type: 'pendingSlabVertex', id: hitSlab.id, vertexIndex: hitSlabRes.vertexIndex!, startMouse: { ...world }, startVerts: hitSlab.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
            } else {
              localDrag = { type: 'pendingSlab', id: hitSlab.id, startMouse: { ...world }, startVerts: hitSlab.vertices.map(v => ({ ...v })), startScreen: { x: sx, y: sy } };
            }
          }
          return;
        }
      }
      const hitDim = !hitCol && !hitWall && !hitPW && !hitBeam && !hitSlabRes ? hitTestDimensions(world, model.dimensions) : null;
      if (hitDim) {
        uiState.selectElement(hitDim.id, 'dimension');
        uiState.setStatusMessage('Dimension selected — press Delete to remove');
        return;
      }
      uiState.setSelectedElements([]);
      localDrag = { type: 'selectingRect', startScreen: { x: sx, y: sy }, startWorld: world };
      selectionRectEnd = { x: sx, y: sy };
      return;
    }

    if (uiState.tool === 'column') {
      const snappedWorld = getSnappedPoint(world, undefined, false);
      const isCirc = uiState.columnShape === 'circular';
      const w = isCirc ? uiState.placementDiameter / 1000 : uiState.placementWidth / 1000;
      const d = isCirc ? uiState.placementDiameter / 1000 : uiState.placementDepth / 1000;
      const h = uiState.placementHeight / 1000;
      model.addColumn(snappedWorld, w, d, h, 'fixed-fixed', uiState.columnShape, isCirc ? uiState.placementDiameter / 1000 : 0.5);
      uiState.selectElement(model.columns[model.columns.length - 1].id, 'column');
      if (isCirc) {
        uiState.setStatusMessage(`Circular Column D=${(w*1000).toFixed(0)}mm`);
      } else {
        uiState.setStatusMessage(`Column ${(w*1000).toFixed(0)}×${(d*1000).toFixed(0)}×${(h*1000).toFixed(0)}mm`);
      }
      return;
    }

    if (uiState.tool === 'wall') {
      if (uiState.wallDrawMode === 'polyline') {
        if (localDrag.type !== 'drawingWallPolyline') {
          const snappedStart = getSnappedPoint(world, undefined, false);
          localDrag = { type: 'drawingWallPolyline', verts: [snappedStart] };
          uiState.setStatusMessage('Click next point, double-click / Enter to finish polyline wall');
        } else {
          const startPt = localDrag.verts[localDrag.verts.length - 1];
          const snappedEnd = getSnappedPoint(world, startPt, e.shiftKey || shiftHeld);
          localDrag = { type: 'drawingWallPolyline', verts: [...localDrag.verts, snappedEnd] };
          uiState.setStatusMessage(`${localDrag.verts.length} points — double-click / Enter to finish`);
        }
      } else {
        if (localDrag.type !== 'drawingWall') {
          const snappedStart = getSnappedPoint(world, undefined, false);
          localDrag = { type: 'drawingWall', start: snappedStart };
          uiState.setStatusMessage('Click endpoint to finish wall');
        } else {
          const startPt = localDrag.start;
          const endPt = getSnappedPoint(world, startPt, e.shiftKey || shiftHeld);
          model.addWall(startPt, endPt);
          const wallLen = distance(startPt, endPt);
          localDrag = { type: 'idle' };
          uiState.setStatusMessage(`Wall placed (L=${wallLen.toFixed(2)}m)`);
        }
      }
      return;
    }

    if (uiState.tool === 'nonStructuralWall') {
      if (uiState.partitionDrawMode === 'polyline') {
        if (localDrag.type !== 'drawingNonStructuralWallPolyline') {
          const snappedStart = getSnappedPoint(world, undefined, false);
          localDrag = { type: 'drawingNonStructuralWallPolyline', verts: [snappedStart] };
          uiState.setStatusMessage('Click next point, double-click / Enter to finish polyline partition');
        } else {
          const startPt = localDrag.verts[localDrag.verts.length - 1];
          const snappedEnd = getSnappedPoint(world, startPt, e.shiftKey || shiftHeld);
          localDrag = { type: 'drawingNonStructuralWallPolyline', verts: [...localDrag.verts, snappedEnd] };
          uiState.setStatusMessage(`${localDrag.verts.length} points — double-click / Enter to finish`);
        }
      } else {
        if (localDrag.type !== 'drawingNonStructuralWall') {
          const snappedStart = getSnappedPoint(world, undefined, false);
          localDrag = { type: 'drawingNonStructuralWall', start: snappedStart };
          uiState.setStatusMessage('Click endpoint to finish partition wall');
        } else {
          const startPt = localDrag.start;
          const endPt = getSnappedPoint(world, startPt, e.shiftKey || shiftHeld);
          model.addNonStructuralWall(startPt, endPt);
          const wallLen = distance(startPt, endPt);
          localDrag = { type: 'idle' };
          uiState.setStatusMessage(`Partition wall placed (L=${wallLen.toFixed(2)}m)`);
        }
      }
      return;
    }

    if (uiState.tool === 'beam') {
      if (localDrag.type !== 'drawingBeam') {
        const snappedStart = getSnappedPoint(world, undefined, false);
        localDrag = { type: 'drawingBeam', start: snappedStart };
        uiState.setStatusMessage('Click endpoint to finish beam');
      } else {
        const startPt = localDrag.start;
        const endPt = getSnappedPoint(world, startPt, e.shiftKey || shiftHeld);
        model.addBeam(startPt, endPt);
        localDrag = { type: 'idle' };
        uiState.setStatusMessage(`Beam placed`);
      }
      return;
    }

    if (uiState.tool === 'dropPanel') {
      const hitCol = hitTestColumns(world, model.columns, blockedIds);
      if (hitCol) {
        const col = model.columns.find(c => c.id === hitCol.id);
        if (col) {
          const dpW = uiState.dropPanelWidth / 1000;
          const dpD = uiState.dropPanelDepth / 1000;
          const dpDrop = uiState.dropPanelDrop / 1000;
          model.addDropPanel(col.position, dpW, dpD, col.rotation, dpDrop, col.id);
          uiState.setStatusMessage(`Drop panel placed at ${col.label}`);
        }
      } else {
        uiState.setStatusMessage('Click on a column to place drop panel');
      }
      return;
    }

    if (uiState.tool === 'slab') {
      if (uiState.slabDrawMode === 'rectangular') {
        if (localDrag.type !== 'drawingSlabRect') {
          const snappedStart = getSnappedPoint(world, undefined, false);
          localDrag = { type: 'drawingSlabRect', start: snappedStart };
          uiState.setStatusMessage('Click opposite corner to place rectangular slab');
        } else {
          const p1 = localDrag.start;
          const p2 = getSnappedPoint(world, p1, e.shiftKey || shiftHeld);
          const corner2 = getSnappedPoint({ x: p2.x, y: p1.y }, undefined, false);
          const corner4 = getSnappedPoint({ x: p1.x, y: p2.y }, undefined, false);
          const verts = [p1, corner2, p2, corner4];
          model.addSlabFromTrace(verts);
          localDrag = { type: 'idle' };
          uiState.setStatusMessage('Rectangular slab placed');
        }
      } else {
        const orthoWorld = localDrag.type === 'tracingSlab' && localDrag.verts.length > 0
          ? getSnappedPoint(world, localDrag.verts[localDrag.verts.length - 1], e.shiftKey || shiftHeld)
          : getSnappedPoint(world, undefined, false);
        const orthoHoleWorld = localDrag.type === 'tracingHole' && localDrag.verts.length > 0
          ? getSnappedPoint(world, localDrag.verts[localDrag.verts.length - 1], e.shiftKey || shiftHeld)
          : getSnappedPoint(world, undefined, false);
        const selectedSlabId = uiState.selectedElementType === 'slab' ? uiState.selectedElementId : null;
        if (selectedSlabId && model.slabs.find(s => s.id === selectedSlabId)) {
          if (localDrag.type !== 'tracingHole' || localDrag.slabId !== selectedSlabId) {
            localDrag = { type: 'tracingHole', slabId: selectedSlabId, verts: [orthoHoleWorld] };
            uiState.setStatusMessage('Click opening vertices, double-click / Enter to close');
          } else {
            if (localDrag.verts.length >= 3 && distance(orthoHoleWorld, localDrag.verts[0]) < 0.35) {
              model.addSlabHole(selectedSlabId, localDrag.verts);
              uiState.setStatusMessage(`Opening: ${localDrag.verts.length} vertices`);
              localDrag = { type: 'idle' };
            } else {
              localDrag = { type: 'tracingHole', slabId: selectedSlabId, verts: [...localDrag.verts, orthoHoleWorld] };
              uiState.setStatusMessage(`${localDrag.verts.length} vertices — double-click / Enter to close`);
            }
          }
        } else {
          if (localDrag.type !== 'tracingSlab') {
            localDrag = { type: 'tracingSlab', verts: [orthoWorld] };
            uiState.setStatusMessage('Click vertices, double-click / Enter to close');
          } else {
            if (localDrag.verts.length >= 3 && distance(orthoWorld, localDrag.verts[0]) < 0.35) {
              model.addSlabFromTrace(localDrag.verts);
              uiState.setStatusMessage(`Slab: ${localDrag.verts.length} vertices`);
              localDrag = { type: 'idle' };
            } else {
              localDrag = { type: 'tracingSlab', verts: [...localDrag.verts, orthoWorld] };
              uiState.setStatusMessage(`${localDrag.verts.length} vertices — double-click / Enter to close`);
            }
          }
        }
      }
      return;
    }

    if (uiState.tool === 'opening') {
      const targetSlabId = uiState.selectedElementType === 'slab'
        ? uiState.selectedElementId
        : (uiState.selectedElementType === 'opening' ? uiState.selectedElementId : null);
      const selectedSlab = targetSlabId ? model.slabs.find(s => s.id === targetSlabId) : null;
      if (uiState.openingDrawMode === 'rectangular') {
        if (selectedSlab) {
          if (localDrag.type !== 'drawingHoleRect' || localDrag.slabId !== selectedSlab.id) {
            const snappedStart = getSnappedPoint(world, undefined, false);
            localDrag = { type: 'drawingHoleRect', slabId: selectedSlab.id, start: snappedStart };
          } else {
            const p1 = localDrag.start;
            const p2 = getSnappedPoint(world, p1, e.shiftKey || shiftHeld);
            const corner2 = getSnappedPoint({ x: p2.x, y: p1.y }, undefined, false);
            const corner4 = getSnappedPoint({ x: p1.x, y: p2.y }, undefined, false);
            model.addSlabHole(selectedSlab.id, [p1, corner2, p2, corner4]);
            localDrag = { type: 'idle' };
            uiState.setStatusMessage('Rectangular opening placed');
          }
        } else {
          const snappedWorld = getSnappedPoint(world, undefined, false);
          const hitSlabRes = hitTestSlabs(snappedWorld, model.slabs, blockedIds);
          if (hitSlabRes) {
            uiState.selectElement(hitSlabRes.id, 'slab');
            localDrag = { type: 'drawingHoleRect', slabId: hitSlabRes.id, start: snappedWorld };
          } else {
            uiState.setStatusMessage('Click on a slab to add an opening');
          }
        }
      } else {
        if (selectedSlab) {
          if (localDrag.type !== 'tracingHole' || localDrag.slabId !== selectedSlab.id) {
            const snappedStart = getSnappedPoint(world, undefined, false);
            localDrag = { type: 'tracingHole', slabId: selectedSlab.id, verts: [snappedStart] };
          } else {
            const orthoHoleWorld = localDrag.verts.length > 0
              ? getSnappedPoint(world, localDrag.verts[localDrag.verts.length - 1], e.shiftKey || shiftHeld)
              : getSnappedPoint(world, undefined, false);
            if (localDrag.verts.length >= 3 && distance(orthoHoleWorld, localDrag.verts[0]) < 0.35) {
              model.addSlabHole(selectedSlab.id, localDrag.verts);
              localDrag = { type: 'idle' };
            } else {
              localDrag = { type: 'tracingHole', slabId: selectedSlab.id, verts: [...localDrag.verts, orthoHoleWorld] };
            }
          }
        } else {
          const snappedWorld = getSnappedPoint(world, undefined, false);
          const hitSlabRes = hitTestSlabs(snappedWorld, model.slabs, blockedIds);
          if (hitSlabRes) {
            uiState.selectElement(hitSlabRes.id, 'slab');
            localDrag = { type: 'tracingHole', slabId: hitSlabRes.id, verts: [snappedWorld] };
          } else {
            uiState.setStatusMessage('Click on a slab to add an opening');
          }
        }
      }
      return;
    }

    if (uiState.tool === 'calibrate') {
      if (!uiState.calibrationPoint1) {
        uiState.setCalibrationPoint1({ x: world.x, y: world.y });
        uiState.setStatusMessage('Click second point');
      } else {
        const snappedSecond = getSnappedPoint(world, uiState.calibrationPoint1, e.shiftKey || shiftHeld);
        const p1Screen = worldToScreen(uiState.calibrationPoint1.x, uiState.calibrationPoint1.y);
        const p2Screen = worldToScreen(snappedSecond.x, snappedSecond.y);
        uiState.calibrationPendingData = { p1Screen, p2Screen };
        uiState.showCalibrationDialog = true;
        uiState.setCalibrationPoint1(null);
        localDrag = { type: 'idle' };
      }
      return;
    }

    if (uiState.tool === 'measure') {
      const snappedWorld = getSnappedPoint(world, undefined, false);
      if ((!localDrag || localDrag.type !== 'measuring')) {
        const hitExistingDim = hitTestDimensions(snappedWorld, model.dimensions);
        if (hitExistingDim) {
          model.deleteDimension(hitExistingDim.id);
          uiState.setStatusMessage('Dimension deleted');
          localDrag = { type: 'idle' };
          return;
        }
      }
      if (!localDrag || localDrag.type !== 'measuring') {
        localDrag = { type: 'measuring', point1Screen: { x: sx, y: sy }, point1World: { ...snappedWorld } };
        uiState.setStatusMessage('Click second point to place dimension');
      } else {
        const p1 = localDrag.point1World;
        const snappedPt = getSnappedPoint(world, p1, e.shiftKey || shiftHeld);
        model.addDimension(p1, snappedPt);
        localDrag = { type: 'idle' };
      }
      return;
    }

    if (uiState.tool === 'pan') {
      localDrag = { type: 'panning', last: { x: sx, y: sy } };
      canvasEl.style.cursor = 'grabbing';
      return;
    }
    } catch (err) { console.error('[handleMouseDown]', err); }
  }

  function handleMouseMove(e: MouseEvent): void {
    lastMouseEvent = e;
    dirty = true;
    shiftHeld = e.shiftKey;
    const rect = canvasEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    mouseScreen = { x: sx, y: sy };
    const world = screenToWorld(sx, sy);
    mouseWorld = world;

    // Cursor value tracking over FEM contour
    if (femState.showFEMContour && femState.hasResults && localDrag.type === 'idle') {
      const hit = sampleFEMResultAtPoint(femState.slabResults, femState.resultType, world);
      if (hit) cursorValue = { x: sx, y: sy, text: hit.label };
      else cursorValue = null;
    } else {
      cursorValue = null;
    }

    if (localDrag.type === 'selectingRect') {
      selectionRectEnd = { x: sx, y: sy };
      return;
    }

    if (localDrag.type === 'pendingColumn' || localDrag.type === 'pendingWall' || localDrag.type === 'pendingBeam' || localDrag.type === 'pendingSlab' || localDrag.type === 'pendingSlabVertex' || localDrag.type === 'pendingSlabEdge' || localDrag.type === 'pendingSlabHoleVertex' || localDrag.type === 'pendingSlabHole' || localDrag.type === 'pendingSlabHoleEdge' || localDrag.type === 'pendingPolylineWallVertex' || localDrag.type === 'pendingDropPanel' || localDrag.type === 'pendingDropPanelVertex' || localDrag.type === 'pendingDropPanelEdge' || localDrag.type === 'pendingMulti') {
      const dx = sx - localDrag.startScreen.x;
      const dy = sy - localDrag.startScreen.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
        if (localDrag.type === 'pendingMulti') {
          model.beginAction();
          localDrag = { type: 'draggingMulti', startWorld: localDrag.startWorld, historyPushed: true };
        } else if (localDrag.type === 'pendingColumn') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingColumn', id: p.id, offset: p.offset, historyPushed: true };
        } else if (localDrag.type === 'pendingWall') {
          const p = localDrag;
          model.beginAction();
          if (p.hitType === 'wallStart') localDrag = { type: 'draggingWallStart', id: p.id, historyPushed: true };
          else if (p.hitType === 'wallEnd') localDrag = { type: 'draggingWallEnd', id: p.id, historyPushed: true };
          else localDrag = { type: 'draggingWallBody', id: p.id, offset: p.offset, historyPushed: true };
        } else if (localDrag.type === 'pendingBeam') {
          const p = localDrag;
          model.beginAction();
          if (p.hitType === 'beamStart') localDrag = { type: 'draggingBeamStart', id: p.id, historyPushed: true };
          else if (p.hitType === 'beamEnd') localDrag = { type: 'draggingBeamEnd', id: p.id, historyPushed: true };
          else localDrag = { type: 'draggingBeamBody', id: p.id, offset: p.offset, historyPushed: true };
        } else if (localDrag.type === 'pendingSlab') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingSlab', id: p.id, startMouse: p.startMouse, startVerts: p.startVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingSlabVertex') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingSlabVertex', id: p.id, vertexIndex: p.vertexIndex, startMouse: p.startMouse, startVerts: p.startVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingSlabEdge') {
          const p = localDrag;
          model.beginAction();
          const edgeA = p.startVerts[p.edgeIndex];
          const edgeB = p.startVerts[(p.edgeIndex + 1) % p.startVerts.length];
          const ex = edgeB.x - edgeA.x, ey = edgeB.y - edgeA.y;
          const len2 = ex * ex + ey * ey;
          let t = len2 < 1e-10 ? 0.5 : ((p.startMouse.x - edgeA.x) * ex + (p.startMouse.y - edgeA.y) * ey) / len2;
          t = Math.max(0, Math.min(1, t));
          const newVert = { x: edgeA.x + t * ex, y: edgeA.y + t * ey };
          const newVerts = [...p.startVerts];
          newVerts.splice(p.edgeIndex + 1, 0, newVert);
          model.updateSlab(p.id, { vertices: newVerts });
          localDrag = { type: 'draggingSlabEdge', id: p.id, vertexIndex: p.edgeIndex + 1, startMouse: p.startMouse, startVerts: newVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingSlabHoleVertex') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingSlabHoleVertex', id: p.id, holeIndex: p.holeIndex, vertexIndex: p.vertexIndex, startMouse: p.startMouse, startHoleVerts: p.startHoleVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingSlabHoleEdge') {
          const p = localDrag;
          model.beginAction();
          const edgeA = p.startHoleVerts[p.edgeIndex];
          const edgeB = p.startHoleVerts[(p.edgeIndex + 1) % p.startHoleVerts.length];
          const ex = edgeB.x - edgeA.x, ey = edgeB.y - edgeA.y;
          const len2 = ex * ex + ey * ey;
          let t = len2 < 1e-10 ? 0.5 : ((p.startMouse.x - edgeA.x) * ex + (p.startMouse.y - edgeA.y) * ey) / len2;
          t = Math.max(0, Math.min(1, t));
          const newVert = { x: edgeA.x + t * ex, y: edgeA.y + t * ey };
          const newHoleVerts = [...p.startHoleVerts];
          newHoleVerts.splice(p.edgeIndex + 1, 0, newVert);
          model.updateSlabHole(p.id, p.holeIndex, newHoleVerts);
          localDrag = { type: 'draggingSlabHoleEdge', id: p.id, holeIndex: p.holeIndex, vertexIndex: p.edgeIndex + 1, startMouse: p.startMouse, startHoleVerts: newHoleVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingSlabHole') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingSlabHole', id: p.id, holeIndex: p.holeIndex, startMouse: p.startMouse, startHoleVerts: p.startHoleVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingPolylineWallVertex') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingPolylineWallVertex', id: p.id, vertexIndex: p.vertexIndex, startMouse: p.startMouse, startVerts: p.startVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingDropPanel') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingDropPanel', id: p.id, startMouse: p.startMouse, startVerts: p.startVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingDropPanelVertex') {
          const p = localDrag;
          model.beginAction();
          localDrag = { type: 'draggingDropPanelVertex', id: p.id, vertexIndex: p.vertexIndex, startMouse: p.startMouse, startVerts: p.startVerts, historyPushed: true };
        } else if (localDrag.type === 'pendingDropPanelEdge') {
          const p = localDrag;
          model.beginAction();
          const edgeA = p.startVerts[p.edgeIndex];
          const edgeB = p.startVerts[(p.edgeIndex + 1) % p.startVerts.length];
          const ex = edgeB.x - edgeA.x, ey = edgeB.y - edgeA.y;
          const len2 = ex * ex + ey * ey;
          let t = len2 < 1e-10 ? 0.5 : ((p.startMouse.x - edgeA.x) * ex + (p.startMouse.y - edgeA.y) * ey) / len2;
          t = Math.max(0, Math.min(1, t));
          const newVert = { x: edgeA.x + t * ex, y: edgeA.y + t * ey };
          const newVerts = [...p.startVerts];
          newVerts.splice(p.edgeIndex + 1, 0, newVert);
          model.updateDropPanel(p.id, { vertices: newVerts });
          localDrag = { type: 'draggingDropPanelEdge', id: p.id, vertexIndex: p.edgeIndex + 1, startMouse: p.startMouse, startVerts: newVerts, historyPushed: true };
        }
      }
      return;
    }

    if (localDrag.type === 'draggingColumn') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const col = model.columns.find(c => c.id === drag.id);
      if (col) {
        const rawPos = { x: world.x - drag.offset.x, y: world.y - drag.offset.y };
        const snappedPos = getSnappedPoint(rawPos, col.position, e.shiftKey || shiftHeld);
        model.updateColumn(drag.id, { position: snappedPos });
      }
      return;
    }

    if (localDrag.type === 'draggingWallBody') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const wall = model.walls.find(w => w.id === drag.id);
      const nsWall = wall ? null : model.nonStructuralWalls.find(w => w.id === drag.id);
      let dx = world.x - drag.offset.x - (wall ? (wall.startPoint.x + wall.endPoint.x) / 2 : (nsWall!.startPoint.x + nsWall!.endPoint.x) / 2);
      let dy = world.y - drag.offset.y - (wall ? (wall.startPoint.y + wall.endPoint.y) / 2 : (nsWall!.startPoint.y + nsWall!.endPoint.y) / 2);
      if (e.shiftKey || shiftHeld) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (wall) {
        model.updateWall(drag.id, {
          startPoint: { x: wall.startPoint.x + dx, y: wall.startPoint.y + dy },
          endPoint: { x: wall.endPoint.x + dx, y: wall.endPoint.y + dy },
        });
      } else if (nsWall) {
        model.updateNonStructuralWall(drag.id, {
          startPoint: { x: nsWall.startPoint.x + dx, y: nsWall.startPoint.y + dy },
          endPoint: { x: nsWall.endPoint.x + dx, y: nsWall.endPoint.y + dy },
        });
      }
      return;
    }

    if (localDrag.type === 'draggingWallStart') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const wall = model.walls.find(w => w.id === drag.id);
      const nsWall = wall ? null : model.nonStructuralWalls.find(w => w.id === drag.id);
      if (wall) { const pt = getSnappedPoint(world, wall.endPoint, e.shiftKey || shiftHeld); model.updateWall(drag.id, { startPoint: pt }); }
      else if (nsWall) { const pt = getSnappedPoint(world, nsWall.endPoint, e.shiftKey || shiftHeld); model.updateNonStructuralWall(drag.id, { startPoint: pt }); }
      return;
    }

    if (localDrag.type === 'draggingWallEnd') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const wall = model.walls.find(w => w.id === drag.id);
      const nsWall = wall ? null : model.nonStructuralWalls.find(w => w.id === drag.id);
      if (wall) { const pt = getSnappedPoint(world, wall.startPoint, e.shiftKey || shiftHeld); model.updateWall(drag.id, { endPoint: pt }); }
      else if (nsWall) { const pt = getSnappedPoint(world, nsWall.startPoint, e.shiftKey || shiftHeld); model.updateNonStructuralWall(drag.id, { endPoint: pt }); }
      return;
    }

    if (localDrag.type === 'draggingPolylineWallVertex') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const pwall = model.polylineWalls.find(w => w.id === drag.id);
      if (pwall && drag.vertexIndex < pwall.vertices.length) {
        const origV = drag.startVerts[drag.vertexIndex];
        let dx = world.x - origV.x;
        let dy = world.y - origV.y;
        if (e.shiftKey || shiftHeld) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const newVerts = drag.startVerts.map((v, i) =>
          i === drag.vertexIndex ? { x: origV.x + dx, y: origV.y + dy } : { ...v }
        );
        model.updatePolylineWall(drag.id, { vertices: newVerts });
      }
      return;
    }

    if (localDrag.type === 'draggingBeamBody') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const beam = model.beams.find(b => b.id === drag.id);
      if (beam) {
        let dx = world.x - drag.offset.x - (beam.startPoint.x + beam.endPoint.x) / 2;
        let dy = world.y - drag.offset.y - (beam.startPoint.y + beam.endPoint.y) / 2;
        if (e.shiftKey || shiftHeld) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        model.updateBeam(drag.id, {
          startPoint: { x: beam.startPoint.x + dx, y: beam.startPoint.y + dy },
          endPoint: { x: beam.endPoint.x + dx, y: beam.endPoint.y + dy },
        });
      }
      return;
    }

    if (localDrag.type === 'draggingBeamStart') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const beam = model.beams.find(b => b.id === drag.id);
      if (beam) { const pt = getSnappedPoint(world, beam.endPoint, e.shiftKey || shiftHeld); model.updateBeam(drag.id, { startPoint: pt }); }
      return;
    }

    if (localDrag.type === 'draggingBeamEnd') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const beam = model.beams.find(b => b.id === drag.id);
      if (beam) { const pt = getSnappedPoint(world, beam.startPoint, e.shiftKey || shiftHeld); model.updateBeam(drag.id, { endPoint: pt }); }
      return;
    }

    if (localDrag.type === 'draggingSlab') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      let dx = world.x - drag.startMouse.x;
      let dy = world.y - drag.startMouse.y;
      if (e.shiftKey || shiftHeld) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      model.updateSlab(drag.id, { vertices: drag.startVerts.map(v => ({ x: v.x + dx, y: v.y + dy })) });
      return;
    }

    if (localDrag.type === 'draggingSlabVertex') {
      const drag = localDrag;
      if (drag.vertexIndex === undefined || drag.vertexIndex >= drag.startVerts.length) { localDrag = { type: 'idle' }; return; }
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const verts = [...drag.startVerts];
      const startRef = drag.startVerts[drag.vertexIndex];
      const pt = getSnappedPoint(world, startRef, e.shiftKey || shiftHeld);
      verts[drag.vertexIndex] = pt;
      model.updateSlab(drag.id, { vertices: verts });
      return;
    }

    if (localDrag.type === 'draggingSlabEdge') {
      const drag = localDrag;
      if (drag.vertexIndex === undefined || drag.vertexIndex >= drag.startVerts.length) { localDrag = { type: 'idle' }; return; }
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const verts = [...drag.startVerts];
      const startRef = drag.startVerts[drag.vertexIndex];
      const pt = getSnappedPoint(world, startRef, e.shiftKey || shiftHeld);
      verts[drag.vertexIndex] = pt;
      model.updateSlab(drag.id, { vertices: verts });
      return;
    }

    if (localDrag.type === 'draggingSlabHoleVertex') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const startRef = drag.startHoleVerts[drag.vertexIndex];
      const pt = getSnappedPoint(world, startRef, e.shiftKey || shiftHeld);
      model.updateSlabHoleVertex(drag.id, drag.holeIndex, drag.vertexIndex, pt);
      return;
    }

    if (localDrag.type === 'draggingSlabHoleEdge') {
      const drag = localDrag;
      if (drag.vertexIndex === undefined || drag.vertexIndex >= drag.startHoleVerts.length) { localDrag = { type: 'idle' }; return; }
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const verts = [...drag.startHoleVerts];
      const startRef = drag.startHoleVerts[drag.vertexIndex];
      const pt = getSnappedPoint(world, startRef, e.shiftKey || shiftHeld);
      verts[drag.vertexIndex] = pt;
      model.updateSlabHole(drag.id, drag.holeIndex, verts);
      return;
    }

    if (localDrag.type === 'draggingSlabHole') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      let dx = world.x - drag.startMouse.x;
      let dy = world.y - drag.startMouse.y;
      if (e.shiftKey || shiftHeld) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const newHoleVerts = drag.startHoleVerts.map(v => ({ x: v.x + dx, y: v.y + dy }));
      model.updateSlabHole(drag.id, drag.holeIndex, newHoleVerts);
      return;
    }

    if (localDrag.type === 'draggingDropPanel') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      let dx = world.x - drag.startMouse.x;
      let dy = world.y - drag.startMouse.y;
      if (e.shiftKey || shiftHeld) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      model.updateDropPanel(drag.id, { vertices: drag.startVerts.map(v => ({ x: v.x + dx, y: v.y + dy })) });
      return;
    }

    if (localDrag.type === 'draggingDropPanelVertex') {
      const drag = localDrag;
      if (drag.vertexIndex === undefined || drag.vertexIndex >= drag.startVerts.length) { localDrag = { type: 'idle' }; return; }
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const verts = [...drag.startVerts];
      const startRef = drag.startVerts[drag.vertexIndex];
      const pt = getSnappedPoint(world, startRef, e.shiftKey);
      verts[drag.vertexIndex] = pt;
      model.updateDropPanel(drag.id, { vertices: verts });
      return;
    }

    if (localDrag.type === 'draggingDropPanelEdge') {
      const drag = localDrag;
      if (drag.vertexIndex === undefined || drag.vertexIndex >= drag.startVerts.length) { localDrag = { type: 'idle' }; return; }
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      const verts = [...drag.startVerts];
      const startRef = drag.startVerts[drag.vertexIndex];
      const pt = getSnappedPoint(world, startRef, e.shiftKey);
      verts[drag.vertexIndex] = pt;
      model.updateDropPanel(drag.id, { vertices: verts });
      return;
    }

    if (localDrag.type === 'draggingMulti') {
      const drag = localDrag;
      if (!drag.historyPushed) { model.beginAction(); drag.historyPushed = true; }
      let dx = world.x - drag.startWorld.x;
      let dy = world.y - drag.startWorld.y;
      if (e.shiftKey || shiftHeld) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      for (const [id, orig] of multiDragOriginals) {
        if (orig.type === 'column') {
          const el = model.columns.find(c => c.id === id);
          if (el) model.updateColumn(id, { position: { x: orig.position.x + dx, y: orig.position.y + dy } });
        } else if (orig.type === 'wall') {
          if (model.walls.find(w => w.id === id)) model.updateWall(id, { startPoint: { x: orig.startPoint.x + dx, y: orig.startPoint.y + dy }, endPoint: { x: orig.endPoint.x + dx, y: orig.endPoint.y + dy } });
        } else if (orig.type === 'polylineWall') {
          if (model.polylineWalls.find(w => w.id === id)) model.updatePolylineWall(id, { vertices: orig.vertices.map((v: Point2D) => ({ x: v.x + dx, y: v.y + dy })) });
        } else if (orig.type === 'beam') {
          if (model.beams.find(b => b.id === id)) model.updateBeam(id, { startPoint: { x: orig.startPoint.x + dx, y: orig.startPoint.y + dy }, endPoint: { x: orig.endPoint.x + dx, y: orig.endPoint.y + dy } });
        } else if (orig.type === 'slab') {
          if (model.slabs.find(s => s.id === id)) model.updateSlab(id, { vertices: orig.vertices.map((v: Point2D) => ({ x: v.x + dx, y: v.y + dy })) });
        } else if (orig.type === 'dropPanel') {
          if (model.dropPanels.find(d => d.id === id)) model.updateDropPanel(id, { vertices: orig.vertices.map((v: Point2D) => ({ x: v.x + dx, y: v.y + dy })) });
        }
      }
      return;
    }

    if (localDrag.type === 'panning') {
      model.canvasViewOffsetX += sx - localDrag.last.x;
      model.canvasViewOffsetY += sy - localDrag.last.y;
      localDrag = { type: 'panning', last: { x: sx, y: sy } };
      return;
    }

    if (localDrag.type === 'idle') {
      if (uiState.tool === 'select') {
        const hitCol = hitTestColumns(world, model.columns, blockedIds);
        const hitWall = !hitCol ? hitTestWalls(world, model.walls, blockedIds) : null;
        const hitPW = !hitCol && !hitWall ? hitTestPolylineWalls(world, model.polylineWalls, blockedIds) : null;
        const hitNSW = !hitCol && !hitWall && !hitPW ? hitTestNonStructuralWalls(world, model.nonStructuralWalls, blockedIds) : null;
        const hitNSPW = !hitCol && !hitWall && !hitPW && !hitNSW ? hitTestPolylineNonStructuralWalls(world, model.polylineNonStructuralWalls, blockedIds) : null;
        const hitBeam = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW ? hitTestBeams(world, model.beams, blockedIds) : null;
        const hitDp = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam ? hitTestDropPanels(world, model.dropPanels, blockedIds) : null;
        const hitSlab = !hitCol && !hitWall && !hitPW && !hitNSW && !hitNSPW && !hitBeam && !hitDp ? hitTestSlabs(world, model.slabs, blockedIds) : null;
        if (hitCol) {
          canvasEl.style.cursor = 'move';
        } else if (hitWall) {
          canvasEl.style.cursor = (hitWall.type === 'wallStart' || hitWall.type === 'wallEnd') ? 'move' : 'pointer';
        } else if (hitPW) {
          canvasEl.style.cursor = hitPW.type === 'polylineWallVertex' ? 'move' : 'pointer';
        } else if (hitNSW) {
          canvasEl.style.cursor = (hitNSW.type === 'nonStructuralWallStart' || hitNSW.type === 'nonStructuralWallEnd') ? 'move' : 'pointer';
        } else if (hitNSPW) {
          canvasEl.style.cursor = hitNSPW.type === 'polylineNonStructuralWallVertex' ? 'move' : 'pointer';
        } else if (hitBeam) {
          canvasEl.style.cursor = (hitBeam.type === 'beamStart' || hitBeam.type === 'beamEnd') ? 'move' : 'pointer';
        } else if (hitDp) {
          canvasEl.style.cursor = (hitDp.type === 'dropPanelEdge') ? 'crosshair' : (hitDp.type === 'dropPanelVertex') ? 'move' : 'pointer';
        } else if (hitSlab) {
          canvasEl.style.cursor = (hitSlab.type === 'slabEdge' || hitSlab.type === 'slabHoleEdge') ? 'crosshair' : (hitSlab.type === 'slabVertex' || hitSlab.type === 'slabHoleVertex') ? 'move' : 'pointer';
        } else {
          canvasEl.style.cursor = 'default';
        }
      } else if (uiState.tool === 'pan') {
        canvasEl.style.cursor = 'grab';
      } else {
        canvasEl.style.cursor = 'crosshair';
      }
    }
  }

  function finishSelectionRect(): void {
    if (localDrag.type !== 'selectingRect' || !selectionRectEnd) return;
    const sx = Math.min(localDrag.startScreen.x, selectionRectEnd.x);
    const sy = Math.min(localDrag.startScreen.y, selectionRectEnd.y);
    const ex = Math.max(localDrag.startScreen.x, selectionRectEnd.x);
    const ey = Math.max(localDrag.startScreen.y, selectionRectEnd.y);
    const w1 = screenToWorld(sx, sy);
    const w2 = screenToWorld(ex, ey);
    const minX = Math.min(w1.x, w2.x);
    const maxX = Math.max(w1.x, w2.x);
    const minY = Math.min(w1.y, w2.y);
    const maxY = Math.max(w1.y, w2.y);
    const isLTR = localDrag.startScreen.x <= selectionRectEnd.x;
    const selectedIds: string[] = [];

    for (const col of model.columns) {
      if (isLTR) {
        const halfW = Math.max(col.width / 2, 0.08);
        const halfD = Math.max(col.depth / 2, 0.08);
        if (col.position.x - halfW >= minX && col.position.x + halfW <= maxX &&
            col.position.y - halfD >= minY && col.position.y + halfD <= maxY) {
          selectedIds.push(col.id);
        }
      } else {
        if (col.position.x >= minX && col.position.x <= maxX &&
            col.position.y >= minY && col.position.y <= maxY) {
          selectedIds.push(col.id);
        }
      }
    }

    for (const wall of model.walls) {
      const startIn = wall.startPoint.x >= minX && wall.startPoint.x <= maxX &&
                      wall.startPoint.y >= minY && wall.startPoint.y <= maxY;
      const endIn = wall.endPoint.x >= minX && wall.endPoint.x <= maxX &&
                    wall.endPoint.y >= minY && wall.endPoint.y <= maxY;
      if (isLTR) { if (startIn && endIn) selectedIds.push(wall.id); }
      else { if (startIn || endIn) selectedIds.push(wall.id); }
    }

    for (const pw of model.polylineWalls) {
      const allIn = pw.vertices.every(v => v.x >= minX && v.x <= maxX && v.y >= minY && v.y <= maxY);
      if (isLTR) { if (allIn) selectedIds.push(pw.id); }
      else { if (pw.vertices.some(v => v.x >= minX && v.x <= maxX && v.y >= minY && v.y <= maxY)) selectedIds.push(pw.id); }
    }

    for (const beam of model.beams) {
      const startIn = beam.startPoint.x >= minX && beam.startPoint.x <= maxX &&
                      beam.startPoint.y >= minY && beam.startPoint.y <= maxY;
      const endIn = beam.endPoint.x >= minX && beam.endPoint.x <= maxX &&
                    beam.endPoint.y >= minY && beam.endPoint.y <= maxY;
      if (isLTR) { if (startIn && endIn) selectedIds.push(beam.id); }
      else { if (startIn || endIn) selectedIds.push(beam.id); }
    }

    for (const slab of model.slabs) {
      if (slab.vertices.length >= 3) {
        const slabBB = {
          minX: Math.min(...slab.vertices.map(v => v.x)),
          maxX: Math.max(...slab.vertices.map(v => v.x)),
          minY: Math.min(...slab.vertices.map(v => v.y)),
          maxY: Math.max(...slab.vertices.map(v => v.y)),
        };
        if (isLTR) {
          if (slabBB.minX >= minX && slabBB.maxX <= maxX &&
              slabBB.minY >= minY && slabBB.maxY <= maxY) {
            selectedIds.push(slab.id);
          }
        } else {
          if (slabBB.minX <= maxX && slabBB.maxX >= minX &&
              slabBB.minY <= maxY && slabBB.maxY >= minY) {
            selectedIds.push(slab.id);
          }
        }
      }
    }

    for (const dp of model.dropPanels) {
      if (dp.vertices.length >= 3) {
        const dpBB = {
          minX: Math.min(...dp.vertices.map(v => v.x)),
          maxX: Math.max(...dp.vertices.map(v => v.x)),
          minY: Math.min(...dp.vertices.map(v => v.y)),
          maxY: Math.max(...dp.vertices.map(v => v.y)),
        };
        if (isLTR) {
          if (dpBB.minX >= minX && dpBB.maxX <= maxX &&
              dpBB.minY >= minY && dpBB.maxY <= maxY) {
            selectedIds.push(dp.id);
          }
        } else {
          if (dpBB.minX <= maxX && dpBB.maxX >= minX &&
              dpBB.minY <= maxY && dpBB.maxY >= minY) {
            selectedIds.push(dp.id);
          }
        }
      }
    }

    for (const dim of model.dimensions) {
      const midX = (dim.startPoint.x + dim.endPoint.x) / 2;
      const midY = (dim.startPoint.y + dim.endPoint.y) / 2;
      const inRect = midX >= minX && midX <= maxX && midY >= minY && midY <= maxY;
      if (isLTR) { if (dim.startPoint.x >= minX && dim.startPoint.x <= maxX && dim.startPoint.y >= minY && dim.startPoint.y <= maxY && dim.endPoint.x >= minX && dim.endPoint.x <= maxX && dim.endPoint.y >= minY && dim.endPoint.y <= maxY) selectedIds.push(dim.id); }
      else { if (inRect) selectedIds.push(dim.id); }
    }

    let selType: import('../engine/types').ElementType | null = null;
    if (selectedIds.length === 1) {
      const id = selectedIds[0];
      if (model.columns.some(c => c.id === id)) selType = 'column';
      else if (model.walls.some(w => w.id === id)) selType = 'wall';
      else if (model.polylineWalls.some(w => w.id === id)) selType = 'wall';
      else if (model.beams.some(b => b.id === id)) selType = 'beam';
      else if (model.slabs.some(s => s.id === id)) selType = 'slab';
      else if (model.dropPanels.some(d => d.id === id)) selType = 'dropPanel';
      else if (model.dimensions.some(d => d.id === id)) selType = 'dimension';
    }
    uiState.setSelectedElements(selectedIds, selType);
    uiState.setStatusMessage(selectedIds.length > 0
      ? `Selected ${selectedIds.length} element(s)`
      : 'No elements in selection area');
    localDrag = { type: 'idle' };
    selectionRectEnd = null;
  }

  function handleMouseUp(_e: MouseEvent): void {
    dirty = true;
    if (localDrag.type === 'selectingRect') { finishSelectionRect(); return; }
    if (localDrag.type === 'panning') {
      canvasEl.style.cursor = uiState.tool === 'pan' ? 'grab' : 'default';
      localDrag = savedDrag ?? { type: 'idle' };
      savedDrag = null;
      return;
    }
    if (localDrag.type === 'pendingColumn' || localDrag.type === 'pendingWall' || localDrag.type === 'pendingBeam' || localDrag.type === 'pendingSlab' || localDrag.type === 'pendingSlabVertex' || localDrag.type === 'pendingSlabHoleVertex' || localDrag.type === 'pendingSlabHole' || localDrag.type === 'pendingPolylineWallVertex' || localDrag.type === 'pendingDropPanel' || localDrag.type === 'pendingDropPanelVertex' || localDrag.type === 'pendingMulti') {
      localDrag = { type: 'idle' };
      return;
    }
    if (localDrag.type === 'pendingSlabHoleEdge') {
      const p = localDrag;
      model.beginAction();
      const edgeA = p.startHoleVerts[p.edgeIndex];
      const edgeB = p.startHoleVerts[(p.edgeIndex + 1) % p.startHoleVerts.length];
      const ex = edgeB.x - edgeA.x, ey = edgeB.y - edgeA.y;
      const len2 = ex * ex + ey * ey;
      let t = len2 < 1e-10 ? 0.5 : ((p.startMouse.x - edgeA.x) * ex + (p.startMouse.y - edgeA.y) * ey) / len2;
      t = Math.max(0, Math.min(1, t));
      const newVert = { x: edgeA.x + t * ex, y: edgeA.y + t * ey };
      const newHoleVerts = [...p.startHoleVerts];
      newHoleVerts.splice(p.edgeIndex + 1, 0, newVert);
      model.updateSlabHole(p.id, p.holeIndex, newHoleVerts);
      localDrag = { type: 'idle' };
      return;
    }
    if (localDrag.type === 'pendingSlabEdge') {
      const p = localDrag;
      model.beginAction();
      const edgeA = p.startVerts[p.edgeIndex];
      const edgeB = p.startVerts[(p.edgeIndex + 1) % p.startVerts.length];
      const ex = edgeB.x - edgeA.x, ey = edgeB.y - edgeA.y;
      const len2 = ex * ex + ey * ey;
      let t = len2 < 1e-10 ? 0.5 : ((p.startMouse.x - edgeA.x) * ex + (p.startMouse.y - edgeA.y) * ey) / len2;
      t = Math.max(0, Math.min(1, t));
      const newVert = { x: edgeA.x + t * ex, y: edgeA.y + t * ey };
      const newVerts = [...p.startVerts];
      newVerts.splice(p.edgeIndex + 1, 0, newVert);
      model.updateSlab(p.id, { vertices: newVerts });
      localDrag = { type: 'idle' };
      return;
    }
    if (localDrag.type === 'pendingDropPanelEdge') {
      const p = localDrag;
      model.beginAction();
      const edgeA = p.startVerts[p.edgeIndex];
      const edgeB = p.startVerts[(p.edgeIndex + 1) % p.startVerts.length];
      const ex = edgeB.x - edgeA.x, ey = edgeB.y - edgeA.y;
      const len2 = ex * ex + ey * ey;
      let t = len2 < 1e-10 ? 0.5 : ((p.startMouse.x - edgeA.x) * ex + (p.startMouse.y - edgeA.y) * ey) / len2;
      t = Math.max(0, Math.min(1, t));
      const newVert = { x: edgeA.x + t * ex, y: edgeA.y + t * ey };
      const newVerts = [...p.startVerts];
      newVerts.splice(p.edgeIndex + 1, 0, newVert);
      model.updateDropPanel(p.id, { vertices: newVerts });
      localDrag = { type: 'idle' };
      return;
    }
    if (localDrag.type === 'draggingColumn' || localDrag.type === 'draggingWallBody' || localDrag.type === 'draggingWallStart' || localDrag.type === 'draggingWallEnd' || localDrag.type === 'draggingBeamBody' || localDrag.type === 'draggingBeamStart' || localDrag.type === 'draggingBeamEnd' || localDrag.type === 'draggingPolylineWallVertex' || localDrag.type === 'draggingSlab' || localDrag.type === 'draggingSlabVertex' || localDrag.type === 'draggingSlabEdge' || localDrag.type === 'draggingSlabHoleVertex' || localDrag.type === 'draggingSlabHoleEdge' || localDrag.type === 'draggingSlabHole' || localDrag.type === 'draggingDropPanel' || localDrag.type === 'draggingDropPanelVertex' || localDrag.type === 'draggingDropPanelEdge' || localDrag.type === 'draggingMulti') {
      localDrag = { type: 'idle' };
      return;
    }
    if (localDrag.type !== 'idle') { return; }
  }

  function handleDblClick(_e: MouseEvent): void {
    if (localDrag.type === 'tracingSlab' && localDrag.verts.length >= 3) {
      const verts = localDrag.verts.slice(0, -1);
      model.addSlabFromTrace(verts.length >= 3 ? verts : localDrag.verts);
      uiState.setStatusMessage(`Slab: ${verts.length} vertices`);
      localDrag = { type: 'idle' };
    } else if (localDrag.type === 'tracingHole' && localDrag.verts.length >= 3) {
      const verts = localDrag.verts.slice(0, -1);
      model.addSlabHole(localDrag.slabId, verts.length >= 3 ? verts : localDrag.verts);
      uiState.setStatusMessage(`Opening: ${verts.length} vertices`);
      localDrag = { type: 'idle' };
    } else if (localDrag.type === 'drawingWallPolyline') {
      if (localDrag.verts.length >= 2) {
        model.addPolylineWall(localDrag.verts);
        uiState.setStatusMessage(`Polyline wall: ${localDrag.verts.length} vertices`);
      }
      localDrag = { type: 'idle' };
    } else if (localDrag.type === 'drawingNonStructuralWallPolyline') {
      if (localDrag.verts.length >= 2) {
        model.addPolylineNonStructuralWall(localDrag.verts);
        uiState.setStatusMessage(`Partition polyline: ${localDrag.verts.length} vertices`);
      }
      localDrag = { type: 'idle' };
    }
  }

  async function handleCanvasFileDrop(file: File): Promise<void> {
    try {
      uiState.setStatusMessage('Loading floor plans...');
      if (file.type === 'application/pdf') {
        const pages = await loadPDFPages(file);
        floorLayers.clearAll();
        let firstLayerId = '';
        for (let i = 0; i < pages.length; i++) {
          const id = floorLayers.addLayer(
            `${file.name} (Page ${i + 1})`,
            pages[i].imageData,
            pages[i].naturalWidth,
            pages[i].naturalHeight
          );
          if (i === 0) firstLayerId = id;
        }
        if (firstLayerId) {
          floorLayers.activeLayerId = firstLayerId;
          const active = floorLayers.layers.find(l => l.id === firstLayerId);
          if (active) {
            model.planImage = active.image as ImageBitmap;
            model.imageNaturalWidth = active.width;
            model.imageNaturalHeight = active.height;
          }
        }
        uiState.setStatusMessage(`Loaded PDF: ${file.name} (${pages.length} pages)`);
      } else {
        const plan = await loadPlanFile(file);
        floorLayers.clearAll();
        const id = floorLayers.addLayer(
          file.name,
          plan.imageData,
          plan.naturalWidth,
          plan.naturalHeight
        );
        floorLayers.activeLayerId = id;
        model.planImage = plan.imageData;
        model.imageNaturalWidth = plan.naturalWidth;
        model.imageNaturalHeight = plan.naturalHeight;
        uiState.setStatusMessage(`Loaded image: ${file.name}`);
      }
    } catch (err) {
      uiState.setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleCanvasDrop(e: DragEvent): void {
    e.preventDefault();
    canvasDragFileOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) handleCanvasFileDrop(file);
  }

  function handleResize(): void {
    dirty = true;
    if (containerEl) {
      width = containerEl.clientWidth;
      height = containerEl.clientHeight;
      canvasEl.width = width;
      canvasEl.height = height;
      model.canvasWidth = width;
      model.canvasHeight = height;
    }
  }

  function handleWheel(e: WheelEvent): void {
    dirty = true;
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const ppm = model.pixelsPerMeter;
    if (ppm < 0.001) return;

    const worldX = (mx - model.canvasViewOffsetX) / (model.canvasZoom * ppm);
    const worldY = -(my - model.canvasViewOffsetY) / (model.canvasZoom * ppm);

    const factor = e.deltaY > 0 ? 0.88 : 1.14;
    model.canvasZoom = Math.max(0.05, Math.min(30, model.canvasZoom * factor));

    model.canvasViewOffsetX = mx - worldX * model.canvasZoom * ppm;
    model.canvasViewOffsetY = my + worldY * model.canvasZoom * ppm;
  }

  function handleKeyDown(e: KeyboardEvent): void {
    try {
    dirty = true;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (isDrawingType(localDrag)) {
        localDrag = { type: 'idle' };
        canvasEl.style.cursor = 'default';
        uiState.setStatusMessage('Drawing cancelled');
      } else {
        model.undo();
        uiState.setStatusMessage('Undo');
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      model.redo();
      uiState.setStatusMessage('Redo');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      if (uiState.selectedElementIds.length > 0) {
        e.preventDefault();
        model.copySelected();
        uiState.setStatusMessage(`Copied ${uiState.selectedElementIds.length} element(s)`);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      model.pasteClipboard();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const allIds = [...model.columns.map(c => c.id), ...model.walls.map(w => w.id),
        ...model.polylineWalls.map(w => w.id), ...model.beams.map(b => b.id),
        ...model.slabs.map(s => s.id), ...model.dropPanels.map(d => d.id)];
      if (allIds.length > 0) {
        uiState.setSelectedElements(allIds);
        uiState.setStatusMessage(`Selected ${allIds.length} element(s)`);
      }
      return;
    }
    if (e.key === 'Enter') {
      if (localDrag.type === 'tracingSlab' && localDrag.verts.length >= 3) {
        model.addSlabFromTrace(localDrag.verts);
        uiState.setStatusMessage(`Slab: ${localDrag.verts.length} vertices`);
        localDrag = { type: 'idle' };
      } else if (localDrag.type === 'tracingSlab') {
        uiState.setStatusMessage('Need at least 3 vertices for slab');
      } else if (localDrag.type === 'tracingHole' && localDrag.verts.length >= 3) {
        model.addSlabHole(localDrag.slabId, localDrag.verts);
        uiState.setStatusMessage(`Opening: ${localDrag.verts.length} vertices`);
        localDrag = { type: 'idle' };
      } else if (localDrag.type === 'tracingHole') {
        uiState.setStatusMessage('Need at least 3 vertices for opening');
      } else if (localDrag.type === 'drawingWallPolyline') {
        if (localDrag.verts.length >= 2) {
          model.addPolylineWall(localDrag.verts);
          uiState.setStatusMessage(`Polyline wall: ${localDrag.verts.length} vertices`);
        }
        localDrag = { type: 'idle' };
      } else if (localDrag.type === 'drawingNonStructuralWallPolyline') {
        if (localDrag.verts.length >= 2) {
          model.addPolylineNonStructuralWall(localDrag.verts);
          uiState.setStatusMessage(`Partition polyline: ${localDrag.verts.length} vertices`);
        }
        localDrag = { type: 'idle' };
      }
      return;
    }
    } catch (err) { console.error('[handleKeyDown]', err); }
  }

  function updateDragWithCurrentMouse(): void {
    if (lastMouseEvent) {
      handleMouseMove(lastMouseEvent);
    }
  }

  function onWindowKeyDown(e: KeyboardEvent): void {
    try {
    if (e.key === 'Shift') {
      if (!shiftHeld) {
        shiftHeld = true;
        dirty = true;
        if (localDrag.type !== 'idle') updateDragWithCurrentMouse();
      }
    }
    if (e.key === 'Escape') { e.preventDefault(); handleEscape(); return; }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (uiState.selectedElementType === 'opening' && uiState.selectedElementId && uiState.selectedHoleIndex !== null) {
        e.preventDefault();
        model.deleteSlabHole(uiState.selectedElementId, uiState.selectedHoleIndex);
        uiState.setSelectedElements([]);
        uiState.selectedHoleIndex = null;
        uiState.setStatusMessage('Opening deleted');
        return;
      }
      // General element deletion (single path, not duplicated below)
      const ids = uiState.selectedElementIds.length > 0
        ? uiState.selectedElementIds
        : (uiState.selectedElementId ? [uiState.selectedElementId] : []);
      if (ids.length > 0) {
        e.preventDefault();
        model.deleteElements(ids);
        uiState.setSelectedElements([]);
        uiState.setStatusMessage(ids.length > 1 ? 'Elements deleted' : 'Element deleted');
        return;
      }
    }

    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      switch (e.key) {
        case 'm': case 'M': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('measure'); return;
        case 'c': case 'C': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('column'); return;
        case 'w': case 'W': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('wall'); return;
        case 'b': case 'B': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('beam'); return;
        case 's': case 'S': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('slab'); return;
        case 'o': case 'O': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('opening'); return;
        case 'd': case 'D': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('dropPanel'); return;
        case 'l': case 'L': e.preventDefault(); localDrag = { type: 'idle' }; uiState.setTool('calibrate'); return;
        case 'r': case 'R': e.preventDefault(); model.resetView(); uiState.setStatusMessage('View reset to default'); return;
      }
    }
    } catch (err) { console.error('[onWindowKeyDown]', err); }
  }

  function onWindowKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      shiftHeld = false;
      dirty = true;
      if (localDrag.type !== 'idle') updateDragWithCurrentMouse();
    }
  }

  $effect(() => {
    const _tool = uiState.tool;
    dirty = true;
    localDrag = { type: 'idle' };
    selectionRectEnd = null;
    uiState.selectedHoleIndex = null;
  });

  $effect(() => {
    uiState.theme;
    dirty = true;
  });

  $effect(() => {
    if (model.slabs.length === 0 && model.dropPanels.length === 0 && model.walls.length === 0 && model.polylineWalls.length === 0 && model.beams.length === 0 && model.columns.length === 0 && model.dimensions.length === 0) {
      dirty = true;
      localDrag = { type: 'idle' };
      selectionRectEnd = null;
      uiState.selectedHoleIndex = null;
    }
  });

  function onLayerOpacityChange(): void {
    dirty = true;
  }

  onMount(() => {
    console.log('[Canvas] mounted');
    ctx = canvasEl.getContext('2d')!;
    handleResize();
    // Center origin on first mount
    if (width > 0 && height > 0 && model.canvasViewOffsetX === 0 && model.canvasViewOffsetY === 0) {
      model.canvasViewOffsetX = width / 2;
      model.canvasViewOffsetY = height / 2;
    }
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', onWindowKeyDown);
    window.addEventListener('keyup', onWindowKeyUp);
    window.addEventListener('layer-opacity-changed', onLayerOpacityChange);
    canvasEl.addEventListener('wheel', handleWheel, { passive: false });
    canvasEl.focus();
    render();
  });

  onDestroy(() => {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('keydown', onWindowKeyDown);
    window.removeEventListener('keyup', onWindowKeyUp);
    window.removeEventListener('layer-opacity-changed', onLayerOpacityChange);
    canvasEl.removeEventListener('wheel', handleWheel);
  });
</script>

<div
  bind:this={containerEl}
  class="relative flex-1 overflow-hidden {canvasDragFileOver ? 'ring-2 ring-[#D62430]' : ''}"
  ondragover={(e) => { e.preventDefault(); canvasDragFileOver = true; }}
  ondragleave={() => canvasDragFileOver = false}
  ondrop={handleCanvasDrop}
>
  <canvas
    bind:this={canvasEl}
    class="block outline-none"
    tabindex="0"
    onkeydown={handleKeyDown}
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onmouseleave={() => cursorValue = null}
    ondblclick={handleDblClick}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>
  {#if cursorValue}
    <div
      class="pointer-events-none absolute z-50 rounded px-2 py-1 text-[11px] font-mono shadow-lg whitespace-nowrap {uiState.theme === 'light' ? 'bg-white/95 text-slate-900 border border-slate-300' : 'bg-slate-900/90 text-slate-200 border border-slate-700/50'}"
      style="left: {cursorValue.x + 14}px; top: {cursorValue.y - 8}px; backdrop-filter: blur(4px);"
    >
      {cursorValue.text}
    </div>
  {/if}
</div>