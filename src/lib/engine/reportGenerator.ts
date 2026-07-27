import type {
  SlabFEMResult,
  GlobalMetrics,
  ReinforcementDesign,
  ShearDesign,
  CrackWidthResult,
  DeflectionCheckResult,
  ColumnPunchingResult,
  FEMResultType,
} from './types';

export type DesignStatus = 'OK' | 'WARNING' | 'FAIL';

export interface SlabReportRow {
  slabId: string;
  nodes: number;
  elements: number;
  maxDeflection_mm: number;
  maxMx: number;
  maxMy: number;
  maxMxy: number;
  minAst: number;
  maxAst: number;
  maxCrackWidth: number;
  worstStatus: DesignStatus | null;
  deflectionCheck?: DeflectionCheckResult;
  punching: { nodeId: number; ratio: number; status: DesignStatus }[];
}

export interface FEMReport {
  generatedAt: string;
  slabCount: number;
  totalElements: number;
  totalNodes: number;
  globalMetrics?: GlobalMetrics;
  slabs: SlabReportRow[];
  summaryStatus: DesignStatus | null;
}

const STATUS_RANK: Record<DesignStatus, number> = { OK: 1, WARNING: 2, FAIL: 3 };

function combineStatus(a: DesignStatus | null, b: DesignStatus | undefined): DesignStatus | null {
  if (!b) return a;
  if (!a) return b;
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function worstOf(items: { status: DesignStatus }[]): DesignStatus | null {
  let worst: DesignStatus | null = null;
  for (const it of items) worst = combineStatus(worst, it.status);
  return worst;
}

function minMax(nums: number[]): { min: number; max: number } {
  if (nums.length === 0) return { min: 0, max: 0 };
  let min = nums[0];
  let max = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < min) min = nums[i];
    if (nums[i] > max) max = nums[i];
  }
  return { min, max };
}

function reinforcementStats(reinforcement: ReinforcementDesign[] | undefined): { min: number; max: number } {
  if (!reinforcement || reinforcement.length === 0) return { min: 0, max: 0 };
  const all = reinforcement.flatMap((r) => [
    r.ast_x_top, r.ast_y_top, r.ast_x_bot, r.ast_y_bot,
  ]);
  return minMax(all);
}

function punchingStats(punching: ColumnPunchingResult[] | undefined): { nodeId: number; ratio: number; status: DesignStatus }[] {
  if (!punching) return [];
  return punching.map((p) => ({ nodeId: p.nodeId, ratio: p.ratio, status: p.status }));
}

export function generateSlabReportRow(result: SlabFEMResult): SlabReportRow {
  const maxDeflection_mm = Math.max(Math.abs(result.minWz), Math.abs(result.maxWz));
  const ast = reinforcementStats(result.reinforcement);
  const crackStats = result.crackWidth
    ? minMax(result.crackWidth.map((c: CrackWidthResult) => c.crackWidth))
    : { min: 0, max: 0 };
  const mxyStats = result.momentMxy.length > 0
    ? minMax(result.momentMxy.map((m) => m.value))
    : { min: 0, max: 0 };

  const worst = combineStatus(
    combineStatus(
      combineStatus(worstOf(result.reinforcement ?? []), worstOf(result.shearDesign ?? []) as DesignStatus | undefined),
      worstOf(result.crackWidth ?? []) as DesignStatus | undefined,
    ),
    worstOf(result.columnPunching ?? []) as DesignStatus | undefined,
  );

  return {
    slabId: result.slabId,
    nodes: result.mesh.nodes.length,
    elements: result.mesh.elements.length,
    maxDeflection_mm,
    maxMx: result.maxMx,
    maxMy: result.maxMy,
    maxMxy: mxyStats.max,
    minAst: ast.min,
    maxAst: ast.max,
    maxCrackWidth: crackStats.max,
    worstStatus: worst,
    deflectionCheck: result.deflectionCheck,
    punching: punchingStats(result.columnPunching),
  };
}

export function generateFEMReport(
  results: SlabFEMResult[],
  globalMetrics?: GlobalMetrics,
): FEMReport {
  const slabs = results.map(generateSlabReportRow);

  let totalElements = 0;
  let totalNodes = 0;
  let summary: DesignStatus | null = null;
  for (const row of slabs) {
    totalElements += row.elements;
    totalNodes += row.nodes;
    summary = combineStatus(summary, row.worstStatus ?? undefined);
  }

  return {
    generatedAt: new Date().toISOString(),
    slabCount: slabs.length,
    totalElements,
    totalNodes,
    globalMetrics,
    slabs,
    summaryStatus: summary,
  };
}

export interface ReportSerializationOptions {
  numberFormat?: (v: number) => string;
  includePunching?: boolean;
}

const DEFAULT_FMT = (v: number): string => v.toFixed(3);

