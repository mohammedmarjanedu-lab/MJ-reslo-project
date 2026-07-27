import type { StructuralGraph, GraphNode, GraphEdge } from '../engine/graphModel';

// graphify-out/ is a generated artifact (gitignored) and may be absent.
// import.meta.glob resolves at build time without failing when the file is
// missing; at runtime we fall back to an empty graph so the app keeps working.
const graphModules = import.meta.glob<string>('../../../graphify-out/graph.json', {
  query: '?url',
  import: 'default',
  eager: true,
});
const graphJsonUrl: string | null = Object.values(graphModules)[0] ?? null;

interface GraphifyNode {
  id: string;
  label?: string;
  file?: string;
  kind?: string;
  community?: number;
  centrality?: number;
}

interface GraphifyEdge {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  confidence_score?: number;
  weight?: number;
}

export interface GraphifyHyperedge {
  id: string;
  label?: string;
  nodes: string[];
  relation?: string;
  confidence?: string;
  confidence_score?: number;
  source_file?: string | null;
}

export interface GraphifyGraph {
  directed: boolean;
  multigraph: boolean;
  graph: { hyperedges: GraphifyHyperedge[] };
  nodes: GraphifyNode[];
  links: GraphifyEdge[];
}

let _cachedGraph: GraphifyGraph | null = null;
let _loadPromise: Promise<GraphifyGraph> | null = null;

async function loadGraph(): Promise<GraphifyGraph> {
  if (_cachedGraph) return _cachedGraph;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      if (!graphJsonUrl) throw new Error('graph.json not bundled (graphify-out/ missing)');
      const res = await fetch(graphJsonUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _cachedGraph = data as GraphifyGraph;
      return _cachedGraph!;
    } catch (e) {
      console.warn('[graphifyBridge] Failed to load graph.json:', e);
      _cachedGraph = { directed: false, multigraph: false, graph: { hyperedges: [] }, nodes: [], links: [] };
      return _cachedGraph;
    }
  })();

  return _loadPromise;
}

export async function getGraph(): Promise<GraphifyGraph> {
  return loadGraph();
}

export async function getNode(id: string): Promise<GraphifyNode | undefined> {
  const g = await loadGraph();
  return g.nodes.find(n => n.id === id);
}

export async function getNeighbors(nodeId: string, depth = 1): Promise<GraphifyNode[]> {
  const g = await loadGraph();
  const visited = new Set<string>([nodeId]);
  const frontier = [nodeId];
  const result: GraphifyNode[] = [];

  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const link of g.links) {
        if (link.source === id && !visited.has(link.target)) {
          visited.add(link.target);
          next.push(link.target);
        } else if (link.target === id && !visited.has(link.source)) {
          visited.add(link.source);
          next.push(link.source);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }

  for (const id of visited) {
    if (id !== nodeId) {
      const node = g.nodes.find(n => n.id === id);
      if (node) result.push(node);
    }
  }
  return result;
}

export async function getNodeEdges(nodeId: string): Promise<GraphifyEdge[]> {
  const g = await loadGraph();
  return g.links.filter(l => l.source === nodeId || l.target === nodeId);
}

export async function findHotspots(threshold = 0.7): Promise<GraphifyNode[]> {
  const g = await loadGraph();
  return g.nodes
    .filter(n => (n.centrality ?? 0) >= threshold)
    .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0));
}

export async function findByKind(kind: string): Promise<GraphifyNode[]> {
  const g = await loadGraph();
  return g.nodes.filter(n => n.kind === kind || n.file?.includes(kind));
}

export async function findByFile(filePath: string): Promise<GraphifyNode[]> {
  const g = await loadGraph();
  return g.nodes.filter(n => n.file?.includes(filePath));
}

export async function getCommunityMembers(communityId: number): Promise<GraphifyNode[]> {
  const g = await loadGraph();
  return g.nodes.filter(n => n.community === communityId);
}

export async function getHyperedgeNodes(hyperedgeId: string): Promise<string[]> {
  const g = await loadGraph();
  const he = g.graph.hyperedges.find((h: { id: string; nodes: string[] }) => h.id === hyperedgeId);
  return he?.nodes || [];
}

export async function getCrossCommunityConnections(): Promise<GraphifyEdge[]> {
  const g = await loadGraph();
  return g.links.filter(l => {
    const src = g.nodes.find(n => n.id === l.source);
    const tgt = g.nodes.find(n => n.id === l.target);
    return src && tgt && src.community !== undefined && tgt.community !== undefined && src.community !== tgt.community;
  });
}

export async function estimateTokenCost(nodeIds: string[]): Promise<number> {
  const g = await loadGraph();
  let total = 0;
  for (const id of nodeIds) {
    const node = g.nodes.find(n => n.id === id);
    if (node) {
      const str = JSON.stringify(node);
      total += Math.ceil(str.length / 4);
    }
  }
  return total;
}

export function clearCache(): void {
  _cachedGraph = null;
  _loadPromise = null;
}

export async function searchNodes(query: string): Promise<GraphifyNode[]> {
  const g = await loadGraph();
  const q = query.toLowerCase();
  return g.nodes.filter(n =>
    n.id.toLowerCase().includes(q) ||
    n.label?.toLowerCase().includes(q) ||
    n.file?.toLowerCase().includes(q)
  );
}

export async function getSubgraph(nodeIds: string[], includeEdges = true): Promise<{ nodes: GraphifyNode[]; edges: GraphifyEdge[] }> {
  const g = await loadGraph();
  const idSet = new Set(nodeIds);
  const nodes = g.nodes.filter(n => idSet.has(n.id));
  let edges: GraphifyEdge[] = [];
  if (includeEdges) {
    edges = g.links.filter(l => idSet.has(l.source) && idSet.has(l.target));
  }
  return { nodes, edges };
}