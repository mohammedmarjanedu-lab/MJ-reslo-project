<script lang="ts">
  import { femState } from '../stores/femResults.svelte';
  import { uiState } from '../stores/uiState.svelte';
</script>

{#if uiState.showFEMResults && (femState.hasResults || femState.isComputing || femState.error)}
  <div class="rounded-lg bg-slate-800/95 p-3 border border-slate-700 text-xs shadow-lg">
    <div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">FEM Results</div>

    {#if femState.isComputing}
      <div class="space-y-2">
        <div class="text-yellow-400">Computing...</div>
        <div class="h-2 rounded-full bg-slate-700 overflow-hidden">
          <div class="h-full rounded-full bg-indigo-500 transition-all" style="width: {femState.progress * 100}%"></div>
        </div>
        <div class="text-slate-400">{(femState.progress * 100).toFixed(0)}%</div>
      </div>

    {:else if femState.error}
      <div class="text-red-400">Error: {femState.error}</div>

    {:else if femState.hasResults}
      <div class="space-y-1 text-slate-300">
        <div>Slabs analyzed: {femState.slabResults.size}</div>
        {#each [...femState.slabResults.values()] as result}
          <div class="text-[10px] text-slate-400 border-t border-slate-700 pt-1 mt-1">
            <div class="text-slate-200 font-medium">{result.slabId}</div>
            <div class="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <span>Nodes: {result.mesh.nodes.length}</span>
              <span>Elements: {result.mesh.elements.length}</span>
              <span>Max defl: <span class="text-red-400">{Math.max(Math.abs(result.minWz), Math.abs(result.maxWz)).toFixed(3)} mm</span></span>
              <span>Min defl: <span class="text-blue-400">{Math.min(Math.abs(result.minWz), Math.abs(result.maxWz)).toFixed(3)} mm</span></span>
            </div>
            {#if result.columnPunching && result.columnPunching.length > 0}
              <div class="mt-1.5 pt-1.5 border-t border-slate-600">
                <div class="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">Punching Stress</div>
                {#each result.columnPunching as p}
                  <div class="flex items-center gap-1.5 text-[10px]">
                    <span class="inline-block h-2 w-2 rounded-full {p.status === 'FAIL' ? 'bg-red-500' : p.status === 'WARNING' ? 'bg-yellow-500' : 'bg-green-500'}"></span>
                    <span>Col N{p.nodeId}:</span>
                    <span>{p.stress_MPa.toFixed(2)}/{p.capacity_MPa.toFixed(2)} MPa</span>
                    <span class="font-mono {p.ratio > 1 ? 'text-red-400' : p.ratio > 0.7 ? 'text-yellow-400' : 'text-green-400'}">({(p.ratio * 100).toFixed(0)}%)</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
