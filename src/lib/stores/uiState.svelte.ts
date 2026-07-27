import type { CanvasMode, ToolType, ElementType } from '../engine/types';

function getSavedApiUrl(): string {
  // 1. Check URL query parameters first (e.g. ?api=https://...) to make shared links foolproof
  if (typeof window !== 'undefined' && window.location) {
    const params = new URLSearchParams(window.location.search);
    const apiParam = params.get('api') || params.get('apiUrl');
    if (apiParam && apiParam.startsWith('http')) {
      try {
        localStorage.setItem('reslo_api_url', apiParam);
      } catch {}
      return apiParam;
    }
  }

  const envUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || 'http://127.0.0.1:8000';
  try {
    const saved = localStorage.getItem('reslo_api_url');
    // Reject stale ephemeral Cloudflare/ngrok tunnels stored in localStorage unless explicitly passed via ?api=...
    if (saved && saved.startsWith('http') && !saved.includes('trycloudflare.com') && !saved.includes('ngrok') && !saved.includes('glass-worm-supervision-mercury')) {
      return saved;
    }
    return envUrl;
  }
  catch { return envUrl; }
}


class UIState {
  mode = $state<CanvasMode>('select');
  tool = $state<ToolType>('select');
  selectedElementId = $state<string | null>(null);
  selectedElementType = $state<ElementType | null>(null);
  selectedElementIds = $state<string[]>([]);
  selectedHoleIndex = $state<number | null>(null);
  slabDrawMode = $state<'polygon' | 'rectangular'>('polygon');
  openingDrawMode = $state<'polygon' | 'rectangular'>('polygon');
  wallDrawMode = $state<'single' | 'polyline'>('single');
  partitionDrawMode = $state<'single' | 'polyline'>('single');
  showGrid = $state(true);
  snapToGrid = $state(false);
  showLabels = $state(false);
  gridSize = $state(1);
  edgeNodeInsertionEnabled = $state(true);
  contextMenu = $state<{ x: number; y: number } | null>(null);
  showPropertiesPanel = $state(true);
  showFEMResults = $state(false);
  viewMode = $state<'2d' | '3d'>('2d');
  isFEMComputing = $state(false);
  femAutoCompute = $state(false);
  femMeshSize = $state(0.5);
  femUseQ8 = $state(false); // Q8 deferred — needs MITC formulation
  deflectionType = $state<'cracked' | 'uncracked'>('uncracked');
  crackedModifierValue = $state(0.25);
  calibrationPoint1 = $state<{ x: number; y: number } | null>(null);
  showCalibrationDialog = $state(false);
  calibrationPendingData = $state<{ p1Screen: { x: number; y: number }; p2Screen: { x: number; y: number } } | null>(null);
  statusMessage = $state('Ready');
  isSelecting = $state(false);
  showExportDialog = $state(false);
  isDrawing = $state(false);
  snappedPoint = $state<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  cancelDrawing: (() => void) | null = null;
  vertexEditTarget = $state<{ elementId: string; vertexIndex: number } | null>(null);
  theme = $state<'dark' | 'light'>(
    (typeof window !== 'undefined' && (localStorage.getItem('reslo_theme') as 'dark' | 'light')) || 'dark'
  );

  // Backend API URL (persisted in localStorage)
  apiUrl = $state<string>(getSavedApiUrl());
  backendConnected = $state(false);

  // New 3D / result visualization state
  colorRamp = $state<'jet' | 'viridis' | 'diverging' | 'thermal' | 'cool_warm'>('jet');
  show3DPlanOverlay = $state(false);
  showColorLegend = $state(true);
  showNodeNumbers = $state(false);
  showElementNumbers = $state(false);
  femAnimationEnabled = $state(false);
  femAnimationScale = $state(1);
  viewPreset = $state<'top' | 'front' | 'side' | 'iso' | 'perspective'>('iso');
  resetViewTrigger = $state(0);
  showSectionCut = $state(false);
  sectionCutPosition = $state(0);
  resultUnitOverride: { [key: string]: string } = {};

  setApiUrl(url: string): void {
    this.apiUrl = url;
    try { localStorage.setItem('reslo_api_url', url); } catch {}
  }

  // Placement defaults (mm)
  placementWidth = $state(500);
  placementDepth = $state(500);
  placementHeight = $state(3000);
  columnShape = $state<'rectangular' | 'circular'>('rectangular');
  placementDiameter = $state(500);
  wallThickness = $state(200); // mm
  beamWidth = $state(300); // mm
  beamDepth = $state(450); // mm
  dropPanelWidth = $state(1500); // mm
  dropPanelDepth = $state(1500); // mm
  dropPanelDrop = $state(150); // mm (extra thickness below slab)

