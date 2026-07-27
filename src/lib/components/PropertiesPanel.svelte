<script lang="ts">
  import { model } from '../stores/structuralModel.svelte';
  import { uiState } from '../stores/uiState.svelte';
  import { computeColumnStiffness, computeShearWallStiffness, computePolylineWallStiffness, polygonSignedArea } from '../engine/mathEngine';

  let selectedColumn = $derived(uiState.selectedElementType === 'column' && uiState.selectedElementId ? model.columns.find(c => c.id === uiState.selectedElementId) ?? null : null);
  let selectedWall = $derived(uiState.selectedElementType === 'wall' && uiState.selectedElementId ? model.walls.find(w => w.id === uiState.selectedElementId) ?? null : null);
  let selectedPolylineWall = $derived(uiState.selectedElementType === 'wall' && uiState.selectedElementId ? model.polylineWalls.find(w => w.id === uiState.selectedElementId) ?? null : null);
  let selectedNonStructuralWall = $derived(uiState.selectedElementType === 'nonStructuralWall' && uiState.selectedElementId ? model.nonStructuralWalls.find(w => w.id === uiState.selectedElementId) ?? null : null);
  let selectedNonStructuralPolylineWall = $derived(uiState.selectedElementType === 'nonStructuralWall' && uiState.selectedElementId ? model.polylineNonStructuralWalls.find(w => w.id === uiState.selectedElementId) ?? null : null);
  let selectedBeam = $derived(uiState.selectedElementType === 'beam' && uiState.selectedElementId ? model.beams.find(b => b.id === uiState.selectedElementId) ?? null : null);
  let selectedSlab = $derived(uiState.selectedElementType === 'slab' && uiState.selectedElementId ? model.slabs.find(s => s.id === uiState.selectedElementId) ?? null : null);
  let selectedDropPanel = $derived(uiState.selectedElementType === 'dropPanel' && uiState.selectedElementId ? model.dropPanels.find(d => d.id === uiState.selectedElementId) ?? null : null);
  let colStiffness = $derived(selectedColumn ? computeColumnStiffness(selectedColumn) : null);
  let wallStiffness = $derived(selectedWall ? computeShearWallStiffness(selectedWall) : null);
  let polylineWallStiffness = $derived(selectedPolylineWall ? computePolylineWallStiffness(selectedPolylineWall) : null);
  let slabArea = $derived(selectedSlab ? Math.abs(polygonSignedArea(selectedSlab.vertices)) : 0);

  let selectedColumns = $derived(model.columns.filter(c => uiState.selectedElementIds.includes(c.id)));
  let selectedWalls = $derived(model.walls.filter(w => uiState.selectedElementIds.includes(w.id)));
  let selectedPolylineWalls = $derived(model.polylineWalls.filter(pw => uiState.selectedElementIds.includes(pw.id)));
  let selectedBeams = $derived(model.beams.filter(b => uiState.selectedElementIds.includes(b.id)));
  let selectedSlabs = $derived(model.slabs.filter(s => uiState.selectedElementIds.includes(s.id)));
  let selectedDropPanels = $derived(model.dropPanels.filter(dp => uiState.selectedElementIds.includes(dp.id)));
  let totalSelected = $derived(uiState.selectedElementIds.length);

  let editingVertexIndex: number | null = $state(null);
  let editingVertexX = $state('');
  let editingVertexY = $state('');
  let elementLocked = $derived(uiState.selectedElementId ? model.isLocked(uiState.selectedElementId) : false);

  function parseNum(val: string): number | null {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  function handleDelete(): void {
    if (uiState.selectedElementType === 'opening' && uiState.selectedElementId && uiState.selectedHoleIndex !== null) {
      if (isLocked(uiState.selectedElementId)) { uiState.setStatusMessage('Cannot delete locked element'); return; }
      model.deleteSlabHole(uiState.selectedElementId, uiState.selectedHoleIndex);
      uiState.setSelectedElements([]);
      uiState.selectedHoleIndex = null;
      return;
    }
    const ids = uiState.selectedElementIds.length > 0
      ? uiState.selectedElementIds
      : (uiState.selectedElementId ? [uiState.selectedElementId] : []);
    const unlockedIds = ids.filter(id => !model.isLocked(id));
    if (ids.length > 0 && unlockedIds.length === 0) {
      uiState.setStatusMessage('Selected elements are locked');
      return;
    }
    if (unlockedIds.length > 0) {
      model.deleteElements(unlockedIds);
      uiState.setSelectedElements([]);
    }
  }

  function beginEdit(): void {
    model.beginAction();
  }

  function startVertexEdit(index: number, verts: { x: number; y: number }[], elementId: string): void {
    editingVertexIndex = index;
    editingVertexX = verts[index].x.toFixed(3);
    editingVertexY = verts[index].y.toFixed(3);
    uiState.vertexEditTarget = { elementId, vertexIndex: index };
  }

  function commitVertexEdit(pwallId: string, verts: { x: number; y: number }[]): void {
    if (editingVertexIndex === null) return;
    const newVerts = verts.map((v, i) =>
      i === editingVertexIndex
        ? { x: parseNum(editingVertexX) ?? v.x, y: parseNum(editingVertexY) ?? v.y }
        : { ...v }
    );
    model.updatePolylineWall(pwallId, { vertices: newVerts });
    editingVertexIndex = null;
    uiState.vertexEditTarget = null;
  }

  function clearVertexEdit(): void {
    editingVertexIndex = null;
    uiState.vertexEditTarget = null;
  }

  const PRESET_COLORS = ['#D62430', '#22C55E', '#38BDF8', '#F59E0B', '#a78bfa', '#f472b6', '#f97316', '#10B981', '#6366f1', '#EC4899', '#ffffff', '#94A3B8'];

  function isLocked(id: string | null | undefined): boolean {
    return id ? model.isLocked(id) : false;
  }

  function handleColorChange(el: { id: string }, color: string, updateFn: (id: string, partial: any) => void): void {
    if (isLocked(el.id)) return;
    updateFn(el.id, { color: color === '__clear__' ? undefined : color });
  }

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
    startPosX = uiState.propertiesPanel.x;
    startPosY = uiState.propertiesPanel.y;
    
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);
  }

  function dragMove(e: MouseEvent) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    uiState.propertiesPanel.x = Math.max(0, Math.min(window.innerWidth - uiState.propertiesPanel.w, startPosX + dx));
    uiState.propertiesPanel.y = Math.max(0, Math.min(window.innerHeight - uiState.propertiesPanel.h, startPosY + dy));
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
    startW = uiState.propertiesPanel.w;
    startH = uiState.propertiesPanel.h;

    window.addEventListener('mousemove', resizeMove);
    window.addEventListener('mouseup', resizeEnd);
  }

  function resizeMove(e: MouseEvent) {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    uiState.propertiesPanel.w = Math.max(240, Math.min(600, startW + dx));
    uiState.propertiesPanel.h = Math.max(150, Math.min(800, startH + dy));
  }

  function resizeEnd() {
    isResizing = false;
    window.removeEventListener('mousemove', resizeMove);
    window.removeEventListener('mouseup', resizeEnd);
  }
