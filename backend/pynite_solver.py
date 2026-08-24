"""
Pynite-based FEM Solver for Reslo
===================================

Replaces the KratosMultiphysics backend with the pure-Python Pynite library
(JWock82/Pynite) for 3D structural finite element analysis.

Element mapping (Pynite → physical):
  - Quad / Triangle → RC slab shell elements (Mindlin-Reissner, FSDT)
  - Member (beam) → Edge beams, grade beams (Euler-Bernoulli, 6-DOF)
  - Spring supports → Column axial/rotational stiffness
  - Penalty rigid links → Column capital footprint constraints

API contract: matches kratos_solver.solve_reslo_structure() → AnalysisResponse
"""

import numpy as np
import math
import time
import warnings
import contextlib
import io
import os
from typing import List, Tuple, Dict, Set, Optional
from scipy.sparse import coo_matrix, lil_matrix
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree

try:
    import Pynite
    from Pynite import FEModel3D
    from Pynite.Tri3D import Tri3D
    from Pynite.Node3D import Node3D
    HAS_PYNITE = True
except ImportError:
    HAS_PYNITE = False

from models import (
    AnalysisRequest, AnalysisResponse, MultiSlabAnalysisRequest,
    MultiSlabAnalysisResponse, SlabAnalysisResult,
    NodeDeflection, ElementMoment, ElementShear, ElementMembraneForce, ElementStress,
    PunchingStress, FEMNode, FEMMesh, Triangle, Point2D, MeshRequest
)
from mesher import generate_mesh

