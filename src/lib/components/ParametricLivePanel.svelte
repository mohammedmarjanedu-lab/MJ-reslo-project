<script lang="ts">
  import { uiState } from '../stores/uiState.svelte';
  import { model } from '../stores/structuralModel.svelte';

  let config = $state({ ...uiState.parametricConfig });

  // Draggable window state
  let isDragging = $state(false);
  let posX = $state<number | null>(null);
  let posY = $state<number | null>(null);
  let startX = 0;
  let startY = 0;
  let startPosX = 0;
  let startPosY = 0;

  function dragStart(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select')) {
      return;
    }
    e.preventDefault();
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPosX = posX ?? 295;
    startPosY = posY ?? 130;

    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);
  }

  function dragMove(e: MouseEvent) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    posX = Math.max(10, Math.min(window.innerWidth - 340, startPosX + dx));
    posY = Math.max(10, Math.min(window.innerHeight - 200, startPosY + dy));
  }

  function dragEnd() {
    isDragging = false;
    window.removeEventListener('mousemove', dragMove);
    window.removeEventListener('mouseup', dragEnd);
  }

  // Update structural model live when config values change via sliders
  function applyLiveUpdate() {
    const x = config.dropDivisor ?? 3;
    config.dropWidth = config.spacingX / x;
    config.dropDepth = config.spacingY / x;
    uiState.parametricConfig = { ...config };
    model.generateParametricStudy(config);
    uiState.setStatusMessage(`Grid Live Update: ${config.spansX}x${config.spansY} spans @ ${config.spacingX}m × ${config.spacingY}m`);
  }

  function close() {
    uiState.showParametricLivePanel = false;
  }

  let totalWidth = $derived((config.spansX * config.spacingX + 2 * config.overhangX).toFixed(2));
  let totalHeight = $derived((config.spansY * config.spacingY + 2 * config.overhangY).toFixed(2));
  let totalCols = $derived((config.spansX + 1) * (config.spansY + 1));
  let isLight = $derived(uiState.theme === 'light');
</script>

<div
  class="fixed z-30 w-84 max-h-[82vh] backdrop-blur-xl border shadow-2xl rounded-2xl p-4 overflow-y-auto flex flex-col gap-3 transition-colors duration-200 {isLight ? 'bg-white/95 text-slate-900 border-slate-300' : 'bg-[#141414]/95 text-white border-[#333333]'}"
  style={posX !== null && posY !== null ? `left: ${posX}px; top: ${posY}px; right: auto;` : `left: 295px; top: 130px; right: auto;`}
