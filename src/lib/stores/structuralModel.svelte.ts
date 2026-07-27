import type { SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, BeamElement, Dimension, Point2D, BoundaryCondition, DropPanelElement, NonStructuralWallElement, PolylineNonStructuralWallElement } from '../engine/types';
import { ScaleCalibrator, computeScaleLabel } from '../engine/scaleCalibrator';
import { HistoryManager } from './history.svelte';
import { uiState } from './uiState.svelte';
import { femState } from './femResults.svelte';
import { floorLayers } from './floorLayers.svelte';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

function getNextLabelSuffix(prefix: string, currentLabels: string[]): string {
  let max = 0;
  const regex = new RegExp(`^${prefix}-(\\d+)$`);
  for (const label of currentLabels) {
    const match = label.match(regex);
    if (match) {
      const val = parseInt(match[1], 10);
      if (val > max) max = val;
    }
  }
  const nextNum = max + 1;
  return `${prefix}-${String(nextNum).padStart(2, '0')}`;
}

const GRADE_TABLE: Record<string, number> = { 'M20': 20, 'M25': 25, 'M30': 30, 'M35': 35, 'M40': 40, 'M45': 45, 'M50': 50, 'M55': 55, 'M60': 60 };

function materialForGrade(grade: string): { elasticModulus: number; concreteDensity: number } {
  const fck = GRADE_TABLE[grade] ?? 25;
  return { elasticModulus: 5000 * Math.sqrt(fck) * 1000, concreteDensity: 25 };
}

function wallMaterialForGrade(grade: string): { elasticModulus: number; shearModulus: number; concreteDensity: number } {
  const base = materialForGrade(grade);
  return { ...base, shearModulus: base.elasticModulus / (2 * (1 + 0.2)) };
}

function newSlab(vertices: Point2D[] = [], grade = 'M25', existingLabels: string[] = []): SlabPolygon {
  const props = materialForGrade(grade);
  return {
    id: genId('S'),
    label: getNextLabelSuffix('S', existingLabels),
    vertices: vertices.map(v => ({ ...v })), holes: [],
    thickness: 0.2, uniformLoad: 5, partitionLoad: 0, concreteGrade: grade, ...props, crackingModifier: 1.0,
  };
}

function computeDropPanelVerts(center: Point2D, width: number, depth: number, rotation: number): Point2D[] {
  const hw = width / 2, hd = depth / 2;
  const cosT = Math.cos(rotation), sinT = Math.sin(rotation);
  const local = [{ x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd }];
  return local.map(p => ({
    x: center.x + p.x * cosT - p.y * sinT,
    y: center.y + p.x * sinT + p.y * cosT,
  }));
}

let clipboard: { columns: ColumnElement[]; walls: ShearWallElement[]; polylineWalls: PolylineWallElement[]; beams: BeamElement[]; slabs: SlabPolygon[]; dropPanels: DropPanelElement[]; nonStructuralWalls: NonStructuralWallElement[]; polylineNonStructuralWalls: PolylineNonStructuralWallElement[] } | null = null;

export function getClipboard() { return clipboard; }
export function setClipboard(c: typeof clipboard) { clipboard = c; }

class StructuralModel {
  calibrator = new ScaleCalibrator();
  slabs = $state<SlabPolygon[]>([]);
  dropPanels = $state<DropPanelElement[]>([]);
  columns = $state<ColumnElement[]>([]);
  walls = $state<ShearWallElement[]>([]);
  polylineWalls = $state<PolylineWallElement[]>([]);
  nonStructuralWalls = $state<NonStructuralWallElement[]>([]);
  polylineNonStructuralWalls = $state<PolylineNonStructuralWallElement[]>([]);
  beams = $state<BeamElement[]>([]);
  dimensions = $state<Dimension[]>([]);
  hiddenElementIds = $state<string[]>([]);
  lockedElementIds = $state<string[]>([]);
  planImage = $state<ImageBitmap | null>(null);
  imageNaturalWidth = $state(0);
  imageNaturalHeight = $state(0);
  canvasViewOffsetX = $state(0);
  canvasViewOffsetY = $state(0);
  canvasZoom = $state(1);
  canvasWidth = $state(800);
  canvasHeight = $state(600);
  isCalibrated = $state(false);
  calibratedLabel = $state('○ Not calibrated');
  _pixelsPerMeter = $state(100);
  get pixelsPerMeter(): number {
    return this._pixelsPerMeter;
  }
  set pixelsPerMeter(val: number) {
    this._pixelsPerMeter = val;
    this.calibrator.pixelsPerMeter = val;
  }

  // Material properties
  concreteGrade = $state('M25');
  rebarGrade = $state('Fe415');

  // Project name for Save As
  projectName = $state('project');

  history = new HistoryManager();
  private _createdAt = Date.now();
  private _isRestoring = false;

  get screenScale(): number {
    return this.calibrator.pixelsPerMeter * this.canvasZoom;
  }

  get concreteFck(): number {
    const grades: Record<string, number> = { 'M20': 20, 'M25': 25, 'M30': 30, 'M35': 35, 'M40': 40, 'M45': 45, 'M50': 50, 'M55': 55, 'M60': 60 };
    return grades[this.concreteGrade] ?? 25;
  }

  get rebarFy(): number {
    const grades: Record<string, number> = { 'Fe250': 250, 'Fe415': 415, 'Fe500': 500, 'Fe550': 550, 'Fe600': 600 };
    return grades[this.rebarGrade] ?? 415;
  }

