<script lang="ts">
  import { uiState } from '../stores/uiState.svelte';
  import { model } from '../stores/structuralModel.svelte';
  import type { ParametricConfig, BoundaryCondition } from '../engine/types';

  let preset = $state<'flatSlabDrops' | 'flatPlate' | 'gridBeams'>(uiState.parametricConfig.preset);

  let spansX = $state(uiState.parametricConfig.spansX);
  let spansY = $state(uiState.parametricConfig.spansY);
  let spacingX = $state(uiState.parametricConfig.spacingX);
  let spacingY = $state(uiState.parametricConfig.spacingY);
  let overhangX = $state(uiState.parametricConfig.overhangX);
  let overhangY = $state(uiState.parametricConfig.overhangY);

  let slabThickness = $state(uiState.parametricConfig.slabThickness);
  let concreteGrade = $state(uiState.parametricConfig.concreteGrade);
  let rebarGrade = $state(uiState.parametricConfig.rebarGrade);

  let hasDropPanels = $state(uiState.parametricConfig.hasDropPanels);
  let dropDivisor = $state(uiState.parametricConfig.dropDivisor ?? 3);
  let dropWidth = $derived(spacingX / dropDivisor);
  let dropDepth = $derived(spacingY / dropDivisor);
  let dropDrop = $state(uiState.parametricConfig.dropDrop);

  let columnShape = $state<'rectangular' | 'circular'>(uiState.parametricConfig.columnShape);
  let columnWidth = $state(uiState.parametricConfig.columnWidth);
  let columnDepth = $state(uiState.parametricConfig.columnDepth);
  let columnDiameter = $state(uiState.parametricConfig.columnDiameter);
  let columnHeight = $state(uiState.parametricConfig.columnHeight);
  let columnBoundary = $state<BoundaryCondition>(uiState.parametricConfig.columnBoundary);

  let deadLoad = $state(uiState.parametricConfig.deadLoad);
  let liveLoad = $state(uiState.parametricConfig.liveLoad);

  let hasGridBeams = $state(uiState.parametricConfig.hasGridBeams);
  let beamWidth = $state(uiState.parametricConfig.beamWidth);
  let beamDepth = $state(uiState.parametricConfig.beamDepth);

  let isLight = $derived(uiState.theme === 'light');

  // Sync state when preset changes
  function selectPreset(selected: 'flatSlabDrops' | 'flatPlate' | 'gridBeams') {
    preset = selected;
    if (selected === 'flatSlabDrops') {
      hasDropPanels = true;
      hasGridBeams = false;
    } else if (selected === 'flatPlate') {
      hasDropPanels = false;
      hasGridBeams = false;
    } else if (selected === 'gridBeams') {
      hasDropPanels = false;
      hasGridBeams = true;
    }
  }

  function close() {
    uiState.showParametricStudyDialog = false;
  }

  function handleGenerate() {
    const config: ParametricConfig = {
      preset,
      spansX,
      spansY,
      spacingX,
      spacingY,
      overhangX,
      overhangY,
      slabThickness,
      hasDropPanels: preset === 'flatSlabDrops' ? true : (preset === 'flatPlate' ? false : hasDropPanels),
      dropDivisor,
      dropWidth,
      dropDepth,
      dropDrop,
      columnShape,
      columnWidth,
      columnDepth,
      columnDiameter,
      columnHeight,
      columnBoundary,
      concreteGrade,
      rebarGrade,
      deadLoad,
      liveLoad,
      hasGridBeams: preset === 'gridBeams' ? true : hasGridBeams,
      beamWidth,
      beamDepth,
    };

    uiState.parametricConfig = { ...config };
    model.generateParametricStudy(config);
    model.resetView();

    uiState.showFEMResults = true;
    uiState.femAutoCompute = false;
    uiState.showParametricLivePanel = true;
    uiState.showParametricStudyDialog = false;
    uiState.setStatusMessage(`Parametric Flat Slab generated (${spansX}x${spansY} spans @ ${spacingX}m x ${spacingY}m)`);
  }

  // SVG Preview Calculations
  const previewWidth = 320;
  const previewHeight = 220;
  const margin = 35;

  let totalDimX = $derived((spansX * spacingX) + 2 * overhangX);
  let totalDimY = $derived((spansY * spacingY) + 2 * overhangY);
  let scaleX = $derived((previewWidth - 2 * margin) / (totalDimX || 1));
  let scaleY = $derived((previewHeight - 2 * margin) / (totalDimY || 1));
  let svgScale = $derived(Math.min(scaleX, scaleY));

  let originX = $derived(margin + overhangX * svgScale);
  let originY = $derived(margin + overhangY * svgScale);

  let gridCols = $derived(Array.from({ length: spansX + 1 }, (_, i) => i));
  let gridRows = $derived(Array.from({ length: spansY + 1 }, (_, i) => i));
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto backdrop-blur-md transition-colors duration-200 {isLight ? 'bg-slate-900/40' : 'bg-black/70'}"
  onclick={close}
