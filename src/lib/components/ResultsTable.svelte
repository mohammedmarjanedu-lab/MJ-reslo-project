<script lang="ts">
  import type { SlabFEMResult, FEMResultType } from '../engine/types';
  import { femState } from '../stores/femResults.svelte';
  import { model } from '../stores/structuralModel.svelte';

  interface Props {
    results?: SlabFEMResult[];
    activeSlabId?: string | null;
    onselect?: (slabId: string) => void;
  }

  let {
    results,
    activeSlabId = null,
    onselect,
  }: Props = $props();

  const rows = $derived(results ?? [...femState.slabResults.values()]);
  const activeId = $derived(activeSlabId ?? femState.activeSlabId);

  const fmt = (v: number | undefined, digits = 2): string => {
    if (v === undefined || !isFinite(v)) return '—';
    return v.toFixed(digits);
  };

  function handleSelect(slabId: string): void {
    if (onselect) onselect(slabId);
    else femState.activeSlabId = slabId;
  }

  function statusClass(status: 'OK' | 'WARNING' | 'FAIL' | undefined): string {
    if (status === 'FAIL') return 'text-red-400';
    if (status === 'WARNING') return 'text-yellow-400';
    if (status === 'OK') return 'text-green-400';
    return 'text-slate-400';
  }

  function worstStatus(r: SlabFEMResult): 'OK' | 'WARNING' | 'FAIL' | undefined {
    const order = { FAIL: 3, WARNING: 2, OK: 1 } as const;
    let worst: 'OK' | 'WARNING' | 'FAIL' | undefined;
    const check = (s?: 'OK' | 'WARNING' | 'FAIL') => {
      if (!s) return;
      if (!worst || order[s] > order[worst]) worst = s;
    };
    for (const d of r.reinforcement ?? []) check(d.status);
    for (const s of r.shearDesign ?? []) check(s.status);
    for (const c of r.crackWidth ?? []) check(c.status);
    for (const p of r.columnPunching ?? []) check(p.status);
    return worst;
  }
</script>

<div class="rounded-lg bg-slate-800/95 border border-slate-700 shadow-lg overflow-hidden text-xs">
  <div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-2 bg-slate-800 border-b border-slate-700">
    Slab Results
  </div>

  {#if rows.length === 0}
    <div class="px-3 py-4 text-center text-slate-500">No analysis results</div>
  {:else}
    <div class="overflow-x-auto custom-scrollbar">
      <table class="w-full border-collapse">
        <thead>
          <tr class="text-[9px] uppercase tracking-wider text-slate-500 bg-slate-900/40">
            <th class="text-left font-semibold px-2 py-1.5">Slab</th>
            <th class="text-right font-semibold px-2 py-1.5">Nodes</th>
            <th class="text-right font-semibold px-2 py-1.5">Elems</th>
            <th class="text-right font-semibold px-2 py-1.5">Max Defl (mm)</th>
            <th class="text-center font-semibold px-2 py-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.slabId)}
            <tr
              class="border-t border-slate-700/50 cursor-pointer transition-colors hover:bg-slate-700/40
                {activeId === r.slabId ? 'bg-indigo-600/20' : ''}"
              onclick={() => handleSelect(r.slabId)}
            >
              <td class="px-2 py-1.5 font-medium text-slate-200">{model.slabs.find(s => s.id === r.slabId || s.label === r.slabId)?.label || r.slabId}</td>
              <td class="px-2 py-1.5 text-right font-mono text-slate-400">{r.mesh.nodes.length}</td>
              <td class="px-2 py-1.5 text-right font-mono text-slate-400">{r.mesh.elements.length}</td>
              <td class="px-2 py-1.5 text-right font-mono text-red-300">{fmt(Math.max(Math.abs(r.minWz), Math.abs(r.maxWz)))}</td>
              <td class="px-2 py-1.5 text-center font-mono font-bold {statusClass(worstStatus(r))}">
                {worstStatus(r) ?? '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