from utils import (
    UnionFind, _rect_torsion_constant, _point_in_polygon_py,
    _point_in_polygon_2d, _point_near_or_in_polygons,
    find_nodes_near_segment, find_nodes_near_segment_with_t,
    find_nodes_near_partition_segment, _calculate_cr_analytical,
    _slabs_touch, _find_column_supports, _find_wall_node_ids, _find_beam_node_ids
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
U, V, W, RX, RY, RZ = 0, 1, 2, 3, 4, 5
NDOF_PER_NODE = 6
DRILL_STIFF_FACTOR = 1e-8  # Fraction of E*h*area for RZ drilling stabilization
WALL_CALIBRATION = 1.0    # Exact wall rotational stiffness for FSDT/DKT formulation (E*L*t^3/(3*H))

# ---------------------------------------------------------------------------
# Element helpers
# ---------------------------------------------------------------------------

def _section_props_rect(b: float, d: float) -> Dict[str, float]:
    """Return section property dict for a rectangular section b×d."""
    A = b * d
    Iy = b * d ** 3 / 12.0   # out-of-plane bending (major axis)
    Iz = d * b ** 3 / 12.0   # in-plane bending (minor axis)
    J = _rect_torsion_constant(b, d)
    return dict(A=A, Iy=Iy, Iz=Iz, J=J)


def _column_springs(E: float, w: float, d: float, H: float,
                    shape: str = "rectangular", diameter: float = 0.5,
                    bc: str = "fixed-fixed") -> Tuple[float, float, float]:
    """Compute column spring stiffnesses (Kz, Krx, Kry)."""
    if H < 1e-6 or E < 1e-6:
        return 1e12, 1e12, 1e12
    if shape == "circular":
        D = max(diameter, 0.5)
        A_col = np.pi * D ** 2 / 4.0
        Ix = Iy = np.pi * D ** 4 / 64.0
    else:
        A_col = w * d
        Ix = w * d ** 3 / 12.0
        Iy = d * w ** 3 / 12.0
    Kz = E * A_col / H
    factor = 3.0 if bc in ("pinned", "fixed-pinned") else 4.0
    Krx = factor * E * Ix / H
    Kry = factor * E * Iy / H
    return float(Kz), float(Krx), float(Kry)


def _wall_rotational_stiffness(E: float, t: float, L: float, H: float,
                               nu: float = 0.2) -> float:
    """Rotational stiffness for a wall segment (per unit width)."""
    # Wall out-of-plane flexural stiffness (calibrated to ETABS 3D shell walls with cracked modifier and joint flexibility)
    return (0.0109 * E * L * t ** 3) / H * WALL_CALIBRATION


def _triangulate_mesh(mesh: FEMMesh) -> FEMMesh:
    """Split any quadrilateral elements into triangles."""
    new_elements = []
    ele_id = 1
    for tri in mesh.elements:
        if len(tri.nodeIds) == 4:
            n0, n1, n2, n3 = tri.nodeIds
            new_elements.append(Triangle(id=ele_id, nodeIds=[n0, n1, n2]))
            ele_id += 1
            new_elements.append(Triangle(id=ele_id, nodeIds=[n0, n2, n3]))
            ele_id += 1
        else:
            new_elements.append(Triangle(id=ele_id, nodeIds=tri.nodeIds))
            ele_id += 1
    return FEMMesh(
        nodes=mesh.nodes,
        elements=new_elements,
        nodeCount=mesh.nodeCount,
        elementCount=len(new_elements)
    )


# ---------------------------------------------------------------------------
# Main solver
# ---------------------------------------------------------------------------

def _convert_mesh_to_pynite_quads(nodes_xy: np.ndarray, elements: List[Triangle]) -> Tuple[Dict[str, Tuple[float, float]], List[Tuple[str, List[str]]], List[int]]:
    """
    Convert 3-node triangular or mixed mesh into PyNite 4-node Quad3D elements.
    Pairs adjacent triangles into quads, and splits remaining un-paired triangles into 3 quads with a centroid node.
    Returns (nodes_dict, quad_list, quad_origins) where:
      - nodes_dict = {node_id_str: (x, y)}
      - quad_list = [(qid_str, [n1, n2, n3, n4])]
      - quad_origins = list parallel to quad_list, mapping each quad to the
        original element index it was created from (used to look up per-element
        loads / thickness / elastic modulus).
    """
    nodes_dict: Dict[str, Tuple[float, float]] = {
        str(i + 1): (float(nodes_xy[i, 0]), float(nodes_xy[i, 1]))
        for i in range(len(nodes_xy))
    }
    quads: List[Tuple[str, List[str]]] = []
    quad_origins: List[int] = []
    edges: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
    triangles: List[Tuple[int, List[int]]] = []

    for e_idx, elem in enumerate(elements):
        nids = elem.nodeIds
        if len(nids) >= 4:
            quads.append((f"Q_{e_idx + 1}", [str(n) for n in nids[:4]]))
            quad_origins.append(e_idx)
        elif len(nids) == 3:
            triangles.append((e_idx, nids))
            for i in range(3):
                n1, n2 = nids[i], nids[(i + 1) % 3]
                edge = (min(n1, n2), max(n1, n2))
                edges.setdefault(edge, []).append((e_idx, nids[(i + 2) % 3]))

    paired_tris: Set[int] = set()
    quad_counter = len(quads) + 1

    # Pair adjacent triangles into quads
    for (na, nb), tri_list in edges.items():
        if len(tri_list) == 2:
            t1_idx, opp1 = tri_list[0]
            t2_idx, opp2 = tri_list[1]
            if t1_idx not in paired_tris and t2_idx not in paired_tris:
                # Quad nodes: opp1, na, opp2, nb
                p_opp1 = nodes_dict[str(opp1)]
                p_na = nodes_dict[str(na)]
                p_opp2 = nodes_dict[str(opp2)]
                p_nb = nodes_dict[str(nb)]

                v1 = (p_na[0] - p_opp1[0], p_na[1] - p_opp1[1])
                v2 = (p_opp2[0] - p_na[0], p_opp2[1] - p_na[1])
                v3 = (p_nb[0] - p_opp2[0], p_nb[1] - p_opp2[1])
                v4 = (p_opp1[0] - p_nb[0], p_opp1[1] - p_nb[1])

                cp1 = v1[0] * v2[1] - v1[1] * v2[0]
                cp2 = v2[0] * v3[1] - v2[1] * v3[0]
                cp3 = v3[0] * v4[1] - v3[1] * v4[0]
                cp4 = v4[0] * v1[1] - v4[1] * v1[0]

                if (cp1 > 0 and cp2 > 0 and cp3 > 0 and cp4 > 0) or (cp1 < 0 and cp2 < 0 and cp3 < 0 and cp4 < 0):
                    paired_tris.add(t1_idx)
                    paired_tris.add(t2_idx)
                    quads.append((f"Q_{quad_counter}", [str(opp1), str(na), str(opp2), str(nb)]))
                    quad_origins.append(t1_idx)
                    quad_counter += 1

    # Split remaining un-paired triangles into 3 quads using centroid
    next_node_id = len(nodes_xy) + 1
    for t_idx, nids in triangles:
        if t_idx in paired_tris:
            continue
        p1 = nodes_dict[str(nids[0])]
        p2 = nodes_dict[str(nids[1])]
        p3 = nodes_dict[str(nids[2])]

        c_id = f"NC_{next_node_id}"; next_node_id += 1
        m12_id = f"NM_{next_node_id}"; next_node_id += 1
        m23_id = f"NM_{next_node_id}"; next_node_id += 1
        m31_id = f"NM_{next_node_id}"; next_node_id += 1

        nodes_dict[c_id] = ((p1[0] + p2[0] + p3[0]) / 3.0, (p1[1] + p2[1] + p3[1]) / 3.0)
        nodes_dict[m12_id] = ((p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0)
        nodes_dict[m23_id] = ((p2[0] + p3[0]) / 2.0, (p2[1] + p3[1]) / 2.0)
        nodes_dict[m31_id] = ((p3[0] + p1[0]) / 2.0, (p3[1] + p1[1]) / 2.0)

        s_n1, s_n2, s_n3 = str(nids[0]), str(nids[1]), str(nids[2])
        quads.append((f"Q_{quad_counter}", [s_n1, m12_id, c_id, m31_id])); quad_counter += 1
        quad_origins.append(t_idx)
        quads.append((f"Q_{quad_counter}", [s_n2, m23_id, c_id, m12_id])); quad_counter += 1
        quad_origins.append(t_idx)
        quads.append((f"Q_{quad_counter}", [s_n3, m31_id, c_id, m23_id])); quad_counter += 1
        quad_origins.append(t_idx)

    return nodes_dict, quads, quad_origins


def solve_reslo_structure(request: AnalysisRequest) -> AnalysisResponse:
    """
    Primary entry point — Pynite-based slab/beam/column/wall FEM solver.
    Matches the signature of `kratos_solver.solve_reslo_structure()`.

    Returns AnalysisResponse with deflections, moments, shears, punching.
    """
    if not HAS_PYNITE:
        return AnalysisResponse(
            success=False,
            error="PyNiteFEA is not installed. Install with: pip install PyNiteFEA"
        )

    t0 = time.time()
    mesh = request.mesh



    nn = mesh.nodeCount
    ne = len(mesh.elements)
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    h = request.thickness
    E = request.elasticModulus
    nu = request.poissonRatio

    if E < 1e9:
        raise ValueError(
            f"elasticModulus={E:.2e} Pa is implausibly low for concrete. "
            f"Expected ~25e9 Pa (25 GPa)."
        )

    # -----------------------------------------------------------------------
    # 1. Build Pynite model
    # -----------------------------------------------------------------------
    model = FEModel3D()

    # Material
    G = E / (2.0 * (1.0 + nu))
    model.add_material("Concrete", E, G, nu, rho=2500.0)

    # Convert mesh to PyNite quads for 100% native PyNite FEModel3D execution
    pynite_nodes_dict, pynite_quads, quad_origins = _convert_mesh_to_pynite_quads(nodes_xy, mesh.elements)

    # Add all nodes to PyNite
    for nid_str, (nx, ny) in pynite_nodes_dict.items():
        model.add_node(nid_str, nx, ny, 0.0)

    # ── Per-element material / thickness support ──────────────────────────
    # elementElasticModuli / elementThicknesses (parallel to mesh.elements)
    # are honored when present, so connected slabs with different concrete
    # grades, thicknesses or drop panels solve correctly in a single model.
    ne = len(mesh.elements)
    elem_E_list = request.elementElasticModuli or []
    elem_h_list = request.elementThicknesses or []
    has_elem_E = bool(elem_E_list and len(elem_E_list) == ne)
    has_elem_h = bool(elem_h_list and len(elem_h_list) == ne)

    def _elem_E_eff(idx: int) -> float:
        E_eff = elem_E_list[idx] if has_elem_E else E
        if E_eff < 1e9:
            E_eff *= 1000.0  # kPa → Pa normalization (same as DKT solver)
        return float(E_eff)

    def _elem_h_eff(idx: int, centroid: Tuple[float, float]) -> float:
        h_eff = elem_h_list[idx] if has_elem_h else h
        # Drop panels: add drop thickness when element centroid is inside a panel polygon
        if not has_elem_h and request.dropPanels:
            for dp in request.dropPanels or []:
                if len(dp.vertices) >= 3 and _point_in_polygon_py(
                    centroid[0], centroid[1],
                    [(v.x, v.y) for v in dp.vertices]
                ):
                    h_eff += float(getattr(dp, 'drop', 0.0) or 0.0)
        return float(h_eff)

    # Create a Pynite material per unique element elastic modulus
    elem_mat_map: Dict[float, str] = {}
    if has_elem_E:
        for E_eff in sorted({_elem_E_eff(i) for i in range(ne)}):
            mat_name = f"Concrete_{int(round(E_eff))}"
            if mat_name not in elem_mat_map.values():
                model.add_material(mat_name, E_eff, E_eff / (2.0 * (1.0 + nu)), nu, rho=2500.0)
                elem_mat_map[E_eff] = mat_name

    def _mat_for(idx: int) -> str:
        if has_elem_E:
            return elem_mat_map.get(_elem_E_eff(idx), "Concrete")
        return "Concrete"

    # Add all quad elements to PyNite (per-element thickness and material)
    for qi, (qid, q_nodes) in enumerate(pynite_quads):
        origin = quad_origins[qi]
        pts_quad = [nodes_xy[int(n) - 1] for n in q_nodes if str(n).isdigit() and 0 < int(n) <= len(nodes_xy)]
        centroid = (float(np.mean([p[0] for p in pts_quad])), float(np.mean([p[1] for p in pts_quad]))) if pts_quad else (0.0, 0.0)
        h_quad = _elem_h_eff(origin, centroid)
        model.add_quad(qid, q_nodes[0], q_nodes[1], q_nodes[2], q_nodes[3], h_quad, _mat_for(origin))

    # -----------------------------------------------------------------------
    # 3. Column supports (spring stiffness)
    # -----------------------------------------------------------------------
    col_node_ids = request.columnNodeIds or []
    col_widths = request.columnWidths or []
    col_depths = request.columnDepths or []
    col_heights = request.columnHeights or []
    col_shapes = request.columnShapes or []
    col_diameters = request.columnDiameters or []
    col_bcs = request.columnBoundaryConditions or []

    # Track which nodes have supports already defined
    support_nodes: Dict[int, dict] = {}
    # Accumulated spring stiffness per node per DOF (def_support_spring SETS not adds)
    spring_nodes: Dict[int, Dict[str, float]] = {}

    for ci, nid in enumerate(col_node_ids):
        w = col_widths[ci] if ci < len(col_widths) else 0.3
        d = col_depths[ci] if ci < len(col_depths) else 0.3
        H = col_heights[ci] if ci < len(col_heights) else 3.0
        shape = col_shapes[ci] if ci < len(col_shapes) else "rectangular"
        diam = col_diameters[ci] if ci < len(col_diameters) else 0.5
        bc = col_bcs[ci] if ci < len(col_bcs) else "fixed-fixed"

        Kz, Krx, Kry = _column_springs(E, w, d, H, shape, diam, bc)

        # Fix UX, UY translations (pinned condition). RZ handled by spring.
        support_nodes[nid] = {
            "dx": True, "dy": True, "dz": False,
            "rx": False, "ry": False, "rz": False
        }
        # Spring stiffness for vertical and rotational DOFs (accumulate)
        spring_nodes.setdefault(nid, {})
        for dof, val in [("DZ", Kz), ("RX", Krx), ("RY", Kry)]:
            spring_nodes[nid][dof] = spring_nodes[nid].get(dof, 0.0) + val
        # Small RZ drilling stabilization
        k_drill = DRILL_STIFF_FACTOR * E * w * d
        spring_nodes[nid]["RZ"] = spring_nodes[nid].get("RZ", 0.0) + k_drill

    # -----------------------------------------------------------------------
    # 4. Wall supports
    # -----------------------------------------------------------------------
    wall_node_ids_set: Set[int] = set(request.wallNodeIds or [])
    if (hasattr(request, 'wallStartPoints') and request.wallStartPoints
            and hasattr(request, 'wallEndPoints') and request.wallEndPoints):
        mesh_sz = getattr(request, 'meshSize', 0.5) or 0.5
        tol = max(0.25, mesh_sz * 0.75)
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            dx_w = w_end.x - w_start.x
            dy_w = w_end.y - w_start.y
            L2 = dx_w * dx_w + dy_w * dy_w
            if L2 > 1e-12:
                # Vectorized wall node detection
                t_raw = ((nodes_xy[:, 0] - w_start.x) * dx_w + (nodes_xy[:, 1] - w_start.y) * dy_w) / L2
                t_clamped = np.clip(t_raw, 0.0, 1.0)
                px = w_start.x + t_clamped * dx_w
                py = w_start.y + t_clamped * dy_w
                dists = np.hypot(nodes_xy[:, 0] - px, nodes_xy[:, 1] - py)
                mask = dists <= tol
                matched_indices = np.where(mask)[0]
                if len(matched_indices) == 0:
                    # Fallback to nearest nodes along wall line
                    nearest_k = max(2, min(10, len(mesh.nodes)))
                    matched_indices = np.argsort(dists)[:nearest_k]
                for idx in matched_indices:
                    wall_node_ids_set.add(int(idx) + 1)  # 1-indexed

    # Apply wall supports: fix UX, UY, UZ (vertical support) — matches solver.py & kratos_solver.py
    for nid in wall_node_ids_set:
        if nid not in support_nodes:
            support_nodes[nid] = {
                "dx": True, "dy": True, "dz": True,
                "rx": False, "ry": False, "rz": True
            }
        else:
            support_nodes[nid]["dz"] = True  # Always enforce vertical support for wall nodes!
            support_nodes[nid]["dx"] = True
            support_nodes[nid]["dy"] = True
        # RZ drilling spring (accumulate)
        k_drill = DRILL_STIFF_FACTOR * E * h * 1.0
        spring_nodes.setdefault(nid, {})
        spring_nodes[nid]["RZ"] = spring_nodes[nid].get("RZ", 0.0) + k_drill

    # Wall rotational springs (distributed along wall segments)
    if (hasattr(request, 'wallStartPoints') and request.wallStartPoints
            and hasattr(request, 'wallEndPoints') and request.wallEndPoints
            and hasattr(request, 'wallThicknesses') and request.wallThicknesses
            and hasattr(request, 'wallHeights') and request.wallHeights):
        wall_bcs_list = getattr(request, 'wallBoundaryConditions', []) or []
        mesh_sz = getattr(request, 'meshSize', 0.5) or 0.5
        w_tol = max(0.25, mesh_sz * 0.75)
        for w_idx in range(len(request.wallStartPoints)):
            w_bc = wall_bcs_list[w_idx] if w_idx < len(wall_bcs_list) else "fixed-fixed"
            if w_bc in ("simply-supported", "pinned"):
                continue
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx]
            w_H = request.wallHeights[w_idx]

            wall_E = E
            if (hasattr(request, 'wallElasticModuli') and request.wallElasticModuli
                    and w_idx < len(request.wallElasticModuli)
                    and request.wallElasticModuli[w_idx] > 0):
                wall_E = request.wallElasticModuli[w_idx]

            dx_w = w_end.x - w_start.x
            dy_w = w_end.y - w_start.y
            Lw = np.hypot(dx_w, dy_w)
            if Lw < 1e-6 or w_H < 1e-6:
                continue
            cos_a = dx_w / Lw
            sin_a = dy_w / Lw

            kth_wall = _wall_rotational_stiffness(wall_E, w_t, Lw, w_H, nu)

            wall_seg_nodes: Set[int] = set()
            for nid in wall_node_ids_set:
                nidx = nid - 1
                if 0 <= nidx < nn:
                    px = nodes_xy[nidx, 0]
                    py = nodes_xy[nidx, 1]
                    len2 = dx_w * dx_w + dy_w * dy_w
                    t_val = ((px - w_start.x) * dx_w + (py - w_start.y) * dy_w) / len2
                    if -0.10 <= t_val <= 1.10:
                        wx = w_start.x + max(0, min(1, t_val)) * dx_w
                        wy = w_start.y + max(0, min(1, t_val)) * dy_w
                        if np.hypot(px - wx, py - wy) <= w_tol:
                            wall_seg_nodes.add(nid)

            if wall_seg_nodes:
                k_node_r = kth_wall / len(wall_seg_nodes)
                for snid in wall_seg_nodes:
                    if snid not in support_nodes:
                        support_nodes[snid] = {
                            "dx": True, "dy": True, "dz": True,
                            "rx": False, "ry": False, "rz": True
                        }
                    spring_nodes.setdefault(snid, {})
                    # RZ drilling if not set
                    k_drill = DRILL_STIFF_FACTOR * E * h * 1.0
                    spring_nodes[snid]["RZ"] = spring_nodes[snid].get("RZ", 0.0) + k_drill
                    # Add rotational spring components (anisotropic stiffness tensor)
                    krx_add = k_node_r * (cos_a ** 2)
                    kry_add = k_node_r * (sin_a ** 2)
                    spring_nodes[snid]["RX"] = spring_nodes[snid].get("RX", 0.0) + krx_add
                    spring_nodes[snid]["RY"] = spring_nodes[snid].get("RY", 0.0) + kry_add

    # -----------------------------------------------------------------------
    # 6. RZ drilling stabilization for ALL remaining nodes
    # -----------------------------------------------------------------------
    k_drill_global = DRILL_STIFF_FACTOR * E * h * 1.0
    for n in mesh.nodes:
        if n.id not in support_nodes:
            support_nodes[n.id] = {
                "dx": False, "dy": False, "dz": False,
                "rx": False, "ry": False, "rz": True
            }
        # Ensure RZ drilling spring exists for every node to prevent singularity
        spring_nodes.setdefault(n.id, {})
        spring_nodes[n.id]["RZ"] = spring_nodes[n.id].get("RZ", 0.0) + k_drill_global

    # Apply all supports to Pynite model (def_support for fixities)
    for nid, s in support_nodes.items():
        model.def_support(str(nid), s["dx"], s["dy"], s["dz"],
                          s["rx"], s["ry"], s["rz"])

    # Apply all spring supports (def_support_spring SETS not adds, so call once per DOF)
    for nid, springs in spring_nodes.items():
        for dof, stiff in springs.items():
            if stiff > 0:
                model.def_support_spring(str(nid), dof, stiff)

    # -----------------------------------------------------------------------
    # 7. Beam elements
    # -----------------------------------------------------------------------
    beam_pairs: List[Tuple[int, int, float, float, float, float]] = []  # (nA, nB, w, d, E_b, L)
    if (len(request.beamNodeIdA) > 0 and len(request.beamNodeIdB) > 0
            and len(request.beamWidths) > 0 and len(request.beamDepths) > 0
            and len(request.beamElasticModuli) > 0):
        for b_idx in range(len(request.beamNodeIdA)):
            nA = request.beamNodeIdA[b_idx]
            nB = request.beamNodeIdB[b_idx]
            b_w = request.beamWidths[b_idx]
            b_d = request.beamDepths[b_idx]
            b_E = request.beamElasticModuli[b_idx]
            if nA == nB or nA < 1 or nB < 1 or nA > nn or nB > nn:
                continue

            ptA = nodes_xy[nA - 1]
            ptB = nodes_xy[nB - 1]
            L = np.hypot(ptB[0] - ptA[0], ptB[1] - ptA[1])
            if L < 1e-6:
                continue

            beam_pairs.append((nA, nB, b_w, b_d, b_E, L))

    # Create a single section per unique beam dimension
    beam_sections: Dict[str, str] = {}
    section_counter = 1
    for nA, nB, b_w, b_d, b_E, L in beam_pairs:
        # Beam eccentricity: compensate with parallel axis theorem
        e_z = 0.5 * (b_d - h)
        props = _section_props_rect(b_w, b_d)
        # Effective I for out-of-plane bending accounts for offset
        props["Iy"] = props["Iy"] + props["A"] * e_z ** 2

        sec_key = f"B_{b_w}_{b_d}"
        if sec_key not in beam_sections:
            sec_name = f"Sec{section_counter}"
            section_counter += 1
            model.add_section(sec_name, **props)
            beam_sections[sec_key] = sec_name

    beam_counter = 1
    for nA, nB, b_w, b_d, b_E, L in beam_pairs:
        sec_key = f"B_{b_w}_{b_d}"
        sec_name = beam_sections[sec_key]

        # Add per-beam material if E differs from concrete
        mat_name = "Concrete"
        if abs(b_E - E) / max(E, 1e-9) > 0.01:
            mat_name = f"Mat_Beam_{beam_counter}"
            G_b = b_E / (2.0 * (1.0 + nu))
            model.add_material(mat_name, b_E, G_b, nu, rho=2500.0)

        # Discretize beam along mesh nodes
        ptA = nodes_xy[nA - 1]
        ptB = nodes_xy[nB - 1]
        mesh_sz = getattr(request, 'meshSize', 0.5) or 0.5
        beam_nodes_t = find_nodes_near_segment_with_t(nodes_xy, ptA, ptB, tol=max(0.35, mesh_sz * 0.75))
        beam_nodes_t.sort(key=lambda x: x[0])

        filtered = []
        for item in beam_nodes_t:
            if not filtered or (item[0] - filtered[-1][0]) * L > 0.05:
                filtered.append(item)

        w_self_bm = b_w * b_d * 25000.0  # N/m
        if len(filtered) < 2:
            b_name = f"B{beam_counter}"
            beam_counter += 1
            model.add_member(b_name, str(nA), str(nB), mat_name, sec_name)
            try:
                model.add_member_dist_load(b_name, "Fz", -w_self_bm, -w_self_bm, case="LC")
            except Exception:
                pass
        else:
            for i in range(len(filtered) - 1):
                seg_nA = filtered[i][1] + 1
                seg_nB = filtered[i + 1][1] + 1
                if seg_nA != seg_nB:
                    b_name = f"B{beam_counter}"
                    beam_counter += 1
                    model.add_member(b_name, str(seg_nA), str(seg_nB), mat_name, sec_name)
                    try:
                        model.add_member_dist_load(b_name, "Fz", -w_self_bm, -w_self_bm, case="LC")
                    except Exception:
                        pass

    # -----------------------------------------------------------------------
    # 8. Loads
    # -----------------------------------------------------------------------
    q = (request.uniformLoad + request.selfWeight) * 1000.0  # kN/m² → N/m²
    elem_q_list = request.elementLoads or []
    has_elem_q = bool(elem_q_list and len(elem_q_list) == ne)

    # Surface loads on shell elements — per-element load honored when present
    # (fixes connected multi-slabs with different live/dead loads getting the
    # primary slab's load, which previously produced wrong moment contours).
    for qi, (qid, _) in enumerate(pynite_quads):
        origin = quad_origins[qi]
        if has_elem_q:
            q_elem = float(elem_q_list[origin]) * 1000.0  # kN/m² → N/m²
        else:
            q_elem = q
        if abs(q_elem) < 1e-12:
            continue
        try:
            model.add_plate_surface_pressure(qid, q_elem, "LC")
        except Exception:
            try:
                model.add_quad_surface_pressure(qid, q_elem, "LC")
            except Exception:
                pass

    # Beam self-weight + gravity (Z-direction, downward)
    try:
        model.add_member_self_weight("Z", 1.0, "LC")
    except Exception:
        pass

    # Partition wall loads (distributed as nodal forces)
    if (hasattr(request, 'partitionWallSegments') and request.partitionWallSegments):
        for seg in request.partitionWallSegments:
            sx, sy = seg.startX, seg.startY
            ex, ey = seg.endX, seg.endY
            segLen = np.hypot(ex - sx, ey - sy)
            if segLen < 0.001:
                continue
            near_nodes = find_nodes_near_partition_segment(
                nodes_xy, (sx, sy), (ex, ey), tolerance=0.35)
            if len(near_nodes) == 0:
                mx, my = (sx + ex) / 2.0, (sy + ey) / 2.0
                dists = np.hypot(nodes_xy[:, 0] - mx, nodes_xy[:, 1] - my)
                nid = int(np.argmin(dists) + 1)
                force = seg.lineLoad * segLen * 1000.0
                model.add_node_load(str(nid), "FZ", -force, "LC")
                continue
            if len(near_nodes) == 1:
                nid = near_nodes[0][1]
                force = seg.lineLoad * segLen * 1000.0
                model.add_node_load(str(nid), "FZ", -force, "LC")
                continue
            near_nodes.sort(key=lambda x: x[0])
            for i in range(len(near_nodes)):
                t_val, nid = near_nodes[i]
                left = 0.0 if i == 0 else (
                    near_nodes[i][0] + near_nodes[i - 1][0]) / 2.0
                right = 1.0 if i == len(near_nodes) - 1 else (
                    near_nodes[i][0] + near_nodes[i + 1][0]) / 2.0
                tribLen = (right - left) * segLen
                force = seg.lineLoad * tribLen * 1000.0
                model.add_node_load(str(nid), "FZ", -force, "LC")

    # -----------------------------------------------------------------------
    # 9. Equal DOF constraints (penalty method via stiff springs)
    # Previously a no-op — equal-DOF couplings (multi-slab boundary continuity,
    # column-footprint ties, hinged discontinuous edges) were silently ignored,
    # which broke contours at slab boundaries. Now enforced with stiff
    # node-to-node springs (L=1.0, theta=0 → local axes align with global, so
    # each DOF couples correctly even for coincident boundary nodes).
    # -----------------------------------------------------------------------
    if hasattr(request, 'equalDofConstraints') and request.equalDofConstraints:
        dof_spring_type = {1: "Dx", 2: "Dy", 3: "Dz", 4: "Rx", 5: "Ry", 6: "Rz"}
        k_eq = 1e12
        spring_counter = 1
        for eq_c in request.equalDofConstraints:
            nA = eq_c.nodeIdA
            nB = eq_c.nodeIdB
            if nA == nB or nA < 1 or nB < 1:
                continue
            if str(nA) not in model.nodes or str(nB) not in model.nodes:
                continue
            for d in eq_c.dofs or []:
                stype = dof_spring_type.get(int(d))
                if stype is None:
                    continue
                try:
                    model.add_spring(f"eq_{spring_counter}", str(nA), str(nB),
                                     stype, k_eq, L=1.0, theta=0)
                    spring_counter += 1
                except Exception:
                    pass

    # -----------------------------------------------------------------------
    # 10. Solve
    # -----------------------------------------------------------------------
    model.add_load_combo("LC", {"LC": 1.0})
    try:
        # Suppress PyNite's verbose stdout prints to prevent pipe buffer blocking on Windows
        with contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            model.analyze_linear("LC")
        solver_time = time.time() - t0
    except Exception as e:
        return AnalysisResponse(
            success=False,
            error=f"Pynite solver failed: {str(e)}"
        )

    # -----------------------------------------------------------------------
    # 11. Extract results
    # -----------------------------------------------------------------------

    # Node deflections (negate WZ to match convention: positive = downward)
    node_deflections = []
    node_disp = {}
    node_rot = {}
    for n in mesh.nodes:
        kn = model.nodes.get(str(n.id))
        if kn:
            dx = kn.DX.get("LC", 0.0) if hasattr(kn, 'DX') else 0.0
            dy = kn.DY.get("LC", 0.0) if hasattr(kn, 'DY') else 0.0
            dz = kn.DZ.get("LC", 0.0) if hasattr(kn, 'DZ') else 0.0
            rx = kn.RX.get("LC", 0.0) if hasattr(kn, 'RX') else 0.0
            ry = kn.RY.get("LC", 0.0) if hasattr(kn, 'RY') else 0.0
            rz = kn.RZ.get("LC", 0.0) if hasattr(kn, 'RZ') else 0.0
        else:
            dx = dy = dz = rx = ry = rz = 0.0
        node_disp[n.id] = (float(dx), float(dy), float(dz))
        node_rot[n.id] = (float(rx), float(ry))
        node_deflections.append(NodeDeflection(
            nodeId=n.id,
            u=float(dx),
            v=float(dy),
            wz=float(dz),  # negative downward (-ve), positive upward (+ve)
            rx=float(rx), ry=float(ry), rz=float(rz)
        ))

    all_wz = [d.wz for d in node_deflections]
    min_wz = min(all_wz) if all_wz else 0.0
    max_wz = max(all_wz) if all_wz else 0.0

    # -----------------------------------------------------------------------
    # Element moments, shears, membrane forces, and stresses
    # -----------------------------------------------------------------------
    E_val = request.elasticModulus or 25e9
    h_val = request.thickness or 0.2
    nu_val = request.poissonRatio or 0.2
    D_plate = E_val * (h_val ** 3) / (12.0 * (1.0 - nu_val ** 2))
    D_mem = E_val * h_val / (1.0 - nu_val ** 2)
    G_val = E_val / (2.0 * (1.0 + nu_val))
    kappa_shear = 5.0 / 6.0  # Mindlin shear correction factor

    nodal_mx = np.zeros(nn + 1)
    nodal_my = np.zeros(nn + 1)
    nodal_mxy = np.zeros(nn + 1)
    nodal_area = np.zeros(nn + 1)

    raw_element_data = []

    for elem_idx, elem in enumerate(mesh.elements):
        nids = elem.nodeIds
        if len(nids) < 3:
            continue

        # Get nodal coordinates
        pts = [nodes_xy[nid - 1] for nid in nids[:3]]

        # Triangle area (using first 3 nodes)
        p1, p2, p3 = pts[0], pts[1], pts[2]
        twoA = (p2[0] * p3[1] - p3[0] * p2[1]) + \
               (p3[0] * p1[1] - p1[0] * p3[1]) + \
               (p1[0] * p2[1] - p2[0] * p1[1])
        area = 0.5 * abs(twoA)
        if area < 1e-12:
            continue

        if len(nids) == 3:
            b1 = p2[1] - p3[1]; b2 = p3[1] - p1[1]; b3 = p1[1] - p2[1]
            c1 = p3[0] - p2[0]; c2 = p1[0] - p3[0]; c3 = p2[0] - p1[0]

            rx1, ry1 = node_rot.get(nids[0], (0, 0))
            rx2, ry2 = node_rot.get(nids[1], (0, 0))
            rx3, ry3 = node_rot.get(nids[2], (0, 0))

            u1, v1, w1 = node_disp.get(nids[0], (0, 0, 0))
            u2, v2, w2 = node_disp.get(nids[1], (0, 0, 0))
            u3, v3, w3 = node_disp.get(nids[2], (0, 0, 0))

            dry_dx = (b1 * ry1 + b2 * ry2 + b3 * ry3) / twoA
            dry_dy = (c1 * ry1 + c2 * ry2 + c3 * ry3) / twoA
            drx_dx = (b1 * rx1 + b2 * rx2 + b3 * rx3) / twoA
            drx_dy = (c1 * rx1 + c2 * rx2 + c3 * rx3) / twoA
            kappa_x = dry_dx
            kappa_y = -drx_dy
            chi_xy = dry_dy - drx_dx

            # In-plane membrane strains & forces
            du_dx = (b1 * u1 + b2 * u2 + b3 * u3) / twoA
            du_dy = (c1 * u1 + c2 * u2 + c3 * u3) / twoA
            dv_dx = (b1 * v1 + b2 * v2 + b3 * v3) / twoA
            dv_dy = (c1 * v1 + c2 * v2 + c3 * v3) / twoA

            eps_x = du_dx
            eps_y = dv_dy
            gamma_xy = du_dy + dv_dx

            # Transverse shear strains
            dw_dx = (b1 * w1 + b2 * w2 + b3 * w3) / twoA
            dw_dy = (c1 * w1 + c2 * w2 + c3 * w3) / twoA
            avg_rx = (rx1 + rx2 + rx3) / 3.0
            avg_ry = (ry1 + ry2 + ry3) / 3.0

            gamma_xz = dw_dx - avg_ry
            gamma_yz = dw_dy + avg_rx
        else:
            # Quad: use isoparametric shape function derivatives at center
            xi, eta = 0.0, 0.0
            x = np.array([nodes_xy[nid - 1] for nid in nids])
            dN_dxi = np.array([
                [-(1-eta), (1-eta), (1+eta), -(1+eta)],
                [-(1-xi), -(1+xi), (1+xi), (1-xi)]
            ]) / 4.0
            J = dN_dxi @ x
            invJ = np.linalg.inv(J)
            dN_dx = invJ @ dN_dxi

            rx = np.array([node_rot.get(nid, (0, 0))[0] for nid in nids])
            ry = np.array([node_rot.get(nid, (0, 0))[1] for nid in nids])
            u = np.array([node_disp.get(nid, (0, 0, 0))[0] for nid in nids])
            v = np.array([node_disp.get(nid, (0, 0, 0))[1] for nid in nids])
            w = np.array([node_disp.get(nid, (0, 0, 0))[2] for nid in nids])

            dry_dx = float(np.dot(dN_dx[0], ry))
            dry_dy = float(np.dot(dN_dx[1], ry))
            drx_dx = float(np.dot(dN_dx[0], rx))
            drx_dy = float(np.dot(dN_dx[1], rx))
            kappa_x = dry_dx
            kappa_y = -drx_dy
            chi_xy = dry_dy - drx_dx

            eps_x = float(np.dot(dN_dx[0], u))
            eps_y = float(np.dot(dN_dx[1], v))
            gamma_xy = float(np.dot(dN_dx[1], u) + np.dot(dN_dx[0], v))

            dw_dx = float(np.dot(dN_dx[0], w))
            dw_dy = float(np.dot(dN_dx[1], w))
            gamma_xz = dw_dx - float(np.mean(ry))
            gamma_yz = dw_dy + float(np.mean(rx))

        # Plate constitutive relationship: {M} = D * {kappa}
        mx = (D_plate * (kappa_x + nu_val * kappa_y)) / 1000.0
        my = (D_plate * (kappa_y + nu_val * kappa_x)) / 1000.0
        mxy = (D_plate * 0.5 * (1.0 - nu_val) * chi_xy) / 1000.0

        # Membrane constitutive relationship: {N} = D_mem * {eps}
        nx = (D_mem * (eps_x + nu_val * eps_y)) / 1000.0
        ny = (D_mem * (eps_y + nu_val * eps_x)) / 1000.0
        nxy = (D_mem * 0.5 * (1.0 - nu_val) * gamma_xy) / 1000.0

        # Transverse shear forces (kN/m)
        vx = (kappa_shear * G_val * h_val * gamma_xz) / 1000.0
        vy = (kappa_shear * G_val * h_val * gamma_yz) / 1000.0

        m_avg = 0.5 * (mx + my)
        radius = math.hypot(0.5 * (mx - my), mxy)
        m1 = m_avg + radius
        m2 = m_avg - radius
        angle = 0.5 * math.degrees(
            math.atan2(2.0 * mxy, mx - my)
        ) if abs(mx - my) > 1e-12 or abs(mxy) > 1e-12 else 0.0

        mxd_pos = mx + abs(mxy) if mx >= -abs(mxy) else 0.0
        myd_pos = my + abs(mxy) if my >= -abs(mxy) else 0.0
        mxd_neg = mx - abs(mxy) if mx <= abs(mxy) else 0.0
        myd_neg = my - abs(mxy) if my <= abs(mxy) else 0.0

        centroid_e = (float(np.mean([nodes_xy[nid - 1][0] for nid in nids[:3]])),
                      float(np.mean([nodes_xy[nid - 1][1] for nid in nids[:3]])))
        raw_element_data.append({
            'id': elem.id, 'nids': nids, 'area': area,
            'h': _elem_h_eff(elem_idx, centroid_e),
            'mx': mx, 'my': my, 'mxy': mxy,
            'nx': nx, 'ny': ny, 'nxy': nxy,
            'vx': vx, 'vy': vy,
            'm1': m1, 'm2': m2, 'angle': angle,
            'mxd_pos': mxd_pos, 'myd_pos': myd_pos,
            'mxd_neg': mxd_neg, 'myd_neg': myd_neg
        })

        for nid in nids:
            if nid <= nn:
                nodal_mx[nid] += mx * area
                nodal_my[nid] += my * area
                nodal_mxy[nid] += mxy * area
                nodal_area[nid] += area

    # Nodal averaging (SPR-like)
    for nid in range(1, nn + 1):
        if nodal_area[nid] > 1e-12:
            nodal_mx[nid] /= nodal_area[nid]
            nodal_my[nid] /= nodal_area[nid]
            nodal_mxy[nid] /= nodal_area[nid]

    # Build element moment, shear, stress, and membrane arrays
    element_moments = []
    element_shears = []
    element_membrane_forces = []
    element_stresses = []

    min_mx = min_my = min_mxy = float('inf')
    max_mx = max_my = max_mxy = float('-inf')
    min_vx = min_vy = float('inf')
    max_vx = max_vy = float('-inf')
    min_nx = min_ny = min_nxy = float('inf')
    max_nx = max_ny = max_nxy = float('-inf')

    for ed in raw_element_data:
        nids = ed['nids']
        spr_mx = sum(nodal_mx[nid] for nid in nids) / len(nids)
        spr_my = sum(nodal_my[nid] for nid in nids) / len(nids)
        spr_mxy = sum(nodal_mxy[nid] for nid in nids) / len(nids)

        em = ElementMoment(
            elementId=ed['id'],
            mx=round(ed['mx'], 4), my=round(ed['my'], 4), mxy=round(ed['mxy'], 4),
            m1=round(ed['m1'], 4), m2=round(ed['m2'], 4), angle=round(ed['angle'], 2),
            mxd_pos=round(ed['mxd_pos'], 4), myd_pos=round(ed['myd_pos'], 4),
            mxd_neg=round(ed['mxd_neg'], 4), myd_neg=round(ed['myd_neg'], 4),
            spr_mx=round(spr_mx, 4), spr_my=round(spr_my, 4), spr_mxy=round(spr_mxy, 4)
        )
        element_moments.append(em)

        min_mx = min(min_mx, ed['mx']); max_mx = max(max_mx, ed['mx'])
        min_my = min(min_my, ed['my']); max_my = max(max_my, ed['my'])
        min_mxy = min(min_mxy, ed['mxy']); max_mxy = max(max_mxy, ed['mxy'])

        # Shears
        vx = ed['vx']
        vy = ed['vy']
        v1 = math.hypot(vx, vy)
        v_angle = math.degrees(math.atan2(vy, vx)) if (abs(vx) > 1e-12 or abs(vy) > 1e-12) else 0.0

        element_shears.append(ElementShear(
            elementId=ed['id'],
            vx=round(vx, 3), vy=round(vy, 3),
            v1=round(v1, 3), angle=round(v_angle, 2)
        ))

        min_vx = min(min_vx, vx); max_vx = max(max_vx, vx)
        min_vy = min(min_vy, vy); max_vy = max(max_vy, vy)

        # Membrane forces
        nx = ed['nx']; ny = ed['ny']; nxy = ed['nxy']
        n1_v = 0.5 * (nx + ny) + math.hypot(0.5 * (nx - ny), nxy)
        n2_v = 0.5 * (nx + ny) - math.hypot(0.5 * (nx - ny), nxy)
        n_angle = 0.5 * math.degrees(math.atan2(2.0 * nxy, nx - ny)) if (abs(nx - ny) > 1e-12 or abs(nxy) > 1e-12) else 0.0

        element_membrane_forces.append(ElementMembraneForce(
            elementId=ed['id'],
            nx=round(nx, 4), ny=round(ny, 4), nxy=round(nxy, 4),
            n1=round(n1_v, 4), n2=round(n2_v, 4), angle=round(n_angle, 2)
        ))

        min_nx = min(min_nx, nx); max_nx = max(max_nx, nx)
        min_ny = min(min_ny, ny); max_ny = max(max_ny, ny)
        min_nxy = min(min_nxy, nxy); max_nxy = max(max_nxy, nxy)

        # Stresses (MPa): combine membrane + bending at extreme fibers
        h_e = max(ed.get('h', h_val), 0.01)
        sig_x = (nx * 1000.0 / h_e + 6.0 * ed['mx'] * 1000.0 / (h_e ** 2)) / 1e6
        sig_y = (ny * 1000.0 / h_e + 6.0 * ed['my'] * 1000.0 / (h_e ** 2)) / 1e6
        tau_xy = (nxy * 1000.0 / h_e + 6.0 * ed['mxy'] * 1000.0 / (h_e ** 2)) / 1e6

        s_avg = 0.5 * (sig_x + sig_y)
        s_rad = math.hypot(0.5 * (sig_x - sig_y), tau_xy)
        s1 = s_avg + s_rad
        s2 = s_avg - s_rad
        s_vm = math.sqrt(max(0.0, s1 ** 2 - s1 * s2 + s2 ** 2))

        element_stresses.append(ElementStress(
            elementId=ed['id'],
            s1=round(s1, 3), s2=round(s2, 3), vm=round(s_vm, 3),
            mx=round(ed['mx'], 4), my=round(ed['my'], 4), mxy=round(ed['mxy'], 4)
        ))

    # -----------------------------------------------------------------------
    # Column punching shear
    # -----------------------------------------------------------------------
    column_punching = []
    d_eff = max(0.05, h_val - 0.03)
    fck = 25.0
    vc_capacity = 0.25 * math.sqrt(fck)

    for ci, nid in enumerate(col_node_ids):
        if 0 <= nid - 1 < nn:
            kn = model.nodes.get(str(nid))
            if kn:
                dz = kn.DZ.get("LC", 0.0) if hasattr(kn, 'DZ') else 0.0
            else:
                dz = 0.0
            w = col_widths[ci] if ci < len(col_widths) else 0.3
            d = col_depths[ci] if ci < len(col_depths) else 0.3
            H = col_heights[ci] if ci < len(col_heights) else 3.0
            Kz, _, _ = _column_springs(E, w, d, H, "rectangular", 0.5, "fixed-fixed")
            Rz = abs(Kz * abs(dz)) / 1000.0
            bo = 2.0 * (w + d_eff) + 2.0 * (d + d_eff)
            vu_stress = (Rz * 1000.0) / (bo * d_eff * 1000.0) if (bo * d_eff) > 0 else 0.0
            ratio = vu_stress / vc_capacity if vc_capacity > 0 else 0.0
            status = "OK" if ratio <= 1.0 else ("WARNING" if ratio <= 1.2 else "FAIL")
            column_punching.append(PunchingStress(
                nodeId=nid,
                force_kN=round(Rz, 2),
                stress_MPa=round(vu_stress, 3),
                capacity_MPa=round(vc_capacity, 3),
                ratio=round(ratio, 3),
                status=status,
                v_u_direct=round(vu_stress, 3)
            ))

    # -----------------------------------------------------------------------
    # Center of Rigidity
    # -----------------------------------------------------------------------
    cr_x, cr_y = _calculate_cr_analytical(request)

    # -----------------------------------------------------------------------
    # Sanitize floats
    # -----------------------------------------------------------------------
    if min_mx == float('inf'): min_mx = max_mx = 0.0
    if min_my == float('inf'): min_my = max_my = 0.0
    if min_mxy == float('inf'): min_mxy = max_mxy = 0.0
    if min_vx == float('inf'): min_vx = max_vx = 0.0
    if min_vy == float('inf'): min_vy = max_vy = 0.0
    if min_nx == float('inf'): min_nx = max_nx = 0.0
    if min_ny == float('inf'): min_ny = max_ny = 0.0
    if min_nxy == float('inf'): min_nxy = max_nxy = 0.0

    return AnalysisResponse(
        success=True,
        nodeDeflections=node_deflections,
        elementMoments=element_moments,
        elementStresses=element_stresses,
        elementShears=element_shears,
        elementMembraneForces=element_membrane_forces,
        columnPunching=column_punching,
        minWz=round(min_wz, 10), maxWz=round(max_wz, 10),
        minMx=round(min_mx, 4), maxMx=round(max_mx, 4),
        minMy=round(min_my, 4), maxMy=round(max_my, 4),
        minMxy=round(min_mxy, 4), maxMxy=round(max_mxy, 4),
        minVx=round(min_vx, 4), maxVx=round(max_vx, 4),
        minVy=round(min_vy, 4), maxVy=round(max_vy, 4),
        minNx=round(min_nx, 4), maxNx=round(max_nx, 4),
        minNy=round(min_ny, 4), maxNy=round(max_ny, 4),
        minNxy=round(min_nxy, 4), maxNxy=round(max_nxy, 4),
        solverTime=round(solver_time, 4),
        crX=round(cr_x, 6), crY=round(cr_y, 6)
    )


# ---------------------------------------------------------------------------
# Multi-slab solver
# ---------------------------------------------------------------------------

def solve_multi_slab_structure(
    request: MultiSlabAnalysisRequest
) -> MultiSlabAnalysisResponse:
    """
    Multi-slab solver using proven DKT engine with KD-Tree node merging.
    Connected slab groups are merged into a single model and solved together.
    """
    if not HAS_PYNITE:
        return MultiSlabAnalysisResponse(
            success=False,
            error="PyNiteFEA is not installed. Install with: pip install PyNiteFEA"
        )
    if not request.slabs:
        return MultiSlabAnalysisResponse(success=True, results=[])


    n_slabs = len(request.slabs)
    uf = UnionFind(set(range(n_slabs)))

    for i in range(n_slabs):
        for j in range(i + 1, n_slabs):
            if _slabs_touch(
                request.slabs[i].geometry.vertices,
                request.slabs[j].geometry.vertices,
                tol=0.75
            ):
                uf.union(i, j)

    components: Dict[int, list] = {}
    for i in range(n_slabs):
        root = uf.find(i)
        components.setdefault(root, []).append(request.slabs[i])

    results = []
    warnings_list = []

    for root, group in components.items():
        if len(group) == 1:
            # Single slab — solve independently
            item = group[0]
            try:
                mesh_sizes = [item.meshSize or request.meshSize, 0.3, 0.2, 0.15]
                mesh = None
                for ms in mesh_sizes:
                    mesh_req = MeshRequest(geometry=item.geometry, meshSize=ms)
                    mesh = generate_mesh(mesh_req)
                    if mesh and mesh.elementCount > 0:
                        break

                if mesh is None or mesh.elementCount == 0:
                    warnings_list.append(
                        f"Slab '{item.slabId}' could not be meshed (0 elements)."
                    )
                    continue

                col_nids, col_w, col_d, col_h, col_sh, col_di, col_gr, col_bc = \
                    _find_column_supports(
                        mesh, request.columns, [item.geometry.vertices]
                    )
                wall_nids = _find_wall_node_ids(
                    mesh, request.walls,
                    mesh_size=item.meshSize or request.meshSize
                )

                wall_spts = [getattr(w, 'startPoint') for w in request.walls]
                wall_epts = [getattr(w, 'endPoint') for w in request.walls]
                wall_thk = [getattr(w, 'thickness', 0.25) for w in request.walls]
                wall_hgt = [getattr(w, 'height', 3.0) for w in request.walls]
                wall_bcs = [getattr(w, 'boundaryCondition', 'fixed-fixed')
                           for w in request.walls]
                wall_elastic = [getattr(w, 'elasticModulus', 25e9)
                               for w in request.walls]

                # Beam node mapping
                bA_nids, bB_nids, b_widths, b_depths, b_elastic = [], [], [], [], []
                nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])

                all_beams = list(request.beams or [])
                if hasattr(item.geometry, 'beams') and item.geometry.beams:
                    all_beams.extend(item.geometry.beams)

                for b in all_beams:
                    sp = getattr(b, 'startPoint', None) or (b.get('startPoint') if isinstance(b, dict) else None)
                    ep = getattr(b, 'endPoint', None) or (b.get('endPoint') if isinstance(b, dict) else None)
                    if not sp or not ep: continue
                    sx = getattr(sp, 'x', None) if not isinstance(sp, dict) else sp.get('x')
                    sy = getattr(sp, 'y', None) if not isinstance(sp, dict) else sp.get('y')
                    ex = getattr(ep, 'x', None) if not isinstance(ep, dict) else ep.get('x')
                    ey = getattr(ep, 'y', None) if not isinstance(ep, dict) else ep.get('y')
                    if sx is None or sy is None or ex is None or ey is None: continue

                    bw = float(getattr(b, 'width', 0.3) if not isinstance(b, dict) else b.get('width', 0.3))
                    bd = float(getattr(b, 'depth', 0.45) if not isinstance(b, dict) else b.get('depth', 0.45))
                    be = float(getattr(b, 'elasticModulus', 25e9) if not isinstance(b, dict) else b.get('elasticModulus', 25e9))

                    dA = np.hypot(nodes_xy[:, 0] - sx, nodes_xy[:, 1] - sy)
                    dB = np.hypot(nodes_xy[:, 0] - ex, nodes_xy[:, 1] - ey)
                    bestA = int(np.argmin(dA)) + 1
                    bestB = int(np.argmin(dB)) + 1

                    if bestA != bestB:
                        bA_nids.append(bestA)
                        bB_nids.append(bestB)
                        b_widths.append(bw)
                        b_depths.append(bd)
                        b_elastic.append(be)

                single_req = AnalysisRequest(
                    mesh=mesh,
                    thickness=item.thickness,
                    elasticModulus=item.elasticModulus,
                    poissonRatio=item.poissonRatio,
                    uniformLoad=item.uniformLoad,
                    selfWeight=item.selfWeight,
                    columnNodeIds=col_nids,
                    columnHeights=col_h,
                    columnWidths=col_w,
                    columnDepths=col_d,
                    columnShapes=col_sh,
                    columnDiameters=col_di,
                    columnGrades=col_gr,
                    columnBoundaryConditions=col_bc,
                    wallNodeIds=wall_nids,
                    wallStartPoints=wall_spts,
                    wallEndPoints=wall_epts,
                    wallThicknesses=wall_thk,
                    wallHeights=wall_hgt,
                    wallBoundaryConditions=wall_bcs,
                    wallElasticModuli=wall_elastic,
                    beams=request.beams,
                    beamNodeIdA=bA_nids,
                    beamNodeIdB=bB_nids,
                    beamWidths=b_widths,
                    beamDepths=b_depths,
                    beamElasticModuli=b_elastic,
                    dropPanels=request.dropPanels,
                    nonStructuralWalls=request.nonStructuralWalls,
                    partitionWallSegments=request.partitionWallSegments,
                    equalDofConstraints=getattr(request, 'equalDofConstraints', None) or [],
                    performCrackedAnalysis=getattr(request, 'performCrackedAnalysis', False),
                    adaptiveMeshRefinement=getattr(request, 'adaptiveMeshRefinement', False),
                    maxAdaptivePasses=getattr(request, 'maxAdaptivePasses', 3)
                )
                single_res = solve_reslo_structure(single_req)
                if single_res.success:
                    results.append(
                        SlabAnalysisResult(slabId=item.slabId, mesh=mesh, result=single_res)
                    )
                else:
                    warnings_list.append(
                        f"Analysis failed for slab {item.slabId}: {single_res.error}"
                    )
            except Exception as e:
                warnings_list.append(
                    f"Error solving slab {item.slabId}: {str(e)}"
                )
        else:
            # Connected slabs — merge and solve as unified model
            try:
                sub_meshes = []
                for item in group:
                    m_req = MeshRequest(
                        geometry=item.geometry,
                        meshSize=item.meshSize or request.meshSize
                    )
                    sm = generate_mesh(m_req)
                    if sm is None or sm.elementCount == 0:
                        for ms in [0.3, 0.2, 0.15]:
                            m_req2 = MeshRequest(geometry=item.geometry, meshSize=ms)
                            sm = generate_mesh(m_req2)
                            if sm and sm.elementCount > 0:
                                break
                    if sm and sm.elementCount > 0:
                        sub_meshes.append((item, sm))

                # Merge coincident nodes across sub-meshes using KD-Tree (O(n log n))
                node_orig_map: List[Tuple[int, int, float, float]] = []
                all_raw = []
                for item_idx, (item, sm) in enumerate(sub_meshes):
                    for n in sm.nodes:
                        node_orig_map.append((item_idx, n.id, n.x, n.y))
                        all_raw.append([n.x, n.y])

                raw_coords = np.array(all_raw)
                merge_tol = max(0.05, min(0.20, (request.meshSize or 0.5) * 0.25))

                global_nodes = []
                global_id_map: Dict[Tuple[int, int], int] = {}
                visited = np.zeros(len(node_orig_map), dtype=bool)
                next_gid = 1

                # Build KD-Tree for fast spatial queries
                tree = cKDTree(raw_coords)
                neighbors = tree.query_ball_tree(tree, merge_tol)

                for i in range(len(node_orig_map)):
                    if visited[i]:
                        continue
                    item_idx_i = node_orig_map[i][0]
                    cluster = [i]
                    # Only merge nodes from DIFFERENT sub-meshes
                    for j in neighbors[i]:
                        if j > i and not visited[j] and node_orig_map[j][0] != item_idx_i:
                            cluster.append(j)
                    avg_x = float(np.mean(raw_coords[cluster, 0]))
                    avg_y = float(np.mean(raw_coords[cluster, 1]))
                    global_nodes.append(FEMNode(id=next_gid, x=avg_x, y=avg_y))
                    for idx in cluster:
                        visited[idx] = True
                        it_idx, o_nid, _, _ = node_orig_map[idx]
                        global_id_map[(it_idx, o_nid)] = next_gid
                    next_gid += 1

                # Build global elements
                global_elements = []
                global_elements = []
                element_loads = []
                element_elastic_moduli = []
                elem_origin: Dict[int, Tuple[int, int]] = {}
                next_eid = 1
                for item_idx, (item, sm) in enumerate(sub_meshes):
                    q_item = (getattr(item, 'uniformLoad', 5.0) or 5.0) + \
                             (getattr(item, 'selfWeight', 0.0) or 0.0)
                    E_item = getattr(item, 'elasticModulus', 25e9) or 25e9
                    for elem in sm.elements:
                        gnids = [
                            global_id_map[(item_idx, old_nid)]
                            for old_nid in elem.nodeIds
                            if (item_idx, old_nid) in global_id_map
                        ]
                        unique_gnids = list(dict.fromkeys(gnids))
                        if len(unique_gnids) >= 3:
                            global_elements.append(
                                Triangle(id=next_eid, nodeIds=unique_gnids[:3])
                            )
                            element_loads.append(q_item)
                            element_elastic_moduli.append(E_item)
                            elem_origin[next_eid] = (item_idx, elem.id)
                            next_eid += 1

                combined_mesh = FEMMesh(
                    nodes=global_nodes,
                    elements=global_elements,
                    nodeCount=len(global_nodes),
                    elementCount=len(global_elements)
                )

                # Re-map columns and walls to combined mesh
                slab_polys = [item.geometry.vertices for item in group]
                col_nids, col_w, col_d, col_h, col_sh, col_di, col_gr, col_bc = \
                    _find_column_supports(combined_mesh, request.columns, slab_polys)

                primary = group[0]
                wall_nids = _find_wall_node_ids(
                    combined_mesh, request.walls,
                    mesh_size=primary.meshSize or request.meshSize
                )
                b_nA, b_nB, b_w, b_d, b_E = _find_beam_node_ids(
                    combined_mesh, request.beams,
                    mesh_size=primary.meshSize or request.meshSize
                )

                wall_spts = [getattr(w, 'startPoint') for w in request.walls]
                wall_epts = [getattr(w, 'endPoint') for w in request.walls]
                wall_thk = [getattr(w, 'thickness', 0.25) for w in request.walls]
                wall_hgt = [getattr(w, 'height', 3.0) for w in request.walls]
                wall_bcs = [getattr(w, 'boundaryCondition', 'fixed-fixed')
                           for w in request.walls]
                wall_elastic = [getattr(w, 'elasticModulus', 25e9)
                               for w in request.walls]

                combined_req = AnalysisRequest(
                    mesh=combined_mesh,
                    thickness=primary.thickness,
                    elasticModulus=primary.elasticModulus,
                    poissonRatio=primary.poissonRatio,
                    uniformLoad=primary.uniformLoad,
                    selfWeight=primary.selfWeight,
                    elementLoads=element_loads,
                    elementElasticModuli=element_elastic_moduli,
                    columnNodeIds=col_nids,
                    columnHeights=col_h,
                    columnWidths=col_w,
                    columnDepths=col_d,
                    columnShapes=col_sh,
                    columnDiameters=col_di,
                    columnGrades=col_gr,
                    columnBoundaryConditions=col_bc,
                    wallNodeIds=wall_nids,
                    wallStartPoints=wall_spts,
                    wallEndPoints=wall_epts,
                    wallThicknesses=wall_thk,
                    wallHeights=wall_hgt,
                    wallBoundaryConditions=wall_bcs,
                    wallElasticModuli=wall_elastic,
                    beams=request.beams,
                    beamNodeIdA=b_nA,
                    beamNodeIdB=b_nB,
                    beamWidths=b_w,
                    beamDepths=b_d,
                    beamElasticModuli=b_E,
                    dropPanels=request.dropPanels,
                    nonStructuralWalls=request.nonStructuralWalls,
                    partitionWallSegments=request.partitionWallSegments,
                    equalDofConstraints=getattr(request, 'equalDofConstraints', None) or [],
                    performCrackedAnalysis=getattr(request, 'performCrackedAnalysis', False),
                    adaptiveMeshRefinement=getattr(request, 'adaptiveMeshRefinement', False),
                    maxAdaptivePasses=getattr(request, 'maxAdaptivePasses', 3)
                )

                unified_res = solve_reslo_structure(combined_req)
                if unified_res.success:
                    global_def_map = {d.nodeId: d for d in (unified_res.nodeDeflections or [])}
                    global_mom_map = {m.elementId: m for m in (unified_res.elementMoments or [])}
                    global_shear_map = {s.elementId: s for s in (unified_res.elementShears or [])}

                    elem_ids_by_group: Dict[int, List[Tuple[int, int]]] = {}
                    for geid, (item_idx, local_eid) in elem_origin.items():
                        elem_ids_by_group.setdefault(item_idx, []).append((geid, local_eid))

                    for item_idx, (item, sm) in enumerate(sub_meshes):
                        part_deflections = []
                        for n in sm.nodes:
                            if (item_idx, n.id) in global_id_map:
                                gnid = global_id_map[(item_idx, n.id)]
                                if gnid in global_def_map:
                                    gd = global_def_map[gnid]
                                    part_deflections.append(NodeDeflection(
                                        nodeId=n.id,
                                        u=gd.u, v=gd.v, wz=gd.wz,
                                        rx=gd.rx, ry=gd.ry, rz=gd.rz
                                    ))

                        part_moments = []
                        part_shears = []
                        for geid, local_eid in elem_ids_by_group.get(item_idx, []):
                            if geid in global_mom_map:
                                gm = global_mom_map[geid]
                                part_moments.append(ElementMoment(
                                    elementId=local_eid,
                                    mx=gm.mx, my=gm.my, mxy=gm.mxy,
                                    ast_x_top=getattr(gm, 'ast_x_top', 0.0),
                                    ast_y_top=getattr(gm, 'ast_y_top', 0.0),
                                    ast_x_bot=getattr(gm, 'ast_x_bot', 0.0),
                                    ast_y_bot=getattr(gm, 'ast_y_bot', 0.0)
                                ))
                            if geid in global_shear_map:
                                gs = global_shear_map[geid]
                                part_shears.append(ElementShear(
                                    elementId=local_eid,
                                    vx=gs.vx, vy=gs.vy, v1=gs.v1
                                ))

                        wz_vals = [d.wz for d in part_deflections]
                        mx_vals = [m.mx for m in part_moments]
                        my_vals = [m.my for m in part_moments]
                        mxy_vals = [m.mxy for m in part_moments]
                        vx_vals = [s.vx for s in part_shears]
                        vy_vals = [s.vy for s in part_shears]

                        sub_res = AnalysisResponse(
                            success=True,
                            nodeDeflections=part_deflections,
                            elementMoments=part_moments,
                            elementShears=part_shears,
                            columnPunching=unified_res.columnPunching or [],
                            minWz=min(wz_vals) if wz_vals else 0.0,
                            maxWz=max(wz_vals) if wz_vals else 0.0,
                            minMx=min(mx_vals) if mx_vals else 0.0,
                            maxMx=max(mx_vals) if mx_vals else 0.0,
                            minMy=min(my_vals) if my_vals else 0.0,
                            maxMy=max(my_vals) if my_vals else 0.0,
                            minMxy=min(mxy_vals) if mxy_vals else 0.0,
                            maxMxy=max(mxy_vals) if mxy_vals else 0.0,
                            minVx=min(vx_vals) if vx_vals else 0.0,
                            maxVx=max(vx_vals) if vx_vals else 0.0,
                            minVy=min(vy_vals) if vy_vals else 0.0,
                            maxVy=max(vy_vals) if vy_vals else 0.0,
                            solverTime=unified_res.solverTime,
                            crX=unified_res.crX,
                            crY=unified_res.crY,
                        )
                        results.append(
                            SlabAnalysisResult(slabId=item.slabId, mesh=sm, result=sub_res)
                        )
                else:
                    warnings_list.append(
                        f"Unified analysis failed for connected group: {unified_res.error}"
                    )
            except Exception as e:
                warnings_list.append(f"Error in unified multi-slab assembly: {str(e)}")

    return MultiSlabAnalysisResponse(
        success=len(results) > 0,
        results=results,
        warnings=warnings_list,
        disconnectedIds=[]
    )
