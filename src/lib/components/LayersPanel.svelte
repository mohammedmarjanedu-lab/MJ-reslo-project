<script lang="ts">
  import { onMount } from 'svelte';
  import { floorLayers } from '../stores/floorLayers.svelte';
  import { model } from '../stores/structuralModel.svelte';
  import { uiState } from '../stores/uiState.svelte';

  onMount(() => {
    if (typeof window !== 'undefined') {
      uiState.initPanels(window.innerWidth, window.innerHeight);
    }
  });

  function handleSetActive(layerId: string) {
    floorLayers.activeLayerId = layerId;
    const active = floorLayers.layers.find(l => l.id === layerId);
    if (active) {
      model.planImage = active.image as ImageBitmap;
      model.imageNaturalWidth = active.width;
      model.imageNaturalHeight = active.height;
      uiState.setStatusMessage(`Active plan switched to: ${active.name}`);
    }
  }

  function handleOpacityChange(layerId: string, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const val = parseFloat(input.value);
    const layer = floorLayers.layers.find(l => l.id === layerId);
    if (layer) {
      layer.opacity = val;
      window.dispatchEvent(new CustomEvent('layer-opacity-changed'));
    }
  }

  function handleTintChange(layerId: string, e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    floorLayers.updateLayer(layerId, { colorTint: select.value as any });
  }

  function toggleVisibility(layerId: string) {
    const layer = floorLayers.layers.find(l => l.id === layerId);
    if (layer) {
      floorLayers.updateLayer(layerId, { visible: !layer.visible });
    }
  }

  function startAlign(layerId: string) {
    floorLayers.startAlignment(layerId);
    uiState.setStatusMessage('Wizard: Click Grid Ref 1 on BASE floor plan');
  }

  function cancelAlign() {
    floorLayers.cancelAlignment();
    uiState.setStatusMessage('Alignment cancelled');
  }

  let allVisible = $derived(floorLayers.layers.length > 0 && floorLayers.layers.every(l => l.visible));

  // Draggable and resizable logic
  let isDragging = $state(false);
  let isResizing = $state(false);
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let startPosX = 0;
  let startPosY = 0;

  function dragStart(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('select') || target.closest('input')) {
      return;
    }
    e.preventDefault();
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPosX = uiState.layersPanel.x;
    startPosY = uiState.layersPanel.y;
    
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);
  }

  function dragMove(e: MouseEvent) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    uiState.layersPanel.x = Math.max(0, Math.min(window.innerWidth - uiState.layersPanel.w, startPosX + dx));
    uiState.layersPanel.y = Math.max(0, Math.min(window.innerHeight - uiState.layersPanel.h, startPosY + dy));
  }

  function dragEnd() {
    isDragging = false;
    window.removeEventListener('mousemove', dragMove);
    window.removeEventListener('mouseup', dragEnd);
  }

  function resizeStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = uiState.layersPanel.w;
    startH = uiState.layersPanel.h;

    window.addEventListener('mousemove', resizeMove);
    window.addEventListener('mouseup', resizeEnd);
  }

  function resizeMove(e: MouseEvent) {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    uiState.layersPanel.w = Math.max(220, Math.min(600, startW + dx));
    uiState.layersPanel.h = Math.max(180, Math.min(800, startH + dy));
  }

  function resizeEnd() {
    isResizing = false;
    window.removeEventListener('mousemove', resizeMove);
    window.removeEventListener('mouseup', resizeEnd);
  }
</script>

<div 
  style="position: absolute; left: {uiState.layersPanel.x}px; top: {uiState.layersPanel.y}px; width: {uiState.layersPanel.w}px; height: {uiState.layersPanel.h}px; z-index: 40;"
  class="flex flex-col rounded-lg bg-slate-800/95 p-3 border border-slate-700 text-xs font-mono shadow-lg select-none pointer-events-auto overflow-hidden"
