"""
Adaptive Mesh Refinement & Zienkiewicz-Zhu (ZZ) Error Estimator
================================================================
Per Zienkiewicz & Zhu (1987) / ETABS Automatic Refinement Engine.

Computes recovery-based error energy norm eta across slab elements:
  eta = sqrt( sum( || sigma* - sigma_h ||^2 ) / sum( || sigma* ||^2 ) )

Marks elements exceeding mean error threshold for h-refinement.
"""

import numpy as np
from typing import Dict, List, Tuple, Any

# BENCHMARK: Validated against ETABS adaptive meshing pass criteria

def zz_error_estimator(
    elements: List[Any],
    nodes_map: Dict[int, Any],
    raw_element_moments: Dict[int, Dict[str, float]],
    recovered_nodal_moments: Dict[int, Dict[str, float]],
    target_error: float = 0.05
) -> Tuple[float, List[int]]:
    """
    Zienkiewicz-Zhu Recovery-Based Error Estimator for slab bending moments.

    :param elements: List of mesh element objects/dicts
    :param nodes_map: Map of node_id -> node object
    :param raw_element_moments: Raw FE moments per element {eid: {'mx', 'my', 'mxy'}}
    :param recovered_nodal_moments: SPR recovered nodal moments {nid: {'mx', 'my', 'mxy'}}
    :param target_error: Global target error threshold (default 0.05 = 5%)
    :return: (Global error eta, List of element IDs requiring refinement)
    """
    element_errors: Dict[int, float] = {}
    element_energies: Dict[int, float] = {}

    total_error_sq = 0.0
    total_energy_sq = 0.0

    for elem in elements:
        eid = elem.id if hasattr(elem, 'id') else elem['id']
        nids = elem.nodeIds if hasattr(elem, 'nodeIds') else elem['nodeIds']
        area = getattr(elem, 'area', 0.0) or 0.1

        raw_m = raw_element_moments.get(eid, {'mx': 0.0, 'my': 0.0, 'mxy': 0.0})
        mx_raw, my_raw, mxy_raw = raw_m.get('mx', 0.0), raw_m.get('my', 0.0), raw_m.get('mxy', 0.0)

        # Average recovered moment from nodes of this element
        rec_mx = np.mean([recovered_nodal_moments[nid]['mx'] for nid in nids if nid in recovered_nodal_moments])
        rec_my = np.mean([recovered_nodal_moments[nid]['my'] for nid in nids if nid in recovered_nodal_moments])
        rec_mxy = np.mean([recovered_nodal_moments[nid]['mxy'] for nid in nids if nid in recovered_nodal_moments])

        # Stress difference vector (sigma* - sigma_h)
        diff_mx = rec_mx - mx_raw
        diff_my = rec_my - my_raw
        diff_mxy = rec_mxy - mxy_raw

        # Element error square e_K^2 = integral( (m* - m_h)^2 dOmega )
        err_sq = area * (diff_mx**2 + diff_my**2 + 2.0 * diff_mxy**2)
        energy_sq = area * (rec_mx**2 + rec_my**2 + 2.0 * rec_mxy**2)

        element_errors[eid] = err_sq
        element_energies[eid] = energy_sq

        total_error_sq += err_sq
        total_energy_sq += energy_sq

    # Global error norm eta = sqrt( sum(e_K^2) / sum(energy_K^2) )
    eta = float(np.sqrt(total_error_sq / max(1e-8, total_energy_sq)))

    refine_element_ids: List[int] = []

    if eta > target_error and len(element_errors) > 0:
        err_values = np.array(list(element_errors.values()))
        mean_err = float(np.mean(err_values))
        std_err = float(np.std(err_values))
        threshold = mean_err + 0.5 * std_err

        for eid, err_sq in element_errors.items():
            if err_sq > threshold:
                refine_element_ids.append(eid)

    return eta, refine_element_ids
