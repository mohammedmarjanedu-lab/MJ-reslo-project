<script lang="ts">
  import type { ColorRampName, FEMResultType } from '../engine/types';
  import { rampCssGradient, rampNameLabel, sampleRamp } from '../engine/colorRamps';

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
    ramp = 'viridis',
    unit = '',
    label,
  }: Props = $props();

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
  const minColor = $derived(rgbCss(sampleRamp(ramp, 0)));
  const maxColor = $derived(rgbCss(sampleRamp(ramp, 1)));
</script>

<div class="rounded-lg bg-slate-800/95 border border-slate-700 p-3 shadow-lg w-[180px] text-xs select-none">
  <div class="flex items-center justify-between mb-2">
    <span class="text-[10px] font-bold text-slate-300 uppercase tracking-wider truncate">{title}</span>
    {#if unit}
      <span class="text-[9px] text-slate-500 ml-1 shrink-0">{unit}</span>
    {/if}
  </div>

  <div class="flex gap-2 items-stretch">
    <!-- Gradient bar -->
    <div
      class="w-4 rounded border border-slate-600 shrink-0"
      style="background: {gradient};"
      role="img"
      aria-label="{title} color ramp"
    ></div>

    <!-- Tick labels -->
    <div class="flex flex-col justify-between flex-1 font-mono text-[10px] leading-none">
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm" style="background: {maxColor};"></span>
        <span class="text-red-300">{fmt(max)}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm bg-slate-400"></span>
        <span class="text-slate-300">{fmt(mid)}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm" style="background: {minColor};"></span>
        <span class="text-blue-300">{fmt(min)}</span>
      </div>
    </div>
  </div>
</div>