>
  <div
    class="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl flex flex-col p-6 gap-5 transition-colors duration-200 {isLight ? 'bg-white text-slate-900 border-slate-300' : 'bg-[#141414]/95 text-white border-[#333333]'}"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Header -->
    <div class="flex items-center justify-between border-b pb-4 {isLight ? 'border-slate-200' : 'border-[#2a2a2a]'}">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-[#D62430]/20 border border-[#D62430]/40 flex items-center justify-center text-xl">
          📊
        </div>
        <div>
          <h2 class="text-base font-bold tracking-wide flex items-center gap-2 {isLight ? 'text-slate-900' : 'text-white'}">
            Parametric Study Generator
            <span class="text-[9px] bg-[#D62430] text-white px-2 py-0.5 rounded font-mono uppercase tracking-wider">ETABS Parity</span>
          </h2>
          <p class="text-xs {isLight ? 'text-slate-500' : 'text-slate-400'}">Generate uniform structural grid templates with live flat slab presets</p>
        </div>
      </div>
      <button
        onclick={close}
        class="text-lg w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer {isLight ? 'text-slate-400 hover:text-slate-900 hover:bg-slate-100' : 'text-slate-400 hover:text-white hover:bg-[#252525]'}"
      >
        ✕
      </button>
    </div>

    <!-- Presets Selector Tabs -->
    <div class="grid grid-cols-3 gap-3">
      <button
        type="button"
        onclick={() => selectPreset('flatSlabDrops')}
        class="flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-left cursor-pointer {preset === 'flatSlabDrops' ? (isLight ? 'bg-[#D62430]/10 border-[#D62430] text-slate-900 font-bold' : 'bg-[#D62430]/15 border-[#D62430] text-white') : (isLight ? 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900' : 'bg-[#1c1c1c] border-[#2e2e2e] text-slate-400 hover:border-slate-600 hover:text-white')}"
      >
        <span class="text-lg">▤</span>
        <span class="text-xs font-bold">Flat Slab + Drop Panels</span>
        <span class="text-[9px] text-center {isLight ? 'text-slate-500' : 'text-slate-400'}">ETABS standard uniform flat slab with drops at columns</span>
      </button>

      <button
        type="button"
        onclick={() => selectPreset('flatPlate')}
        class="flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-left cursor-pointer {preset === 'flatPlate' ? (isLight ? 'bg-[#D62430]/10 border-[#D62430] text-slate-900 font-bold' : 'bg-[#D62430]/15 border-[#D62430] text-white') : (isLight ? 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900' : 'bg-[#1c1c1c] border-[#2e2e2e] text-slate-400 hover:border-slate-600 hover:text-white')}"
      >
        <span class="text-lg">▣</span>
        <span class="text-xs font-bold">Flat Plate (No Drops)</span>
        <span class="text-[9px] text-center {isLight ? 'text-slate-500' : 'text-slate-400'}">Uniform slab direct on column supports</span>
      </button>

      <button
        type="button"
        onclick={() => selectPreset('gridBeams')}
        class="flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-left cursor-pointer {preset === 'gridBeams' ? (isLight ? 'bg-[#D62430]/10 border-[#D62430] text-slate-900 font-bold' : 'bg-[#D62430]/15 border-[#D62430] text-white') : (isLight ? 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900' : 'bg-[#1c1c1c] border-[#2e2e2e] text-slate-400 hover:border-slate-600 hover:text-white')}"
      >
        <span class="text-lg">▦</span>
        <span class="text-xs font-bold">Grid Beam & Slab System</span>
        <span class="text-[9px] text-center {isLight ? 'text-slate-500' : 'text-slate-400'}">Two-way floor slab supported by orthogonal grid beams</span>
      </button>
    </div>

    <!-- Main Form & Live Preview Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <!-- Form Input Column (7 cols) -->
      <div class="lg:col-span-7 flex flex-col gap-4 overflow-y-auto max-h-[52vh] pr-1">
        <!-- Warning Alert -->
        <div class="flex items-center gap-2 p-2.5 rounded-lg border text-[11px] {isLight ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-amber-950/40 border-amber-800/50 text-amber-300'}">
          <span class="text-sm">⚠️</span>
          <span>Generating a parametric model will clear existing elements in the workspace.</span>
        </div>

        <!-- 1. UNIFORM MATERIAL PROPERTIES (SINGLE INPUT) -->
        <div class="p-3.5 rounded-xl border flex flex-col gap-3 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
          <div class="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 {isLight ? 'text-emerald-700' : 'text-emerald-400'}">
            <span>🧱</span> Uniform Material Specification
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Concrete Grade (Uniform)</label>
              <select bind:value={concreteGrade} class="w-full rounded-lg px-2 py-1.5 text-xs border focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600' : 'bg-[#262626] border-[#383838] text-white focus:border-emerald-400'}">
                <option value="M20">M20 (fck = 20 MPa)</option>
                <option value="M25">M25 (fck = 25 MPa)</option>
                <option value="M30">M30 (fck = 30 MPa)</option>
                <option value="M35">M35 (fck = 35 MPa)</option>
                <option value="M40">M40 (fck = 40 MPa)</option>
                <option value="M45">M45 (fck = 45 MPa)</option>
                <option value="M50">M50 (fck = 50 MPa)</option>
              </select>
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Steel Rebar Grade</label>
              <select bind:value={rebarGrade} class="w-full rounded-lg px-2 py-1.5 text-xs border focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600' : 'bg-[#262626] border-[#383838] text-white focus:border-emerald-400'}">
                <option value="Fe250">Fe250 (fy = 250 MPa)</option>
                <option value="Fe415">Fe415 (fy = 415 MPa)</option>
                <option value="Fe500">Fe500 (fy = 500 MPa)</option>
                <option value="Fe550">Fe550 (fy = 550 MPa)</option>
                <option value="Fe600">Fe600 (fy = 600 MPa)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 2. Grid Specifications -->
        <div class="p-3.5 rounded-xl border flex flex-col gap-3 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
          <div class="text-xs font-bold text-[#D62430] uppercase tracking-wider flex items-center gap-1.5">
            <span>🌐</span> Grid & Span Dimensions
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">X Spans (Nx)</label>
              <input type="number" min="1" max="10" bind:value={spansX} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#D62430] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Y Spans (Ny)</label>
              <input type="number" min="1" max="10" bind:value={spansY} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#D62430] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">X Spacing Lx (m)</label>
              <input type="number" step="0.1" min="1" max="25" bind:value={spacingX} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#D62430] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Y Spacing Ly (m)</label>
              <input type="number" step="0.1" min="1" max="25" bind:value={spacingY} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#D62430] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Overhang X (m)</label>
              <input type="number" step="0.1" min="0" max="5" bind:value={overhangX} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#D62430] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Overhang Y (m)</label>
              <input type="number" step="0.1" min="0" max="5" bind:value={overhangY} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#D62430] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
          </div>
        </div>

        <!-- 3. Column Specifications -->
        <div class="p-3.5 rounded-xl border flex flex-col gap-3 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
          <div class="text-xs font-bold text-[#00e5ff] uppercase tracking-wider flex items-center gap-1.5">
            <span>⊞</span> Column Properties
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Column Shape</label>
              <select bind:value={columnShape} class="w-full rounded-lg px-2 py-1.5 text-xs border focus:border-[#00e5ff] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}">
                <option value="rectangular">Rectangular</option>
                <option value="circular">Circular</option>
              </select>
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Story Height (mm)</label>
              <input type="number" step="100" min="1500" max="10000" bind:value={columnHeight} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#00e5ff] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
          </div>

          {#if columnShape === 'rectangular'}
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Width b (mm)</label>
                <input type="number" step="25" min="150" max="2000" bind:value={columnWidth} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#00e5ff] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
              </div>
              <div>
                <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Depth d (mm)</label>
                <input type="number" step="25" min="150" max="2000" bind:value={columnDepth} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#00e5ff] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
              </div>
            </div>
          {:else}
            <div class="grid grid-cols-1 gap-3">
              <div>
                <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Diameter D (mm)</label>
                <input type="number" step="25" min="150" max="2000" bind:value={columnDiameter} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#00e5ff] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
              </div>
            </div>
          {/if}
        </div>

        <!-- 4. Thickness Specifications -->
        <div class="p-3.5 rounded-xl border flex flex-col gap-3 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
          <div class="text-xs font-bold text-[#ff4d79] uppercase tracking-wider flex items-center gap-1.5">
            <span>▣</span> Thickness
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Slab Thickness (mm)</label>
              <input type="number" step="10" min="100" max="600" bind:value={slabThickness} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#ff4d79] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            {#if preset === 'flatSlabDrops' || hasDropPanels}
              <div>
                <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">
                  Drop Projection (mm) <span class="text-[9px] font-mono text-[#f97316] font-bold">Total: {slabThickness + dropDrop}mm</span>
                </label>
                <input type="number" step="25" min="50" max="400" bind:value={dropDrop} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-[#f97316] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
              </div>
            {/if}
          </div>

          {#if preset === 'flatSlabDrops' || hasDropPanels}
            <div class="mt-1 pt-2 border-t flex flex-col gap-2 {isLight ? 'border-slate-200' : 'border-[#2d2d2d]'}">
              <div class="flex items-center justify-between">
                <div class="text-[11px] font-bold text-[#f97316]">Drop Panel Size (L / x)</div>
                <div class="text-[10px] font-mono text-[#f97316] font-bold">{dropWidth.toFixed(2)}m × {dropDepth.toFixed(2)}m</div>
              </div>
              <div>
                <label class="text-[9px] block mb-0.5 {isLight ? 'text-slate-600' : 'text-slate-400'}">Drop Size Ratio (L / x)</label>
                <select bind:value={dropDivisor} class="w-full rounded-lg px-2 py-1.5 text-xs border focus:border-[#f97316] focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}">
                  <option value={2}>L / 2 (x = 2)</option>
                  <option value={3}>L / 3 (x = 3)</option>
                  <option value={4}>L / 4 (x = 4)</option>
                  <option value={5}>L / 5 (x = 5)</option>
                  <option value={6}>L / 6 (x = 6)</option>
                  <option value={7}>L / 7 (x = 7)</option>
                  <option value={8}>L / 8 (x = 8)</option>
                  <option value={9}>L / 9 (x = 9)</option>
                </select>
              </div>
            </div>
          {/if}

          {#if preset === 'gridBeams' || hasGridBeams}
            <div class="mt-1 pt-2 border-t flex flex-col gap-2 {isLight ? 'border-slate-200' : 'border-[#2d2d2d]'}">
              <div class="text-[11px] font-bold text-[#10b981]">Grid Beam Dimensions</div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="text-[9px] block mb-0.5 {isLight ? 'text-slate-600' : 'text-slate-400'}">Beam Width (mm)</label>
                  <input type="number" step="25" min="150" max="1000" bind:value={beamWidth} class="w-full rounded-lg px-2 py-1 text-xs border {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
                </div>
                <div>
                  <label class="text-[9px] block mb-0.5 {isLight ? 'text-slate-600' : 'text-slate-400'}">Beam Depth (mm)</label>
                  <input type="number" step="25" min="200" max="1500" bind:value={beamDepth} class="w-full rounded-lg px-2 py-1 text-xs border {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
                </div>
              </div>
            </div>
          {/if}
        </div>

        <!-- 5. Loading Specifications -->
        <div class="p-3.5 rounded-xl border flex flex-col gap-3 {isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#1c1c1c] border-[#2a2a2a]'}">
          <div class="text-xs font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
            <span>⚖️</span> Floor Loading
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Superimposed DL (kN/m²)</label>
              <input type="number" step="0.5" min="0" max="20" bind:value={deadLoad} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-indigo-400 focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
            <div>
              <label class="text-[10px] block mb-1 {isLight ? 'text-slate-600' : 'text-slate-400'}">Live Load LL (kN/m²)</label>
              <input type="number" step="0.5" min="0" max="20" bind:value={liveLoad} class="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:border-indigo-400 focus:outline-none {isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#262626] border-[#383838] text-white'}" />
            </div>
          </div>
        </div>
      </div>

      <!-- Live Blueprint Preview (5 cols) -->
      <div class="lg:col-span-5 flex flex-col gap-3 p-4 rounded-xl border items-center justify-between {isLight ? 'bg-slate-100 border-slate-200' : 'bg-[#181818] border-[#2e2e2e]'}">
        <div class="w-full flex items-center justify-between border-b pb-2 {isLight ? 'border-slate-200' : 'border-[#282828]'}">
          <span class="text-xs font-bold flex items-center gap-1.5 {isLight ? 'text-slate-800' : 'text-slate-300'}">
            <span>👁️</span> Live Blueprint Preview
          </span>
          <span class="text-[10px] font-mono {isLight ? 'text-slate-500' : 'text-slate-500'}">{(spansX * spacingX).toFixed(1)}m × {(spansY * spacingY).toFixed(1)}m</span>
        </div>

        <!-- SVG Canvas -->
        <div class="w-full rounded-lg border p-2 flex items-center justify-center overflow-hidden min-h-[240px] {isLight ? 'bg-white border-slate-300' : 'bg-[#0d0d0d] border-[#2a2a2a]'}">
          <svg width={previewWidth} height={previewHeight} class="select-none">
            <!-- Grid Background Lines -->
            <defs>
              <pattern id="modalGrid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke={isLight ? '#f0f0f0' : '#1f1f1f'} stroke-width="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#modalGrid)" />

            <!-- Outer Slab Boundary -->
            <rect
              x={originX - overhangX * svgScale}
              y={originY - overhangY * svgScale}
              width={(spansX * spacingX + 2 * overhangX) * svgScale}
              height={(spansY * spacingY + 2 * overhangY) * svgScale}
              fill="#ff4d7915"
              stroke="#ff4d79"
              stroke-width="1.5"
              stroke-dasharray="4 2"
              rx="3"
            />

            <!-- Grid Beams (if enabled) -->
            {#if preset === 'gridBeams' || hasGridBeams}
              {#each gridRows as ry}
                <line
                  x1={originX}
                  y1={originY + ry * spacingY * svgScale}
                  x2={originX + spansX * spacingX * svgScale}
                  y2={originY + ry * spacingY * svgScale}
                  stroke="#10b981"
                  stroke-width="3"
                  opacity="0.8"
                />
              {/each}
              {#each gridCols as cx}
                <line
                  x1={originX + cx * spacingX * svgScale}
                  y1={originY}
                  x2={originX + cx * spacingX * svgScale}
                  y2={originY + spansY * spacingY * svgScale}
                  stroke="#10b981"
                  stroke-width="3"
                  opacity="0.8"
                />
              {/each}
            {/if}

            <!-- Grid Lines -->
            {#each gridCols as cx}
              <line
                x1={originX + cx * spacingX * svgScale}
                y1={originY - 10}
                x2={originX + cx * spacingX * svgScale}
                y2={originY + spansY * spacingY * svgScale + 10}
                stroke={isLight ? '#94a3b8' : '#444444'}
                stroke-width="1"
                stroke-dasharray="3 3"
              />
              <text
                x={originX + cx * spacingX * svgScale}
                y={originY - 14}
                fill={isLight ? '#475569' : '#888888'}
                font-size="9"
                text-anchor="middle"
                font-weight="bold"
              >{String.fromCharCode(65 + cx)}</text>
            {/each}

            {#each gridRows as ry}
              <line
                x1={originX - 10}
                y1={originY + ry * spacingY * svgScale}
                x2={originX + spansX * spacingX * svgScale + 10}
                y2={originY + ry * spacingY * svgScale}
                stroke={isLight ? '#94a3b8' : '#444444'}
                stroke-width="1"
                stroke-dasharray="3 3"
              />
              <text
                x={originX - 14}
                y={originY + ry * spacingY * svgScale + 3}
                fill={isLight ? '#475569' : '#888888'}
                font-size="9"
                text-anchor="middle"
                font-weight="bold"
              >{ry + 1}</text>
            {/each}

            <!-- Drop Panels -->
            {#if preset === 'flatSlabDrops' || hasDropPanels}
              {#each gridCols as cx}
                {#each gridRows as ry}
                  <rect
                    x={originX + cx * spacingX * svgScale - (dropWidth * svgScale) / 2}
                    y={originY + ry * spacingY * svgScale - (dropDepth * svgScale) / 2}
                    width={dropWidth * svgScale}
                    height={dropDepth * svgScale}
                    fill="#f9731620"
                    stroke="#f97316"
                    stroke-width="1"
                  />
                {/each}
              {/each}
            {/if}

            <!-- Columns -->
            {#each gridCols as cx}
              {#each gridRows as ry}
                {#if columnShape === 'circular'}
                  <circle
                    cx={originX + cx * spacingX * svgScale}
                    cy={originY + ry * spacingY * svgScale}
                    r={Math.max(3, (columnDiameter / 1000) * svgScale * 0.5)}
                    fill="#00e5ff"
                    stroke="#0099bb"
                    stroke-width="1"
                  />
                {:else}
                  <rect
                    x={originX + cx * spacingX * svgScale - Math.max(3, ((columnWidth / 1000) * svgScale) / 2)}
                    y={originY + ry * spacingY * svgScale - Math.max(3, ((columnDepth / 1000) * svgScale) / 2)}
                    width={Math.max(6, (columnWidth / 1000) * svgScale)}
                    height={Math.max(6, (columnDepth / 1000) * svgScale)}
                    fill="#00e5ff"
                    stroke="#0099bb"
                    stroke-width="1"
                  />
                {/if}
              {/each}
            {/each}
          </svg>
        </div>

        <!-- Summary Statistics -->
        <div class="w-full grid grid-cols-3 gap-2 text-center text-[10px]">
          <div class="p-2 rounded-lg border {isLight ? 'bg-white border-slate-200' : 'bg-[#222222] border-[#333333]'}">
            <span class="block {isLight ? 'text-slate-500' : 'text-slate-400'}">Total Columns</span>
            <span class="font-bold text-[#00e5ff]">{(spansX + 1) * (spansY + 1)}</span>
          </div>
          <div class="p-2 rounded-lg border {isLight ? 'bg-white border-slate-200' : 'bg-[#222222] border-[#333333]'}">
            <span class="block {isLight ? 'text-slate-500' : 'text-slate-400'}">Slab Area</span>
            <span class="font-bold text-[#ff4d79]">{totalDimX.toFixed(1)}m × {totalDimY.toFixed(1)}m</span>
          </div>
          <div class="p-2 rounded-lg border {isLight ? 'bg-white border-slate-200' : 'bg-[#222222] border-[#333333]'}">
            <span class="block {isLight ? 'text-slate-500' : 'text-slate-400'}">Drop Panels</span>
            <span class="font-bold text-[#f97316]">{hasDropPanels || preset === 'flatSlabDrops' ? (spansX + 1) * (spansY + 1) : 0}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal Footer Actions -->
    <div class="flex items-center justify-end gap-3 pt-3 border-t {isLight ? 'border-slate-200' : 'border-[#2a2a2a]'}">
      <button
        type="button"
        onclick={close}
        class="px-5 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer {isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700' : 'bg-[#242424] hover:bg-[#333333] text-slate-300'}"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={handleGenerate}
        class="px-6 py-2 rounded-xl text-xs font-bold text-white bg-[#D62430] hover:bg-[#b51c26] shadow-lg shadow-[#D62430]/30 transition-all cursor-pointer flex items-center gap-2"
      >
        <span>⚡</span>
        <span>Generate Model & Launch Live Controls</span>
      </button>
    </div>
  </div>
</div>
