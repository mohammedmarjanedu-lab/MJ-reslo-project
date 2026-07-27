import type { FEMMesh, SlabPolygon, ColumnElement, ShearWallElement } from './types';

export interface AwatifNode {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface AwatifElement {
  id: number;
  nodes: number[];
  thickness?: number;
  elasticity?: number;
  poissonRatio?: number;
}

export interface AwatifSupport {
  nodeId: number;
  fx: boolean;
  fy: boolean;
  fz: boolean;
  mx: boolean;
  my: boolean;
  mz: boolean;
}

export interface AwatifLoad {
  nodeId: number;
  fx: number;
  fy: number;
  fz: number;
  mx: number;
  my: number;
  mz: number;
}

export function createAwatifModel() {
  return {
    version: '1.0-awatif-native',
    ready: true,
    async initialize() {
      this.ready = true;
      return true;
    },
    convertResloMeshToAwatif(mesh: FEMMesh, slab: SlabPolygon, columns: ColumnElement[] = [], walls: ShearWallElement[] = []) {
      const nodes: AwatifNode[] = mesh.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, z: 0 }));
      const elements: AwatifElement[] = mesh.elements.map(e => ({
        id: e.id,
        nodes: e.nodeIds,
        thickness: slab.thickness,
        elasticity: slab.elasticModulus || 25e9,
        poissonRatio: 0.2
      }));

      const supports: AwatifSupport[] = [];
      for (const col of columns) {
        let minD = Infinity;
        let bestId = 1;
        for (const n of mesh.nodes) {
          const d = Math.hypot(n.x - col.position.x, n.y - col.position.y);
          if (d < minD) { minD = d; bestId = n.id; }
        }
        if (minD <= 1.5) {
          supports.push({
            nodeId: bestId,
            fx: true, fy: true, fz: true,
            mx: true, my: true, mz: false
          });
        }
      }

      return { nodes, elements, supports };
    }
  };
}