>
  <!-- Panel Header (Draggable Handle) -->
  <div
    class="flex items-center justify-between border-b pb-2.5 cursor-move select-none {isLight ? 'border-slate-200' : 'border-[#262626]'}"
    onmousedown={dragStart}
  >
    <div class="flex items-center gap-2">
      <span class="w-6 h-6 rounded-lg bg-[#D62430]/20 border border-[#D62430]/40 flex items-center justify-center text-xs">📊</span>
      <div>
        <h3 class="text-xs font-bold tracking-wide {isLight ? 'text-slate-900' : 'text-white'}">Parametric Grid Sliders</h3>
        <p class="text-[9px] {isLight ? 'text-slate-500' : 'text-slate-400'}">Live real-time geometric scaling</p>
      </div>
    </div>
    <div class="flex items-center gap-1">
      <button
        onclick={() => { uiState.showParametricStudyDialog = true; }}
        class="text-[9px] px-2.5 py-1 rounded-md transition-colors cursor-pointer {isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300' : 'bg-[#242424] hover:bg-[#333333] text-slate-300'}"
        title="Open Full Preset Dialog"
      >
        Presets
      </button>
    </div>
  </div>

  <!-- Live Stats Badge -->
  <div class="grid grid-cols-3 gap-2 text-center text-[9px] p-2 rounded-xl border {isLight ? 'bg-slate-100/90 border-slate-200' : 'bg-[#1a1a1a] border-[#282828]'}">
    <div>
      <span class="{isLight ? 'text-slate-500' : 'text-slate-400'} block">Total Width</span>
      <span class="font-bold text-[#D62430]">{totalWidth}m</span>
    </div>
    <div>
      <span class="{isLight ? 'text-slate-500' : 'text-slate-400'} block">Total Length</span>
      <span class="font-bold text-[#ff4d79]">{totalHeight}m</span>
    </div>
    <div>
      <span class="{isLight ? 'text-slate-500' : 'text-slate-400'} block">Columns</span>
      <span class="font-bold text-[#00e5ff]">{totalCols}</span>
    </div>
  </div>

  <!-- Live Sliders Group -->
  <div class="flex flex-col gap-3.5">
    <!-- 1. X Grid Spacing Slider -->
    <div class="p-2.5 rounded-xl border flex flex-col gap-1.5 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
      <div class="flex items-center justify-between text-xs">
        <label class="text-[10px] font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">X Grid Spacing (Lx)</label>
        <span class="font-mono text-[11px] font-bold text-[#D62430]">{config.spacingX.toFixed(1)} m</span>
      </div>
      <input
        type="range"
        min="2.0"
        max="15.0"
        step="0.1"
        bind:value={config.spacingX}
        oninput={applyLiveUpdate}
        class="w-full accent-[#D62430] cursor-pointer"
      />
      <div class="flex justify-between text-[8px] font-mono {isLight ? 'text-slate-400' : 'text-slate-500'}">
        <span>2.0m</span>
        <span>8.0m</span>
        <span>15.0m</span>
      </div>
    </div>

    <!-- 2. Y Grid Spacing Slider -->
    <div class="p-2.5 rounded-xl border flex flex-col gap-1.5 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
      <div class="flex items-center justify-between text-xs">
        <label class="text-[10px] font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">Y Grid Spacing (Ly)</label>
        <span class="font-mono text-[11px] font-bold text-[#D62430]">{config.spacingY.toFixed(1)} m</span>
      </div>
      <input
        type="range"
        min="2.0"
        max="15.0"
        step="0.1"
        bind:value={config.spacingY}
        oninput={applyLiveUpdate}
        class="w-full accent-[#D62430] cursor-pointer"
      />
      <div class="flex justify-between text-[8px] font-mono {isLight ? 'text-slate-400' : 'text-slate-500'}">
        <span>2.0m</span>
        <span>8.0m</span>
        <span>15.0m</span>
      </div>
    </div>

    <!-- 3. X & Y Spans Sliders -->
    <div class="grid grid-cols-2 gap-2">
      <div class="p-2.5 rounded-xl border flex flex-col gap-1 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
        <div class="flex items-center justify-between text-[10px]">
          <span class="font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">X Spans (Nx)</span>
          <span class="font-mono text-[#00e5ff] font-bold">{config.spansX}</span>
        </div>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          bind:value={config.spansX}
          oninput={applyLiveUpdate}
          class="w-full accent-[#00e5ff] cursor-pointer"
        />
      </div>

      <div class="p-2.5 rounded-xl border flex flex-col gap-1 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
        <div class="flex items-center justify-between text-[10px]">
          <span class="font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">Y Spans (Ny)</span>
          <span class="font-mono text-[#00e5ff] font-bold">{config.spansY}</span>
        </div>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          bind:value={config.spansY}
          oninput={applyLiveUpdate}
          class="w-full accent-[#00e5ff] cursor-pointer"
        />
      </div>
    </div>

    <!-- 4. Slab Thickness Slider -->
    <div class="p-2.5 rounded-xl border flex flex-col gap-1.5 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
      <div class="flex items-center justify-between text-xs">
        <label class="text-[10px] font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">Slab Thickness</label>
        <span class="font-mono text-[11px] font-bold text-[#ff4d79]">{config.slabThickness} mm</span>
      </div>
      <input
        type="range"
        min="120"
        max="400"
        step="10"
        bind:value={config.slabThickness}
        oninput={applyLiveUpdate}
        class="w-full accent-[#ff4d79] cursor-pointer"
      />
      <div class="flex justify-between text-[8px] font-mono {isLight ? 'text-slate-400' : 'text-slate-500'}">
        <span>120mm</span>
        <span>250mm</span>
        <span>400mm</span>
      </div>
    </div>

    <!-- 5. Column Size Slider -->
    <div class="p-2.5 rounded-xl border flex flex-col gap-1.5 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
      <div class="flex items-center justify-between text-xs">
        <label class="text-[10px] font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">
          {config.columnShape === 'circular' ? 'Column Diameter' : 'Column Width/Depth'}
        </label>
        <span class="font-mono text-[11px] font-bold text-[#00e5ff]">
          {config.columnShape === 'circular' ? `${config.columnDiameter}mm` : `${config.columnWidth}×${config.columnDepth}mm`}
        </span>
      </div>
      {#if config.columnShape === 'circular'}
        <input
          type="range"
          min="200"
          max="1000"
          step="25"
          bind:value={config.columnDiameter}
          oninput={applyLiveUpdate}
          class="w-full accent-[#00e5ff] cursor-pointer"
        />
      {:else}
        <input
          type="range"
          min="200"
          max="1000"
          step="25"
          bind:value={config.columnWidth}
          oninput={(e) => {
            const val = Number((e.target as HTMLInputElement).value);
            config.columnWidth = val;
            config.columnDepth = val;
            applyLiveUpdate();
          }}
          class="w-full accent-[#00e5ff] cursor-pointer"
        />
      {/if}
    </div>

    <!-- 6. Drop Panel Dimensions (L / x) -->
    {#if config.hasDropPanels}
      <div class="p-2.5 rounded-xl border flex flex-col gap-1.5 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
        <div class="flex items-center justify-between text-xs">
          <label class="text-[10px] font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">Drop Panel Size (L / x)</label>
          <span class="font-mono text-[11px] font-bold text-[#f97316]">
            L / {config.dropDivisor ?? 3} ({(config.spacingX / (config.dropDivisor ?? 3)).toFixed(2)}m × {(config.spacingY / (config.dropDivisor ?? 3)).toFixed(2)}m)
          </span>
        </div>
        <input
          type="range"
          min="2"
          max="10"
          step="1"
          bind:value={config.dropDivisor}
          oninput={(e) => {
            const x = Number((e.target as HTMLInputElement).value);
            config.dropDivisor = x;
            config.dropWidth = config.spacingX / x;
            config.dropDepth = config.spacingY / x;
            applyLiveUpdate();
          }}
          class="w-full accent-[#f97316] cursor-pointer"
        />
        <div class="flex justify-between text-[8px] font-mono {isLight ? 'text-slate-400' : 'text-slate-500'}">
          <span>L/2</span>
          <span>L/4</span>
          <span>L/6</span>
          <span>L/8</span>
          <span>L/10</span>
        </div>
      </div>
    {/if}

    <!-- 7. Overhang Slider -->
    <div class="p-2.5 rounded-xl border flex flex-col gap-1.5 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
      <div class="flex items-center justify-between text-xs">
        <label class="text-[10px] font-bold {isLight ? 'text-slate-800' : 'text-slate-300'}">Edge Overhang</label>
        <span class="font-mono text-[11px] font-bold text-indigo-400">{config.overhangX.toFixed(1)} m</span>
      </div>
      <input
        type="range"
        min="0.0"
        max="5.0"
        step="0.1"
        bind:value={config.overhangX}
        oninput={(e) => {
          const val = Number((e.target as HTMLInputElement).value);
          config.overhangX = val;
          config.overhangY = val;
          applyLiveUpdate();
        }}
        class="w-full accent-indigo-400 cursor-pointer"
      />
      <div class="flex justify-between text-[8px] font-mono {isLight ? 'text-slate-400' : 'text-slate-500'}">
        <span>0.0m</span>
        <span>2.5m</span>
        <span>5.0m</span>
      </div>
    </div>
  </div>

  <!-- Footer Quick Actions -->
  <div class="pt-2 border-t flex items-center gap-2 {isLight ? 'border-slate-200' : 'border-[#262626]'}">
    <button
      onclick={() => { model.resetView(); }}
      class="w-full py-1.5 rounded-lg text-[10px] font-bold transition-colors cursor-pointer text-center {isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300' : 'bg-[#242424] hover:bg-[#333333] text-slate-300'}"
    >
      Center View
    </button>
  </div>
</div>
