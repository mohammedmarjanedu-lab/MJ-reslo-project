import type { FEMWorkerInput, FEMWorkerOutput, SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, SlabFEMResult, BeamElement, DropPanelElement, NonStructuralWallElement, PolylineNonStructuralWallElement } from '../lib/engine/types';
import { analyzeAllSlabs } from '../lib/engine/femSolver';

function post(msg: FEMWorkerOutput): void {
  try { self.postMessage(msg); } catch (e) { /* swallow */ }
}

async function analyzeViaApi(
  slab: SlabPolygon, columns: ColumnElement[], walls: ShearWallElement[],
  polylineWalls: PolylineWallElement[], meshSize: number, poissonRatio: number,
  beams: BeamElement[] = [], dropPanels: DropPanelElement[] = [],
  nonStructuralWalls: NonStructuralWallElement[] = [], polylineNonStructuralWalls: PolylineNonStructuralWallElement[] = []
): Promise<SlabFEMResult | null> {
  try {
    const { analyzeSlabViaApi } = await import('../lib/engine/pyApi');
    return await analyzeSlabViaApi(slab, columns, walls, polylineWalls, meshSize, poissonRatio, beams, dropPanels, nonStructuralWalls, polylineNonStructuralWalls);
  } catch { return null; }
}

async function tryApiAll(
  slabs: SlabPolygon[], columns: ColumnElement[], walls: ShearWallElement[],
  polylineWalls: PolylineWallElement[], meshSize: number, poissonRatio: number,
  beams: BeamElement[] = [], dropPanels: DropPanelElement[] = [],
  nonStructuralWalls: NonStructuralWallElement[] = [], polylineNonStructuralWalls: PolylineNonStructuralWallElement[] = []
): Promise<SlabFEMResult[]> {
  const results: SlabFEMResult[] = [];
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    post({ type: 'PROGRESS', progress: i / slabs.length, slabId: s.id });
    const r = await analyzeViaApi(s, columns, walls, polylineWalls, meshSize, poissonRatio, beams, dropPanels, nonStructuralWalls, polylineNonStructuralWalls);
    if (r) results.push(r);
  }
  return results;
}

self.onmessage = async (event: MessageEvent<FEMWorkerInput>) => {
  const input = event.data;
  if (input.type !== 'ANALYZE') return;

  try {
    post({ type: 'PROGRESS', progress: 0 });

    const { results, warnings } = analyzeAllSlabs(
      input.slabs, input.columns, input.walls, input.polylineWalls,
      input.beams, input.dropPanels,
      input.nonStructuralWalls, input.polylineNonStructuralWalls,
      input.meshSize, input.poissonRatio,
      input.useQ8 ?? false,
      (pct, slabId) => { post({ type: 'PROGRESS', progress: pct, slabId }); },
      input.designOptions
    );

    for (const warn of warnings) {
      console.warn('[FEM Solver]', warn);
    }

    for (const r of results) {
      if (typeof r.minWz !== 'number' || isNaN(r.minWz)) r.minWz = 0;
      if (typeof r.maxWz !== 'number' || isNaN(r.maxWz)) r.maxWz = 0;
      if (typeof r.minMx !== 'number' || isNaN(r.minMx)) r.minMx = 0;
      if (typeof r.maxMx !== 'number' || isNaN(r.maxMx)) r.maxMx = 0;
      if (typeof r.minMy !== 'number' || isNaN(r.minMy)) r.minMy = 0;
      if (typeof r.maxMy !== 'number' || isNaN(r.maxMy)) r.maxMy = 0;
    }

    post({ type: 'RESULT', results });
  } catch (err) {
    let msg = 'Unknown solver error';
    if (err instanceof Error) {
      msg = err.message || err.toString();
    } else if (typeof err === 'string') {
      msg = err;
    } else if (err && typeof err === 'object') {
      msg = JSON.stringify(err);
    }
    post({ type: 'ERROR', error: msg });
  }
};
