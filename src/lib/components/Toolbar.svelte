<script lang="ts">
  import { uiState } from '../stores/uiState.svelte';
  import { model } from '../stores/structuralModel.svelte';
  import MaterialProperty from './MaterialProperty.svelte';

  const tools: { type: 'column' | 'wall' | 'nonStructuralWall' | 'beam' | 'slab' | 'opening' | 'dropPanel' | 'calibrate' | 'measure'; label: string; icon: string; shortcut: string }[] = [
    { type: 'measure', label: 'Measure', icon: '📏', shortcut: 'M' },
    { type: 'column', label: 'Column', icon: '⊞', shortcut: 'C' },
    { type: 'wall', label: 'Wall', icon: '≡', shortcut: 'W' },
    { type: 'nonStructuralWall', label: 'Partition', icon: '▦', shortcut: 'P' },
    { type: 'beam', label: 'Beam', icon: '━', shortcut: 'B' },
    { type: 'slab', label: 'Slab', icon: '▣', shortcut: 'S' },
    { type: 'dropPanel', label: 'Drop Panel', icon: '▤', shortcut: 'D' },
    { type: 'opening', label: 'Opening', icon: '◻', shortcut: 'O' },
    { type: 'calibrate', label: 'Calibrate', icon: '⇌', shortcut: 'L' },
  ];

  let wallSubMode = $state<'single' | 'polyline'>(uiState.wallDrawMode);
  let partitionSubMode = $state<'single' | 'polyline'>(uiState.partitionDrawMode);
  let dpWidth = $state(uiState.dropPanelWidth);
  let dpDepth = $state(uiState.dropPanelDepth);
  let dpDrop = $state(uiState.dropPanelDrop);

  $effect(() => { uiState.dropPanelWidth = dpWidth; });
  $effect(() => { uiState.dropPanelDepth = dpDepth; });
  $effect(() => { uiState.dropPanelDrop = dpDrop; });

  $effect(() => { uiState.wallDrawMode = wallSubMode; });
  $effect(() => { uiState.partitionDrawMode = partitionSubMode; });

  let allSlabsLocked = $derived(model.slabs.length > 0 && model.slabs.every(s => model.isLocked(s.id)));
  let allColsLocked = $derived(model.columns.length > 0 && model.columns.every(s => model.isLocked(s.id)));
  let allWallsLocked = $derived(model.walls.length > 0 && model.walls.every(s => model.isLocked(s.id)));
  let partWallIds = $derived([...model.nonStructuralWalls.map(s => s.id), ...model.polylineNonStructuralWalls.map(s => s.id)]);
  let allPartsLocked = $derived(partWallIds.length > 0 && partWallIds.every(id => model.isLocked(id)));
  let allBeamsLocked = $derived(model.beams.length > 0 && model.beams.every(s => model.isLocked(s.id)));
  let allDpLocked = $derived(model.dropPanels.length > 0 && model.dropPanels.every(s => model.isLocked(s.id)));

  let lockAnim = $state<string | null>(null);

  function animateLock(group: string) {
    lockAnim = group;
    setTimeout(() => { if (lockAnim === group) lockAnim = null; }, 400);
  }

  function toggleSlabLock() {
    const ids = model.slabs.map(s => s.id);
    if (ids.every(id => model.isLocked(id))) ids.forEach(id => model.unlockElement(id));
    else ids.forEach(id => model.lockElement(id));
    animateLock('slabs');
  }
  function toggleColLock() {
    const ids = model.columns.map(s => s.id);
    if (ids.every(id => model.isLocked(id))) ids.forEach(id => model.unlockElement(id));
    else ids.forEach(id => model.lockElement(id));
    animateLock('cols');
  }
  function toggleWallLock() {
    const ids = model.walls.map(s => s.id);
    if (ids.every(id => model.isLocked(id))) ids.forEach(id => model.unlockElement(id));
    else ids.forEach(id => model.lockElement(id));
    animateLock('walls');
  }
  function togglePartLock() {
    if (partWallIds.every(id => model.isLocked(id))) partWallIds.forEach(id => model.unlockElement(id));
    else partWallIds.forEach(id => model.lockElement(id));
    animateLock('parts');
  }
  function toggleBeamLock() {
    const ids = model.beams.map(s => s.id);
    if (ids.every(id => model.isLocked(id))) ids.forEach(id => model.unlockElement(id));
    else ids.forEach(id => model.lockElement(id));
    animateLock('beams');
  }
  function toggleDpLock() {
    const ids = model.dropPanels.map(s => s.id);
    if (ids.every(id => model.isLocked(id))) ids.forEach(id => model.unlockElement(id));
    else ids.forEach(id => model.lockElement(id));
    animateLock('dp');
  }
