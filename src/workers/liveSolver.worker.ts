import type { SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, BeamElement, DropPanelElement, NonStructuralWallElement, PolylineNonStructuralWallElement } from '../lib/engine/types';
import { analyzeAllSlabs } from '../lib/engine/femSolver';

export interface LiveSolveInput {
  slabs: SlabPolygon[];
  columns: ColumnElement[];
  walls: ShearWallElement[];
  polylineWalls: PolylineWallElement[];
  beams?: BeamElement[];
  dropPanels?: DropPanelElement[];
  nonStructuralWalls?: NonStructuralWallElement[];
  polylineNonStructuralWalls?: PolylineNonStructuralWallElement[];
  meshSize: number;
  poissonRatio: number;
}

self.onmessage = (event: MessageEvent<LiveSolveInput>) => {
  const { slabs, columns, walls, polylineWalls, beams, dropPanels, nonStructuralWalls, polylineNonStructuralWalls, meshSize, poissonRatio } = event.data;
  try {
    const { results } = analyzeAllSlabs(
      slabs, columns, walls, polylineWalls,
      beams || [], dropPanels || [],
      nonStructuralWalls || [], polylineNonStructuralWalls || [],
      meshSize, poissonRatio,
      false
    );
    self.postMessage({ success: true, results });
  } catch (err: any) {
    self.postMessage({ success: false, error: err?.message || String(err) });
  }
};