  setMode(m: CanvasMode): void {
    this.mode = m;
    if (m === 'select') this.tool = 'select';
    else if (m === 'placeColumn') this.tool = 'column';
    else if (m === 'drawWall') this.tool = 'wall';
    else if (m === 'drawNonStructuralWall') this.tool = 'nonStructuralWall';
    else if (m === 'drawBeam') this.tool = 'beam';
    else if (m === 'traceSlab') this.tool = 'slab';
    else if (m === 'traceOpening') this.tool = 'opening';
    else if (m === 'calibrate') this.tool = 'calibrate';
    else if (m === 'pan') this.tool = 'pan';
    else if (m === 'measure') this.tool = 'measure';
    else if (m === 'placeDropPanel') this.tool = 'dropPanel';
  }

  setTool(t: ToolType): void {
    this.tool = t;
    if (t === 'select') this.mode = 'select';
    else if (t === 'column') this.mode = 'placeColumn';
    else if (t === 'wall') this.mode = 'drawWall';
    else if (t === 'nonStructuralWall') this.mode = 'drawNonStructuralWall';
    else if (t === 'beam') this.mode = 'drawBeam';
    else if (t === 'slab') this.mode = 'traceSlab';
    else if (t === 'opening') this.mode = 'traceOpening';
    else if (t === 'pan') this.mode = 'pan';
    else if (t === 'calibrate') this.mode = 'calibrate';
    else if (t === 'measure') this.mode = 'measure';
    else if (t === 'dropPanel') this.mode = 'placeDropPanel';
    if (t !== 'select') this.selectedElementIds = [];
  }

  selectElement(id: string | null, type: ElementType | null): void {
    this.selectedElementId = id;
    this.selectedElementType = type;
    this.selectedElementIds = id ? [id] : [];
    this.showPropertiesPanel = id !== null;
    if (type !== 'opening') {
      this.selectedHoleIndex = null;
    }
  }

  setSelectedElements(ids: string[], elementType?: ElementType | null): void {
    this.selectedElementIds = ids;
    this.selectedElementId = ids.length === 1 ? ids[0] : null;
    if (elementType !== undefined) {
      this.selectedElementType = elementType;
      if (elementType !== 'opening') {
        this.selectedHoleIndex = null;
      }
    }
    if (ids.length === 0) {
      this.selectedElementType = null;
      this.showPropertiesPanel = false;
      this.selectedHoleIndex = null;
    } else if (ids.length === 1) {
      this.showPropertiesPanel = true;
      if (this.selectedElementType !== 'opening') {
        this.selectedHoleIndex = null;
      }
    } else {
      this.showPropertiesPanel = false;
      this.selectedHoleIndex = null;
    }
  }

  get hasSelection(): boolean {
    return this.selectedElementIds.length > 0;
  }

  isSelected(id: string): boolean {
    return this.selectedElementIds.includes(id);
  }

  setContextMenu(pos: { x: number; y: number } | null): void {
    this.contextMenu = pos;
  }

  // Visibility toggles
  showSlabs = $state(true);
  showColumns = $state(true);
  showWalls = $state(true);
  showNonStructuralWalls = $state(true);
  showBeams = $state(true);
  showDropPanels = $state(true);

  showAllElements(): void {
    this.showSlabs = true;
    this.showColumns = true;
    this.showWalls = true;
    this.showNonStructuralWalls = true;
    this.showBeams = true;
    this.showDropPanels = true;
  }

  setCalibrationPoint1(p: { x: number; y: number } | null): void {
    this.calibrationPoint1 = p;
  }

  setStatusMessage(msg: string): void {
    this.statusMessage = msg;
  }

  setShowFEMResults(v: boolean): void {
    this.showFEMResults = v;
  }

  setViewMode(mode: '2d' | '3d'): void {
    this.viewMode = mode;
    if (mode === '3d') {
      this.setTool('select');
      this.setStatusMessage('3D View — switch back to 2D plan view to edit elements');
    } else {
      this.setStatusMessage('2D Plan View');
    }
  }

  // Draggable and Resizable Panels positioning
  layersPanel = $state({ x: 0, y: 0, w: 260, h: 320, initialized: false });
  propertiesPanel = $state({ x: 0, y: 0, w: 340, h: 420, initialized: false });

  initPanels(windowWidth: number, windowHeight: number): void {
    if (!this.layersPanel.initialized && windowWidth > 100) {
      this.layersPanel.x = windowWidth - 280;
      this.layersPanel.y = 80;
      this.layersPanel.initialized = true;
    }
    if (!this.propertiesPanel.initialized && windowWidth > 100) {
      this.propertiesPanel.x = windowWidth - this.propertiesPanel.w - 20;
      this.propertiesPanel.y = 440;
      this.propertiesPanel.initialized = true;
    }
  }
}

// Apply saved theme immediately to avoid flash-of-wrong-theme
if (typeof document !== 'undefined') {
  const saved = localStorage.getItem('reslo_theme');
  document.documentElement.classList.toggle('light-theme', saved === 'light');
}

export const uiState = new UIState();