</script>

<div class="sidebar-panel flex flex-col gap-0.5 rounded-lg bg-[#1a1a1a] p-1.5 shadow-lg border border-[#333333]">
  <!-- Parametric Study Button -->
  <button
    class="w-full flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors text-[#ffffff] bg-[#333333]/50 hover:bg-[#D62430] hover:text-white cursor-pointer select-none mb-1 border border-[#444444]/30"
    onclick={() => uiState.setStatusMessage('Parametric Study mode selected (Not implemented)')}
    title="Parametric Study"
  >
    <span class="w-5 text-center text-base">📊</span>
    <span class="flex-1 text-left text-xs font-medium">Parametric Study</span>
    <span class="text-[8px] bg-slate-700 text-slate-300 px-1 py-0.2 rounded uppercase font-bold tracking-wider">PRO</span>
  </button>

  {#each tools as t}
    <div class="flex flex-col">
      <button
        class="w-full flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors
          {uiState.tool === t.type
            ? 'bg-[#D62430] text-white'
            : 'text-[#ffffff] hover:bg-[#333333] hover:text-white'}"
        class:active={uiState.tool === t.type}
        onclick={() => uiState.setTool(t.type)}
        title="{t.label} ({t.shortcut})"
      >
        <span class="w-5 text-center text-base">{t.icon}</span>
        <span class="flex-1 text-left text-xs font-medium">{t.label}</span>
        <span class="text-[10px] text-[#666666] font-mono">{t.shortcut}</span>
      </button>
      {#if uiState.tool === t.type && t.type === 'slab'}
        <div class="flex gap-1 px-1">
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {uiState.slabDrawMode === 'polygon' ? 'bg-[#333333] text-white border-[#D62430]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#333333] hover:text-white'}"
            class:active={uiState.slabDrawMode === 'polygon'}
            onclick={(e) => { e.stopPropagation(); uiState.slabDrawMode = 'polygon'; }}
          >Poly</button>
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {uiState.slabDrawMode === 'rectangular' ? 'bg-[#333333] text-white border-[#D62430]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#333333] hover:text-white'}"
            class:active={uiState.slabDrawMode === 'rectangular'}
            onclick={(e) => { e.stopPropagation(); uiState.slabDrawMode = 'rectangular'; }}
          >Rect</button>
        </div>
      {/if}
      {#if uiState.tool === t.type && t.type === 'opening'}
        <div class="flex gap-0.5 px-1">
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {uiState.openingDrawMode === 'polygon' ? 'bg-[#333333] text-white border-[#D62430]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#333333] hover:text-white'}"
            class:active={uiState.openingDrawMode === 'polygon'}
            onclick={(e) => { e.stopPropagation(); uiState.openingDrawMode = 'polygon'; }}
          >Poly</button>
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {uiState.openingDrawMode === 'rectangular' ? 'bg-[#333333] text-white border-[#D62430]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#333333] hover:text-white'}"
            class:active={uiState.openingDrawMode === 'rectangular'}
            onclick={(e) => { e.stopPropagation(); uiState.openingDrawMode = 'rectangular'; }}
          >Rect</button>
        </div>
      {/if}
      {#if uiState.tool === t.type && t.type === 'beam'}
        <div class="flex items-center gap-1 px-1">
          <label class="text-[9px] text-[#ffffff] flex-1">Width</label>
          <select bind:value={uiState.beamWidth} class="w-16 rounded bg-[#333333] px-1 py-0.5 text-white text-[9px] border border-[#444444]">
            <option value={200}>200mm</option>
            <option value={230}>230mm</option>
            <option value={300}>300mm</option>
            <option value={350}>350mm</option>
            <option value={400}>400mm</option>
            <option value={450}>450mm</option>
            <option value={500}>500mm</option>
          </select>
        </div>
        <div class="flex items-center gap-1 px-1">
          <label class="text-[9px] text-[#ffffff] flex-1">Depth</label>
          <select bind:value={uiState.beamDepth} class="w-16 rounded bg-[#333333] px-1 py-0.5 text-white text-[9px] border border-[#444444]">
            <option value={300}>300mm</option>
            <option value={350}>350mm</option>
            <option value={400}>400mm</option>
            <option value={450}>450mm</option>
            <option value={500}>500mm</option>
            <option value={600}>600mm</option>
            <option value={750}>750mm</option>
            <option value={900}>900mm</option>
          </select>
        </div>
      {/if}
      {#if uiState.tool === t.type && t.type === 'dropPanel'}
        <div class="flex flex-col gap-0.5 px-1">
          <div class="flex items-center gap-1">
            <label class="text-[9px] text-[#ffffff] flex-1">Width</label>
            <select bind:value={dpWidth} class="w-16 rounded bg-[#333333] px-1 py-0.5 text-white text-[9px] border border-[#444444]">
              <option value={1000}>1.0m</option>
              <option value={1200}>1.2m</option>
              <option value={1500}>1.5m</option>
              <option value={1800}>1.8m</option>
              <option value={2000}>2.0m</option>
              <option value={2500}>2.5m</option>
            </select>
          </div>
          <div class="flex items-center gap-1">
            <label class="text-[9px] text-[#ffffff] flex-1">Depth</label>
            <select bind:value={dpDepth} class="w-16 rounded bg-[#333333] px-1 py-0.5 text-white text-[9px] border border-[#444444]">
              <option value={1000}>1.0m</option>
              <option value={1200}>1.2m</option>
              <option value={1500}>1.5m</option>
              <option value={1800}>1.8m</option>
              <option value={2000}>2.0m</option>
              <option value={2500}>2.5m</option>
            </select>
          </div>
          <div class="flex items-center gap-1">
            <label class="text-[9px] text-[#ffffff] flex-1">Drop</label>
            <select bind:value={dpDrop} class="w-16 rounded bg-[#333333] px-1 py-0.5 text-white text-[9px] border border-[#444444]">
              <option value={100}>100mm</option>
              <option value={150}>150mm</option>
              <option value={200}>200mm</option>
              <option value={250}>250mm</option>
              <option value={300}>300mm</option>
            </select>
          </div>
        </div>
      {/if}
      {#if uiState.tool === t.type && t.type === 'wall'}
        <div class="flex gap-0.5 px-1">
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {wallSubMode === 'single' ? 'bg-[#333333] text-white border-[#D62430]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#333333] hover:text-white'}"
            class:active={wallSubMode === 'single'}
            onclick={(e) => { e.stopPropagation(); wallSubMode = 'single'; }}
          >Single</button>
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {wallSubMode === 'polyline' ? 'bg-[#333333] text-white border-[#D62430]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#333333] hover:text-white'}"
            class:active={wallSubMode === 'polyline'}
            onclick={(e) => { e.stopPropagation(); wallSubMode = 'polyline'; }}
          >Poly</button>
        </div>
      {/if}
      {#if uiState.tool === t.type && t.type === 'nonStructuralWall'}
        <div class="flex gap-0.5 px-1">
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {partitionSubMode === 'single' ? 'bg-[#f97316] text-white border-[#f97316]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#f97316] hover:text-white'}"
            class:active={partitionSubMode === 'single'}
            onclick={(e) => { e.stopPropagation(); partitionSubMode = 'single'; }}
          >Single</button>
          <button
            class="flex-1 py-0.5 text-[9px] rounded border transition-colors text-center cursor-pointer {partitionSubMode === 'polyline' ? 'bg-[#f97316] text-white border-[#f97316]' : 'bg-[#1a1a1a] text-[#ffffff] border-[#333333] hover:bg-[#f97316] hover:text-white'}"
            class:active={partitionSubMode === 'polyline'}
            onclick={(e) => { e.stopPropagation(); partitionSubMode = 'polyline'; }}
          >Poly</button>
        </div>
      {/if}
      {#if t.type === 'calibrate'}
        <div class="flex items-center gap-1 px-1 py-0.5 text-[9px]">
          <span class="inline-block h-1.5 w-1.5 rounded-full {model.isCalibrated ? 'bg-green-500' : 'bg-[#666666]'}"></span>
          <span class={model.isCalibrated ? 'text-green-400' : 'text-[#ffffff]'}>
            {model.isCalibrated ? model.calibratedLabel : 'Not calibrated'}
          </span>
        </div>
      {/if}
    </div>
  {/each}

  <div class="border-t border-[#333333]"></div>

  <div class="flex gap-0.5">
    <button
      class="flex-1 rounded px-1.5 py-1 text-[10px] transition-colors {(model.history.canUndo || uiState.isDrawing) ? 'text-[#ffffff] hover:bg-[#D62430] hover:text-white' : 'text-[#666666] cursor-not-allowed'}"
      onclick={() => { if (uiState.isDrawing && uiState.cancelDrawing) { uiState.cancelDrawing(); } else if (model.history.canUndo) { model.undo(); uiState.setStatusMessage('Undo'); } }}
      disabled={!model.history.canUndo && !uiState.isDrawing}
      title={uiState.isDrawing ? 'Cancel drawing (Esc)' : 'Undo (Ctrl+Z)'}
    >{uiState.isDrawing ? '✕ Cancel' : '↩ Undo'}</button>
    <button
      class="flex-1 rounded px-1.5 py-1 text-[10px] transition-colors {model.history.canRedo ? 'text-[#ffffff] hover:bg-[#D62430] hover:text-white' : 'text-[#666666] cursor-not-allowed'}"
      onclick={() => { if (model.history.canRedo) { model.redo(); uiState.setStatusMessage('Redo'); } }}
      disabled={!model.history.canRedo}
      title="Redo (Ctrl+Shift+Z)"
    >↪ Redo</button>
  </div>

  <div class="border-t border-[#333333]"></div>

  <div class="flex items-center justify-between gap-1 px-1.5 py-0.5 text-[9px] text-[#ffffff]">
    <label class="flex items-center gap-1 cursor-pointer">
      <input type="checkbox" checked={uiState.showGrid}
        onchange={(e) => {
          const on = (e.currentTarget as HTMLInputElement).checked;
          uiState.showGrid = on;
          if (!on) uiState.snapToGrid = false;
        }}
        class="accent-[#D62430]" />
      Grid
    </label>
    {#if uiState.showGrid}
      <div class="flex items-center gap-0.5">
        <input type="number" min="0.1" step="any" bind:value={uiState.gridSize}
          class="w-9 rounded bg-[#333333] px-1 py-0.5 text-white text-[9px] border border-[#444444] text-center" />
        <label class="flex items-center gap-0.5 cursor-pointer">
          <input type="checkbox" bind:checked={uiState.snapToGrid} class="accent-[#D62430]" />
          Snap
        </label>
      </div>
    {/if}
    <label class="flex items-center gap-0.5 cursor-pointer">
      <input type="checkbox" bind:checked={uiState.edgeNodeInsertionEnabled} class="accent-[#D62430]" />
      Edge
    </label>
  </div>

  <div class="border-t border-[#333333]"></div>

  <div class="grid grid-cols-2 gap-1 mx-1.5">
    <button
      class="flex items-center justify-center gap-1 rounded bg-[#333333] hover:bg-[#D62430] text-[#ffffff] py-1 text-[9px] font-semibold transition-colors text-center cursor-pointer select-none"
      onclick={() => { model.autoNumberElements(); uiState.setStatusMessage('Auto numbered elements'); }}
      title="Auto number elements"
    >
      <span>🔢</span> Auto Num
    </button>

    <button
      class="flex items-center justify-center gap-1 rounded py-1 text-[9px] font-semibold transition-colors text-center cursor-pointer select-none {uiState.showLabels ? 'bg-[#D62430] text-[#ffffff]' : 'bg-[#333333] text-[#ffffff] hover:bg-[#D62430]'}"
      onclick={() => { uiState.showLabels = !uiState.showLabels; uiState.setStatusMessage(uiState.showLabels ? 'Labels shown' : 'Labels hidden'); }}
      title="Toggle element labels"
    >
      <span>🏷️</span> Labels {uiState.showLabels ? 'ON' : 'OFF'}
    </button>
  </div>

  <div class="border-t border-[#333333]"></div>

  <div class="text-[9px] font-bold text-[#ffffff] uppercase tracking-wider px-1.5">Visibility / Lock</div>

  <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 px-1.5 text-[9px]">
    <!-- Slabs -->
    <div class="flex items-center gap-1">
      <input type="checkbox" bind:checked={uiState.showSlabs} class="accent-[#D62430]" />
      <span class="flex-1 text-[#ffffff] truncate">Slabs</span>
      <button
        onclick={toggleSlabLock}
        class="lock-btn text-[9px] p-0.5 rounded transition-all duration-200 cursor-pointer"
        class:text-[#f59e0b]={allSlabsLocked}
        class:text-[#666666]={!allSlabsLocked}
        class:lock-animate={lockAnim === 'slabs'}
        title={allSlabsLocked ? 'Unlock all slabs' : 'Lock all slabs'}
      >{allSlabsLocked ? '🔒' : '🔓'}</button>
    </div>

    <!-- Columns -->
    <div class="flex items-center gap-1">
      <input type="checkbox" bind:checked={uiState.showColumns} class="accent-[#D62430]" />
      <span class="flex-1 text-[#ffffff] truncate">Cols</span>
      <button
        onclick={toggleColLock}
        class="lock-btn text-[9px] p-0.5 rounded transition-all duration-200 cursor-pointer"
        class:text-[#f59e0b]={allColsLocked}
        class:text-[#666666]={!allColsLocked}
        class:lock-animate={lockAnim === 'cols'}
        title={allColsLocked ? 'Unlock all columns' : 'Lock all columns'}
      >{allColsLocked ? '🔒' : '🔓'}</button>
    </div>

    <!-- Walls -->
    <div class="flex items-center gap-1">
      <input type="checkbox" bind:checked={uiState.showWalls} class="accent-[#D62430]" />
      <span class="flex-1 text-[#ffffff] truncate">Walls</span>
      <button
        onclick={toggleWallLock}
        class="lock-btn text-[9px] p-0.5 rounded transition-all duration-200 cursor-pointer"
        class:text-[#f59e0b]={allWallsLocked}
        class:text-[#666666]={!allWallsLocked}
        class:lock-animate={lockAnim === 'walls'}
        title={allWallsLocked ? 'Unlock all walls' : 'Lock all walls'}
      >{allWallsLocked ? '🔒' : '🔓'}</button>
    </div>

    <!-- Partitions -->
    <div class="flex items-center gap-1">
      <input type="checkbox" bind:checked={uiState.showNonStructuralWalls} class="accent-[#D62430]" />
      <span class="flex-1 text-[#ffffff] truncate">Parts</span>
      <button
        onclick={togglePartLock}
        class="lock-btn text-[9px] p-0.5 rounded transition-all duration-200 cursor-pointer"
        class:text-[#f59e0b]={allPartsLocked}
        class:text-[#666666]={!allPartsLocked}
        class:lock-animate={lockAnim === 'parts'}
        title={allPartsLocked ? 'Unlock all partitions' : 'Lock all partitions'}
      >{allPartsLocked ? '🔒' : '🔓'}</button>
    </div>

    <!-- Beams -->
    <div class="flex items-center gap-1">
      <input type="checkbox" bind:checked={uiState.showBeams} class="accent-[#D62430]" />
      <span class="flex-1 text-[#ffffff] truncate">Beams</span>
      <button
        onclick={toggleBeamLock}
        class="lock-btn text-[9px] p-0.5 rounded transition-all duration-200 cursor-pointer"
        class:text-[#f59e0b]={allBeamsLocked}
        class:text-[#666666]={!allBeamsLocked}
        class:lock-animate={lockAnim === 'beams'}
        title={allBeamsLocked ? 'Unlock all beams' : 'Lock all beams'}
      >{allBeamsLocked ? '🔒' : '🔓'}</button>
    </div>

    <!-- Drop Panels -->
    <div class="flex items-center gap-1">
      <input type="checkbox" bind:checked={uiState.showDropPanels} class="accent-[#D62430]" />
      <span class="flex-1 text-[#ffffff] truncate">Drops</span>
      <button
        onclick={toggleDpLock}
        class="lock-btn text-[9px] p-0.5 rounded transition-all duration-200 cursor-pointer"
        class:text-[#f59e0b]={allDpLocked}
        class:text-[#666666]={!allDpLocked}
        class:lock-animate={lockAnim === 'dp'}
        title={allDpLocked ? 'Unlock all drop panels' : 'Lock all drop panels'}
      >{allDpLocked ? '🔒' : '🔓'}</button>
    </div>
  </div>

  {#if model.hiddenElementIds.length > 0}
    <div class="border-t border-[#333333]"></div>
    <div class="text-[9px] font-bold text-[#ffffff] uppercase tracking-wider px-1.5 flex items-center justify-between">
      <span>Hidden ({model.hiddenElementIds.length})</span>
      <button
        class="text-[9px] text-[#ffffff] hover:text-[#D62430]"
        onclick={() => { model.unhideAll(); uiState.setStatusMessage('All elements shown'); }}
      >Show</button>
    </div>
    <div class="max-h-[100px] overflow-y-auto">
      {#each model.hiddenElementIds as hid}
        <div class="flex items-center gap-1 px-1.5 py-0 text-[9px] text-[#ffffff]">
          <span class="truncate flex-1">{hid}</span>
          <button
            class="text-[#ffffff] hover:text-[#D62430]"
            onclick={() => { model.unhideElement(hid); uiState.setStatusMessage('Element shown'); }}
            title="Show element"
          >👁</button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="border-t border-[#333333]"></div>

  <MaterialProperty />
</div>

<style>
  @keyframes lockPop {
    0% { transform: scale(1); }
    50% { transform: scale(1.35); }
    100% { transform: scale(1); }
  }
  .lock-btn.lock-animate {
    animation: lockPop 0.35s ease-in-out;
  }
</style>