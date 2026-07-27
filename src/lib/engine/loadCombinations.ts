import type { LoadCase, LoadCombination } from './types';

/** Default IS 456:2000 Table 18 load cases. */
export function defaultLoadCases(): LoadCase[] {
  return [
    { id: 'lc_dl', name: 'DL', label: 'Dead Load', selfWeightFactor: 1, liveLoadFactor: 0, partitionLoadFactor: 0, active: true },
    { id: 'lc_ll', name: 'LL', label: 'Live Load', selfWeightFactor: 0, liveLoadFactor: 1, partitionLoadFactor: 0, active: true },
    { id: 'lc_pl', name: 'PL', label: 'Partition Load', selfWeightFactor: 0, liveLoadFactor: 0, partitionLoadFactor: 1, active: true },
  ];
}

/** Default IS 456:2000 Table 18 load combinations. */
export function defaultCombinations(): LoadCombination[] {
  return [
    {
      id: 'comb_ult',
      label: '1.5 (DL + LL)',
      description: 'IS 456 Cl.18.2.1 — Ultimate load combination',
      isServiceLoad: false,
      factors: [
        { loadCaseId: 'lc_dl', factor: 1.5 },
        { loadCaseId: 'lc_ll', factor: 1.5 },
      ],
    },
    {
      id: 'comb_serv',
      label: '1.0 (DL + LL)',
      description: 'Service load for deflection and crack width checks',
      isServiceLoad: true,
      factors: [
        { loadCaseId: 'lc_dl', factor: 1.0 },
        { loadCaseId: 'lc_ll', factor: 1.0 },
      ],
    },
    {
      id: 'comb_pl',
      label: '1.0 (DL + PL)',
      description: 'Service load including partition walls',
      isServiceLoad: true,
      factors: [
        { loadCaseId: 'lc_dl', factor: 1.0 },
        { loadCaseId: 'lc_pl', factor: 1.0 },
      ],
    },
  ];
}

/** Compute combined slab load (kN/m²) from active load cases. */
export function computeCombinedLoad(
  slab: { uniformLoad: number; partitionLoad: number; concreteDensity: number; thickness: number },
  cases: LoadCase[]
): number {
  let selfWeight = slab.concreteDensity * slab.thickness;
  let total = 0;
  for (const c of cases) {
    if (!c.active) continue;
    total += c.selfWeightFactor * selfWeight;
    total += c.liveLoadFactor * slab.uniformLoad;
    total += c.partitionLoadFactor * slab.partitionLoad;
  }
  return total;
}
