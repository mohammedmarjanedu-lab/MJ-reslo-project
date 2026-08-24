export interface Point2D {
  x: number;
  y: number;
}

export interface SlabPolygon {
  id: string;
  label: string;
  vertices: Point2D[];
  holes: Point2D[][];
  thickness: number;
  concreteDensity: number;
  uniformLoad: number;
  partitionLoad: number;
  deadLoad?: number;
  liveLoad?: number;
  elasticModulus: number;
  concreteGrade?: string;
  color?: string;
  crackingModifier?: number;
  discontinuousEdges?: { startPoint: Point2D; endPoint: Point2D }[];
}

export type BoundaryCondition = 'fixed-fixed' | 'fixed-free' | 'simply-supported' | 'pinned' | 'fixed';

export interface ColumnElement {
  id: string;
  position: Point2D;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  elasticModulus: number;
  concreteDensity: number;
  label: string;
  boundaryCondition: BoundaryCondition;
  shape?: 'rectangular' | 'circular';
  diameter?: number;
  concreteGrade?: string;
  color?: string;
}

export interface ShearWallElement {
  id: string;
  startPoint: Point2D;
  endPoint: Point2D;
  thickness: number;
  height: number;
  elasticModulus: number;
  shearModulus: number;
  concreteDensity: number;
  label: string;
  boundaryCondition?: BoundaryCondition;
  concreteGrade?: string;
  poissonRatio?: number;
  nonStructural?: true;
  color?: string;
  partitionUnitWeight?: number; // kN/m² for non-structural walls
}

export interface PolylineWallElement {
  id: string;
  vertices: Point2D[];
  thickness: number;
  height: number;
  elasticModulus: number;
  shearModulus: number;
  concreteDensity: number;
  label: string;
  boundaryCondition?: BoundaryCondition;
  concreteGrade?: string;
  poissonRatio?: number;
  nonStructural?: true;
  color?: string;
  partitionUnitWeight?: number; // kN/m² for non-structural walls
}

export interface BeamElement {
  id: string;
  startPoint: Point2D;
  endPoint: Point2D;
  width: number;
  depth: number;
  height: number;
  elasticModulus: number;
  concreteDensity: number;
  label: string;
  concreteGrade?: string;
  color?: string;
}

export interface ElementStiffness {
  id: string;
  position: Point2D;
  kx: number;
  ky: number;
  kxy: number;
  weight: number;
}

export interface SlabContribution {
  area: number;
  centroid: Point2D;
  selfWeight: number;
  imposedLoad: number;
  totalWeight: number;
}

export interface GlobalMetrics {
  cm: Point2D;
  cr: Point2D;
  ex: number;
  ey: number;
  totalWeight: number;
  torsionalRatioX: number;
  torsionalRatioY: number;
  torsionalRatioWithAccidentalX: number;
  torsionalRatioWithAccidentalY: number;
  hasTorsionalIrregularity: boolean;
  hasExtremeTorsionalIrregularity: boolean;
  liveLoadMassFactor: number;
}

export interface FEMNode {
  id: number;
  x: number;
  y: number;
}

export interface FEMElement {
  id: number;
  nodeIds: number[];
  area: number;
}

export interface FEMMesh {
  nodes: FEMNode[];
  elements: FEMElement[];
  meshSize: number;
  unconnectedNodeIds?: number[];
}

export interface FEMResults {
  nodeDeflections: { nodeId: number; wz: number }[];
  momentMx: { elementId: number; value: number }[];
  momentMy: { elementId: number; value: number }[];
  momentMxy: { elementId: number; value: number }[];
}

export interface FEMStressResult {
  elementId: number;
  s1: number;
  s2: number;
  angle: number;
  vm: number; // von Mises
}

export interface FEMShearResult {
  elementId: number;
  vx: number;
  vy: number;
  v1: number;
  angle: number;
}

export interface FEMMembraneResult {
  elementId: number;
  nx: number;
  ny: number;
  nxy: number;
  n1: number;
  n2: number;
  angle: number;
}

export interface WoodArmerMoment {
  elementId: number;
  mx_top: number;
  my_top: number;
  mx_bot: number;
  my_bot: number;
}