export function reportToCSV(report: FEMReport, opts: ReportSerializationOptions = {}): string {
  const fmt = opts.numberFormat ?? DEFAULT_FMT;
  const includePunching = opts.includePunching ?? true;
  const headers = [
    'Slab', 'Nodes', 'Elements', 'Max Deflection (mm)', 'Max Mx', 'Max My', 'Max Mxy',
    'Min Ast', 'Max Ast', 'Max Crack (mm)', 'Status',
    ...(includePunching ? ['Max Punching Ratio'] : []),
  ];
  const lines: string[] = [headers.join(',')];

  for (const r of report.slabs) {
    const maxPunch = r.punching.length > 0
      ? Math.max(...r.punching.map((p) => p.ratio))
      : 0;
    const cells = [
      `"${r.slabId}"`, r.nodes, r.elements,
      fmt(r.maxDeflection_mm), fmt(r.maxMx), fmt(r.maxMy), fmt(r.maxMxy),
      fmt(r.minAst), fmt(r.maxAst), fmt(r.maxCrackWidth),
      r.worstStatus ?? '',
      ...(includePunching ? [fmt(maxPunch)] : []),
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

export function reportToText(report: FEMReport): string {
  const fmt = DEFAULT_FMT;
  const out: string[] = [];
  out.push('RESLab FEM Analysis Report');
  out.push(`Generated: ${report.generatedAt}`);
  out.push(`Slabs: ${report.slabCount} | Elements: ${report.totalElements} | Nodes: ${report.totalNodes}`);
  out.push(`Overall status: ${report.summaryStatus ?? 'N/A'}`);
  out.push('');

  if (report.globalMetrics) {
    const m = report.globalMetrics;
    out.push('Global Metrics');
    out.push(`  CM:  (${fmt(m.cm.x)}, ${fmt(m.cm.y)}) m`);
    out.push(`  CR:  (${fmt(m.cr.x)}, ${fmt(m.cr.y)}) m`);
    out.push(`  ex / ey: ${fmt(m.ex)} / ${fmt(m.ey)} m`);
    out.push(`  Total weight: ${fmt(m.totalWeight)} kN`);
    out.push(`  Torsional ratio X / Y: ${(m.torsionalRatioX * 100).toFixed(1)}% / ${(m.torsionalRatioY * 100).toFixed(1)}%`);
    out.push(`  Torsional irregularity: ${m.hasTorsionalIrregularity ? 'YES' : 'no'}`);
    out.push('');
  }

  out.push('Per-Slab Summary');
  out.push('------------------------------------------------------------');
  for (const r of report.slabs) {
    out.push(`Slab ${r.slabId} [${r.worstStatus ?? 'N/A'}]`);
    out.push(`  Mesh: ${r.nodes} nodes, ${r.elements} elements`);
    out.push(`  Deflection: ${fmt(r.maxDeflection_mm)} mm`);
    out.push(`  Moments: Mx ${fmt(r.maxMx)}, My ${fmt(r.maxMy)}, Mxy ${fmt(r.maxMxy)} kN·m/m`);
    out.push(`  Reinforcement: ${fmt(r.minAst)} – ${fmt(r.maxAst)} mm²/m`);
    out.push(`  Max crack width: ${fmt(r.maxCrackWidth)} mm`);
    if (r.deflectionCheck) {
      out.push(`  Span ratio: ${(r.deflectionCheck.spanRatio).toFixed(2)} (limit ${r.deflectionCheck.limitRatio.toFixed(2)}) [${r.deflectionCheck.longTermStatus}]`);
    }
    if (r.punching.length > 0) {
      const worst = r.punching.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      out.push(`  Max punching: Col N${worst.nodeId} ratio ${fmt(worst.ratio)} [${worst.status}]`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function resultTypeDisplayName(rt: FEMResultType): string {
  const map: Partial<Record<FEMResultType, string>> = {
    deflection: 'Deflection',
    mx: 'Moment Mx',
    my: 'Moment My',
    mxy: 'Moment Mxy',
    stress_s1: 'Principal σ₁',
    stress_s2: 'Principal σ₂',
    stress_vm: 'Von Mises σ',
    shear_vx: 'Shear Vx',
    shear_vy: 'Shear Vy',
    shear_v1: 'Shear V₁',
    membrane_nx: 'Membrane Nx',
    membrane_ny: 'Membrane Ny',
    membrane_nxy: 'Membrane Nxy',
    membrane_n1: 'Membrane N₁',
    punching: 'Punching Ratio',
    ast_x_top: 'Ast x (top)',
    ast_x_bot: 'Ast x (bot)',
    ast_y_top: 'Ast y (top)',
    ast_y_bot: 'Ast y (bot)',
    ast_max: 'Ast (max)',
    crack_width: 'Crack Width',
    deflection_check: 'Deflection Check',
  };
  return map[rt] ?? rt;
}