  setCalibrated(): void {
    this.isCalibrated = true;
    this.pixelsPerMeter = this.calibrator.pixelsPerMeter;
    this.calibratedLabel = `✓ Calibrated (${computeScaleLabel(this.pixelsPerMeter)})`;
  }

  private _snapshot() {
    return {
      columns: JSON.parse(JSON.stringify(this.columns)),
      walls: JSON.parse(JSON.stringify(this.walls)),
      polylineWalls: JSON.parse(JSON.stringify(this.polylineWalls)),
      nonStructuralWalls: JSON.parse(JSON.stringify(this.nonStructuralWalls)),
      polylineNonStructuralWalls: JSON.parse(JSON.stringify(this.polylineNonStructuralWalls)),
      beams: JSON.parse(JSON.stringify(this.beams)),
      slabs: JSON.parse(JSON.stringify(this.slabs)),
      dropPanels: JSON.parse(JSON.stringify(this.dropPanels)),
      dimensions: JSON.parse(JSON.stringify(this.dimensions)),
      hiddenElementIds: [...this.hiddenElementIds],
      lockedElementIds: [...this.lockedElementIds],
    };
  }

  /** Serialize full project state for file save / localStorage */
  serialize(): string {
    const data = {
      version: 1,
      projectName: this.projectName,
      createdAt: this._createdAt,
      modifiedAt: Date.now(),
      concreteGrade: this.concreteGrade,
      rebarGrade: this.rebarGrade,
      elements: {
        columns: this.columns.map(c => ({
          id: c.id,
          position: { x: c.position.x, y: c.position.y },
          width: c.width,
          depth: c.depth,
          height: c.height,
          rotation: c.rotation,
          elasticModulus: c.elasticModulus,
          concreteDensity: c.concreteDensity,
          label: c.label,
          boundaryCondition: c.boundaryCondition,
          shape: c.shape,
          diameter: c.diameter,
          concreteGrade: c.concreteGrade,
          color: c.color,
        })),
        walls: this.walls.map(w => ({
          id: w.id,
          startPoint: { x: w.startPoint.x, y: w.startPoint.y },
          endPoint: { x: w.endPoint.x, y: w.endPoint.y },
          thickness: w.thickness,
          height: w.height,
          elasticModulus: w.elasticModulus,
          shearModulus: w.shearModulus,
          concreteDensity: w.concreteDensity,
          label: w.label,
          boundaryCondition: w.boundaryCondition,
          concreteGrade: w.concreteGrade,
          poissonRatio: w.poissonRatio,
          color: w.color,
        })),
        polylineWalls: this.polylineWalls.map(w => ({
          id: w.id,
          vertices: w.vertices.map(v => ({ x: v.x, y: v.y })),
          thickness: w.thickness,
          height: w.height,
          elasticModulus: w.elasticModulus,
          shearModulus: w.shearModulus,
          concreteDensity: w.concreteDensity,
          label: w.label,
          boundaryCondition: w.boundaryCondition,
          concreteGrade: w.concreteGrade,
          poissonRatio: w.poissonRatio,
          color: w.color,
        })),
        nonStructuralWalls: this.nonStructuralWalls.map(w => ({
          id: w.id,
          startPoint: { x: w.startPoint.x, y: w.startPoint.y },
          endPoint: { x: w.endPoint.x, y: w.endPoint.y },
          thickness: w.thickness,
          height: w.height,
          label: w.label,
          color: w.color,
          partitionUnitWeight: w.partitionUnitWeight,
        })),
        polylineNonStructuralWalls: this.polylineNonStructuralWalls.map(w => ({
          id: w.id,
          vertices: w.vertices.map(v => ({ x: v.x, y: v.y })),
          thickness: w.thickness,
          height: w.height,
          label: w.label,
          color: w.color,
          partitionUnitWeight: w.partitionUnitWeight,
        })),
        beams: this.beams.map(b => ({
          id: b.id,
          startPoint: { x: b.startPoint.x, y: b.startPoint.y },
          endPoint: { x: b.endPoint.x, y: b.endPoint.y },
          width: b.width,
          depth: b.depth,
          height: b.height,
          elasticModulus: b.elasticModulus,
          concreteDensity: b.concreteDensity,
          label: b.label,
          concreteGrade: b.concreteGrade,
          color: b.color,
        })),
        slabs: this.slabs.map(s => ({
          id: s.id,
          label: s.label,
          vertices: s.vertices.map(v => ({ x: v.x, y: v.y })),
          holes: s.holes.map(h => h.map(v => ({ x: v.x, y: v.y }))),
          thickness: s.thickness,
          concreteDensity: s.concreteDensity,
          uniformLoad: s.uniformLoad,
          partitionLoad: s.partitionLoad,
          elasticModulus: s.elasticModulus,
          concreteGrade: s.concreteGrade,
          color: s.color,
          crackingModifier: s.crackingModifier,
        })),
        dropPanels: this.dropPanels.map(d => ({
          id: d.id,
          vertices: d.vertices.map(v => ({ x: v.x, y: v.y })),
          center: { x: d.center.x, y: d.center.y },
          width: d.width,
          depth: d.depth,
          rotation: d.rotation,
          drop: d.drop,
          label: d.label,
          parentColumnId: d.parentColumnId,
          concreteGrade: d.concreteGrade,
          elasticModulus: d.elasticModulus,
          concreteDensity: d.concreteDensity,
        })),
        dimensions: this.dimensions.map(d => ({
          id: d.id,
          startPoint: { x: d.startPoint.x, y: d.startPoint.y },
          endPoint: { x: d.endPoint.x, y: d.endPoint.y },
          distance: d.distance,
        })),
      },
      view: {
        offsetX: this.canvasViewOffsetX,
        offsetY: this.canvasViewOffsetY,
        zoom: this.canvasZoom,
      },
      calibration: {
        isCalibrated: this.isCalibrated,
        pixelsPerMeter: this.calibrator.pixelsPerMeter,
      },
      hiddenElementIds: [...this.hiddenElementIds],
      lockedElementIds: [...this.lockedElementIds],
    };
    return JSON.stringify(data, null, 2);
  }