</script>

{#if uiState.selectedElementIds.length > 0}
  <div 
    style="position: absolute; left: {uiState.propertiesPanel.x}px; top: {uiState.propertiesPanel.y}px; width: {uiState.propertiesPanel.w}px; height: {uiState.propertiesPanel.h}px; z-index: 40;"
    class="flex flex-col rounded-lg bg-slate-800/95 p-3 border border-slate-700 text-xs shadow-lg select-none pointer-events-auto overflow-hidden"
  >
    <div 
      class="flex items-center justify-between border-b border-slate-700/50 pb-1.5 mb-1.5 cursor-move select-none shrink-0"
      onmousedown={dragStart}
    >
      <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex-1">Properties</div>
    </div>

    <div class="flex-1 overflow-y-auto pr-1 space-y-3">
      {#if uiState.selectedElementIds.length > 1}
        <div class="text-slate-300 font-bold text-sm mb-1">{totalSelected} elements selected</div>
        <div class="text-slate-400 font-medium mb-3 text-[11px]">Edit properties of all selected elements below. Unchanged fields retain their values.</div>

        <div class="space-y-3">
          {#if selectedSlabs.length > 0}
            <div class="border border-slate-700/50 rounded-lg p-2.5 bg-slate-900/30 space-y-2">
              <div class="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
                <div class="font-bold text-blue-400 text-[10px] uppercase tracking-wider">Slabs ({selectedSlabs.length})</div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Thickness (m)</label>
                  <input type="number" step="0.01" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const s of selectedSlabs) model.updateSlab(s.id, { thickness: v });
                        uiState.setStatusMessage(`Updated thickness to ${v}m for ${selectedSlabs.length} slabs`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Concrete Grade</label>
                  <select
                    onchange={(e) => {
                      const g = e.currentTarget.value;
                      if (g) {
                        model.beginAction();
                        for (const s of selectedSlabs) model.updateSlab(s.id, { concreteGrade: g });
                        uiState.setStatusMessage(`Updated concrete grade to ${g} for ${selectedSlabs.length} slabs`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Keep original</option>
                    <option value="M20">M20</option>
                    <option value="M25">M25</option>
                    <option value="M30">M30</option>
                    <option value="M35">M35</option>
                    <option value="M40">M40</option>
                    <option value="M45">M45</option>
                    <option value="M50">M50</option>
                    <option value="M55">M55</option>
                    <option value="M60">M60</option>
                  </select>
                </div>
              </div>
              <div>
                <label class="block text-slate-500 mb-0.5 text-[10px]">Uniform Load (kN/m²)</label>
                <input type="number" step="0.5" placeholder="Keep original"
                  onchange={(e) => {
                    const v = parseFloat(e.currentTarget.value);
                    if (!isNaN(v)) {
                      model.beginAction();
                      for (const s of selectedSlabs) model.updateSlab(s.id, { uniformLoad: v });
                      uiState.setStatusMessage(`Updated uniform load to ${v} kN/m² for ${selectedSlabs.length} slabs`);
                    }
                  }}
                  class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-blue-500 focus:outline-none" />
              </div>
            </div>
          {/if}

          {#if selectedColumns.length > 0}
            <div class="border border-slate-700/50 rounded-lg p-2.5 bg-slate-900/30 space-y-2">
              <div class="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
                <div class="font-bold text-amber-400 text-[10px] uppercase tracking-wider">Columns ({selectedColumns.length})</div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Shape</label>
                  <select
                    onchange={(e) => {
                      const shape = e.currentTarget.value as 'rectangular' | 'circular';
                      if (shape) {
                        model.beginAction();
                        for (const c of selectedColumns) model.updateColumn(c.id, { shape });
                        uiState.setStatusMessage(`Updated shape to ${shape} for ${selectedColumns.length} columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="">Keep original</option>
                    <option value="rectangular">Rectangular</option>
                    <option value="circular">Circular</option>
                  </select>
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Concrete Grade</label>
                  <select
                    onchange={(e) => {
                      const g = e.currentTarget.value;
                      if (g) {
                        model.beginAction();
                        for (const c of selectedColumns) model.updateColumn(c.id, { concreteGrade: g });
                        uiState.setStatusMessage(`Updated concrete grade to ${g} for ${selectedColumns.length} columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="">Keep original</option>
                    <option value="M20">M20</option>
                    <option value="M25">M25</option>
                    <option value="M30">M30</option>
                    <option value="M35">M35</option>
                    <option value="M40">M40</option>
                    <option value="M45">M45</option>
                    <option value="M50">M50</option>
                    <option value="M55">M55</option>
                    <option value="M60">M60</option>
                  </select>
                </div>
              </div>
              <div class="grid grid-cols-3 gap-1">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[9px]">Width b (m)</label>
                  <input type="number" step="0.05" placeholder="b"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const c of selectedColumns) {
                          if (c.shape !== 'circular') model.updateColumn(c.id, { width: v });
                        }
                        uiState.setStatusMessage(`Updated width to ${v}m for selected columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-1 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none text-center" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[9px]">Depth h (m)</label>
                  <input type="number" step="0.05" placeholder="h"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const c of selectedColumns) {
                          if (c.shape !== 'circular') model.updateColumn(c.id, { depth: v });
                        }
                        uiState.setStatusMessage(`Updated depth to ${v}m for selected columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-1 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none text-center" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[9px]">Diam. D (m)</label>
                  <input type="number" step="0.05" placeholder="D"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const c of selectedColumns) {
                          if (c.shape === 'circular') model.updateColumn(c.id, { diameter: v, width: v, depth: v });
                        }
                        uiState.setStatusMessage(`Updated diameter to ${v}m for selected circular columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-1 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none text-center" />
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Height (m)</label>
                  <input type="number" step="0.1" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const c of selectedColumns) model.updateColumn(c.id, { height: v });
                        uiState.setStatusMessage(`Updated height to ${v}m for ${selectedColumns.length} columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Boundary Cond.</label>
                  <select
                    onchange={(e) => {
                      const bc = e.currentTarget.value as BoundaryCondition;
                      if (bc) {
                        model.beginAction();
                        for (const c of selectedColumns) model.updateColumn(c.id, { boundaryCondition: bc });
                        uiState.setStatusMessage(`Updated boundary condition to ${bc} for ${selectedColumns.length} columns`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="">Keep original</option>
                    <option value="fixed-fixed">Fixed-Fixed</option>
                    <option value="fixed-pinned">Fixed-Pinned</option>
                    <option value="fixed-free">Fixed-Free</option>
                    <option value="pinned-pinned">Pinned-Pinned</option>
                  </select>
                </div>
              </div>
            </div>
          {/if}

          {#if selectedBeams.length > 0}
            <div class="border border-slate-700/50 rounded-lg p-2.5 bg-slate-900/30 space-y-2">
              <div class="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
                <div class="font-bold text-violet-400 text-[10px] uppercase tracking-wider">Beams ({selectedBeams.length})</div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Width (m)</label>
                  <input type="number" step="0.05" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const b of selectedBeams) model.updateBeam(b.id, { width: v });
                        uiState.setStatusMessage(`Updated width to ${v}m for ${selectedBeams.length} beams`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-violet-500 focus:outline-none" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Depth (m)</label>
                  <input type="number" step="0.05" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const b of selectedBeams) model.updateBeam(b.id, { depth: v });
                        uiState.setStatusMessage(`Updated depth to ${v}m for ${selectedBeams.length} beams`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-violet-500 focus:outline-none" />
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Concrete Grade</label>
                  <select
                    onchange={(e) => {
                      const g = e.currentTarget.value;
                      if (g) {
                        model.beginAction();
                        for (const b of selectedBeams) model.updateBeam(b.id, { concreteGrade: g });
                        uiState.setStatusMessage(`Updated concrete grade to ${g} for ${selectedBeams.length} beams`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-violet-500 focus:outline-none"
                  >
                    <option value="">Keep original</option>
                    <option value="M20">M20</option>
                    <option value="M25">M25</option>
                    <option value="M30">M30</option>
                    <option value="M35">M35</option>
                    <option value="M40">M40</option>
                    <option value="M45">M45</option>
                    <option value="M50">M50</option>
                    <option value="M55">M55</option>
                    <option value="M60">M60</option>
                  </select>
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Height (m)</label>
                  <input type="number" step="0.1" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const b of selectedBeams) model.updateBeam(b.id, { height: v });
                        uiState.setStatusMessage(`Updated height to ${v}m for ${selectedBeams.length} beams`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-violet-500 focus:outline-none" />
                </div>
              </div>
            </div>
          {/if}

          {#if (selectedWalls.length + selectedPolylineWalls.length) > 0}
            <div class="border border-slate-700/50 rounded-lg p-2.5 bg-slate-900/30 space-y-2">
              <div class="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
                <div class="font-bold text-purple-400 text-[10px] uppercase tracking-wider">Walls ({selectedWalls.length + selectedPolylineWalls.length})</div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Thickness (m)</label>
                  <input type="number" step="0.05" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const w of selectedWalls) model.updateWall(w.id, { thickness: v });
                        for (const pw of selectedPolylineWalls) model.updatePolylineWall(pw.id, { thickness: v });
                        uiState.setStatusMessage(`Updated thickness to ${v}m for selected walls`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-purple-500 focus:outline-none" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Height (m)</label>
                  <input type="number" step="0.1" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const w of selectedWalls) model.updateWall(w.id, { height: v });
                        for (const pw of selectedPolylineWalls) model.updatePolylineWall(pw.id, { height: v });
                        uiState.setStatusMessage(`Updated height to ${v}m for selected walls`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-purple-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label class="block text-slate-500 mb-0.5 text-[10px]">Concrete Grade</label>
                <select
                  onchange={(e) => {
                    const g = e.currentTarget.value;
                    if (g) {
                      model.beginAction();
                      for (const w of selectedWalls) model.updateWall(w.id, { concreteGrade: g });
                      for (const pw of selectedPolylineWalls) model.updatePolylineWall(pw.id, { concreteGrade: g });
                      uiState.setStatusMessage(`Updated concrete grade to ${g} for selected walls`);
                    }
                  }}
                  class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-purple-500 focus:outline-none"
                >
                  <option value="">Keep original</option>
                  <option value="M20">M20</option>
                  <option value="M25">M25</option>
                  <option value="M30">M30</option>
                  <option value="M35">M35</option>
                  <option value="M40">M40</option>
                  <option value="M45">M45</option>
                  <option value="M50">M50</option>
                  <option value="M55">M55</option>
                  <option value="M60">M60</option>
                </select>
              </div>
            </div>
          {/if}

          {#if selectedDropPanels.length > 0}
            <div class="border border-slate-700/50 rounded-lg p-2.5 bg-slate-900/30 space-y-2">
              <div class="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
                <div class="font-bold text-pink-400 text-[10px] uppercase tracking-wider">Drop Panels ({selectedDropPanels.length})</div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Drop thickness (m)</label>
                  <input type="number" step="0.05" placeholder="Keep original"
                    onchange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (v > 0) {
                        model.beginAction();
                        for (const dp of selectedDropPanels) model.updateDropPanel(dp.id, { drop: v });
                        uiState.setStatusMessage(`Updated drop depth to ${v}m for ${selectedDropPanels.length} drop panels`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-pink-500 focus:outline-none" />
                </div>
                <div>
                  <label class="block text-slate-500 mb-0.5 text-[10px]">Concrete Grade</label>
                  <select
                    onchange={(e) => {
                      const g = e.currentTarget.value;
                      if (g) {
                        model.beginAction();
                        for (const dp of selectedDropPanels) model.updateDropPanel(dp.id, { concreteGrade: g });
                        uiState.setStatusMessage(`Updated concrete grade to ${g} for ${selectedDropPanels.length} drop panels`);
                      }
                    }}
                    class="w-full rounded bg-slate-700/80 px-2 py-1 text-white border border-slate-600 focus:border-pink-500 focus:outline-none"
                  >
                    <option value="">Keep original</option>
                    <option value="M20">M20</option>
                    <option value="M25">M25</option>
                    <option value="M30">M30</option>
                    <option value="M35">M35</option>
                    <option value="M40">M40</option>
                    <option value="M45">M45</option>
                    <option value="M50">M50</option>
                    <option value="M55">M55</option>
                    <option value="M60">M60</option>
                  </select>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {:else if uiState.selectedElementId && (selectedColumn || selectedWall || selectedPolylineWall || selectedNonStructuralWall || selectedNonStructuralPolylineWall || selectedBeam || selectedSlab || selectedDropPanel)}
    <div class="flex items-center justify-between">
      <div class="font-bold text-slate-300 text-sm">
        {selectedColumn?.label || selectedPolylineWall?.label || selectedNonStructuralPolylineWall?.label || selectedWall?.label || selectedNonStructuralWall?.label || selectedBeam?.label || selectedSlab?.label || selectedDropPanel?.label || 'Element'}
      </div>
      <div class="flex items-center gap-1">
        <button
          onclick={() => { const id = uiState.selectedElementId; if (!id) return; if (model.isLocked(id)) model.unlockElement(id); else model.lockElement(id); }}
          class="lock-toggle text-[10px] p-0.5 rounded transition-all duration-200 cursor-pointer hover:scale-125"
          class:text-amber-400={isLocked(uiState.selectedElementId)}
          class:text-slate-500={!isLocked(uiState.selectedElementId)}
          title={isLocked(uiState.selectedElementId) ? 'Unlock this element' : 'Lock this element'}
        >{isLocked(uiState.selectedElementId) ? '🔒' : '🔓'}</button>
        <span class="rounded-full px-2 py-0.5 text-[10px] font-medium
          {uiState.selectedElementType === 'column' ? 'bg-amber-900/50 text-amber-300' : uiState.selectedElementType === 'beam' ? 'bg-violet-900/50 text-violet-300' : uiState.selectedElementType === 'wall' ? 'bg-purple-900/50 text-purple-300' : uiState.selectedElementType === 'dropPanel' ? 'bg-orange-900/50 text-orange-300' : 'bg-blue-900/50 text-blue-300'}">
          {uiState.selectedElementType === 'column' ? 'COLUMN' : uiState.selectedElementType === 'beam' ? 'BEAM' : uiState.selectedElementType === 'wall' ? (selectedPolylineWall ? 'POLY WALL' : 'WALL') : uiState.selectedElementType === 'nonStructuralWall' ? (selectedNonStructuralPolylineWall ? 'PARTITION POLY' : 'PARTITION') : uiState.selectedElementType === 'dropPanel' ? 'DROP PANEL' : 'SLAB'}
        </span>
      </div>
    </div>
    <!-- Color Presets -->
    <div class="flex flex-wrap gap-1">
      {#each PRESET_COLORS as pc}
        <button
          class="w-4 h-4 rounded-full border border-slate-600 cursor-pointer hover:scale-110 transition-transform"
          style="background-color: {pc};"
          onclick={() => {
            const el = selectedColumn || selectedWall || selectedPolylineWall || selectedNonStructuralWall || selectedNonStructuralPolylineWall || selectedBeam || selectedSlab || selectedDropPanel;
            if (el && !isLocked(el.id)) {
              if (selectedColumn) model.updateColumn(el.id, { color: pc === '#D62430' && uiState.selectedElementType === 'column' ? undefined : pc });
              else if (selectedWall) model.updateWall(el.id, { color: pc === '#D62430' ? undefined : pc });
              else if (selectedPolylineWall) model.updatePolylineWall(el.id, { color: pc === '#D62430' ? undefined : pc });
              else if (selectedNonStructuralWall) model.updateNonStructuralWall(el.id, { color: pc === '#f97316' ? undefined : pc });
              else if (selectedNonStructuralPolylineWall) model.updatePolylineNonStructuralWall(el.id, { color: pc === '#f97316' ? undefined : pc });
              else if (selectedBeam) model.updateBeam(el.id, { color: pc === '#F59E0B' ? undefined : pc });
              else if (selectedSlab) model.updateSlab(el.id, { color: pc === '#38BDF8' ? undefined : pc });
              else if (selectedDropPanel) model.updateDropPanel(el.id, { color: pc === '#f472b6' ? undefined : pc });
            }
          }}
          title="Set color to {pc}"
        ></button>
      {/each}
      {#if uiState.selectedElementId && !isLocked(uiState.selectedElementId)}
        <button
          class="w-4 h-4 rounded-full border border-slate-600 cursor-pointer hover:scale-110 transition-transform flex items-center justify-center text-[8px] text-slate-400 bg-slate-800"
          onclick={() => {
            const el = selectedColumn || selectedWall || selectedPolylineWall || selectedNonStructuralWall || selectedNonStructuralPolylineWall || selectedBeam || selectedSlab || selectedDropPanel;
            if (el) {
              const noop = (id: string, p: any) => {};
              if (selectedColumn) model.updateColumn(el.id, { color: undefined });
              else if (selectedWall) model.updateWall(el.id, { color: undefined });
              else if (selectedPolylineWall) model.updatePolylineWall(el.id, { color: undefined });
              else if (selectedNonStructuralWall) model.updateNonStructuralWall(el.id, { color: undefined });
              else if (selectedNonStructuralPolylineWall) model.updatePolylineNonStructuralWall(el.id, { color: undefined });
              else if (selectedBeam) model.updateBeam(el.id, { color: undefined });
              else if (selectedSlab) model.updateSlab(el.id, { color: undefined });
              else if (selectedDropPanel) model.updateDropPanel(el.id, { color: undefined });
            }
          }}
          title="Reset to default color"
        >↺</button>
      {/if}
    </div>

    {#if elementLocked}
      <div class="bg-amber-900/30 border border-amber-700/50 rounded px-2 py-1 text-[10px] text-amber-300 flex items-center gap-1">
        🔒 This element is locked — edits disabled
      </div>
    {/if}
    <div class="space-y-2" class:pointer-events-none={elementLocked} class:opacity-60={elementLocked}>
      {#if selectedColumn}
        {@const col = selectedColumn}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">X (m)</label>
            <input type="number" step="0.001" value={col.position.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateColumn(col.id, { position: { ...col.position, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Y (m)</label>
            <input type="number" step="0.001" value={col.position.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateColumn(col.id, { position: { ...col.position, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5 font-medium">Shape</label>
            <select
              value={col.shape || 'rectangular'}
              onfocus={beginEdit}
              onchange={(e) => {
                const shape = e.currentTarget.value as 'rectangular' | 'circular';
                model.updateColumn(col.id, { shape });
              }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
            >
              <option value="rectangular">Rectangular</option>
              <option value="circular">Circular</option>
            </select>
          </div>
          {#if col.shape === 'circular'}
            <div>
              <label class="block text-slate-500 mb-0.5 font-medium">Diameter D (m)</label>
              <input type="number" step="0.05" value={col.diameter || col.width || 0.5}
                onfocus={beginEdit}
                onchange={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateColumn(col.id, { diameter: v, width: v, depth: v }); }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
          {:else}
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-slate-500 mb-0.5 font-medium">Width b (m)</label>
                <input type="number" step="0.05" value={col.width}
                  onfocus={beginEdit}
                  onchange={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateColumn(col.id, { width: v }); }}
                  class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
              </div>
              <div>
                <label class="block text-slate-500 mb-0.5 font-medium">Depth h (m)</label>
                <input type="number" step="0.05" value={col.depth}
                  onfocus={beginEdit}
                  onchange={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateColumn(col.id, { depth: v }); }}
                  class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
              </div>
            </div>
          {/if}
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Height H (m)</label>
            <input type="number" step="0.1" value={col.height}
              onfocus={beginEdit}
              onchange={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateColumn(col.id, { height: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Rotation &theta; (&deg;)</label>
            <input type="number" step="1" value={(col.rotation * 180 / Math.PI).toFixed(0)}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateColumn(col.id, { rotation: v * Math.PI / 180 }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div>
          <label class="block text-slate-500 mb-0.5">Boundary Condition</label>
          <select
            value={col.boundaryCondition}
            onfocus={beginEdit}
            onchange={(e) => model.updateColumn(col.id, { boundaryCondition: e.currentTarget.value as 'fixed-fixed' | 'fixed-free' })}
            class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
          >
            <option value="fixed-fixed">Fixed-Fixed (12EI/H³)</option>
            <option value="fixed-free">Fixed-Free (3EI/H³)</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Grade</label>
            <select
              value={col.concreteGrade || model.concreteGrade}
              onfocus={beginEdit}
              onchange={(e) => model.updateColumn(col.id, { concreteGrade: e.currentTarget.value })}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
            >
              <option value="M20">M20</option>
              <option value="M25">M25</option>
              <option value="M30">M30</option>
              <option value="M35">M35</option>
              <option value="M40">M40</option>
              <option value="M45">M45</option>
              <option value="M50">M50</option>
              <option value="M55">M55</option>
              <option value="M60">M60</option>
            </select>
          </div>
        </div>
        {#if colStiffness}
          <div class="border-t border-slate-700 pt-2">
            <div class="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Stiffness</div>
            <div class="text-slate-300">k<sub>x</sub> = {colStiffness.kx.toFixed(1)} kN/m</div>
            <div class="text-slate-300">k<sub>y</sub> = {colStiffness.ky.toFixed(1)} kN/m</div>
            <div class="text-slate-400">W = {colStiffness.weight.toFixed(1)} kN</div>
          </div>
        {/if}
      {/if}

      {#if selectedWall}
        {@const wall = selectedWall}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Start X (m)</label>
            <input type="number" step="0.001" value={wall.startPoint.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateWall(wall.id, { startPoint: { ...wall.startPoint, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Start Y (m)</label>
            <input type="number" step="0.001" value={wall.startPoint.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateWall(wall.id, { startPoint: { ...wall.startPoint, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">End X (m)</label>
            <input type="number" step="0.001" value={wall.endPoint.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateWall(wall.id, { endPoint: { ...wall.endPoint, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">End Y (m)</label>
            <input type="number" step="0.001" value={wall.endPoint.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateWall(wall.id, { endPoint: { ...wall.endPoint, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Thickness t (m)</label>
            <input type="number" step="0.05" value={wall.thickness}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateWall(wall.id, { thickness: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Height H (m)</label>
            <input type="number" step="0.1" value={wall.height}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateWall(wall.id, { height: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div>
          <label class="block text-slate-500 mb-0.5">Boundary Condition</label>
          <select
            value={wall.boundaryCondition || 'fixed-free'}
            onfocus={beginEdit}
            onchange={(e) => model.updateWall(wall.id, { boundaryCondition: e.currentTarget.value as 'fixed-fixed' | 'fixed-free' })}
            class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
          >
            <option value="fixed-free">Fixed-Free (3EI/H³)</option>
            <option value="fixed-fixed">Fixed-Fixed (12EI/H³)</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Grade</label>
            <select
              value={wall.concreteGrade || model.concreteGrade}
              onfocus={beginEdit}
              onchange={(e) => model.updateWall(wall.id, { concreteGrade: e.currentTarget.value })}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
            >
              <option value="M20">M20</option>
              <option value="M25">M25</option>
              <option value="M30">M30</option>
              <option value="M35">M35</option>
              <option value="M40">M40</option>
              <option value="M45">M45</option>
              <option value="M50">M50</option>
              <option value="M55">M55</option>
              <option value="M60">M60</option>
            </select>
          </div>
        </div>
        {#if wallStiffness}
          <div class="border-t border-slate-700 pt-2">
            <div class="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Stiffness</div>
            <div class="text-slate-300">k<sub>x</sub> = {wallStiffness.kx.toFixed(1)} kN/m</div>
            <div class="text-slate-300">k<sub>y</sub> = {wallStiffness.ky.toFixed(1)} kN/m</div>
            <div class="text-slate-400">W = {wallStiffness.weight.toFixed(1)} kN</div>
          </div>
        {/if}
      {/if}

      {#if selectedBeam}
        {@const beam = selectedBeam}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Start X (m)</label>
            <input type="number" step="0.001" value={beam.startPoint.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateBeam(beam.id, { startPoint: { ...beam.startPoint, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Start Y (m)</label>
            <input type="number" step="0.001" value={beam.startPoint.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateBeam(beam.id, { startPoint: { ...beam.startPoint, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">End X (m)</label>
            <input type="number" step="0.001" value={beam.endPoint.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateBeam(beam.id, { endPoint: { ...beam.endPoint, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">End Y (m)</label>
            <input type="number" step="0.001" value={beam.endPoint.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateBeam(beam.id, { endPoint: { ...beam.endPoint, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Width b (m)</label>
            <input type="number" step="0.05" value={beam.width}
              onfocus={beginEdit}
              onchange={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateBeam(beam.id, { width: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Depth h (m)</label>
            <input type="number" step="0.05" value={beam.depth}
              onfocus={beginEdit}
              onchange={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateBeam(beam.id, { depth: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Grade</label>
            <select
              value={beam.concreteGrade || model.concreteGrade}
              onfocus={beginEdit}
              onchange={(e) => model.updateBeam(beam.id, { concreteGrade: e.currentTarget.value })}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
            >
              <option value="M20">M20</option>
              <option value="M25">M25</option>
              <option value="M30">M30</option>
              <option value="M35">M35</option>
              <option value="M40">M40</option>
              <option value="M45">M45</option>
              <option value="M50">M50</option>
              <option value="M55">M55</option>
              <option value="M60">M60</option>
            </select>
          </div>
        </div>
      {/if}

      {#if selectedPolylineWall}
        {@const pwall = selectedPolylineWall}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Vertices</label>
            <div class="text-white font-mono">{pwall.vertices.length}</div>
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Thickness t (m)</label>
            <input type="number" step="0.01" value={pwall.thickness}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updatePolylineWall(pwall.id, { thickness: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Height H (m)</label>
            <input type="number" step="0.1" value={pwall.height}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updatePolylineWall(pwall.id, { height: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div>
          <label class="block text-slate-500 mb-0.5">Boundary Condition</label>
          <select
            value={pwall.boundaryCondition || 'fixed-free'}
            onfocus={beginEdit}
            onchange={(e) => model.updatePolylineWall(pwall.id, { boundaryCondition: e.currentTarget.value as 'fixed-fixed' | 'fixed-free' })}
            class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
          >
            <option value="fixed-free">Fixed-Free (3EI/H³)</option>
            <option value="fixed-fixed">Fixed-Fixed (12EI/H³)</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Grade</label>
            <select
              value={pwall.concreteGrade || model.concreteGrade}
              onfocus={beginEdit}
              onchange={(e) => model.updatePolylineWall(pwall.id, { concreteGrade: e.currentTarget.value })}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
            >
              <option value="M20">M20</option>
              <option value="M25">M25</option>
              <option value="M30">M30</option>
              <option value="M35">M35</option>
              <option value="M40">M40</option>
              <option value="M45">M45</option>
              <option value="M50">M50</option>
              <option value="M55">M55</option>
              <option value="M60">M60</option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-slate-500 mb-0.5">Vertex Coordinates</label>
          <div class="max-h-32 overflow-y-auto space-y-1">
            {#each pwall.vertices as v, i}
              <div class="flex items-center gap-1">
                <span class="text-slate-400 w-4 text-[10px]">{i}</span>
                {#if editingVertexIndex === i}
                  <input type="number" step="0.01" bind:value={editingVertexX}
                    class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                    onkeydown={(e) => { if (e.key === 'Enter') commitVertexEdit(pwall.id, pwall.vertices); if (e.key === 'Escape') clearVertexEdit(); }} />
                  <input type="number" step="0.01" bind:value={editingVertexY}
                    class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                    onkeydown={(e) => { if (e.key === 'Enter') commitVertexEdit(pwall.id, pwall.vertices); if (e.key === 'Escape') clearVertexEdit(); }} />
                  <button class="text-[10px] text-green-400 hover:text-green-300" onclick={() => commitVertexEdit(pwall.id, pwall.vertices)}>✓</button>
                {:else}
                  <span class="text-white font-mono text-[10px] cursor-pointer hover:text-sky-400" onclick={() => startVertexEdit(i, pwall.vertices, pwall.id)}>
                    {v.x.toFixed(2)}, {v.y.toFixed(2)}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
        {#if polylineWallStiffness}
          <div class="border-t border-slate-700 pt-2 space-y-0.5">
            <div class="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Stiffness</div>
            <div class="text-slate-300">k<sub>x</sub> = {polylineWallStiffness.kx.toFixed(1)} kN/m</div>
            <div class="text-slate-300">k<sub>y</sub> = {polylineWallStiffness.ky.toFixed(1)} kN/m</div>
            <div class="text-slate-400">W = {polylineWallStiffness.weight.toFixed(1)} kN</div>
          </div>
        {/if}
      {/if}

      {#if selectedNonStructuralWall}
        {@const nsw = selectedNonStructuralWall}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Start X (m)</label>
            <input type="number" step="0.001" value={nsw.startPoint.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateNonStructuralWall(nsw.id, { startPoint: { ...nsw.startPoint, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Start Y (m)</label>
            <input type="number" step="0.001" value={nsw.startPoint.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateNonStructuralWall(nsw.id, { startPoint: { ...nsw.startPoint, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">End X (m)</label>
            <input type="number" step="0.001" value={nsw.endPoint.x}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateNonStructuralWall(nsw.id, { endPoint: { ...nsw.endPoint, x: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">End Y (m)</label>
            <input type="number" step="0.001" value={nsw.endPoint.y}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateNonStructuralWall(nsw.id, { endPoint: { ...nsw.endPoint, y: v } }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Thickness t (m)</label>
            <input type="number" step="0.01" value={nsw.thickness}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateNonStructuralWall(nsw.id, { thickness: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Height H (m)</label>
            <input type="number" step="0.1" value={nsw.height}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateNonStructuralWall(nsw.id, { height: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Unit Weight (kN/m&sup3;)</label>
            <input type="number" step="0.1" min="0" value={nsw.partitionUnitWeight ?? 25}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v >= 0) model.updateNonStructuralWall(nsw.id, { partitionUnitWeight: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Load (kN/m)</label>
            <div class="text-white font-mono px-1 py-1">{((nsw.partitionUnitWeight ?? 25) * nsw.thickness * nsw.height).toFixed(2)}</div>
          </div>
        </div>
      {/if}

      {#if selectedNonStructuralPolylineWall}
        {@const nspw = selectedNonStructuralPolylineWall}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Vertices</label>
            <div class="text-white font-mono">{nspw.vertices.length}</div>
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Thickness t (m)</label>
            <input type="number" step="0.01" value={nspw.thickness}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updatePolylineNonStructuralWall(nspw.id, { thickness: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Height H (m)</label>
            <input type="number" step="0.1" value={nspw.height}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updatePolylineNonStructuralWall(nspw.id, { height: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Unit Weight (kN/m&sup3;)</label>
            <input type="number" step="0.1" min="0" value={nspw.partitionUnitWeight ?? 25}
              onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v >= 0) model.updatePolylineNonStructuralWall(nspw.id, { partitionUnitWeight: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Total Length (m)</label>
            <div class="text-white font-mono px-1 py-1">{nspw.vertices.reduce((s, _, i, arr) => { if (i === 0) return 0; const a = arr[i - 1], b = arr[i]; return s + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2); }, 0).toFixed(2)}</div>
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Total Load (kN)</label>
            <div class="text-white font-mono px-1 py-1">{((nspw.partitionUnitWeight ?? 25) * nspw.thickness * nspw.height * nspw.vertices.reduce((s, _, i, arr) => { if (i === 0) return 0; const a = arr[i - 1], b = arr[i]; return s + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2); }, 0)).toFixed(2)}</div>
          </div>
        </div>
        <div>
          <label class="block text-slate-500 mb-0.5">Vertex Coordinates</label>
          <div class="max-h-32 overflow-y-auto space-y-1">
            {#each nspw.vertices as v, i}
              <div class="flex items-center gap-1">
                <span class="text-slate-400 w-4 text-[10px]">{i}</span>
                {#if editingVertexIndex === i}
                  <input type="number" step="0.01" bind:value={editingVertexX}
                    class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                    onkeydown={(e) => { if (e.key === 'Enter') commitVertexEdit(nspw.id, nspw.vertices); if (e.key === 'Escape') clearVertexEdit(); }} />
                  <input type="number" step="0.01" bind:value={editingVertexY}
                    class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                    onkeydown={(e) => { if (e.key === 'Enter') commitVertexEdit(nspw.id, nspw.vertices); if (e.key === 'Escape') clearVertexEdit(); }} />
                  <button class="text-[10px] text-green-400 hover:text-green-300" onclick={() => commitVertexEdit(nspw.id, nspw.vertices)}>✓</button>
                {:else}
                  <span class="text-white font-mono text-[10px] cursor-pointer hover:text-sky-400" onclick={() => startVertexEdit(i, nspw.vertices, nspw.id)}>
                    {v.x.toFixed(2)}, {v.y.toFixed(2)}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if selectedSlab}
        {@const slab = selectedSlab}
        <div class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Vertices</label>
              <div class="text-white font-mono">{slab.vertices.length}</div>
            </div>
            <div>
              <label class="block text-slate-500 mb-0.5">Area (m²)</label>
              <div class="text-white font-mono">{slabArea.toFixed(2)}</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Thickness (m)</label>
              <input type="number" step="0.01" value={slab.thickness}
                onfocus={beginEdit}
                oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateSlab(slab.id, { thickness: v }); }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
            <div>
              <label class="block text-slate-500 mb-0.5">Live Load (kN/m²)</label>
              <input type="number" step="0.5" value={slab.uniformLoad}
                onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateSlab(slab.id, { uniformLoad: v }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
          <div>
              <label class="block text-slate-500 mb-0.5">SuperImposed Dead Load (kN/m²)</label>
              <input type="number" step="0.5" min="0" value={slab.partitionLoad ?? 0}
                onfocus={beginEdit}
              oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null) model.updateSlab(slab.id, { partitionLoad: Math.max(0, v) }); }}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-slate-500 mb-0.5">Grade</label>
            <select
              value={slab.concreteGrade || model.concreteGrade}
              onfocus={beginEdit}
              onchange={(e) => model.updateSlab(slab.id, { concreteGrade: e.currentTarget.value })}
              class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
            >
              <option value="M20">M20</option>
              <option value="M25">M25</option>
              <option value="M30">M30</option>
              <option value="M35">M35</option>
              <option value="M40">M40</option>
              <option value="M45">M45</option>
              <option value="M50">M50</option>
              <option value="M55">M55</option>
              <option value="M60">M60</option>
            </select>
          </div>

        </div>
        <div>
          <label class="block text-slate-500 mb-0.5">Vertex Coordinates</label>
            <div class="max-h-32 overflow-y-auto space-y-1">
              {#each slab.vertices as v, i}
                <div class="flex items-center gap-1">
                  <span class="text-slate-400 w-4 text-[10px]">{i}</span>
                  {#if editingVertexIndex === i}
                    <input type="number" step="0.01" bind:value={editingVertexX}
                      class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                      onkeydown={(e) => { if (e.key === 'Enter') { const nv = slab.vertices.map((vv, ii) => ii === i ? { x: parseNum(editingVertexX) ?? vv.x, y: parseNum(editingVertexY) ?? vv.y } : { ...vv }); model.updateSlab(slab.id, { vertices: nv }); clearVertexEdit(); } if (e.key === 'Escape') clearVertexEdit(); }} />
                    <input type="number" step="0.01" bind:value={editingVertexY}
                      class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                      onkeydown={(e) => { if (e.key === 'Enter') { const nv = slab.vertices.map((vv, ii) => ii === i ? { x: parseNum(editingVertexX) ?? vv.x, y: parseNum(editingVertexY) ?? vv.y } : { ...vv }); model.updateSlab(slab.id, { vertices: nv }); clearVertexEdit(); } if (e.key === 'Escape') clearVertexEdit(); }} />
                    <button class="text-[10px] text-green-400 hover:text-green-300" onclick={() => { const nv = slab.vertices.map((vv, ii) => ii === i ? { x: parseNum(editingVertexX) ?? vv.x, y: parseNum(editingVertexY) ?? vv.y } : { ...vv }); model.updateSlab(slab.id, { vertices: nv }); clearVertexEdit(); }}>✓</button>
                  {:else}
                    <span class="text-white font-mono text-[10px] cursor-pointer hover:text-sky-400" onclick={() => { editingVertexIndex = i; editingVertexX = v.x.toFixed(3); editingVertexY = v.y.toFixed(3); uiState.vertexEditTarget = { elementId: slab.id, vertexIndex: i }; }}>
                      {v.x.toFixed(2)}, {v.y.toFixed(2)}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
          <button
            onclick={() => uiState.setTool('slab')}
            class="w-full rounded bg-indigo-700 py-1.5 text-xs text-indigo-200 hover:bg-indigo-600 transition-colors mt-2"
          >Add Opening (trace on slab)</button>
        </div>
      {/if}

      {#if selectedDropPanel}
        {@const dp = selectedDropPanel}
        <div class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Vertices</label>
              <div class="text-white font-mono">{dp.vertices.length}</div>
            </div>
            <div>
              <label class="block text-slate-500 mb-0.5">Drop (m)</label>
              <input type="number" step="0.01" value={dp.drop}
                onfocus={beginEdit}
                oninput={(e) => { const v = parseNum(e.currentTarget.value); if (v !== null && v > 0) model.updateDropPanel(dp.id, { drop: v }); }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Width ref (m)</label>
              <input type="number" step="0.05" value={dp.width}
                onfocus={beginEdit}
                oninput={(e) => {
                  const w = parseNum(e.currentTarget.value);
                  if (w === null || w <= 0) return;
                  const hw = w / 2;
                  const cosT = Math.cos(dp.rotation), sinT = Math.sin(dp.rotation);
                  const newVerts = dp.vertices.map((v, i) => {
                    const local = [{ x: -hw, y: -dp.depth/2 }, { x: hw, y: -dp.depth/2 }, { x: hw, y: dp.depth/2 }, { x: -hw, y: dp.depth/2 }];
                    if (i < 4) return { x: dp.center.x + local[i].x * cosT - local[i].y * sinT, y: dp.center.y + local[i].x * sinT + local[i].y * cosT };
                    return v;
                  });
                  model.updateDropPanel(dp.id, { width: w, vertices: dp.vertices.length === 4 ? newVerts : dp.vertices });
                }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
            <div>
              <label class="block text-slate-500 mb-0.5">Depth ref (m)</label>
              <input type="number" step="0.05" value={dp.depth}
                onfocus={beginEdit}
                oninput={(e) => {
                  const d = parseNum(e.currentTarget.value);
                  if (d === null || d <= 0) return;
                  const hd = d / 2;
                  const cosT = Math.cos(dp.rotation), sinT = Math.sin(dp.rotation);
                  const newVerts = dp.vertices.map((v, i) => {
                    const local = [{ x: -dp.width/2, y: -hd }, { x: dp.width/2, y: -hd }, { x: dp.width/2, y: hd }, { x: -dp.width/2, y: hd }];
                    if (i < 4) return { x: dp.center.x + local[i].x * cosT - local[i].y * sinT, y: dp.center.y + local[i].x * sinT + local[i].y * cosT };
                    return v;
                  });
                  model.updateDropPanel(dp.id, { depth: d, vertices: dp.vertices.length === 4 ? newVerts : dp.vertices });
                }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Grade</label>
              <select
                value={dp.concreteGrade || model.concreteGrade}
                onfocus={beginEdit}
                onchange={(e) => model.updateDropPanel(dp.id, { concreteGrade: e.currentTarget.value })}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600"
              >
                <option value="M20">M20</option>
                <option value="M25">M25</option>
                <option value="M30">M30</option>
                <option value="M35">M35</option>
                <option value="M40">M40</option>
                <option value="M45">M45</option>
                <option value="M50">M50</option>
                <option value="M55">M55</option>
                <option value="M60">M60</option>
              </select>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Rotation &theta; (&deg;)</label>
              <input type="number" step="1" value={(dp.rotation * 180 / Math.PI).toFixed(0)}
                onfocus={beginEdit}
                oninput={(e) => {
                  const rot = (parseNum(e.currentTarget.value) ?? 0) * Math.PI / 180;
                  if (dp.vertices.length === 4) {
                    const hw = dp.width / 2, hd = dp.depth / 2;
                    const cosT = Math.cos(rot), sinT = Math.sin(rot);
                    const local = [{ x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd }];
                    const newVerts = local.map(p => ({
                      x: dp.center.x + p.x * cosT - p.y * sinT,
                      y: dp.center.y + p.x * sinT + p.y * cosT,
                    }));
                    model.updateDropPanel(dp.id, { rotation: rot, vertices: newVerts });
                  } else {
                    model.updateDropPanel(dp.id, { rotation: rot });
                  }
                }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
            <div>
              <label class="block text-slate-500 mb-0.5">Center X (m)</label>
              <input type="number" step="0.001" value={dp.center.x}
                onfocus={beginEdit}
                oninput={(e) => {
                  const nx = parseNum(e.currentTarget.value);
                  if (nx === null) return;
                  const dx = nx - dp.center.x;
                  const newCenter = { x: nx, y: dp.center.y };
                  const newVerts = dp.vertices.map(v => ({ x: v.x + dx, y: v.y }));
                  model.updateDropPanel(dp.id, { center: newCenter, vertices: newVerts });
                }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-slate-500 mb-0.5">Center Y (m)</label>
              <input type="number" step="0.001" value={dp.center.y}
                onfocus={beginEdit}
                oninput={(e) => {
                  const ny = parseNum(e.currentTarget.value);
                  if (ny === null) return;
                  const dy = ny - dp.center.y;
                  const newCenter = { x: dp.center.x, y: ny };
                  const newVerts = dp.vertices.map(v => ({ x: v.x, y: v.y + dy }));
                  model.updateDropPanel(dp.id, { center: newCenter, vertices: newVerts });
                }}
                class="w-full rounded bg-slate-700 px-2 py-1 text-white border border-slate-600" />
            </div>
          </div>
          <div>
            <label class="block text-slate-500 mb-0.5">Vertex Coordinates</label>
            <div class="max-h-32 overflow-y-auto space-y-1">
              {#each dp.vertices as v, i}
                <div class="flex items-center gap-1">
                  <span class="text-slate-400 w-4 text-[10px]">{i}</span>
                  {#if editingVertexIndex === i}
                    <input type="number" step="0.01" bind:value={editingVertexX}
                      class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                      onkeydown={(e) => { if (e.key === 'Enter') { const nv = dp.vertices.map((vv, ii) => ii === i ? { x: parseNum(editingVertexX) ?? vv.x, y: parseNum(editingVertexY) ?? vv.y } : { ...vv }); model.updateDropPanel(dp.id, { vertices: nv }); clearVertexEdit(); } if (e.key === 'Escape') clearVertexEdit(); }} />
                    <input type="number" step="0.01" bind:value={editingVertexY}
                      class="w-16 rounded bg-slate-700 px-1 py-0.5 text-white text-[10px] border border-slate-600"
                      onkeydown={(e) => { if (e.key === 'Enter') { const nv = dp.vertices.map((vv, ii) => ii === i ? { x: parseNum(editingVertexX) ?? vv.x, y: parseNum(editingVertexY) ?? vv.y } : { ...vv }); model.updateDropPanel(dp.id, { vertices: nv }); clearVertexEdit(); } if (e.key === 'Escape') clearVertexEdit(); }} />
                    <button class="text-[10px] text-green-400 hover:text-green-300" onclick={() => { const nv = dp.vertices.map((vv, ii) => ii === i ? { x: parseNum(editingVertexX) ?? vv.x, y: parseNum(editingVertexY) ?? vv.y } : { ...vv }); model.updateDropPanel(dp.id, { vertices: nv }); clearVertexEdit(); }}>✓</button>
                  {:else}
                    <span class="text-white font-mono text-[10px] cursor-pointer hover:text-sky-400" onclick={() => { editingVertexIndex = i; editingVertexX = v.x.toFixed(3); editingVertexY = v.y.toFixed(3); uiState.vertexEditTarget = { elementId: dp.id, vertexIndex: i }; }}>
                      {v.x.toFixed(2)}, {v.y.toFixed(2)}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div> <!-- end .space-y-2 -->
  {/if}
</div>

<div class="flex gap-2 pt-2 border-t border-slate-700 shrink-0 mt-1.5">
  <button
    onclick={handleDelete}
    class="flex-1 rounded bg-red-800 py-1.5 text-xs text-red-200 hover:bg-red-700 transition-colors cursor-pointer"
  >Delete</button>
</div>

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
{/if}