export interface ReinforcementDesign {
  elementId: number;
  ast_x_top: number;
  ast_y_top: number;
  ast_x_bot: number;
  ast_y_bot: number;
  ast_x_top_spacing: number;
  ast_y_top_spacing: number;
  ast_x_bot_spacing: number;
  ast_y_bot_spacing: number;
  bar_dia: number;
  status: 'OK' | 'WARNING' | 'FAIL';
}

export interface ShearDesign {
  elementId: number;
  tau_v: number;
  tau_c: number;
  ratio: number;
  status: 'OK' | 'WARNING' | 'FAIL';
  requireShearReinforcement: boolean;
}

export interface CrackWidthResult {
  elementId: number;
  crackWidth: number;
  limit: number;
  status: 'OK' | 'WARNING' | 'FAIL';
}

export interface DeflectionCheckResult {
  slabId: string;
  maxDeflection: number;
  span: number;
  spanRatio: number;
  limitRatio: number;
  shortTermStatus: 'OK' | 'WARNING' | 'FAIL';
  longTermDeflection: number;
  longTermRatio: number;
  longTermStatus: 'OK' | 'WARNING' | 'FAIL';
}

export interface SlabFEMResult {
  slabId: string;
  mesh: FEMMesh;
  nodeDeflections: { nodeId: number; wz: number; u?: number; v?: number }[];
  momentMx: { elementId: number; value: number }[];
  momentMy: { elementId: number; value: number }[];
  momentMxy: { elementId: number; value: number }[];
  stresses: FEMStressResult[];
  shears?: FEMShearResult[];
  membraneForces?: FEMMembraneResult[];
  columnPunching?: ColumnPunchingResult[];
  woodArmer?: WoodArmerMoment[];
  reinforcement?: ReinforcementDesign[];
  shearDesign?: ShearDesign[];
  crackWidth?: CrackWidthResult[];
  deflectionCheck?: DeflectionCheckResult;
  minWz: number;
  maxWz: number;
  minMx: number;
  maxMx: number;
  minMy: number;
  maxMy: number;
  minMxy?: number;
  maxMxy?: number;
  minVx?: number;
  maxVx?: number;
  minVy?: number;
  maxVy?: number;
  minNx?: number;
  maxNx?: number;
  minNy?: number;
  maxNy?: number;
  minNxy?: number;
  maxNxy?: number;
  minAstXTop?: number;
  maxAstXTop?: number;
  minAstYTop?: number;
  maxAstYTop?: number;
  minAstXBot?: number;
  maxAstXBot?: number;
  minAstYBot?: number;
  maxAstYBot?: number;
  minCrack?: number;
  maxCrack?: number;
  crX?: number;
  crY?: number;
}

export interface ColumnPunchingResult {
  nodeId: number;
  force_kN: number;
  stress_MPa: number;
  capacity_MPa: number;
  ratio: number;
  status: 'OK' | 'WARNING' | 'FAIL';
}

export type FEMResultType = 'deflection' | 'mx' | 'my' | 'mxy' | 'stress_s1' | 'stress_s2' | 'stress_vm' | 'shear_vx' | 'shear_vy' | 'shear_v1' | 'membrane_nx' | 'membrane_ny' | 'membrane_nxy' | 'membrane_n1' | 'punching' | 'ast_x_top' | 'ast_x_bot' | 'ast_y_top' | 'ast_y_bot' | 'ast_max' | 'crack_width' | 'deflection_check';

export type ColorRampName = 'jet' | 'viridis' | 'diverging' | 'thermal' | 'cool_warm';

export type LoadCaseName = 'DL' | 'LL' | 'PL' | 'WL' | 'EQ' | 'user';

export interface LoadCase {
  id: string;
  name: LoadCaseName;
  label: string;
  selfWeightFactor: number;
  liveLoadFactor: number;
  partitionLoadFactor: number;
  active: boolean;
}

export interface LoadCombination {
  id: string;
  label: string;
  description: string;
  factors: { loadCaseId: string; factor: number }[];
  isServiceLoad: boolean;
}

