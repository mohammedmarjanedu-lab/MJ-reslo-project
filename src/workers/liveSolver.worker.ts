import type { SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement } from '../lib/engine/types';
import { analyzeAllSlabs } from '../lib/engine/femSolver';

export interface LiveSolveInput {
  slabs: SlabPolygon[];
  columns: ColumnElement[];
  walls: ShearWallElement[];
  polylineWalls: PolylineWallElement[];
  meshSize: number;
  poissonRatio: number;
}

self.onmessage = (event: MessageEvent<LiveSolveInput>) => {
  const { slabs, columns, walls, polylineWalls, meshSize, poissonRatio } = event.data;
  try {
    const { results } = analyzeAllSlabs(
      slabs, columns, walls, polylineWalls,
      [], [], [], [],
      meshSize, poissonRatio,
      false
    );
    self.postMessage({ success: true, results });
  } catch (err: any) {
    self.postMessage({ success: false, error: err?.message || String(err) });
  }
};
