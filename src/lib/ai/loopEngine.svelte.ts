import { memoryStore, type MemoryEvent, type MemoryEventKind, type EditPayload, type SolvePayload, type PerfPayload, type ViewPayload } from './memoryStore.svelte';
import { graphStore } from '../stores/graphStore.svelte';
import { headroom } from '../engine/headroom';
import { getNeighbors, findHotspots, getCrossCommunityConnections, searchNodes, getNodeEdges, findByFile, getGraph, type GraphifyGraph, clearCache as clearGraphifyCache } from './graphifyBridge';
import { buildGraph, compressGraph, estimateTokens, type StructuralGraph } from '../engine/graphModel';
import { model } from '../stores/structuralModel.svelte';
import { femState } from '../stores/femResults.svelte';
import { uiState } from '../stores/uiState.svelte';
import { getCurrentFps, getPerfHistory, startPerfProbe, perfProbeStop, perfProbeIsRunning as isPerfProbeRunning } from './perfProbe';
import { llmClient } from './llmClient.svelte';

export type LoopPhase = 'observe' | 'remember' | 'reason' | 'act' | 'verify';

export interface Insight {
  id: string;
  ts: number;
  phase: LoopPhase;
  kind: 'perf' | 'architecture' | 'numerical' | 'workflow' | 'memory';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  affectedFiles: string[];
  suggestedAction?: string;
  confidence: number;
  tokensEstimate: number;
  verified: boolean;
}

export interface LoopState {
  running: boolean;
  lastRun: number;
  phase: LoopPhase;
  insights: Insight[];
  pendingInsights: Insight[];
  verifiedInsights: Insight[];
  error?: string;
}