  /** Deserialize and restore full project state */
  deserialize(json: string): void {
    const data = JSON.parse(json);
    if (!data.elements) throw new Error('Invalid project file');
    this._isRestoring = true;
    this.columns = data.elements.columns ?? [];
    // Migrate old-format non-structural walls into new arrays
    const oldWalls: ShearWallElement[] = data.elements.walls ?? [];
    const oldPW: PolylineWallElement[] = data.elements.polylineWalls ?? [];
    this.nonStructuralWalls = (data.elements.nonStructuralWalls ?? []).map((w: NonStructuralWallElement) => ({ ...w }))
      .concat(oldWalls.filter(w => w.nonStructural).map(w => ({ id: w.id, startPoint: w.startPoint, endPoint: w.endPoint, thickness: w.thickness, height: w.height, label: w.label, color: w.color, partitionUnitWeight: w.partitionUnitWeight })));
    this.polylineNonStructuralWalls = (data.elements.polylineNonStructuralWalls ?? []).map((w: PolylineNonStructuralWallElement) => ({ ...w }))
      .concat(oldPW.filter(w => w.nonStructural).map(w => ({ id: w.id, vertices: w.vertices, thickness: w.thickness, height: w.height, label: w.label, color: w.color, partitionUnitWeight: w.partitionUnitWeight })));
    this.walls = oldWalls.filter(w => !w.nonStructural);
    this.polylineWalls = oldPW.filter(w => !w.nonStructural);
    this.beams = data.elements.beams ?? [];
    this.slabs = (data.elements.slabs ?? []).map((s: SlabPolygon, i: number) => ({
      ...s,
      label: s.label ?? `S-${String(i + 1).padStart(2, '0')}`,
      crackingModifier: s.crackingModifier ?? 1.0,
    }));
    this.dropPanels = data.elements.dropPanels ?? [];
    this.dimensions = data.elements.dimensions ?? [];
    this.hiddenElementIds = data.hiddenElementIds ?? [];
    this.lockedElementIds = data.lockedElementIds ?? [];
    if (data.concreteGrade) this.concreteGrade = data.concreteGrade;
    if (data.rebarGrade) this.rebarGrade = data.rebarGrade;
    if (data.projectName) this.projectName = data.projectName;
    if (data.view) {
      this.canvasViewOffsetX = data.view.offsetX ?? 0;
      this.canvasViewOffsetY = data.view.offsetY ?? 0;
      this.canvasZoom = data.view.zoom ?? 1;
    }
    if (data.calibration) {
      this.isCalibrated = data.calibration.isCalibrated ?? false;
      this.pixelsPerMeter = data.calibration.pixelsPerMeter ?? 100;
      if (this.isCalibrated) {
        this.setCalibrated();
      }
    }
    femState.clear();
    uiState.femAutoCompute = false;
    this.history.reset();
    this._isRestoring = false;
  }

  /** Download project as .9e file — uses native Save As dialog when available */
  async saveToFile(): Promise<void> {
    const json = this.serialize();
    const blob = new Blob([json], { type: 'application/json' });

    // Try the File System Access API (Chromium browsers)
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: `${this.projectName}.9e`,
          types: [
            { description: 'Reslo Project', accept: { 'application/json': ['.9e'] } },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        this.projectName = handle.name.replace(/\.9e$/, '') || this.projectName;
        uiState.setStatusMessage(`Saved as ${handle.name}`);
        return;
      } catch (e: any) {
        if (e.name === 'AbortError') return; // user cancelled
      }
    }