export interface Dimension {
  id: string;
  startPoint: Point2D;
  endPoint: Point2D;
  distance: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface DropPanelElement {
  id: string;
  vertices: Point2D[];
  center: Point2D;
  width: number;
  depth: number;
  rotation: number;
  drop: number;
  concreteDensity: number;
  elasticModulus: number;
  label: string;
  parentColumnId?: string;
  concreteGrade?: string;
  color?: string;
}

export interface NonStructuralWallElement {
  id: string;
  startPoint: Point2D;
  endPoint: Point2D;
  thickness: number;
  height: number;
  label: string;
  color?: string;
  partitionUnitWeight?: number;
}

export interface PolylineNonStructuralWallElement {
  id: string;
  vertices: Point2D[];
  thickness: number;
  height: number;
  label: string;
  color?: string;
  partitionUnitWeight?: number;
}

export type CanvasMode =
  | 'select'
  | 'placeColumn'
  | 'drawWall'
  | 'drawNonStructuralWall'
  | 'drawBeam'
  | 'traceSlab'
  | 'traceOpening'
  | 'calibrate'
  | 'pan'
  | 'measure'
  | 'placeColumnDrag'
  | 'placeDropPanel';

export type DragState =
  | { type: 'idle' }
  | { type: 'hover'; elementId: string }
  | { type: 'draggingColumn'; elementId: string; offset: Point2D }
  | { type: 'draggingWallBody'; elementId: string; offset: Point2D }
  | { type: 'draggingWallStart'; elementId: string }
  | { type: 'draggingWallEnd'; elementId: string }
  | { type: 'draggingWallThickness'; elementId: string }
  | { type: 'draggingNSWallBody'; elementId: string; offset: Point2D }
  | { type: 'draggingNSWallStart'; elementId: string }
  | { type: 'draggingNSWallEnd'; elementId: string }
  | { type: 'drawingNonStructuralWall'; startPoint: Point2D }
  | { type: 'drawingWall'; startPoint: Point2D }
  | { type: 'drawingBeam'; startPoint: Point2D }
  | { type: 'tracingSlab'; vertices: Point2D[] }
  | { type: 'calibrating'; point1: Point2D | null }
  | { type: 'panning'; lastPos: Point2D };

export type ToolType =
  | 'select'
  | 'column'
  | 'wall'
  | 'nonStructuralWall'
  | 'beam'
  | 'slab'
  | 'opening'
  | 'dropPanel'
  | 'pan'
  | 'calibrate'
  | 'measure';

export type ElementType = 'column' | 'wall' | 'nonStructuralWall' | 'beam' | 'slab' | 'dropPanel' | 'dimension' | 'opening';

export interface UIState {
  mode: CanvasMode;
  tool: ToolType;
  selectedElementId: string | null;
  selectedElementType: ElementType | null;
  showGrid: boolean;
  snapToGrid: boolean;
  gridSize: number;
  contextMenu: { x: number; y: number } | null;
  showPropertiesPanel: boolean;
}

export interface FEMWorkerInput {
  type: 'ANALYZE';
  slabs: SlabPolygon[];
  columns: ColumnElement[];
  walls: ShearWallElement[];
  polylineWalls: PolylineWallElement[];
  beams: BeamElement[];
  dropPanels: DropPanelElement[];
  nonStructuralWalls: NonStructuralWallElement[];
  polylineNonStructuralWalls: PolylineNonStructuralWallElement[];
  meshSize: number;
  poissonRatio: number;
  useQ8: boolean;
  designOptions?: {
    concreteGrade?: string;
    steelGrade?: string;
    cover?: number;
    barDia?: number;
    exposureLimit?: number;
    longTermFactor?: number;
  };
}

export type FEMWorkerOutput =
  | { type: 'PROGRESS'; progress: number; slabId?: string }
  | { type: 'RESULT'; results: SlabFEMResult[] }
  | { type: 'ERROR'; error: string };

export interface SharedNode {
  id: string;
  point: Point2D;
  connectedElements: string[];
}

export interface ParametricConfig {
  preset: 'flatSlabDrops' | 'flatPlate' | 'gridBeams';
  spansX: number;
  spansY: number;
  spacingX: number;
  spacingY: number;
  overhangX: number;
  overhangY: number;
  slabThickness: number;
  hasDropPanels: boolean;
  dropDivisor?: number;
  dropWidth: number;
  dropDepth: number;
  dropDrop: number;
  columnShape: 'rectangular' | 'circular';
  columnWidth: number;
  columnDepth: number;
  columnDiameter: number;
  columnHeight: number;
  columnBoundary: BoundaryCondition;
  concreteGrade: string;
  rebarGrade: string;
  deadLoad: number;
  liveLoad: number;
  hasGridBeams: boolean;
  beamWidth: number;
  beamDepth: number;
}