const HEADROOM_WARNING = 800;
const HEADROOM_CRITICAL = 1500;
const MAX_INSIGHTS = 20;
const LOOP_INTERVAL_MS = 5000;
const IDLE_THRESHOLD_MS = 2000;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class LoopEngine {
  state = $state<LoopState>({
    running: false,
    lastRun: 0,
    phase: 'observe',
    insights: [],
    pendingInsights: [],
    verifiedInsights: [],
  });

  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _lastActivity = Date.now();
  private _enabled = true;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', () => this._touch());
      window.addEventListener('keydown', () => this._touch());
      window.addEventListener('click', () => this._touch());
    }
  }

  private _touch(): void {
    this._lastActivity = Date.now();
  }

  private _isIdle(): boolean {
    return Date.now() - this._lastActivity > IDLE_THRESHOLD_MS;
  }

  private _isRunning(): boolean {
    return isPerfProbeRunning();
  }

  start(): void {
    if (this.state.running) return;
    this._enabled = true;
    this.state.running = true;
    this._schedule();
  }

  stop(): void {
    this._enabled = false;
    this.state.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  setEnabled(v: boolean): void {
    this._enabled = v;
    if (v && !this.state.running) this.start();
    else if (!v) this.stop();
  }

  isRunning(): boolean {
    return this.state.running;
  }

  getState(): LoopState {
    return this.state;
  }

  private _schedule(): void {
    if (!this._enabled || !this.state.running) return;

    if (!this._isIdle()) {
      this._timer = setTimeout(() => this._schedule(), 1000);
      return;
    }

    this._runLoop().finally(() => {
      if (this._enabled && this.state.running) {
        this._timer = setTimeout(() => this._schedule(), LOOP_INTERVAL_MS);
      }
    });
  }

  private async _runLoop(): Promise<void> {
    this.state.phase = 'observe';
    await this._observe();

    this.state.phase = 'remember';
    this._remember();

    this.state.phase = 'reason';
    await this._reason();

    this.state.phase = 'act';
    this._act();

    this.state.phase = 'verify';
    this._verify();

    this.state.lastRun = Date.now();
  }

  private async _observe(): Promise<void> {
    try {
      const memStats = memoryStore.getStats();
      const graphReport = graphStore.report;
      const hr = headroom.getReport?.() ?? { tokens: 0, level: 'green' };

      if (hr.tokens >= HEADROOM_CRITICAL) {
        this._addInsight({
          phase: 'observe',
          kind: 'memory',
          severity: 'critical',
          title: 'Token budget critical',
          description: `Graphify headroom at ${hr.tokens} tokens (critical > ${HEADROOM_CRITICAL}). Loop may lose context.`,
          affectedFiles: ['graphify-out/'],
          suggestedAction: 'Run graphify compression (L2/L3) or prune unused nodes.',
          confidence: 0.95,
          tokensEstimate: hr.tokens,
        });
      } else if (hr.tokens >= HEADROOM_WARNING) {
        this._addInsight({
          phase: 'observe',
          kind: 'memory',
          severity: 'warning',
          title: 'Token budget warning',
          description: `Graphify headroom at ${hr.tokens} tokens (warning > ${HEADROOM_WARNING}).`,
          affectedFiles: ['graphify-out/'],
          suggestedAction: 'Consider compression or wait for auto-prune.',
          confidence: 0.85,
          tokensEstimate: hr.tokens,
        });
      }

      if (graphReport?.level === 'red') {
        this._addInsight({
          phase: 'observe',
          kind: 'memory',
          severity: 'critical',
          title: 'Graph store at red level',
          description: `Graph store compression at L${graphReport.compression}, tokens: ${graphReport.tokens}.`,
          affectedFiles: ['src/lib/engine/graphModel.ts', 'src/lib/stores/graphStore.svelte.ts'],
          suggestedAction: 'Trigger manual compression or wait for headroom cleanup.',
          confidence: 0.9,
          tokensEstimate: graphReport.tokens,
        });
      }

      const perf = getPerfHistory();
      if (perf.length > 10) {
        const avgFps = perf.reduce((a, b) => a + b, 0) / perf.length;
        if (avgFps < 30) {
          this._addInsight({
            phase: 'observe',
            kind: 'perf',
            severity: avgFps < 15 ? 'critical' : 'warning',
            title: `Low FPS: ${avgFps.toFixed(1)}`,
            description: `Average render FPS dropped to ${avgFps.toFixed(1)}. Canvas may be overloaded.`,
            affectedFiles: ['src/lib/components/WorkspaceCanvas.svelte', 'src/lib/canvas/renderer.ts'],
            suggestedAction: 'Enable offscreen joint cache (P1), reduce element count, or increase mesh size.',
            confidence: 0.8,
            tokensEstimate: 100,
          });
        }
      }

      const recentEdits = memoryStore.getByKind('edit', 10);
      if (recentEdits.length > 20) {
        this._addInsight({
          phase: 'observe',
          kind: 'workflow',
          severity: 'info',
          title: 'High edit velocity',
          description: `${recentEdits.length} edits in recent session. Consider batch operations or undo checkpoint.`,
          affectedFiles: [],
          suggestedAction: 'Use multi-select or scripting for repetitive changes.',
          confidence: 0.7,
          tokensEstimate: 50,
        });
      }
    } catch (e) {
      this.state.error = `Observe failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private _remember(): void {
    const memStats = memoryStore.getStats();
    const graph = buildGraph(
      model.slabs[0] ?? null,
      model.columns,
      model.walls,
      model.pixelsPerMeter,
      model.imageNaturalWidth,
      model.imageNaturalHeight
    );
    const compressed = compressGraph(graph, 1);
    const tokenCost = estimateTokens(compressed);

    memoryStore.pushView({
      mode: uiState.viewMode,
      zoom: model.canvasZoom,
      pan: { x: model.canvasViewOffsetX, y: model.canvasViewOffsetY },
    });

    memoryStore.pushPerf({
      fps: getCurrentFps() ?? 60,
      frameTimeMs: 1000 / (getCurrentFps() ?? 60),
      dirty: true,
      elementCount: model.columns.length + model.walls.length + model.beams.length + model.slabs.length,
    });
  }

  private async _reason(): Promise<void> {
    try {
      const g: GraphifyGraph = await getGraph();
      const hotspots = await findHotspots(0.75);
      const crossComm = await getCrossCommunityConnections();

      for (const hs of hotspots.slice(0, 3)) {
        const neighbors = await getNeighbors(hs.id, 2);
        const affectedFiles = neighbors
          .map(n => n.file)
          .filter(Boolean) as string[];

        this._addInsight({
          phase: 'reason',
          kind: 'architecture',
          severity: 'info',
          title: `Hotspot: ${hs.label ?? hs.id}`,
          description: `High-centrality node (${(hs.centrality ?? 0).toFixed(2)}) with ${neighbors.length} neighbors. Changes here may ripple.`,
          affectedFiles,
          suggestedAction: 'Review before modifying; add tests for connected components.',
          confidence: 0.75,
          tokensEstimate: neighbors.length * 50,
        });
      }

      if (crossComm.length > 5) {
        const files = new Set<string>();
        for (const edge of crossComm.slice(0, 10)) {
          const src = g.nodes.find(n => n.id === edge.source);
          const tgt = g.nodes.find(n => n.id === edge.target);
          if (src?.file) files.add(src.file);
          if (tgt?.file) files.add(tgt.file);
        }

        this._addInsight({
          phase: 'reason',
          kind: 'architecture',
          severity: 'warning',
          title: 'Many cross-community edges',
          description: `${crossComm.length} edges connect different communities. May indicate tight coupling.`,
          affectedFiles: Array.from(files),
          suggestedAction: 'Consider introducing interfaces or facades at community boundaries.',
          confidence: 0.7,
          tokensEstimate: files.size * 100,
        });
      }

      const solverNodes = await searchNodes('femSolver');
      const apiNodes = await searchNodes('pyApi');
      if (solverNodes.length > 0 && apiNodes.length > 0) {
        this._addInsight({
          phase: 'reason',
          kind: 'architecture',
          severity: 'info',
          title: 'Dual solver architecture detected',
          description: 'Both in-browser web worker and Pynite backend present. Ensure fallback logic is tested.',
          affectedFiles: ['src/lib/engine/femSolver.ts', 'src/workers/fem.worker.ts', 'backend/pynite_solver.py'],
          suggestedAction: 'Run benchmark suite to validate parity between solvers.',
          confidence: 0.85,
          tokensEstimate: 200,
        });
      }

      const renderNodes = await findByFile('renderer.ts');
      if (renderNodes.length > 0) {
        const renderEdges = [];
        for (const n of renderNodes) {
          const edges = await getNodeEdges(n.id);
          renderEdges.push(...edges);
        }
        if (renderEdges.length > 50) {
          this._addInsight({
            phase: 'reason',
            kind: 'perf',
            severity: 'info',
            title: 'Renderer has high connectivity',
            description: `renderer.ts connects to ${renderEdges.length} other modules. May be a god object candidate.`,
            affectedFiles: ['src/lib/canvas/renderer.ts'],
            suggestedAction: 'Consider splitting renderer by element type (columns, walls, slabs, etc.).',
            confidence: 0.65,
            tokensEstimate: 150,
          });
        }
      }
    } catch (e) {
      console.warn('[loopEngine] Reason failed:', e);
    }

    // Optional: augment heuristic reasoning with the connected LLM (Omniroute).
    await this._reasonWithLLM();
  }

  /**
   * When an OpenAI-compatible LLM proxy (e.g. Omniroute) is reachable, send a
   * compact snapshot of the current structural model + FEM state and turn the
   * model's reply into insight cards. Fails silently — the loop keeps working
   * on heuristics alone if the LLM is offline or unconfigured.
   */
  private async _reasonWithLLM(): Promise<void> {
    if (!llmClient.isConfigured()) return;
    try {
      if (!(await llmClient.health())) return;

      const snapshot = {
        elements: {
          slabs: model.slabs.length,
          columns: model.columns.length,
          walls: model.walls.length + model.polylineWalls.length,
          beams: model.beams.length,
          dropPanels: model.dropPanels.length,
        },
        concreteGrade: model.concreteGrade,
        rebarGrade: model.rebarGrade,
        fem: femState.hasResults ? {
          slabCount: femState.slabResults.size,
          maxDeflection_mm: +Math.max(Math.abs(femState.globalMinWz), Math.abs(femState.globalMaxWz)).toFixed(2),
          warnings: (femState.warnings ?? []).slice(0, 5),
        } : null,
        headroomTokens: graphStore.report?.tokens ?? 0,
      };

      const insights = await llmClient.chatJson<{
        title: string;
        description: string;
        kind?: string;
        severity?: string;
        suggestedAction?: string;
        confidence?: number;
        affectedFiles?: string[];
      }[]>([
        {
          role: 'system',
          content:
            'You are a structural-engineering assistant embedded in Reslo, an IS 456:2000 RC floor design tool. ' +
            'Given a JSON snapshot of the current model and FEM results, return concise, actionable insights. ' +
            'Respond ONLY with a JSON array of at most 3 objects, each with keys: ' +
            'title (string), description (string), kind (one of perf|architecture|numerical|workflow|memory), ' +
            'severity (one of info|warning|critical), suggestedAction (string), confidence (0..1).',
        },
        { role: 'user', content: JSON.stringify(snapshot) },
      ], { maxTokens: 700 });

      if (!Array.isArray(insights)) return;
      const allowedKind = new Set(['perf', 'architecture', 'numerical', 'workflow', 'memory']);
      const allowedSev = new Set(['info', 'warning', 'critical']);
      for (const it of insights.slice(0, 3)) {
        if (!it?.title || !it?.description) continue;
        this._addInsight({
          phase: 'reason',
          kind: (allowedKind.has(it.kind as string) ? it.kind : 'architecture') as Insight['kind'],
          severity: (allowedSev.has(it.severity as string) ? it.severity : 'info') as Insight['severity'],
          title: `🤖 ${it.title}`,
          description: it.description,
          affectedFiles: Array.isArray(it.affectedFiles) ? it.affectedFiles : [],
          suggestedAction: it.suggestedAction,
          confidence: typeof it.confidence === 'number' ? Math.max(0, Math.min(1, it.confidence)) : 0.6,
          tokensEstimate: 200,
        });
      }
    } catch (e) {
      console.warn('[loopEngine] LLM reasoning skipped:', e instanceof Error ? e.message : e);
    }
  }

  private _act(): void {
    const newInsights = this.state.pendingInsights.filter(i => !i.verified);
    this.state.insights = [...this.state.insights, ...newInsights].slice(-MAX_INSIGHTS);
    this.state.pendingInsights = [];
  }

  private _verify(): void {
    const toVerify = this.state.insights.filter(i => !i.verified);
    for (const insight of toVerify) {
      if (this._canAutoVerify(insight)) {
        insight.verified = true;
        this.state.verifiedInsights.push(insight);
      }
    }
  }

  private _canAutoVerify(insight: Insight): boolean {
    if (insight.kind === 'memory' && insight.severity === 'critical') return true;
    if (insight.kind === 'perf' && insight.severity === 'critical') return true;
    if (insight.confidence >= 0.9) return true;
    return false;
  }

  private _addInsight(data: Omit<Insight, 'id' | 'ts' | 'verified'>): void {
    const insight: Insight = {
      ...data,
      id: genId(),
      ts: Date.now(),
      phase: this.state.phase,
      verified: false,
    };
    this.state.pendingInsights.push(insight);
  }

  clearInsights(): void {
    this.state.insights = [];
    this.state.pendingInsights = [];
    this.state.verifiedInsights = [];
  }

  dismissInsight(id: string): void {
    this.state.insights = this.state.insights.filter(i => i.id !== id);
    this.state.pendingInsights = this.state.pendingInsights.filter(i => i.id !== id);
    this.state.verifiedInsights = this.state.verifiedInsights.filter(i => i.id !== id);
  }

  verifyInsight(id: string): void {
    const idx = this.state.pendingInsights.findIndex(i => i.id === id);
    if (idx >= 0) {
      const insight = this.state.pendingInsights[idx];
      insight.verified = true;
      this.state.pendingInsights.splice(idx, 1);
      this.state.verifiedInsights.push(insight);
    }
  }

  clearError(): void {
    this.state.error = undefined;
  }
}

export const loopEngine = new LoopEngine();