    // Fallback: prompt for filename, then download
    const name = prompt('Enter file name:', this.projectName);
    if (name === null) return;
    const fileName = name.trim() || this.projectName;
    this.projectName = fileName;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName}.9e`;
    a.click();
    URL.revokeObjectURL(a.href);
    uiState.setStatusMessage(`Saved as ${fileName}.9e`);
  }

  /** Load project from .9e file */
  loadFromFile(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          this.deserialize(reader.result as string);
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  /** Auto-save to localStorage (debounced) */
  private _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  saveToLocalStorage(): void {
    try {
      const json = this.serialize();
      localStorage.setItem('reslo-project', json);
    } catch { /* quota exceeded — silently ignore */ }
  }

  /** Load from localStorage */
  loadFromLocalStorage(): boolean {
    try {
      const json = localStorage.getItem('reslo-project');
      if (json) {
        this.deserialize(json);
        return true;
      }
    } catch { /* silent */ }
    return false;
  }

  /** Schedule auto-save (call after each mutation) */
  scheduleAutoSave(): void {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => this.saveToLocalStorage(), 2000);
  }

  private _restore(snap: { columns: ColumnElement[]; walls: ShearWallElement[]; polylineWalls: PolylineWallElement[]; nonStructuralWalls?: NonStructuralWallElement[]; polylineNonStructuralWalls?: PolylineNonStructuralWallElement[]; beams: BeamElement[]; slabs: SlabPolygon[]; dropPanels: DropPanelElement[]; dimensions: Dimension[]; hiddenElementIds?: string[]; lockedElementIds?: string[] }): void {
    this.columns = snap.columns;
    this.walls = snap.walls;
    this.polylineWalls = snap.polylineWalls;
    this.nonStructuralWalls = snap.nonStructuralWalls ?? [];
    this.polylineNonStructuralWalls = snap.polylineNonStructuralWalls ?? [];
    this.beams = snap.beams;
    this.slabs = snap.slabs;
    this.dropPanels = snap.dropPanels;
    this.dimensions = snap.dimensions;
    if (snap.hiddenElementIds) this.hiddenElementIds = snap.hiddenElementIds;
    if (snap.lockedElementIds) this.lockedElementIds = snap.lockedElementIds;
    femState.clear();
    this.scheduleAutoSave();
  }

  beginAction(): void {
    if (!this._isRestoring) {
      this.history.push(this._snapshot());
    }
  }

  undo(): void {
    const snap = this.history.undo();
    if (snap) {
      this._isRestoring = true;
      this._restore(snap);
      this._isRestoring = false;
    }
  }

  redo(): void {
    const snap = this.history.redo();
    if (snap) {
      this._isRestoring = true;
      this._restore(snap);
      this._isRestoring = false;
    }
  }

  copySelected(): void {
    const ids = uiState.selectedElementIds;
    const copied: typeof clipboard = { columns: [], walls: [], polylineWalls: [], beams: [], slabs: [], dropPanels: [], nonStructuralWalls: [], polylineNonStructuralWalls: [] };
    for (const id of ids) {
      const col = this.columns.find(c => c.id === id);
      if (col) copied.columns.push(JSON.parse(JSON.stringify(col)));
      const wall = this.walls.find(w => w.id === id);
      if (wall) copied.walls.push(JSON.parse(JSON.stringify(wall)));
      const pwall = this.polylineWalls.find(w => w.id === id);
      if (pwall) copied.polylineWalls.push(JSON.parse(JSON.stringify(pwall)));
      const nswall = this.nonStructuralWalls.find(w => w.id === id);
      if (nswall) copied.nonStructuralWalls.push(JSON.parse(JSON.stringify(nswall)));
      const nspwall = this.polylineNonStructuralWalls.find(w => w.id === id);
      if (nspwall) copied.polylineNonStructuralWalls.push(JSON.parse(JSON.stringify(nspwall)));
      const beam = this.beams.find(b => b.id === id);
      if (beam) copied.beams.push(JSON.parse(JSON.stringify(beam)));
      const slab = this.slabs.find(s => s.id === id);
      if (slab) copied.slabs.push(JSON.parse(JSON.stringify(slab)));
      const dp = this.dropPanels.find(d => d.id === id);
      if (dp) copied.dropPanels.push(JSON.parse(JSON.stringify(dp)));
    }
    setClipboard(copied);
  }

  pasteClipboard(): void {
    const cb = getClipboard();
    if (!cb) return;
    this.beginAction();
    const offset = 1.5;
    const pastedIds: string[] = [];
    for (const col of cb.columns) {
      const id = genId('C');
      let targetX = col.position.x + offset;
      let targetY = col.position.y + offset;
      if (uiState.snapToGrid && uiState.gridSize > 0) {
        const gs = uiState.gridSize;
        targetX = Math.round(targetX / gs) * gs;
        targetY = Math.round(targetY / gs) * gs;
      }
      const newLabel = getNextLabelSuffix('C', this.columns.map(c => c.label));
      const newCol = { ...col, id, position: { x: targetX, y: targetY }, label: newLabel };
      this.columns = [...this.columns, newCol];
      pastedIds.push(id);
    }
    for (const wall of cb.walls) {
      const id = genId('W');
      const newLabel = getNextLabelSuffix('W', this.walls.map(w => w.label));
      const newWall = { ...wall, id, startPoint: { x: wall.startPoint.x + offset, y: wall.startPoint.y + offset }, endPoint: { x: wall.endPoint.x + offset, y: wall.endPoint.y + offset }, label: newLabel };
      this.walls = [...this.walls, newWall];
      pastedIds.push(id);
    }
    for (const pwall of cb.polylineWalls) {
      const id = genId('PW');
      const newVerts = pwall.vertices.map(v => ({ x: v.x + offset, y: v.y + offset }));
      const newLabel = getNextLabelSuffix('PW', this.polylineWalls.map(w => w.label));
      const newPwall = { ...pwall, id, vertices: newVerts, label: newLabel };
      this.polylineWalls = [...this.polylineWalls, newPwall];
      pastedIds.push(id);
    }
    for (const nswall of cb.nonStructuralWalls) {
      const id = genId('NW');
      const newLabel = getNextLabelSuffix('NW', this.nonStructuralWalls.map(w => w.label));
      const newNswall = { ...nswall, id, startPoint: { x: nswall.startPoint.x + offset, y: nswall.startPoint.y + offset }, endPoint: { x: nswall.endPoint.x + offset, y: nswall.endPoint.y + offset }, label: newLabel };
      this.nonStructuralWalls = [...this.nonStructuralWalls, newNswall];
      pastedIds.push(id);
    }
    for (const nspwall of cb.polylineNonStructuralWalls) {
      const id = genId('NPW');
      const newVerts = nspwall.vertices.map(v => ({ x: v.x + offset, y: v.y + offset }));
      const newLabel = getNextLabelSuffix('NPW', this.polylineNonStructuralWalls.map(w => w.label));
      const newNspwall = { ...nspwall, id, vertices: newVerts, label: newLabel };
      this.polylineNonStructuralWalls = [...this.polylineNonStructuralWalls, newNspwall];
      pastedIds.push(id);
    }
    for (const beam of cb.beams) {
      const id = genId('B');
      const newLabel = getNextLabelSuffix('B', this.beams.map(b => b.label));
      const newBeam = { ...beam, id, startPoint: { x: beam.startPoint.x + offset, y: beam.startPoint.y + offset }, endPoint: { x: beam.endPoint.x + offset, y: beam.endPoint.y + offset }, label: newLabel };
      this.beams = [...this.beams, newBeam];
      pastedIds.push(id);
    }
    for (const slab of cb.slabs) {
      const id = genId('S');
      const newLabel = getNextLabelSuffix('S', this.slabs.map(s => s.label));
      const newVerts = slab.vertices.map(v => ({ x: v.x + offset, y: v.y + offset }));
      const newHoles = slab.holes.map(h => h.map(v => ({ x: v.x + offset, y: v.y + offset })));
      const newSlab = { ...slab, id, label: newLabel, vertices: newVerts, holes: newHoles };
      this.slabs = [...this.slabs, newSlab];
      pastedIds.push(id);
    }
    for (const dp of (cb.dropPanels || [])) {
      const id = genId('DP');
      const newVerts = dp.vertices.map(v => ({ x: v.x + offset, y: v.y + offset }));
      const newLabel = getNextLabelSuffix('DP', this.dropPanels.map(d => d.label));
      const newDp = { ...dp, id, vertices: newVerts, center: { x: dp.center.x + offset, y: dp.center.y + offset }, label: newLabel };
      this.dropPanels = [...this.dropPanels, newDp];
      pastedIds.push(id);
    }
    if (pastedIds.length > 0) {
      uiState.setSelectedElements(pastedIds);
    }
    const total = pastedIds.length;
    uiState.setStatusMessage(`Pasted ${total} element(s)`);
  }

  resetView(): void {
    if (this.planImage && this.imageNaturalWidth > 0 && this.imageNaturalHeight > 0) {
      const zoomX = this.canvasWidth / this.imageNaturalWidth;
      const zoomY = this.canvasHeight / this.imageNaturalHeight;
      const fitZoom = Math.min(zoomX, zoomY) * 0.9;
      this.canvasZoom = Math.max(0.05, Math.min(2.0, fitZoom));
      this.canvasViewOffsetX = (this.canvasWidth - this.imageNaturalWidth * this.canvasZoom) / 2;
      this.canvasViewOffsetY = (this.canvasHeight - this.imageNaturalHeight * this.canvasZoom) / 2;
    } else {
      this.canvasZoom = 1;
      this.canvasViewOffsetX = this.canvasWidth / 2;
      this.canvasViewOffsetY = this.canvasHeight / 2;
    }
    // Also reset 3D view preset and trigger 3D camera reset
    uiState.viewPreset = 'iso';
    uiState.resetViewTrigger += 1;
  }

  resetModel(): void {
    this.beginAction();
    this.slabs = [];
    this.dropPanels = [];
    this.columns = [];
    this.walls = [];
    this.polylineWalls = [];
    this.beams = [];
    this.dimensions = [];
    this.nonStructuralWalls = [];
    this.polylineNonStructuralWalls = [];
    this.hiddenElementIds = [];
    this.lockedElementIds = [];
    this.planImage = null;
    femState.clear();
    floorLayers.clearAll();
    this.imageNaturalWidth = 0;
    this.imageNaturalHeight = 0;
    this.canvasViewOffsetX = this.canvasWidth / 2;
    this.canvasViewOffsetY = this.canvasHeight / 2;
    this.canvasZoom = 1;
    nextId = 1;
    this.calibrator = new ScaleCalibrator();
    this.isCalibrated = false;
    this.calibratedLabel = '○ Not calibrated';
    uiState.setSelectedElements([]);
    uiState.selectedHoleIndex = null;
    uiState.setTool('select');
    this.scheduleAutoSave();
  }

  hideElement(id: string): void {
    if (!this.hiddenElementIds.includes(id)) {
      this.hiddenElementIds = [...this.hiddenElementIds, id];
    }
  }

  unhideElement(id: string): void {
    this.hiddenElementIds = this.hiddenElementIds.filter(hid => hid !== id);
  }

  unhideAll(): void {
    this.hiddenElementIds = [];
  }

  isHidden(id: string): boolean {
    return this.hiddenElementIds.includes(id);
  }

  toggleHidden(id: string): void {
    if (this.isHidden(id)) this.unhideElement(id);
    else this.hideElement(id);
  }

  lockElement(id: string): void {
    if (!this.lockedElementIds.includes(id)) {
      this.lockedElementIds = [...this.lockedElementIds, id];
    }
  }

  unlockElement(id: string): void {
    this.lockedElementIds = this.lockedElementIds.filter(lid => lid !== id);
  }

  unlockAll(): void {
    this.lockedElementIds = [];
  }

  isLocked(id: string): boolean {
    return this.lockedElementIds.includes(id);
  }

  toggleLocked(id: string): void {
    if (this.isLocked(id)) this.unlockElement(id);
    else this.lockElement(id);
  }

  addColumn(
    pos: { x: number; y: number },
    width = 0.5,
    depth = 0.5,
    height = 3.0,
    bc: BoundaryCondition = 'fixed-fixed',
    shape: 'rectangular' | 'circular' = 'rectangular',
    diameter = 0.5,
    grade?: string
  ): void {
    this.beginAction();
    const g = grade ?? this.concreteGrade;
    const props = materialForGrade(g);
    this.columns = [...this.columns, {
      id: genId('C'), position: { ...pos }, width, depth, height,
      rotation: 0, boundaryCondition: bc,
      label: getNextLabelSuffix('C', this.columns.map(c => c.label)),
      shape, diameter, concreteGrade: g, ...props
    }];
  }

  updateColumn(id: string, partial: Partial<ColumnElement>): void {
    if (this.isLocked(id)) return;
    this.columns = this.columns.map(c => {
      if (c.id !== id) return c;
      let updated = { ...c, ...partial };
      if (partial.concreteGrade) {
        updated = { ...updated, ...materialForGrade(partial.concreteGrade) };
      }
      return updated;
    });
  }

  deleteColumn(id: string): void {
    if (this.isLocked(id)) return;
    this.beginAction();
    this.columns = this.columns.filter(c => c.id !== id);
  }

  addWall(start: { x: number; y: number }, end: { x: number; y: number }, grade?: string): void {
    this.beginAction();
    const g = grade ?? this.concreteGrade;
    const props = wallMaterialForGrade(g);
    const t = uiState.wallThickness / 1000;
    this.walls = [...this.walls, {
      id: genId('W'), startPoint: { ...start }, endPoint: { ...end },
      thickness: t, height: 3.0,
      label: getNextLabelSuffix('W', this.walls.map(w => w.label)),
      boundaryCondition: 'fixed-free', concreteGrade: g, poissonRatio: 0.2, ...props,
    }];
  }

  addPolylineWall(vertices: Point2D[], grade?: string): void {
    if (vertices.length < 2) return;
    this.beginAction();
    const g = grade ?? this.concreteGrade;
    const props = wallMaterialForGrade(g);
    const t = uiState.wallThickness / 1000;
    this.polylineWalls = [...this.polylineWalls, {
      id: genId('PW'), vertices: vertices.map(v => ({ ...v })),
      thickness: t, height: 3.0,
      label: getNextLabelSuffix('PW', this.polylineWalls.map(w => w.label)),
      boundaryCondition: 'fixed-free', concreteGrade: g, poissonRatio: 0.2, ...props,
    }];
  }

  addNonStructuralWall(start: { x: number; y: number }, end: { x: number; y: number }): void {
    this.beginAction();
    const t = uiState.wallThickness / 1000;
    this.nonStructuralWalls = [...this.nonStructuralWalls, {
      id: genId('NW'), startPoint: { ...start }, endPoint: { ...end },
      thickness: t, height: 3.0,
      label: getNextLabelSuffix('NW', this.nonStructuralWalls.map(w => w.label)),
    }];
  }

  addPolylineNonStructuralWall(vertices: Point2D[]): void {
    if (vertices.length < 2) return;
    this.beginAction();
    const t = uiState.wallThickness / 1000;
    this.polylineNonStructuralWalls = [...this.polylineNonStructuralWalls, {
      id: genId('NPW'), vertices: vertices.map(v => ({ ...v })),
      thickness: t, height: 3.0,
      label: getNextLabelSuffix('NPW', this.polylineNonStructuralWalls.map(w => w.label)),
    }];
  }

  updateWall(id: string, partial: Partial<ShearWallElement>): void {
    if (this.isLocked(id)) return;
    this.walls = this.walls.map(w => {
      if (w.id !== id) return w;
      let updated = { ...w, ...partial };
      if (partial.concreteGrade) {
        updated = { ...updated, ...wallMaterialForGrade(partial.concreteGrade) };
      }
      return updated;
    });
  }

  updatePolylineWall(id: string, partial: Partial<PolylineWallElement>): void {
    if (this.isLocked(id)) return;
    this.polylineWalls = this.polylineWalls.map(w => {
      if (w.id !== id) return w;
      let updated = { ...w, ...partial };
      if (partial.concreteGrade) {
        updated = { ...updated, ...wallMaterialForGrade(partial.concreteGrade) };
      }
      return updated;
    });
  }

  deleteWall(id: string): void {
    if (this.isLocked(id)) return;
    this.beginAction();
    this.walls = this.walls.filter(w => w.id !== id);
    this.polylineWalls = this.polylineWalls.filter(w => w.id !== id);
  }

  updateNonStructuralWall(id: string, partial: Partial<NonStructuralWallElement>): void {
    if (this.isLocked(id)) return;
    this.nonStructuralWalls = this.nonStructuralWalls.map(w => w.id === id ? { ...w, ...partial } : w);
  }

  updatePolylineNonStructuralWall(id: string, partial: Partial<PolylineNonStructuralWallElement>): void {
    if (this.isLocked(id)) return;
    this.polylineNonStructuralWalls = this.polylineNonStructuralWalls.map(w => w.id === id ? { ...w, ...partial } : w);
  }

  deleteNonStructuralWall(id: string): void {
    if (this.isLocked(id)) return;
    this.beginAction();
    this.nonStructuralWalls = this.nonStructuralWalls.filter(w => w.id !== id);
    this.polylineNonStructuralWalls = this.polylineNonStructuralWalls.filter(w => w.id !== id);
  }

  addBeam(start: { x: number; y: number }, end: { x: number; y: number }, grade?: string): void {
    this.beginAction();
    const g = grade ?? this.concreteGrade;
    const props = materialForGrade(g);
    this.beams = [...this.beams, {
      id: genId('B'), startPoint: { ...start }, endPoint: { ...end },
      width: uiState.beamWidth / 1000, depth: uiState.beamDepth / 1000, height: 3.0,
      label: getNextLabelSuffix('B', this.beams.map(b => b.label)),
      concreteGrade: g, ...props
    }];
  }

  updateBeam(id: string, partial: Partial<BeamElement>): void {
    if (this.isLocked(id)) return;
    this.beams = this.beams.map(b => {
      if (b.id !== id) return b;
      let updated = { ...b, ...partial };
      if (partial.concreteGrade) {
        updated = { ...updated, ...materialForGrade(partial.concreteGrade) };
      }
      return updated;
    });
  }

  deleteBeam(id: string): void {
    if (this.isLocked(id)) return;
    this.beginAction();
    this.beams = this.beams.filter(b => b.id !== id);
  }

  addDimension(startPoint: Point2D, endPoint: Point2D): void {
    this.beginAction();
    const dist = Math.sqrt(
      (endPoint.x - startPoint.x) ** 2 + (endPoint.y - startPoint.y) ** 2
    );
    this.dimensions = [...this.dimensions, {
      id: genId('D'),
      startPoint: { ...startPoint },
      endPoint: { ...endPoint },
      distance: dist,
    }];
  }

  deleteDimension(id: string): void {
    this.beginAction();
    this.dimensions = this.dimensions.filter(d => d.id !== id);
  }

  deleteElements(ids: string[]): void {
    if (ids.length === 0) return;
    this.beginAction();
    const idSet = new Set(ids);
    const lockedSet = new Set(this.lockedElementIds);
    const filtered = ids.filter(id => !lockedSet.has(id));
    if (filtered.length === 0) return;
    const fIdSet = new Set(filtered);
    const colsBefore = this.columns.length + this.walls.length + this.polylineWalls.length + this.nonStructuralWalls.length + this.polylineNonStructuralWalls.length + this.beams.length + this.slabs.length + this.dropPanels.length;
    this.columns = this.columns.filter(c => !fIdSet.has(c.id));
    this.walls = this.walls.filter(w => !fIdSet.has(w.id));
    this.polylineWalls = this.polylineWalls.filter(w => !fIdSet.has(w.id));
    this.nonStructuralWalls = this.nonStructuralWalls.filter(w => !fIdSet.has(w.id));
    this.polylineNonStructuralWalls = this.polylineNonStructuralWalls.filter(w => !fIdSet.has(w.id));
    this.beams = this.beams.filter(b => !fIdSet.has(b.id));
    this.slabs = this.slabs.filter(s => !fIdSet.has(s.id));
    this.dropPanels = this.dropPanels.filter(d => !fIdSet.has(d.id));
    this.dimensions = this.dimensions.filter(d => !fIdSet.has(d.id));
    this.hiddenElementIds = this.hiddenElementIds.filter(hid => !fIdSet.has(hid));
    this.lockedElementIds = this.lockedElementIds.filter(lid => !fIdSet.has(lid));
    const colsAfter = this.columns.length + this.walls.length + this.polylineWalls.length + this.nonStructuralWalls.length + this.polylineNonStructuralWalls.length + this.beams.length + this.slabs.length + this.dropPanels.length;
    if (colsBefore !== colsAfter) {
      femState.clear();
    }
  }

  addSlabFromTrace(verts: Point2D[], grade?: string): void {
    this.beginAction();
    this.slabs = [...this.slabs, newSlab(verts, grade ?? this.concreteGrade, this.slabs.map(s => s.label))];
  }

  addDropPanel(center: Point2D, width: number, depth: number, rotation: number, drop: number, parentColumnId?: string, grade?: string): void {
    this.beginAction();
    const g = grade ?? this.concreteGrade;
    const props = materialForGrade(g);
    const verts = computeDropPanelVerts(center, width, depth, rotation);
    this.dropPanels = [...this.dropPanels, {
      id: genId('DP'), vertices: verts, center: { ...center }, width, depth, rotation, drop,
      label: getNextLabelSuffix('DP', this.dropPanels.map(d => d.label)),
      parentColumnId, concreteGrade: g, ...props
    }];
  }

  updateDropPanel(id: string, partial: Partial<DropPanelElement>): void {
    if (this.isLocked(id)) return;
    this.dropPanels = this.dropPanels.map(d => {
      if (d.id !== id) return d;
      let updated = { ...d, ...partial };
      if (partial.concreteGrade) {
        updated = { ...updated, ...materialForGrade(partial.concreteGrade) };
      }
      return updated;
    });
  }

  deleteDropPanel(id: string): void {
    if (this.isLocked(id)) return;
    this.beginAction();
    this.dropPanels = this.dropPanels.filter(d => d.id !== id);
  }

  updateSlab(id: string, partial: Partial<SlabPolygon>): void {
    if (this.isLocked(id)) return;
    this.slabs = this.slabs.map(s => {
      if (s.id !== id) return s;
      let updated = { ...s, ...partial };
      if (partial.concreteGrade) {
        updated = { ...updated, ...materialForGrade(partial.concreteGrade) };
      }
      return updated;
    });
  }

  clearSlab(id: string): void {
    if (this.isLocked(id)) return;
    this.beginAction();
    this.slabs = this.slabs.filter(s => s.id !== id);
    femState.clear();
  }

  addSlabHole(slabId: string, holeVerts: Point2D[]): void {
    if (holeVerts.length < 3) return;
    this.beginAction();
    this.slabs = this.slabs.map(s =>
      s.id === slabId ? { ...s, holes: [...s.holes, holeVerts.map(v => ({ ...v }))] } : s
    );
  }

  updateSlabHoleVertex(slabId: string, holeIndex: number, vertexIndex: number, newPos: Point2D): void {
    this.slabs = this.slabs.map(s => {
      if (s.id !== slabId) return s;
      const holes = s.holes.map((h, hi) => {
        if (hi !== holeIndex) return h;
        return h.map((v, vi) => vi === vertexIndex ? { ...newPos } : { ...v });
      });
      return { ...s, holes };
    });
  }

  updateSlabHole(slabId: string, holeIndex: number, holeVerts: Point2D[]): void {
    this.slabs = this.slabs.map(s => {
      if (s.id !== slabId) return s;
      const holes = s.holes.map((h, hi) => hi === holeIndex ? holeVerts.map(v => ({ ...v })) : h);
      return { ...s, holes };
    });
  }

  deleteSlabHole(slabId: string, holeIndex: number): void {
    this.beginAction();
    this.slabs = this.slabs.map(s =>
      s.id === slabId ? { ...s, holes: s.holes.filter((_, hi) => hi !== holeIndex) } : s
    );
  }

  autoNumberElements(): void {
    this.beginAction();

    const compare = (p1: Point2D, p2: Point2D) => {
      if (Math.abs(p1.y - p2.y) > 0.001) {
        return p2.y - p1.y; // Y descending (top-to-bottom)
      }
      return p1.x - p2.x; // X ascending (left-to-right)
    };

    // 1. Columns
    const sortedCols = [...this.columns].sort((a, b) => compare(a.position, b.position));
    this.columns = this.columns.map(c => {
      const idx = sortedCols.findIndex(sc => sc.id === c.id);
      return { ...c, label: `C-${String(idx + 1).padStart(2, '0')}` };
    });

    // 2. Shear Walls
    const getMidpoint = (start: Point2D, end: Point2D) => ({
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2
    });
    const sortedWalls = [...this.walls].sort((a, b) => compare(getMidpoint(a.startPoint, a.endPoint), getMidpoint(b.startPoint, b.endPoint)));
    this.walls = this.walls.map(w => {
      const idx = sortedWalls.findIndex(sw => sw.id === w.id);
      return { ...w, label: `W-${String(idx + 1).padStart(2, '0')}` };
    });

    // 3. Polyline Walls
    const getVerticesCentroid = (verts: Point2D[]) => {
      if (verts.length === 0) return { x: 0, y: 0 };
      let sx = 0, sy = 0;
      for (const v of verts) { sx += v.x; sy += v.y; }
      return { x: sx / verts.length, y: sy / verts.length };
    };
    const sortedPWalls = [...this.polylineWalls].sort((a, b) => compare(getVerticesCentroid(a.vertices), getVerticesCentroid(b.vertices)));
    this.polylineWalls = this.polylineWalls.map(w => {
      const idx = sortedPWalls.findIndex(sw => sw.id === w.id);
      return { ...w, label: `PW-${String(idx + 1).padStart(2, '0')}` };
    });

    // 4. Beams
    const sortedBeams = [...this.beams].sort((a, b) => compare(getMidpoint(a.startPoint, a.endPoint), getMidpoint(b.startPoint, b.endPoint)));
    this.beams = this.beams.map(b => {
      const idx = sortedBeams.findIndex(sb => sb.id === b.id);
      return { ...b, label: `B-${String(idx + 1).padStart(2, '0')}` };
    });

    // 5. Drop Panels
    const sortedDP = [...this.dropPanels].sort((a, b) => compare(a.center, b.center));
    this.dropPanels = this.dropPanels.map(d => {
      const idx = sortedDP.findIndex(sd => sd.id === d.id);
      return { ...d, label: `DP-${String(idx + 1).padStart(2, '0')}` };
    });

    // 6. Slabs (sorted by centroid)
    const getSlabCentroid = (verts: Point2D[]) => {
      if (verts.length === 0) return { x: 0, y: 0 };
      let sx = 0, sy = 0;
      for (const v of verts) { sx += v.x; sy += v.y; }
      return { x: sx / verts.length, y: sy / verts.length };
    };
    const sortedSlabs = [...this.slabs].sort((a, b) => compare(getSlabCentroid(a.vertices), getSlabCentroid(b.vertices)));
    this.slabs = this.slabs.map(s => {
      const idx = sortedSlabs.findIndex(ss => ss.id === s.id);
      return { ...s, label: `S-${String(idx + 1).padStart(2, '0')}` };
    });

    // 7. Non-structural Walls
    const sortedNSW = [...this.nonStructuralWalls].sort((a, b) => compare(getMidpoint(a.startPoint, a.endPoint), getMidpoint(b.startPoint, b.endPoint)));
    this.nonStructuralWalls = this.nonStructuralWalls.map(w => {
      const idx = sortedNSW.findIndex(sn => sn.id === w.id);
      return { ...w, label: `NW-${String(idx + 1).padStart(2, '0')}` };
    });

    // 8. Polyline Non-structural Walls
    const sortedNSPW = [...this.polylineNonStructuralWalls].sort((a, b) => compare(getVerticesCentroid(a.vertices), getVerticesCentroid(b.vertices)));
    this.polylineNonStructuralWalls = this.polylineNonStructuralWalls.map(w => {
      const idx = sortedNSPW.findIndex(sn => sn.id === w.id);
      return { ...w, label: `NPW-${String(idx + 1).padStart(2, '0')}` };
    });

    this.scheduleAutoSave();
  }
}

export const model = new StructuralModel();