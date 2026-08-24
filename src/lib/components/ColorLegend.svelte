<script lang="ts">
  import type { ColorRampName, FEMResultType } from '../engine/types';
  import { rampCssGradient, rampNameLabel, sampleRamp } from '../engine/colorRamps';

  import { uiState } from '../stores/uiState.svelte';

  interface Props {
    resultType: FEMResultType;
    min: number;
    max: number;
    ramp?: ColorRampName;
    unit?: string;
    label?: string;
  }

  let {
    resultType,
    min,
    max,
    ramp = 'jet',
    unit = '',
    label,
  }: Props = $props();

  const isLight = $derived(uiState.theme === 'light');
  const title = $derived(label ?? resultTypeLabel(resultType));
  const gradient = $derived(rampCssGradient(ramp));
  const fmt = (v: number): string => (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(2) : v.toFixed(2));
  const mid = $derived((min + max) / 2);

  function resultTypeLabel(rt: FEMResultType): string {
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
      ast_x_top: 'Ast (x, top)',
      ast_x_bot: 'Ast (x, bot)',
      ast_y_top: 'Ast (y, top)',
      ast_y_bot: 'Ast (y, bot)',
      ast_max: 'Ast (max)',
      crack_width: 'Crack Width',
      deflection_check: 'Deflection Check',
    };
    return map[rt] ?? rampNameLabel(ramp);
  }

  function rgbCss(rgb: [number, number, number]): string {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }
  // The gradient bar renders ramp position 0 at the bottom and 1 at the top.
  // For inverted result types (deflection), the contour maps the *most negative*
  // value to ramp 1, so the top label must be min and the bottom label max —
  // and the swatches must follow the same order, otherwise swatch and number
  // disagree with the contour on canvas.
  const invert = $derived(resultType === 'deflection' || resultType === 'deflection_check');
  const topVal = $derived(invert ? min : max);
  const botVal = $derived(invert ? max : min);
  const topColor = $derived(rgbCss(sampleRamp(ramp, 1)));
  const botColor = $derived(rgbCss(sampleRamp(ramp, 0)));
</script>

<div class="rounded-lg p-3 shadow-lg w-[180px] text-xs select-none transition-colors border {isLight ? 'bg-white/95 border-slate-300 text-slate-800' : 'bg-slate-800/95 border-slate-700 text-slate-200'}">
  <div class="flex items-center justify-between mb-2">
    <span class="text-[10px] font-bold uppercase tracking-wider truncate {isLight ? 'text-slate-700' : 'text-slate-300'}">{title}</span>
    {#if unit}
      <span class="text-[9px] ml-1 shrink-0 {isLight ? 'text-slate-500' : 'text-slate-400'}">{unit}</span>
    {/if}
  </div>

  <div class="flex gap-2 items-stretch">
    <!-- Gradient bar -->
    <div
      class="w-4 rounded border shrink-0 {isLight ? 'border-slate-300' : 'border-slate-600'}"
      style="background: {gradient};"
      role="img"
      aria-label="{title} color ramp"
    ></div>

    <!-- Tick labels -->
    <div class="flex flex-col justify-between flex-1 font-mono text-[10px] leading-none">
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm" style="background: {topColor};"></span>
        <span class="{isLight ? 'text-red-600 font-semibold' : 'text-red-300'}">{fmt(topVal)}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm {isLight ? 'bg-slate-300' : 'bg-slate-400'}"></span>
        <span class="{isLight ? 'text-slate-700' : 'text-slate-300'}">{fmt(mid)}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm" style="background: {botColor};"></span>
        <span class="{isLight ? 'text-blue-600 font-semibold' : 'text-blue-300'}">{fmt(botVal)}</span>
      </div>
    </div>
  </div>
</div>
