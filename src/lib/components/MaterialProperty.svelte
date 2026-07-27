<script lang="ts">
  import { model } from '../stores/structuralModel.svelte';

  const concreteGrades = [
    { value: 'M20', label: 'M20 (fck=20 MPa)' },
    { value: 'M25', label: 'M25 (fck=25 MPa)' },
    { value: 'M30', label: 'M30 (fck=30 MPa)' },
    { value: 'M35', label: 'M35 (fck=35 MPa)' },
    { value: 'M40', label: 'M40 (fck=40 MPa)' },
    { value: 'M45', label: 'M45 (fck=45 MPa)' },
    { value: 'M50', label: 'M50 (fck=50 MPa)' },
    { value: 'M55', label: 'M55 (fck=55 MPa)' },
    { value: 'M60', label: 'M60 (fck=60 MPa)' },
  ];
</script>

<div class="flex flex-col gap-1.5 px-1.5 py-1">
  <div class="text-[9px] font-bold text-[#ffffff] uppercase tracking-wider">Default Concrete Grade</div>
  <select
    bind:value={model.concreteGrade}
    class="w-full rounded bg-[#333333] px-2 py-1 text-[10px] text-white border border-[#444444] focus:border-[#D62430] focus:outline-none"
  >
    {#each concreteGrades as g}
      <option value={g.value}>{g.label}</option>
    {/each}
  </select>
</div>