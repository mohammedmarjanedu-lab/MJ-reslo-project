import { buildGraph, compressGraph, estimateTokens, type StructuralGraph } from '../engine/graphModel';
import { model } from '../stores/structuralModel.svelte';
import { femState } from '../stores/femResults.svelte';
import { uiState } from '../stores/uiState.svelte';
import type { SlabPolygon, ColumnElement, ShearWallElement } from '../engine/types';

const MEMORY_KEY = 'reslo.memory.v1';
const MAX_EVENTS = 200;
const MAX_TOKENS_PER_EVENT = 1200;

export type MemoryEventKind = 'edit' | 'solve' | 'perf' | 'code' | 'view';

export interface MemoryEvent {
  id: string;
  ts: number;
  kind: MemoryEventKind;
  graphHash: string;
  tokenCost: number;
  payload: EditPayload | SolvePayload | PerfPayload | ViewPayload;
}

export interface EditPayload {
  action: 'add' | 'move' | 'delete' | 'modify' | 'undo' | 'redo';
  elementType: 'slab' | 'column' | 'wall' | 'beam' | 'dropPanel' | 'dimension';
  elementId?: string;
  before?: unknown;
  after?: unknown;
}

export interface SolvePayload {
  solver: 'worker' | 'pynite' | 'kratos' | 'dkt_backend';
  slabCount: number;
  elementCount: number;
  durationMs: number;
  success: boolean;
  warnings: string[];
}

export interface PerfPayload {
  fps: number;
  frameTimeMs: number;
  dirty: boolean;
  elementCount: number;
}

export interface ViewPayload {
  mode: '2d' | '3d';
  zoom: number;
  pan: { x: number; y: number };
}

type Payload = EditPayload | SolvePayload | PerfPayload | ViewPayload;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hashGraph(graph: StructuralGraph): string {
  const str = JSON.stringify({
    v: graph.v,
    n: graph.n.map(n => ({ i: n.i, x: n.x, y: n.y, t: n.t })),
    e: graph.e.map(e => ({ s: e.s, t: e.t, k: e.k })),
    m: graph.m,
  });
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function buildCurrentGraph(): StructuralGraph {
  const slabs = model.slabs;
  const slab = slabs.length > 0 ? slabs[0] : null;
  return buildGraph(slab, model.columns, model.walls, model.pixelsPerMeter, model.imageNaturalWidth, model.imageNaturalHeight);
}

class MemoryStore {
  events = $state<MemoryEvent[]>([]);
  enabled = $state(true);
  private _initialized = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this._load();
    }
  }

  private _load(): void {
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MemoryEvent[];
        this.events = parsed.slice(-MAX_EVENTS);
      }
    } catch {
      this.events = [];
    }
    this._initialized = true;
  }

  private _save(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(this.events.slice(-MAX_EVENTS)));
    } catch {
      if (this.events.length > 50) {
        this.events = this.events.slice(-50);
        this._save();
      }
    }
  }

  private _estimateTokenCost(graph: StructuralGraph, kind: MemoryEventKind): number {
    const base = estimateTokens(graph);
    const multiplier = kind === 'solve' ? 1.5 : kind === 'perf' ? 0.3 : 1;
    return Math.min(Math.ceil(base * multiplier), MAX_TOKENS_PER_EVENT);
  }

  push(kind: MemoryEventKind, payload: Payload): void {
    if (!this.enabled || !this._initialized) return;

    const graph = buildCurrentGraph();
    const compressed = compressGraph(graph, 1);
    const graphHash = hashGraph(compressed);
    const tokenCost = this._estimateTokenCost(compressed, kind);

    const event: MemoryEvent = {
      id: genId(),
      ts: Date.now(),
      kind,
      graphHash,
      tokenCost,
      payload,
    };

    this.events = [...this.events, event].slice(-MAX_EVENTS);
    this._save();
  }

  pushEdit(payload: EditPayload): void {
    this.push('edit', payload);
  }

  pushSolve(payload: SolvePayload): void {
    this.push('solve', payload);
  }

  pushPerf(payload: PerfPayload): void {
    this.push('perf', payload);
  }

  pushView(payload: ViewPayload): void {
    this.push('view', payload);
  }

  getRecent(limit = 50): MemoryEvent[] {
    return this.events.slice(-limit);
  }

  getByKind(kind: MemoryEventKind, limit = 50): MemoryEvent[] {
    return this.events.filter(e => e.kind === kind).slice(-limit);
  }

  clear(): void {
    this.events = [];
    this._save();
  }

  getStats(): { count: number; totalTokens: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    let totalTokens = 0;
    for (const e of this.events) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      totalTokens += e.tokenCost;
    }
    return { count: this.events.length, totalTokens, byKind };
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }
}

export const memoryStore = new MemoryStore();