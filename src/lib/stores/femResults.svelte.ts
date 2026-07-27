import type { SlabFEMResult, FEMMesh, FEMResultType } from '../engine/types';
import { computeSprContour, type SprSlabInput } from '../engine/sprRecovery';

class FEMResultState {
  slabResults = $state<Map<string, SlabFEMResult>>(new Map());
  isComputing = $state(false);
  progress = $state(0);
  error = $state<string | null>(null);
  warnings = $state<string[]>([]);
  disconnectedIds = $state<Set<string>>(new Set());
  resultType = $state<FEMResultType>('deflection');
  deformedScale = $state(30);
  showFEMContour = $state(true);
  showFEMMesh = $state(false);
  activeSlabId = $state<string | null>(null);

  private _timeoutId: ReturnType<typeof setTimeout> | null = null;

  get hasResults(): boolean {
    return this.slabResults.size > 0;
  }

  get globalMinWz(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minWz < min) min = r.minWz; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxWz(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxWz > max) max = r.maxWz; }
    return max === -Infinity ? 0 : max;
  }

  get activeResult(): SlabFEMResult | undefined {
    return this.activeSlabId ? this.slabResults.get(this.activeSlabId) : undefined;
  }

  // ─── P3: Derived contour cache ───
  // Recomputed only when slabResults OR resultType change — NOT every render frame.
  // Returns per-slab node-value maps + unified global min/max for the current result type.
  contourCache = $derived.by(() => {
    const rt = this.resultType;
    const slabs: SlabFEMResult[] = [];
    for (const r of this.slabResults.values()) slabs.push(r);

    type ContourData = { nodeValues: Map<number, number>; globalMin: number; globalMax: number };
    const perSlab = new Map<string, ContourData>();
    let globalMin = 0;
    let globalMax = 0;

    function safeMinMax(arr: number[]): [number, number] {
      if (arr.length === 0) return [0, 0];
      let mn = arr[0], mx = arr[0];
      for (let i = 1; i < arr.length; i++) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i]; }
      return [mn, mx];
    }

    // SPR (Superconvergent Patch Recovery) nodal smoothing — ETABS/SAFE-grade contours:
    // per node, an area-weighted least-squares plane is fitted over the centroid values
    // of the incident-element patch and evaluated at the node. Nodes of different slabs
    // at the same position share one patch (continuous contours across joints); hinged
    // nodes keep segregated patches (moments are discontinuous across articulated lines).
    function elemToGlobalNodeValues(
      dataExtractor: (r: SlabFEMResult) => { elementId: number; value?: number }[],
      valueKey?: string
    ): Map<string, Map<number, number>> {
      const inputs: SprSlabInput[] = slabs.map(r => {
        const values = new Map<number, number>();
        for (const item of dataExtractor(r)) {
          const v = valueKey ? (item as any)[valueKey] : (item as any).value;
          if (v !== undefined && isFinite(v)) values.set(item.elementId, v);
        }
        return {
          slabId: r.slabId,
          nodes: r.mesh.nodes,
          elements: r.mesh.elements,
          values,
          hingedNodeIds: r.hingedNodeIds,
        };
      });
      const sprMap = computeSprContour(inputs);

      // Keep the outer shape every node gets a defined value (0 for data-less nodes),
      // identical to the previous plain-averaging behaviour.
      const resultMap = new Map<string, Map<number, number>>();
      for (const r of slabs) {
        const smoothed = sprMap.get(r.slabId) ?? new Map();
        const localMap = new Map<number, number>();
        for (const n of r.mesh.nodes) {
          localMap.set(n.id, smoothed.get(n.id) ?? 0);
        }
        resultMap.set(r.slabId, localMap);
      }
      return resultMap;
    }

    const allVals: number[] = [];
    let resultMap: Map<string, Map<number, number>> | null = null;

    switch (rt) {
      case 'deflection': {
        const accum = new Map<string, number[]>();
        function pKeyDefl(x: number, y: number): string {
          return Math.round(x * 200) + '_' + Math.round(y * 200);
        }
        for (const r of slabs) {
          for (const d of r.nodeDeflections) {
            const node = r.mesh.nodes.find(n => n.id === d.nodeId);
            if (node && isFinite(d.wz)) {
              const pk = pKeyDefl(node.x, node.y);
              let arr = accum.get(pk);
              if (!arr) { arr = []; accum.set(pk, arr); }
              arr.push(d.wz);
            }
          }
        }
        const avgDeflMap = new Map<string, number>();
        for (const [pk, vals] of accum) {
          let sum = 0; for (let i = 0; i < vals.length; i++) sum += vals[i];
          avgDeflMap.set(pk, sum / vals.length);
        }
        resultMap = new Map();
        for (const r of slabs) {
          const m = new Map<number, number>();
          for (const d of r.nodeDeflections) {
            const node = r.mesh.nodes.find(n => n.id === d.nodeId);
            const val = node ? (avgDeflMap.get(pKeyDefl(node.x, node.y)) ?? d.wz) : d.wz;
            m.set(d.nodeId, val);
            allVals.push(val);
          }
          resultMap.set(r.slabId, m);
        }
        break;
      }
      case 'mx': {
        resultMap = elemToGlobalNodeValues(r => r.momentMx);
        break;
      }
      case 'my': {
        resultMap = elemToGlobalNodeValues(r => r.momentMy);
        break;
      }
      case 'mxy': {
        resultMap = elemToGlobalNodeValues(r => r.momentMxy);
        break;
      }
      case 'punching': {
        resultMap = new Map();
        for (const r of slabs) {
          const m = new Map<number, number>();
          for (const p of (r.columnPunching || [])) { m.set(p.nodeId, p.ratio); allVals.push(p.ratio); }
          resultMap.set(r.slabId, m);
        }
        break;
      }
      case 'ast_x_top': {
        resultMap = elemToGlobalNodeValues(r => r.reinforcement || [], 'ast_x_top');
        break;
      }
      case 'ast_y_top': {
        resultMap = elemToGlobalNodeValues(r => r.reinforcement || [], 'ast_y_top');
        break;
      }
      case 'ast_x_bot': {
        resultMap = elemToGlobalNodeValues(r => r.reinforcement || [], 'ast_x_bot');
        break;
      }
      case 'ast_y_bot': {
        resultMap = elemToGlobalNodeValues(r => r.reinforcement || [], 'ast_y_bot');
        break;
      }
      case 'ast_max': {
        resultMap = elemToGlobalNodeValues(r => (r.reinforcement || []).map(m => ({
          elementId: m.elementId,
          value: Math.max(m.ast_x_top, m.ast_y_top, m.ast_x_bot, m.ast_y_bot)
        })));
        break;
      }
      case 'crack_width': {
        resultMap = elemToGlobalNodeValues(r => r.crackWidth || [], 'crackWidth');
        break;
      }
      case 'deflection_check': {
        resultMap = new Map();
        for (const r of slabs) {
          const m = new Map<number, number>();
          for (const d of r.nodeDeflections) {
            const val = Math.abs(d.wz);
            m.set(d.nodeId, val);
            allVals.push(val);
          }
          resultMap.set(r.slabId, m);
        }
        break;
      }
      default: {
        const key = rt === 'stress_s1' ? 's1' : rt === 'stress_s2' ? 's2' : (rt.startsWith('shear') ? (rt === 'shear_vx' ? 'vx' : rt === 'shear_vy' ? 'vy' : 'v1') : rt.startsWith('membrane') ? rt.replace('membrane_', '') : 'vm');
        const getter = (r: SlabFEMResult) => (rt.startsWith('shear') ? (r.shears || []) : rt.startsWith('membrane') ? (r.membraneForces || []) : r.stresses) as any[];
        resultMap = elemToGlobalNodeValues(getter, key);
        break;
      }
    }

    if (rt === 'punching') { globalMin = 0; globalMax = 1; }
    else if (rt !== 'deflection' && rt !== 'deflection_check' && resultMap) {
      // Legend min/max from the SMOOTHED nodal field so the legend matches the display
      // exactly (previously the legend used raw element extremes while the map showed
      // averaged values — a mismatch ETABS never exhibits).
      const smoothedVals: number[] = [];
      for (const m of resultMap.values()) for (const v of m.values()) if (isFinite(v)) smoothedVals.push(v);
      [globalMin, globalMax] = safeMinMax(smoothedVals);
    }
    else [globalMin, globalMax] = safeMinMax(allVals);

    for (const r of slabs) {
      const nodeValues = resultMap?.get(r.slabId) ?? new Map();
      perSlab.set(r.slabId, { nodeValues, globalMin, globalMax });
    }

    return { perSlab, globalMin, globalMax };
  });

  get globalMinMx(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minMx < min) min = r.minMx; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxMx(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxMx > max) max = r.maxMx; }
    return max === -Infinity ? 0 : max;
  }

  get globalMinMy(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minMy < min) min = r.minMy; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxMy(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxMy > max) max = r.maxMy; }
    return max === -Infinity ? 0 : max;
  }

  get globalMinVx(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minVx !== undefined && r.minVx < min) min = r.minVx; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxVx(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxVx !== undefined && r.maxVx > max) max = r.maxVx; }
    return max === -Infinity ? 0 : max;
  }

  get globalMinVy(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minVy !== undefined && r.minVy < min) min = r.minVy; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxVy(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxVy !== undefined && r.maxVy > max) max = r.maxVy; }
    return max === -Infinity ? 0 : max;
  }

  get globalMinNx(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minNx !== undefined && r.minNx < min) min = r.minNx; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxNx(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxNx !== undefined && r.maxNx > max) max = r.maxNx; }
    return max === -Infinity ? 0 : max;
  }

  get globalMinNy(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minNy !== undefined && r.minNy < min) min = r.minNy; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxNy(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxNy !== undefined && r.maxNy > max) max = r.maxNy; }
    return max === -Infinity ? 0 : max;
  }

  get globalMinNxy(): number {
    let min = Infinity;
    for (const r of this.slabResults.values()) { if (r.minNxy !== undefined && r.minNxy < min) min = r.minNxy; }
    return min === Infinity ? 0 : min;
  }

  get globalMaxNxy(): number {
    let max = -Infinity;
    for (const r of this.slabResults.values()) { if (r.maxNxy !== undefined && r.maxNxy > max) max = r.maxNxy; }
    return max === -Infinity ? 0 : max;
  }

  setResults(results: SlabFEMResult[]): void {
    this._clearTimeout();
    const map = new Map<string, SlabFEMResult>();
    for (const r of results) map.set(r.slabId, r);
    this.slabResults = map;
    this.isComputing = false;
    this.progress = 1;
    this.error = null;
    if (results.length > 0) {
      this.showFEMContour = true;
      this.activeSlabId = results[0].slabId;
    }
  }

  setComputing(): void {
    this._clearTimeout();
    this.isComputing = true;
    this.progress = 0;
    this.error = null;
    this._refreshTimeout();
  }

  refreshTimeout(): void {
    this._refreshTimeout();
  }

  private _refreshTimeout(): void {
    this._clearTimeout();
    this._timeoutId = setTimeout(() => {
      if (this.isComputing) {
        this.isComputing = false;
        this.error = 'FEM computation timed out after 120s — try increasing mesh size or reducing slab area';
      }
    }, 120000);
  }

  setProgress(p: number): void {
    this.progress = p;
  }

  setError(msg: string): void {
    this._clearTimeout();
    this.error = msg;
    this.isComputing = false;
    this.progress = 0;
  }

  clear(): void {
    this._clearTimeout();
    this.slabResults = new Map();
    this.isComputing = false;
    this.progress = 0;
    this.error = null;
    this.warnings = [];
    this.disconnectedIds = new Set();
    this.showFEMContour = false;
    this.activeSlabId = null;
  }

  private _clearTimeout(): void {
    if (this._timeoutId !== null) { clearTimeout(this._timeoutId); this._timeoutId = null; }
  }
}

export const femState = new FEMResultState();