>
  <div 
    class="flex items-center justify-between border-b border-slate-700/50 pb-1.5 mb-1.5 cursor-move select-none shrink-0"
    onmousedown={dragStart}
  >
    <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex-1">Floor Plan Layers</div>
    <!-- Toggle all layers visibility -->
    <button
      onclick={() => floorLayers.toggleAllVisibility()}
      class="text-slate-500 hover:text-slate-300 transition-colors px-1 mr-1 cursor-pointer"
      title={allVisible ? 'Hide all layers' : 'Show all layers'}
    >
      {#if allVisible}
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
        </svg>
      {:else}
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      {/if}
    </button>
    {#if floorLayers.alignmentState?.active}
      <button 
        onclick={cancelAlign}
        class="bg-red-500/25 hover:bg-red-500/40 text-red-400 border border-red-500/30 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide transition-colors cursor-pointer shrink-0"
      >
        Cancel Align
      </button>
    {/if}
  </div>

  {#if floorLayers.layers.length === 0}
    <div class="text-slate-500 text-[10px] text-center py-4 flex-1 flex items-center justify-center">
      <div>
        No drawings loaded.<br/>Drop a PDF or image to start.
      </div>
    </div>
  {:else}
    <div class="space-y-3 flex-1 overflow-y-auto pr-1">
      {#each floorLayers.layers as layer (layer.id)}
        {@const isActive = floorLayers.activeLayerId === layer.id}
        {@const isAligningThis = floorLayers.alignmentState?.layerId === layer.id}
        
        <div class="p-2 rounded border transition-colors
          {isActive ? 'bg-indigo-950/20 border-indigo-500/50' : 'bg-slate-900/40 border-slate-700/50 hover:border-slate-600/50'}">
          
          <!-- Layer Header -->
          <div class="flex items-center justify-between gap-1.5 mb-1.5">
            <button 
              onclick={() => handleSetActive(layer.id)}
              class="flex items-center gap-1.5 text-left font-semibold text-[10px] truncate max-w-[130px] cursor-pointer"
              title="Click to set as active base plan"
            >
              <span class="w-2.5 h-2.5 rounded-full border border-slate-500 flex items-center justify-center shrink-0
                {isActive ? 'bg-indigo-500 border-indigo-400' : 'bg-transparent'}">
              </span>
              <span class={isActive ? 'text-indigo-300' : 'text-slate-300'}>
                {layer.name}
              </span>
            </button>

            <!-- Eye Icon Toggle -->
            <button
              onclick={() => toggleVisibility(layer.id)}
              class="text-slate-500 hover:text-slate-300 transition-colors px-1 cursor-pointer"
              title={layer.visible ? 'Hide overlay' : 'Show overlay'}
            >
              {#if layer.visible}
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              {:else}
                <svg class="w-3.5 h-3.5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              {/if}
            </button>
          </div>

          {#if !isActive}
            <!-- Controls for Overlays -->
            <div class="space-y-1.5 pt-1.5 border-t border-slate-800 text-[10px] text-slate-400">
              <!-- Opacity Slider -->
              <div class="flex items-center justify-between gap-1">
                <span>Opacity:</span>
                <input 
                  type="range" 
                  min="0.05" 
                  max="0.95" 
                  step="0.05" 
                  value={layer.opacity} 
                  oninput={(e) => handleOpacityChange(layer.id, e)}
                  class="w-24 accent-indigo-500 cursor-pointer h-1 rounded bg-slate-700"
                />
                <span class="w-6 text-right font-mono">{(layer.opacity * 100).toFixed(0)}%</span>
              </div>

              <!-- Color Tint Selection -->
              <div class="flex items-center justify-between gap-1">
                <span>Tint:</span>
                <select
                  value={layer.colorTint}
                  onchange={(e) => handleTintChange(layer.id, e)}
                  class="bg-slate-800 border border-slate-700 rounded px-1 text-[10px] text-slate-300 focus:outline-none"
                >
                  <option value="none">Original Colors</option>
                  <option value="cyan">Cyan Overlay</option>
                  <option value="magenta">Magenta Overlay</option>
                  <option value="yellow">Yellow Overlay</option>
                  <option value="green">Green Overlay</option>
                  <option value="red">Red Overlay</option>
                </select>
              </div>

              <!-- Alignment Wizard Launch Button -->
              <div class="flex justify-end pt-1">
                {#if isAligningThis}
                  <span class="text-[9px] text-pink-400 font-semibold animate-pulse">
                    Click points on canvas...
                  </span>
                {:else}
                  <button
                    onclick={() => startAlign(layer.id)}
                    class="bg-slate-700 hover:bg-slate-600 hover:text-white border border-slate-600 rounded px-2 py-0.5 text-[9px] transition-colors cursor-pointer"
                  >
                    2-Point Align
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            <div class="text-[9px] text-indigo-400/80 italic pt-0.5">
              Active Base Floor Plan
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Alignment Wizard Help Guide -->
  {#if floorLayers.alignmentState?.active}
    <div class="bg-indigo-950/30 border border-indigo-500/30 rounded p-1.5 mt-2 text-[9px] text-slate-300 space-y-1 shrink-0">
      <div class="font-bold text-indigo-400 uppercase tracking-wide">Alignment Wizard</div>
      {#if floorLayers.alignmentState.step === 'base1'}
        <div>1. Click <strong class="text-blue-400">Point 1</strong> (e.g. Grid A-1) on <strong class="text-indigo-300">Base plan</strong>.</div>
      {:else if floorLayers.alignmentState.step === 'base2'}
        <div>2. Click <strong class="text-blue-400">Point 2</strong> (e.g. Grid H-12) on <strong class="text-indigo-300">Base plan</strong>.</div>
      {:else if floorLayers.alignmentState.step === 'overlay1'}
        <div>3. Click matching <strong class="text-pink-400">Point 1</strong> on <strong class="text-indigo-300">Overlay plan</strong>.</div>
      {:else if floorLayers.alignmentState.step === 'overlay2'}
        <div>4. Click matching <strong class="text-pink-400">Point 2</strong> on <strong class="text-indigo-300">Overlay plan</strong>.</div>
      {/if}
    </div>
  {/if}

  <!-- Resize handle -->
  <div 
    class="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-se-resize flex items-end justify-end p-0.5"
    onmousedown={resizeStart}
  >
    <svg class="w-2.5 h-2.5 text-slate-500 hover:text-slate-300" viewBox="0 0 10 10" fill="currentColor">
      <path d="M10 0 L0 10 L10 10 Z" />
    </svg>
  </div>
</div>
