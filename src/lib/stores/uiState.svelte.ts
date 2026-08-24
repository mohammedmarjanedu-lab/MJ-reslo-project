import type { CanvasMode, ToolType, ElementType, ParametricConfig } from '../engine/types';

export const DEFAULT_PARAMETRIC_CONFIG: ParametricConfig = {
  preset: 'flatSlabDrops',
  spansX: 3,
  spansY: 3,
  spacingX: 6.0,
  spacingY: 6.0,
  overhangX: 0.5,
  overhangY: 0.5,
  slabThickness: 200,
  hasDropPanels: true,
  dropDivisor: 3,
  dropWidth: 2.0,
  dropDepth: 2.0,
  dropDrop: 150,
  columnShape: 'rectangular',
  columnWidth: 450,
  columnDepth: 450,
  columnDiameter: 500,
  columnHeight: 3000,
  columnBoundary: 'fixed-fixed',
  concreteGrade: 'M25',
  rebarGrade: 'Fe500',
  deadLoad: 1.5,
  liveLoad: 3.0,
  hasGridBeams: false,
  beamWidth: 300,
  beamDepth: 450,
};

function getSavedApiUrl(): string {
  // 1. Check URL query parameters first (e.g. ?api=https://...) to make shared links foolproof
  if (typeof window !== 'undefined' && window.location) {
    const params = new URLSearchParams(window.location.search);
    const apiParam = params.get('api') || params.get('apiUrl');
    if (apiParam && apiParam.startsWith('http')) {
      const cleanParam = apiParam.replace(/localhost:8000/g, '127.0.0.1:8000').replace(/\/$/, '');
      try {
        localStorage.setItem('reslo_api_url', cleanParam);
      } catch {}
      return cleanParam;
    }

    // 2. Check localStorage if valid for current protocol
    try {
      const saved = localStorage.getItem('reslo_api_url');
      if (saved && saved.startsWith('http')) {
        if (window.location.protocol === 'https:' && saved.startsWith('http://')) {
          localStorage.removeItem('reslo_api_url');
        } else {
          return saved.replace(/localhost:8000/g, '127.0.0.1:8000').replace(/\/$/, '');
        }
      }
    } catch {}

    // 3. If running on unified server (port 8000 or any Cloudflare tunnel / remote host), default to window.location.origin
    if (window.location.origin && !window.location.origin.includes(':5173')) {
      return window.location.origin.replace(/\/$/, '');
    }
  }

  const envUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) ? import.meta.env.VITE_API_URL.replace(/localhost:8000/g, '127.0.0.1:8000') : '';
  if (envUrl) return envUrl.replace(/\/$/, '');

  return 'http://127.0.0.1:8000';
}


class UIState {
  solverEngine = $state<'ts_local' | 'python_backend'>('python_backend');
  mode = $state<CanvasMode>('select');
  tool = $state<ToolType>('select');
  isCanvasInteracting = $state(false);
  selectedElementId = $state<string | null>(null);
  selectedElementType = $state<ElementType | null>(null);
  selectedElementIds = $state<string[]>([]);
  selectedHoleIndex = $state<number | null>(null);
  slabDrawMode = $state<'polygon' | 'rectangular'>('polygon');
  openingDrawMode = $state<'polygon' | 'rectangular'>('polygon');
  wallDrawMode = $state<'single' | 'polyline'>('single');
  partitionDrawMode = $state<'single' | 'polyline'>('single');
  showGrid = $state(true);
  showGrid3D = $state(true);
  snapToGrid = $state(false);
  showLabels = $state(false);
  gridSize = $state(1);
  edgeNodeInsertionEnabled = $state(true);
  contextMenu = $state<{ x: number; y: number } | null>(null);
  showPropertiesPanel = $state(true);
  showFEMResults = $state(true);
  viewMode = $state<'2d' | '3d'>('2d');
  isFEMComputing = $state(false);
  femAutoCompute = $state(false);
  femMeshSize = $state(0.5);
  femUseQ8 = $state(false); // Q8 deferred — needs MITC formulation
  deflectionType = $state<'cracked' | 'uncracked'>('uncracked');
  crackedModifierValue = $state(0.25);
  showDeflectionPanel = $state(true);
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

  // Parametric Study State
  showParametricStudyDialog = $state(false);
  showParametricLivePanel = $state(false);
  parametricConfig = $state<ParametricConfig>({ ...DEFAULT_PARAMETRIC_CONFIG });

  // New 3D / result visualization state
  colorRamp = $state<'jet' | 'viridis' | 'diverging' | 'thermal' | 'cool_warm'>('jet');
  show3DPlanOverlay = $state(false);
  showColorLegend = $state(true);
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
  wallThickness = $state(250); // mm
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
  layersPanel = $state({ x: 0, y: 12, w: 260, h: 380, initialized: false });
  propertiesPanel = $state({ x: 0, y: 0, w: 340, h: 420, initialized: false });

  initPanels(windowWidth: number, windowHeight: number): void {
    if (windowWidth > 100) {
      if (!this.layersPanel.initialized || this.layersPanel.x <= 0) {
        this.layersPanel.w = 260;
        this.layersPanel.h = 380;
        this.layersPanel.x = Math.max(10, windowWidth - 220 - 12 - this.layersPanel.w - 12);
        this.layersPanel.y = 12;
        this.layersPanel.initialized = true;
      }
      if (!this.propertiesPanel.initialized) {
        this.propertiesPanel.x = windowWidth - this.propertiesPanel.w - 20;
        this.propertiesPanel.y = 440;
        this.propertiesPanel.initialized = true;
      }
    }
  }
}

// Apply saved theme immediately to avoid flash-of-wrong-theme
if (typeof document !== 'undefined') {
  const saved = localStorage.getItem('reslo_theme');
  document.documentElement.classList.toggle('light-theme', saved === 'light');
}

export const uiState = new UIState();
