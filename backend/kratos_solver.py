"""
RESLO Backend Solver - Kratos Multiphysics Implementation
=========================================================

This module implements the 3D Finite Element Analysis (FEA) solver using KratosMultiphysics
(BSD-4 Licensed) for thin-plate slab bending, beam-column frame action, and structural continuity.

Element & Solver Inventory (ETABS-classical equivalents):
-----------------------------------------------------------
- Thin Plate/Slab: ShellThinElement3D3N (triangles) & ShellThinElement3D4N (quads) — DKT-class
- Columns / Beams: CrLinearBeamElement3D2N — classical Euler-Bernoulli frame elements
- Rigid Links (Capitals): LinearMasterSlaveConstraint — rigid diaphragm / column-head capital behaviour
- Shear Walls: DOF fixity (line supports) & master-slave coupling along wall lines
- Sparse Solver: SkylineLUFactorizationSolver / BlockBuilderAndSolver
- Base Fixities: Node.Fix() on DISPLACEMENT and ROTATION

Engineering Continuity Constraints:
-----------------------------------
- C0 Continuity: Zero displacement gaps across slab-column-wall interfaces.
- C1 Continuity: Rotational/slope continuity across plate elements and rigid connections.
"""

import os
import numpy as np
import time
import math
import warnings
import logging
import sys
import io
from typing import Any, List, Tuple, Dict, Set, Optional
from scipy.spatial import cKDTree

# Configure OpenMP parallel execution for Kratos
os.environ["OMP_NUM_THREADS"] = str(os.cpu_count() or 4)

import KratosMultiphysics as KM
try:
    import KratosMultiphysics.StructuralMechanicsApplication as SMA
    _HAS_SMA = True
except ImportError as _sma_err:
    _HAS_SMA = False
    _SMA_IMPORT_ERROR = str(_sma_err)
    logger = logging.getLogger("uvicorn")
    logger.warning(f"StructuralMechanicsApplication not available: {_sma_err}. Kratos solver disabled.")

logger = logging.getLogger("uvicorn")

from models import (
    AnalysisRequest, AnalysisResponse, MultiSlabAnalysisRequest, MultiSlabAnalysisResponse,
    SlabAnalysisResult, NodeDeflection, Point2D, MeshRequest, FEMNode, FEMMesh, Triangle,
    ColumnSupport, WallSupport, MpcConstraint, MpcTerm, EqualDofConstraint
)
from mesher import generate_mesh

from cracked_section import compute_long_term_multiplier

def select_shell_element_name(num_nodes: int, thickness: float, span: float = 5.0) -> str:
    """
    Match ETABS default shell element selection:
    - Quad (4-node) -> ShellThinElementCorotational3D4N
    - Triangle (3-node) -> ShellThinElement3D3N
    """
    if num_nodes == 4:
        return "ShellThinElementCorotational3D4N"
    return "ShellThinElement3D3N"

def _rect_torsion_constant(b: float, d: float) -> float:
    """Saint-Venant torsional constant (J) for a rectangular section."""
    w = min(b, d)
    h = max(b, d)
    if w < 1e-12 or h < 1e-12:
        return 0.0
    r = w / h
    return h * w**3 * (1.0 / 3.0 - 0.21 * r * (1.0 - r**4 / 12.0))

def _point_in_polygon(x: float, y: float, poly: List[Tuple[float, float]]) -> bool:
    """Ray-casting algorithm to check if point (x, y) is inside a polygon."""
    num = len(poly)
    if num < 3:
        return False
    j = num - 1
    c = False
    for i in range(num):
        if ((poly[i][1] > y) != (poly[j][1] > y)) and \
                (x < (poly[j][0] - poly[i][0]) * (y - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]):
            c = not c
        j = i
    return c

def find_nodes_near_segment(nodes_xy: np.ndarray, start_pt: Tuple[float, float], end_pt: Tuple[float, float], tol: float = 0.05) -> List[int]:
    """Find 1-indexed mesh node IDs located near a 2D line segment within geometric tolerance."""
    if len(nodes_xy) == 0:
        return []
    sx, sy = start_pt[0], start_pt[1]
    ex, ey = end_pt[0], end_pt[1]
    dx = ex - sx
    dy = ey - sy
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        return []
    t = ((nodes_xy[:, 0] - sx) * dx + (nodes_xy[:, 1] - sy) * dy) / L2
    mask = (t >= 0.0 - tol) & (t <= 1.0 + tol)
    if not np.any(mask):
        return []
    indices = np.where(mask)[0]
    t_cand = t[mask]
    t_clipped = np.clip(t_cand, 0, 1)
    px = sx + t_clipped * dx
    py = sy + t_clipped * dy
    nx = nodes_xy[indices, 0]
    ny = nodes_xy[indices, 1]
    dist2 = (nx - px)**2 + (ny - py)**2
    matching_mask = dist2 < tol * tol
    return (indices[matching_mask] + 1).tolist()

def find_nodes_near_segment_with_t(nodes_xy: np.ndarray, start_pt: Tuple[float, float], end_pt: Tuple[float, float], tol: float = 0.01) -> List[Tuple[float, int]]:
    """Find 1-indexed mesh node IDs near a line segment, returning (t_parameter, node_id) sorted along segment."""
    if len(nodes_xy) == 0:
        return []
    sx, sy = start_pt[0], start_pt[1]
    ex, ey = end_pt[0], end_pt[1]
    dx = ex - sx
    dy = ey - sy
    L = np.hypot(dx, dy)
    if L < 1e-6:
        return []
    L2 = L * L
    t = ((nodes_xy[:, 0] - sx) * dx + (nodes_xy[:, 1] - sy) * dy) / L2
    mask = (t >= -1e-5) & (t <= 1.0 + 1e-5)
    if not np.any(mask):
        return []
    indices = np.where(mask)[0]
    t_cand = t[mask]
    nx = nodes_xy[indices, 0]
    ny = nodes_xy[indices, 1]
    dist = np.abs((ny - sy) * dx - (nx - sx) * dy) / L
    matching_mask = dist < tol
    matched_indices = indices[matching_mask]
    matched_ts = t_cand[matching_mask]
    return [(float(matched_ts[i]), int(matched_indices[i] + 1)) for i in range(len(matched_indices))]

def find_nodes_near_partition_segment(nodes_xy: np.ndarray, start_pt: Tuple[float, float], end_pt: Tuple[float, float], tolerance: float = 0.35) -> List[Tuple[float, int]]:
    """Find nodes near partition wall line segment for load distribution."""
    if len(nodes_xy) == 0:
        return []
    sx, sy = start_pt[0], start_pt[1]
    ex, ey = end_pt[0], end_pt[1]
    dx = ex - sx
    dy = ey - sy
    segLen = np.hypot(dx, dy)
    if segLen < 1e-6:
        return []
    segLen2 = segLen * segLen
    t = ((nodes_xy[:, 0] - sx) * dx + (nodes_xy[:, 1] - sy) * dy) / segLen2
    mask = (t >= -0.01) & (t <= 1.01)
    if not np.any(mask):
        return []
    indices = np.where(mask)[0]
    t_cand = t[mask]
    nx = -dy / segLen
    ny = dx / segLen
    px = nodes_xy[indices, 0] - sx
    py = nodes_xy[indices, 1] - sy
    cross = px * nx + py * ny
    matching_mask = np.abs(cross) < tolerance
    matched_indices = indices[matching_mask]
    matched_ts = t_cand[matching_mask]
    return [(max(0.0, min(1.0, float(matched_ts[i]))), int(matched_indices[i] + 1)) for i in range(len(matched_indices))]

def _calculate_cr_analytical(request: AnalysisRequest) -> Tuple[float, float]:
    """Calculate Center of Rigidity using pure analytical stiffness formulation assembled about CM."""
    if not request.mesh or not request.mesh.nodes:
        return 0.0, 0.0
    nodes_map = {n.id: n for n in request.mesh.nodes}
    
    # 1. Center of Mass (CM)
    W_slab = 0.0
    slab_cx_sum = 0.0
    slab_cy_sum = 0.0
    
    concrete_density = 25000.0  # N/mÂ³
    t_slab = request.thickness
    
    for tri in request.mesh.elements:
        if len(tri.nodeIds) < 3 or tri.nodeIds[0] not in nodes_map or tri.nodeIds[1] not in nodes_map or tri.nodeIds[2] not in nodes_map:
            continue
        n1 = nodes_map[tri.nodeIds[0]]
        n2 = nodes_map[tri.nodeIds[1]]
        n3 = nodes_map[tri.nodeIds[2]]
        
        area = 0.5 * abs(n1.x * (n2.y - n3.y) + n2.x * (n3.y - n1.y) + n3.x * (n1.y - n2.y))
        xc = (n1.x + n2.x + n3.x) / 3.0
        yc = (n1.y + n2.y + n3.y) / 3.0
        
        h_eff = t_slab
        if request.dropPanels:
            for dp in request.dropPanels:
                poly = [(v.x, v.y) for v in dp.vertices]
                if len(poly) >= 3 and _point_in_polygon(xc, yc, poly):
                    h_eff = t_slab + dp.drop
                    break

        weight = concrete_density * h_eff * area
        W_slab += weight
        slab_cx_sum += weight * xc
        slab_cy_sum += weight * yc
        
    slab_cx = slab_cx_sum / W_slab if W_slab > 1e-6 else 0.0
    slab_cy = slab_cy_sum / W_slab if W_slab > 1e-6 else 0.0
    
    W_total = W_slab
    CM_num_x = W_slab * slab_cx
    CM_num_y = W_slab * slab_cy
    
    # Columns weights
    for i, col_nid in enumerate(request.columnNodeIds):
        node = nodes_map.get(col_nid)
        if not node:
            continue
        H = request.columnHeights[i] if (request.columnHeights and i < len(request.columnHeights)) else 3.0
        w = request.columnWidths[i] if (request.columnWidths and i < len(request.columnWidths)) else 0.3
        d = request.columnDepths[i] if (request.columnDepths and i < len(request.columnDepths)) else 0.3
        shape = request.columnShapes[i] if (request.columnShapes and i < len(request.columnShapes)) else "rectangular"
        diameter = request.columnDiameters[i] if (request.columnDiameters and i < len(request.columnDiameters)) else 0.5
        
        col_area = (np.pi * diameter**2 / 4.0) if shape == "circular" else (w * d)
        weight_col = concrete_density * col_area * H
        
        W_total += weight_col
        CM_num_x += weight_col * node.x
        CM_num_y += weight_col * node.y
        
    # Walls weights
    if (request.wallStartPoints and request.wallEndPoints
            and request.wallThicknesses and request.wallHeights):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx] if w_idx < len(request.wallThicknesses) else 0.25
            w_H = request.wallHeights[w_idx] if w_idx < len(request.wallHeights) else 3.0
            Lw = np.hypot(w_end.x - w_start.x, w_end.y - w_start.y)
            
            weight_wall = concrete_density * w_t * Lw * w_H
            xc = (w_start.x + w_end.x) / 2.0
            yc = (w_start.y + w_end.y) / 2.0
            
            W_total += weight_wall
            CM_num_x += weight_wall * xc
            CM_num_y += weight_wall * yc
            
    cm_x = CM_num_x / W_total if W_total > 1e-6 else 0.0
    cm_y = CM_num_y / W_total if W_total > 1e-6 else 0.0

    # 2. Accumulate stiffness matrix about CM
    Kxx = Kyy = Kxy = KxTheta = KyTheta = 0.0
    
    nu = request.poissonRatio
    E = request.elasticModulus
    G = E / (2.0 * (1.0 + nu))
    
    for i, col_nid in enumerate(request.columnNodeIds):
        node = nodes_map.get(col_nid)
        if not node:
            continue
        cx, cy = node.x, node.y
        H = request.columnHeights[i] if (request.columnHeights and i < len(request.columnHeights)) else 3.0
        w = request.columnWidths[i] if (request.columnWidths and i < len(request.columnWidths)) else 0.3
        d = request.columnDepths[i] if (request.columnDepths and i < len(request.columnDepths)) else 0.3
        shape = request.columnShapes[i] if (request.columnShapes and i < len(request.columnShapes)) else "rectangular"
        diameter = request.columnDiameters[i] if (request.columnDiameters and i < len(request.columnDiameters)) else 0.5
        
        if H < 1e-6 or E < 1e-6:
            continue
            
        if shape == "circular":
            D = diameter if diameter > 0.0 else 0.5
            Iy = Ix = np.pi * D**4 / 64.0
        else:
            Iy = d * w**3 / 12.0
            Ix = w * d**3 / 12.0
            
        bc = request.columnBoundaryConditions[i] if (request.columnBoundaryConditions and i < len(request.columnBoundaryConditions)) else "fixed-fixed"
        col_fixity = 3.0 if bc == "fixed-free" else 12.0
        kx = col_fixity * E * Iy / H**3
        ky = col_fixity * E * Ix / H**3
        
        Kxx += kx
        Kyy += ky
        
        xRel = cx - cm_x
        yRel = cy - cm_y
        KxTheta += kx * yRel
        KyTheta += ky * xRel
        
    if (request.wallStartPoints and request.wallEndPoints
            and request.wallThicknesses and request.wallHeights):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx] if w_idx < len(request.wallThicknesses) else 0.25
            w_H = request.wallHeights[w_idx] if w_idx < len(request.wallHeights) else 3.0

            # Use wall-specific E if provided, otherwise fall back to slab E
            wall_E = E
            if (hasattr(request, 'wallElasticModuli') and request.wallElasticModuli
                    and w_idx < len(request.wallElasticModuli) and request.wallElasticModuli[w_idx] > 0):
                wall_E = request.wallElasticModuli[w_idx]
            G_wall = wall_E / (2.0 * (1.0 + nu))

            dx = w_end.x - w_start.x
            dy = w_end.y - w_start.y
            Lw = np.hypot(dx, dy)
            if Lw < 1e-6 or w_H < 1e-6:
                continue

            alpha = np.arctan2(dy, dx)
            xc = (w_start.x + w_end.x) / 2.0
            yc = (w_start.y + w_end.y) / 2.0

            bc = request.wallBoundaryConditions[w_idx] if (request.wallBoundaryConditions and w_idx < len(request.wallBoundaryConditions)) else "fixed-free"
            wall_fixity = 12.0 if bc == "fixed-fixed" else 3.0

            I_in = w_t * Lw**3 / 12.0
            A_w = w_t * Lw

            delta_flex_in = w_H**3 / (wall_fixity * wall_E * I_in)
            delta_shear_in = 1.2 * w_H / (G_wall * A_w)
            k_in = 1.0 / (delta_flex_in + delta_shear_in)

            D_plate = (wall_E * w_t**3) / (12.0 * (1.0 - nu**2))
            k_out = (wall_fixity * D_plate * Lw) / w_H**3
            
            cosA2 = np.cos(alpha)**2
            sinA2 = np.sin(alpha)**2
            sinCos = np.sin(alpha) * np.cos(alpha)
            
            kx_w = k_in * cosA2 + k_out * sinA2
            ky_w = k_in * sinA2 + k_out * cosA2
            kxy_w = (k_in - k_out) * sinCos
            
            Kxx += kx_w
            Kyy += ky_w
            Kxy += kxy_w
            
            xRel = xc - cm_x
            yRel = yc - cm_y
            KxTheta += kx_w * yRel - kxy_w * xRel
            KyTheta += ky_w * xRel - kxy_w * yRel
            
    denom = Kxx * Kyy - Kxy * Kxy
    if abs(denom) < 1e-18:
        return cm_x, cm_y
        
    cr_x = cm_x + (Kxx * KyTheta + Kxy * KxTheta) / denom
    cr_y = cm_y + (Kyy * KxTheta + Kxy * KyTheta) / denom
    return cr_x, cr_y


class UnionFind:
    """Disjoint Set Union (Union-Find) graph audit to detect unconstrained/floating components."""
    def __init__(self, elements: Set[int]):
        self.parent = {x: x for x in elements}

    def find(self, x: int) -> int:
        if x not in self.parent:
            self.parent[x] = x
            return x
        path = []
        while self.parent[x] != x:
            path.append(x)
            x = self.parent[x]
        for node in path:
            self.parent[node] = x
        return x

    def union(self, x: int, y: int):
        rx = self.find(x)
        ry = self.find(y)
        if rx != ry:
            self.parent[rx] = ry


def solve_reslo_structure(request: AnalysisRequest) -> AnalysisResponse:
    """
    Main entry point for solving RESLO slab structures via Kratos Multiphysics backend.
    Preserves 100% of the AnalysisRequest input contract and returns AnalysisResponse.
    """
    if not _HAS_SMA:
        return AnalysisResponse(
            success=False,
            error=f"Kratos StructuralMechanicsApplication is not available: {_SMA_IMPORT_ERROR}. "
                  f"The solver falls back to the pure Python DKT solver automatically."
        )
    t0 = time.time()

    if not request.columnNodeIds and not request.wallNodeIds:
        return AnalysisResponse(
            success=False,
            error="The structure has no supports. Please add at least one column or wall support before running analysis."
        )

    mesh = request.mesh
    if not mesh or not mesh.nodes or not mesh.elements:
        return AnalysisResponse(
            success=False,
            error="Invalid geometry: mesh contains no nodes or elements."
        )

    nn = mesh.nodeCount
    ne = len(mesh.elements)
    h = request.thickness
    E = request.elasticModulus
    nu = request.poissonRatio

    if E < 1e9:
        raise ValueError(f"elasticModulus={E:.2e} Pa is implausibly low. Expected ~25e9 Pa (25 GPa).")

    # Enforce counter-clockwise (CCW) node ordering on mesh elements (triangles and quads)
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    nodes_map = {n.id: n for n in mesh.nodes}

    elem_nodes = []
    for tri in mesh.elements:
        nids = [nid - 1 for nid in tri.nodeIds]
        if len(nids) == 3:
            x0, y0 = nodes_xy[nids[0]]
            x1, y1 = nodes_xy[nids[1]]
            x2, y2 = nodes_xy[nids[2]]
            signed_area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if signed_area < 0:
                nids[1], nids[2] = nids[2], nids[1]
        elem_nodes.append(nids)

    # Columns setup & footprint patches
    col_node_indices = []
    col_dims_map = {}
    col_node_ids = request.columnNodeIds or []
    col_widths = request.columnWidths or []
    col_depths = request.columnDepths or []

    for ci, nid in enumerate(col_node_ids):
        nidx = nid - 1
        if 0 <= nidx < len(nodes_xy):
            col_node_indices.append(nidx)
            wcol = col_widths[ci] if ci < len(col_widths) else 0.3
            dcol = col_depths[ci] if ci < len(col_depths) else 0.3
            col_dims_map[nidx] = (wcol, dcol)

    tree = cKDTree(nodes_xy)
    col_node_patches = {}
    for col_idx, nidx in enumerate(col_node_indices):
        if not (0 <= nidx < len(nodes_xy)):
            continue
        xc, yc = nodes_xy[nidx]
        shape = request.columnShapes[col_idx] if (request.columnShapes and col_idx < len(request.columnShapes)) else "rectangular"
        patch = []

        if shape == "circular":
            diameter = request.columnDiameters[col_idx] if (request.columnDiameters and col_idx < len(request.columnDiameters)) else 0.5
            radius = diameter / 2.0 + 0.01
            candidates = tree.query_ball_point([xc, yc], radius)
            for n in candidates:
                if np.hypot(nodes_xy[n, 0] - xc, nodes_xy[n, 1] - yc) <= radius:
                    patch.append(n)
        else:
            wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
            r_bound = np.hypot(wcol / 2.0 + 0.01, dcol / 2.0 + 0.01)
            candidates = tree.query_ball_point([xc, yc], r_bound)
            for n in candidates:
                if (abs(nodes_xy[n, 0] - xc) <= wcol / 2.0 + 0.01 and abs(nodes_xy[n, 1] - yc) <= dcol / 2.0 + 0.01):
                    patch.append(n)
        if not patch:
            patch = [nidx]
        col_node_patches[nidx] = patch

    slave_nodes = set()
    already_linked_nodes = set()
    for nidx, patch in col_node_patches.items():
        master_id = nidx + 1
        for n in patch:
            slave_id = n + 1
            if slave_id != master_id and slave_id not in already_linked_nodes:
                slave_nodes.add(slave_id)
                already_linked_nodes.add(slave_id)

    wall_node_ids_set = set(request.wallNodeIds)
    if (hasattr(request, 'wallStartPoints') and request.wallStartPoints
            and hasattr(request, 'wallEndPoints') and request.wallEndPoints):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            dx_w = w_end.x - w_start.x
            dy_w = w_end.y - w_start.y
            L2 = dx_w * dx_w + dy_w * dy_w
            if L2 > 1e-12:
                for node in mesh.nodes:
                    t_val = max(0.0, min(1.0, ((node.x - w_start.x) * dx_w + (node.y - w_start.y) * dy_w) / L2))
                    px = w_start.x + t_val * dx_w
                    py = w_start.y + t_val * dy_w
                    if np.hypot(node.x - px, node.y - py) < 0.25:
                        wall_node_ids_set.add(node.id)
    G_val = E / (2 * (1 + nu))

    # Calculate effective element thicknesses including drop panels
    elem_thicknesses = {}
    for elem_idx, tri_nodes in enumerate(elem_nodes):
        h_eff = request.elementThicknesses[elem_idx] if (request.elementThicknesses and elem_idx < len(request.elementThicknesses)) else h
        if request.dropPanels:
            pts = nodes_xy[tri_nodes]
            xc = float(np.mean(pts[:, 0]))
            yc = float(np.mean(pts[:, 1]))
            for dp in request.dropPanels:
                poly = [(v.x, v.y) for v in dp.vertices]
                if len(poly) >= 3 and _point_in_polygon(xc, yc, poly):
                    h_eff = h_eff + dp.drop
                    break
        elem_thicknesses[elem_idx] = h_eff

    # Initialize Kratos Model & ModelPart
    kratos_model = KM.Model()
    model_part = kratos_model.CreateModelPart("StructuralModelPart")
    model_part.ProcessInfo.SetValue(KM.DOMAIN_SIZE, 3)

    # Register Nodal Solution Step Variables
    model_part.AddNodalSolutionStepVariable(KM.DISPLACEMENT)
    model_part.AddNodalSolutionStepVariable(KM.REACTION)
    model_part.AddNodalSolutionStepVariable(KM.ROTATION)
    model_part.AddNodalSolutionStepVariable(KM.TORQUE)
    model_part.AddNodalSolutionStepVariable(KM.VOLUME_ACCELERATION)
    model_part.AddNodalSolutionStepVariable(SMA.POINT_LOAD)

    # Identify connected nodes to handle floating/unconnected nodes
    connected_nodes = set()
    for tri in elem_nodes:
        for nid in tri:
            connected_nodes.add(nid + 1)
    if request.beamNodeIdA and request.beamNodeIdB:
        for b_idx in range(len(request.beamNodeIdA)):
            connected_nodes.add(request.beamNodeIdA[b_idx])
            connected_nodes.add(request.beamNodeIdB[b_idx])
    for nidx in col_node_indices:
        connected_nodes.add(nidx + 1)

    node_fixities = {}

    # Add Mesh Nodes to Kratos ModelPart
    kratos_nodes_map = {}
    for node in mesh.nodes:
        knode = model_part.CreateNewNode(node.id, node.x, node.y, 0.0)
        knode.AddDof(KM.DISPLACEMENT_X, KM.REACTION_X)
        knode.AddDof(KM.DISPLACEMENT_Y, KM.REACTION_Y)
        knode.AddDof(KM.DISPLACEMENT_Z, KM.REACTION_Z)
        knode.AddDof(KM.ROTATION_X, KM.TORQUE_X)
        knode.AddDof(KM.ROTATION_Y, KM.TORQUE_Y)
        knode.AddDof(KM.ROTATION_Z, KM.TORQUE_Z)
        kratos_nodes_map[node.id] = knode

        node_fixities[node.id] = [0, 0, 0, 0, 0, 0]
        # Fix drilling rotation Rz for thin shell stability (all shell nodes)
        node_fixities[node.id][5] = 1
        # Nodes with no support at all will be caught and stabilized later (line ~797)
        # Do NOT fully fix all unconnected nodes — that breaks walls-only models

    # Column Elements Setup (CrLinearBeamElement3D2N)
    col_base_node_ids = []
    col_properties_counter = 1000
    for col_idx, nidx in enumerate(col_node_indices):
        master_id = nidx + 1
        wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
        xc, yc = nodes_xy[nidx]
        col_H = request.columnHeights[col_idx] if (request.columnHeights and col_idx < len(request.columnHeights)) else 3.0
        if col_H < 1e-6:
            col_H = 3.0

        base_node_id = col_idx + 1000001
        col_base_node_ids.append(base_node_id)
        kbase_node = model_part.CreateNewNode(base_node_id, xc, yc, -col_H)
        kbase_node.AddDof(KM.DISPLACEMENT_X, KM.REACTION_X)
        kbase_node.AddDof(KM.DISPLACEMENT_Y, KM.REACTION_Y)
        kbase_node.AddDof(KM.DISPLACEMENT_Z, KM.REACTION_Z)
        kbase_node.AddDof(KM.ROTATION_X, KM.TORQUE_X)
        kbase_node.AddDof(KM.ROTATION_Y, KM.TORQUE_Y)
        kbase_node.AddDof(KM.ROTATION_Z, KM.TORQUE_Z)
        kratos_nodes_map[base_node_id] = kbase_node
        node_fixities[base_node_id] = [1, 1, 1, 1, 1, 1]  # Fully fixed column base

        col_grade = request.columnGrades[col_idx] if (request.columnGrades and col_idx < len(request.columnGrades)) else "M25"
        fck = float(col_grade.replace("M", "")) if col_grade.startswith("M") else 25.0
        E_col = 5000.0 * np.sqrt(fck) * 1e6
        nu_col = 0.2

        shape = request.columnShapes[col_idx] if (request.columnShapes and col_idx < len(request.columnShapes)) else "rectangular"
        if shape == "circular":
            diameter = request.columnDiameters[col_idx] if (request.columnDiameters and col_idx < len(request.columnDiameters)) else 0.5
            Ac = np.pi * diameter**2 / 4.0
            Iy = Iz = np.pi * diameter**4 / 64.0
            Jc = np.pi * diameter**4 / 32.0
        else:
            Ac = wcol * dcol
            Iy = wcol * dcol**3 / 12.0
            Iz = dcol * wcol**3 / 12.0
            Jc = _rect_torsion_constant(wcol, dcol)

        prop_col = model_part.CreateNewProperties(col_properties_counter)
        col_properties_counter += 1
        prop_col.SetValue(KM.YOUNG_MODULUS, E_col)
        prop_col.SetValue(KM.POISSON_RATIO, nu_col)
        prop_col.SetValue(KM.DENSITY, 2500.0)
        prop_col.SetValue(SMA.CROSS_AREA, Ac)
        prop_col.SetValue(SMA.I22, Iy)
        prop_col.SetValue(SMA.I33, Iz)
        prop_col.SetValue(SMA.TORSIONAL_INERTIA, Jc)

        col_ele_tag = col_idx + 3000001
        model_part.CreateNewElement("CrLinearBeamElement3D2N", col_ele_tag, [base_node_id, master_id], prop_col)

    # Column Capital Rigid Links (C0 & C1 3D Rigid Beam Kinematics)
    # Radiating rigid beam elements incorporate exact 3D rigid lever arm kinematics (w_slave = w_master + dy*Rx - dx*Ry)
    # matching OpenSees rigidLink('beam') and ETABS rigid diaphragm/column head capital behavior.
    prop_rigid_capital = model_part.CreateNewProperties(999990)
    prop_rigid_capital.SetValue(KM.YOUNG_MODULUS, E * 100.0)
    prop_rigid_capital.SetValue(KM.POISSON_RATIO, nu)
    prop_rigid_capital.SetValue(KM.DENSITY, 0.0)
    prop_rigid_capital.SetValue(SMA.CROSS_AREA, 0.25)
    prop_rigid_capital.SetValue(SMA.I22, 0.0052)
    prop_rigid_capital.SetValue(SMA.I33, 0.0052)
    prop_rigid_capital.SetValue(SMA.TORSIONAL_INERTIA, 0.0104)

    constraint_counter = 1
    rigid_beam_counter = 4000001
    already_linked = set()
    for nidx, patch in col_node_patches.items():
        master_id = nidx + 1
        for n in patch:
            slave_id = n + 1
            if slave_id != master_id and slave_id not in already_linked:
                model_part.CreateNewElement("CrLinearBeamElement3D2N", rigid_beam_counter, [master_id, slave_id], prop_rigid_capital)
                rigid_beam_counter += 1
                already_linked.add(slave_id)


    # Shear Walls Fixities — fix Ux, Uy, Uz (translations) at wall nodes
    for nid in wall_node_ids_set:
        if nid not in slave_nodes and nid in node_fixities:
            node_fixities[nid][0] = 1  # Ux
            node_fixities[nid][1] = 1  # Uy
            node_fixities[nid][2] = 1  # Uz

    # Identify which wall nodes belong to clamped (fixed-fixed / fixed) walls
    fixed_rot_wall_node_ids = set()
    if (hasattr(request, 'wallStartPoints') and request.wallStartPoints
            and hasattr(request, 'wallEndPoints') and request.wallEndPoints
            and hasattr(request, 'wallBoundaryConditions') and request.wallBoundaryConditions):
        for w_idx in range(len(request.wallStartPoints)):
            bc = request.wallBoundaryConditions[w_idx] if w_idx < len(request.wallBoundaryConditions) else ""
            if bc in ("fixed-fixed", "fixed"):
                w_start = request.wallStartPoints[w_idx]
                w_end = request.wallEndPoints[w_idx]
                for node in mesh.nodes:
                    dx_w = w_end.x - w_start.x
                    dy_w = w_end.y - w_start.y
                    L2 = dx_w * dx_w + dy_w * dy_w
                    if L2 > 1e-12:
                        t_val = max(0.0, min(1.0, ((node.x - w_start.x) * dx_w + (node.y - w_start.y) * dy_w) / L2))
                        px = w_start.x + t_val * dx_w
                        py = w_start.y + t_val * dy_w
                        if np.hypot(node.x - px, node.y - py) < 0.15:
                            fixed_rot_wall_node_ids.add(node.id)

    # Fix Rx, Ry ONLY for wall nodes belonging to clamped (fixed-fixed / fixed) walls
    for w_nid in fixed_rot_wall_node_ids:
        if w_nid not in slave_nodes and w_nid in node_fixities:
            node_fixities[w_nid][3] = 1  # Rx
            node_fixities[w_nid][4] = 1  # Ry

    # Union-Find Audit for Floating/Unsupported Component Stabilization.
    # NOTE: runs BEFORE constraint creation below so the slave-restraint guards
    # (equalDOF / MPC) observe the final fixity state — a slave DOF must never be
    # fixed, so stabilized nodes are correctly excluded from constraint creation.
    all_node_ids = set(kratos_nodes_map.keys())
    uf = UnionFind(all_node_ids)

    for tri in elem_nodes:
        # elem_nodes holds 0-based node indices; UF is built over 1-based node IDs
        for k in range(len(tri) - 1):
            uf.union(tri[k] + 1, tri[k + 1] + 1)
        if len(tri) > 2:
            uf.union(tri[0] + 1, tri[-1] + 1)

    for col_idx, nidx in enumerate(col_node_indices):
        master_id = nidx + 1
        base_node_id = col_idx + 1000001
        uf.union(master_id, base_node_id)
        patch = col_node_patches.get(nidx, [])
        for p_nid in patch:
            uf.union(master_id, p_nid + 1)

    if request.equalDofConstraints:
        for eq_c in request.equalDofConstraints:
            if eq_c.nodeIdA and eq_c.nodeIdB:
                uf.union(int(eq_c.nodeIdA), int(eq_c.nodeIdB))

    if getattr(request, 'mpcConstraints', None):
        for mpc in request.mpcConstraints:
            for m in mpc.masters:
                if mpc.slaveNodeId and m.nodeId:
                    uf.union(int(mpc.slaveNodeId), int(m.nodeId))

    supported_roots = set()
    for nid in all_node_ids:
        is_sup = False
        if nid >= 1000001:
            is_sup = True
        else:
            fix = node_fixities.get(nid, [0, 0, 0, 0, 0, 0])
            if fix[0] == 1 or fix[1] == 1 or fix[2] == 1:
                is_sup = True
        if is_sup:
            supported_roots.add(uf.find(nid))

    unsupported_count = 0
    unsupported_node_ids = []
    for nid in all_node_ids:
        root = uf.find(nid)
        if root not in supported_roots:
            node_fixities[nid] = [1, 1, 1, 1, 1, 1]
            unsupported_count += 1
            unsupported_node_ids.append(nid)

    if unsupported_count > 0:
        logger.warning(f"Solver stabilized: fully fixed {unsupported_count} unsupported/floating nodes to prevent singular matrix error. Node IDs: {unsupported_node_ids}")

    # Equal DOF Constraints (e.g. C0 hinges and multi-slab interface constraints).
    # A slave DOF must never be support-restrained (Kratos forbids fixing a slave):
    # skip DOFs already fixed on the slave (B) side — the support restraint wins,
    # consistent with the MPC guard and the TS worker's `if (bc[slaveDof]) continue;`.
    if request.equalDofConstraints:
        for eq_c in request.equalDofConstraints:
            if (eq_c.nodeIdA and eq_c.nodeIdB and int(eq_c.nodeIdA) != int(eq_c.nodeIdB)
                    and eq_c.nodeIdA in kratos_nodes_map and eq_c.nodeIdB in kratos_nodes_map):
                knodeA = kratos_nodes_map[int(eq_c.nodeIdA)]
                knodeB = kratos_nodes_map[int(eq_c.nodeIdB)]
                fixB = node_fixities.get(int(eq_c.nodeIdB))
                dof_vars = [KM.DISPLACEMENT_X, KM.DISPLACEMENT_Y, KM.DISPLACEMENT_Z, KM.ROTATION_X, KM.ROTATION_Y, KM.ROTATION_Z]
                for d_idx in eq_c.dofs:
                    if 1 <= d_idx <= 6:
                        if fixB is not None and fixB[d_idx - 1] == 1:
                            continue  # slave DOF is restrained — support condition takes precedence
                        var = dof_vars[d_idx - 1]
                        model_part.CreateNewMasterSlaveConstraint(
                            "LinearMasterSlaveConstraint",
                            constraint_counter,
                            knodeA, var,
                            knodeB, var,
                            1.0, 0.0
                        )
                        constraint_counter += 1

    # Weighted multi-master MPCs (ETABS-style edge constraints for non-conformal
    # multi-slab joints): u_slave = Σ w_i·u_master_i via LinearMasterSlaveConstraint.
    # Ties whose slave DOF is support-restrained are skipped (a slave cannot be fixed).
    if getattr(request, 'mpcConstraints', None):
        dof_vars_m = [KM.DISPLACEMENT_X, KM.DISPLACEMENT_Y, KM.DISPLACEMENT_Z, KM.ROTATION_X, KM.ROTATION_Y, KM.ROTATION_Z]
        for mpc in request.mpcConstraints:
            sid = int(mpc.slaveNodeId)
            if sid not in kratos_nodes_map:
                continue
            d_idx = int(mpc.slaveDof) - 1
            if not (0 <= d_idx < 6):
                continue
            if sid in node_fixities and node_fixities[sid][d_idx] == 1:
                continue  # restrained slave — fixing a slave is invalid in Kratos
            var = dof_vars_m[d_idx]
            slave_dof = kratos_nodes_map[sid].GetDof(var)
            master_dofs: List[Any] = []
            for m in mpc.masters:
                mid = int(m.nodeId)
                if mid in kratos_nodes_map and mid != sid:
                    master_dofs.append((kratos_nodes_map[mid], float(m.weight)))
            if not master_dofs:
                continue
            W = KM.Matrix(1, len(master_dofs))
            dof_list = []
            for mi, (mk, w) in enumerate(master_dofs):
                dof_list.append(mk.GetDof(var))
                W[0, mi] = w
            Cvec = KM.Vector(1)
            Cvec[0] = 0.0
            model_part.CreateNewMasterSlaveConstraint(
                "LinearMasterSlaveConstraint",
                constraint_counter,
                dof_list,
                [slave_dof],
                W, Cvec
            )
            constraint_counter += 1




    # Slab Shell Elements Setup (MITC4 Quads & DKT Triangles)
    properties_map = {}
    prop_counter = 1

    for elem_idx, tri_nodes in enumerate(elem_nodes):
        elem_id = elem_idx + 1
        h_eff = elem_thicknesses.get(elem_idx, h)
        E_eff = request.elementElasticModuli[elem_idx] if (request.elementElasticModuli and elem_idx < len(request.elementElasticModuli)) else E

        prop_key = (round(h_eff, 4), round(E_eff, -4))
        if prop_key not in properties_map:
            prop_tag = prop_counter
            prop_counter += 1
            prop_shell = model_part.CreateNewProperties(prop_tag)
            prop_shell.SetValue(KM.YOUNG_MODULUS, E_eff)
            prop_shell.SetValue(KM.POISSON_RATIO, nu)
            prop_shell.SetValue(KM.THICKNESS, h_eff)
            prop_shell.SetValue(KM.DENSITY, 2500.0)
            # Plate/shell theory requires plane-stress: sigma_zz = 0 through the
            # thickness. A full 3D law cannot condense sigma_zz and yields
            # plane-strain stiffness  E(1-nu)/((1+nu)(1-2nu))  instead of the
            # Kirchhoff plate modulus  E/(1-nu^2)  — for nu=0.2 that is +6.7%
            # stiffer (measured: Kratos plate converged 7.3% below the exact
            # Mindlin-Navier deflection; with this law it matches theory).
            claw = SMA.LinearElasticPlaneStress2DLaw()
            prop_shell.SetValue(KM.CONSTITUTIVE_LAW, claw)
            properties_map[prop_key] = prop_shell
        else:
            prop_shell = properties_map[prop_key]

        n_ids = [nid + 1 for nid in tri_nodes]
        elem_type_name = select_shell_element_name(len(n_ids), h_eff)
        model_part.CreateNewElement(elem_type_name, elem_id, n_ids, prop_shell)

    # Beam Elements Setup (CrLinearBeamElement3D2N)
    beam_forces = {}
    if (request.beamNodeIdA and request.beamNodeIdB and request.beamWidths and request.beamDepths and request.beamElasticModuli):
        for b_idx in range(len(request.beamNodeIdA)):
            nA = request.beamNodeIdA[b_idx]
            nB = request.beamNodeIdB[b_idx]
            b_w = request.beamWidths[b_idx]
            b_d = request.beamDepths[b_idx]
            b_E = request.beamElasticModuli[b_idx]
            if nA == nB or nA not in kratos_nodes_map or nB not in kratos_nodes_map:
                continue
            ptA = nodes_xy[nA - 1]
            ptB = nodes_xy[nB - 1]
            L_beam = np.hypot(ptB[0] - ptA[0], ptB[1] - ptA[1])
            if L_beam < 1e-6:
                continue
            beam_nodes = find_nodes_near_segment_with_t(nodes_xy, ptA, ptB, tol=0.01)
            beam_nodes.sort(key=lambda item: item[0])
            filtered_nodes = []
            for item in beam_nodes:
                if not filtered_nodes or (item[0] - filtered_nodes[-1][0]) * L_beam > 0.05:
                    filtered_nodes.append(item)
            beam_nodes = filtered_nodes

            A_sect = b_w * b_d
            Iy = b_w * b_d**3 / 12.0
            Iz = b_d * b_w**3 / 12.0
            J_sect = _rect_torsion_constant(b_w, b_d)

            prop_beam_seg = model_part.CreateNewProperties(prop_counter)
            prop_counter += 1
            prop_beam_seg.SetValue(KM.YOUNG_MODULUS, b_E)
            prop_beam_seg.SetValue(KM.POISSON_RATIO, nu)
            prop_beam_seg.SetValue(KM.DENSITY, 2500.0)
            prop_beam_seg.SetValue(SMA.CROSS_AREA, A_sect)
            prop_beam_seg.SetValue(SMA.I22, Iy)
            prop_beam_seg.SetValue(SMA.I33, Iz)
            prop_beam_seg.SetValue(SMA.TORSIONAL_INERTIA, J_sect)

            for i in range(len(beam_nodes) - 1):
                n_start_id = beam_nodes[i][1]
                n_end_id = beam_nodes[i + 1][1]
                pt_start = nodes_xy[n_start_id - 1]
                pt_end = nodes_xy[n_end_id - 1]
                seg_L = np.hypot(pt_end[0] - pt_start[0], pt_end[1] - pt_start[1])
                net_d = max(0.0, b_d - h)
                w_self = 25000.0 * b_w * net_d
                W_seg = w_self * seg_L
                beam_forces[n_start_id] = beam_forces.get(n_start_id, 0.0) + W_seg / 2.0
                beam_forces[n_end_id] = beam_forces.get(n_end_id, 0.0) + W_seg / 2.0

                beam_ele_tag = b_idx * 1000 + i + 8000000
                model_part.CreateNewElement("CrLinearBeamElement3D2N", beam_ele_tag, [n_start_id, n_end_id], prop_beam_seg)

    # Apply DOF Fixities to Kratos Nodes
    for nid, fixs in node_fixities.items():
        knode = kratos_nodes_map[nid]
        dof_enums = [KM.DISPLACEMENT_X, KM.DISPLACEMENT_Y, KM.DISPLACEMENT_Z, KM.ROTATION_X, KM.ROTATION_Y, KM.ROTATION_Z]
        for idx, fval in enumerate(fixs):
            if fval == 1:
                knode.Fix(dof_enums[idx])
        # Mark all nodes with ANY fixity as BOUNDARY for proper constraint enforcement
        if any(f == 1 for f in fixs):
            knode.Set(KM.BOUNDARY, True)

    # Nodal Load Assembly (Uniform Load + Beam Self-Weight + Partition Walls)
    nodal_forces = {}
    for elem_idx, tri in enumerate(mesh.elements):
        q_val = request.elementLoads[elem_idx] if (request.elementLoads and elem_idx < len(request.elementLoads)) else (request.uniformLoad + request.selfWeight)
        q = q_val * 1000.0  # kN/mÂ² -> N/mÂ²
        nids = tri.nodeIds
        pts = [mesh.nodes[nid - 1] for nid in nids]
        if len(nids) == 3:
            area = 0.5 * abs(pts[0].x * (pts[1].y - pts[2].y) + pts[1].x * (pts[2].y - pts[0].y) + pts[2].x * (pts[0].y - pts[1].y))
            fe = q * area / 3.0
        else:
            area = 0.5 * abs(
                (pts[0].x * pts[1].y - pts[1].x * pts[0].y) +
                (pts[1].x * pts[2].y - pts[2].x * pts[1].y) +
                (pts[2].x * pts[3].y - pts[3].x * pts[2].y) +
                (pts[3].x * pts[0].y - pts[0].x * pts[3].y)
            )
            fe = q * area / 4.0
        for nid in nids:
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + fe

    for nid, fz_beam in beam_forces.items():
        nodal_forces[nid] = nodal_forces.get(nid, 0.0) + fz_beam

    tolerance = 0.35
    for seg in request.partitionWallSegments:
        sx, sy = seg.startX, seg.startY
        ex, ey = seg.endX, seg.endY
        segLen = np.hypot(ex - sx, ey - sy)
        if segLen < 0.001:
            continue
        near_nodes = find_nodes_near_partition_segment(nodes_xy, (sx, sy), (ex, ey), tolerance=tolerance)
        if len(near_nodes) == 0:
            mx, my = (sx + ex) / 2.0, (sy + ey) / 2.0
            dists = np.hypot(nodes_xy[:, 0] - mx, nodes_xy[:, 1] - my)
            nid = int(np.argmin(dists) + 1)
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + seg.lineLoad * segLen * 1000.0
            continue
        if len(near_nodes) == 1:
            nid = near_nodes[0][1]
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + seg.lineLoad * segLen * 1000.0
            continue
        near_nodes.sort(key=lambda x: x[0])
        for i in range(len(near_nodes)):
            t_val, nid = near_nodes[i]
            left = 0.0 if i == 0 else (near_nodes[i][0] + near_nodes[i - 1][0]) / 2.0
            right = 1.0 if i == len(near_nodes) - 1 else (near_nodes[i][0] + near_nodes[i + 1][0]) / 2.0
            tribLen = (right - left) * segLen
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + seg.lineLoad * tribLen * 1000.0

    # Clone time step to step 1 for Kratos static solution step variable assembly
    model_part.CloneTimeStep(1.0)

    # Create Kratos Point Load Conditions on Nodes
    cond_counter = 1
    dummy_prop = model_part.CreateNewProperties(999999)
    for nid, fz in nodal_forces.items():
        if nid in kratos_nodes_map:
            knode = kratos_nodes_map[nid]
            cond = model_part.CreateNewCondition("PointLoadCondition3D1N", cond_counter, [nid], dummy_prop)
            cond.SetValue(SMA.POINT_LOAD, [0.0, 0.0, -fz])
            cond_counter += 1

    # Configure Kratos Linear Static Solver Strategy
    # SparseLUSolver (UMFPACK-backed) is 3-10x faster than SkylineLU for large sparse systems
    try:
        linear_solver = KM.SparseLUSolver()
    except AttributeError:
        linear_solver = KM.SkylineLUFactorizationSolver()
    builder_and_solver = KM.ResidualBasedBlockBuilderAndSolver(linear_solver)
    scheme = KM.ResidualBasedIncrementalUpdateStaticScheme()

    strategy = KM.ResidualBasedLinearStrategy(
        model_part,
        scheme,
        builder_and_solver,
        True,  # CalculateReactions = True (Required for column base axial force & punching shear)
        False, False, False
    )
    strategy.SetEchoLevel(0)



    try:
        strategy.Solve()
        solver_time = time.time() - t0
    except Exception as solve_err:
        logger.error(f"Kratos solver exception: {str(solve_err)}")
        return AnalysisResponse(success=False, error=f"Kratos solver exception: {str(solve_err)}")

    # Recover Results
    # 1. Nodal Deflections & Rotations
    node_deflections = []
    for node in mesh.nodes:
        knode = kratos_nodes_map.get(node.id)
        if knode:
            disp = knode.GetSolutionStepValue(KM.DISPLACEMENT)
            rot = knode.GetSolutionStepValue(KM.ROTATION)
            node_deflections.append(NodeDeflection(
                nodeId=node.id,
                u=disp[0],
                v=disp[1],
                wz=-disp[2],  # positive downwards
                rx=rot[0],
                ry=rot[1],
                rz=rot[2]
            ))
        else:
            node_deflections.append(NodeDeflection(nodeId=node.id, wz=0.0, rx=0.0, ry=0.0))

    all_wz = [d.wz for d in node_deflections]
    min_wz = min(all_wz) if all_wz else 0.0
    max_wz = max(abs(w) for w in all_wz) if all_wz else 0.0

    # Cracked Section Long-Term Deflection
    cracked_wz_max = None
    if request.performCrackedAnalysis and max_wz > 0:
        lt_factor = compute_long_term_multiplier(xi=2.0)
        cracked_wz_max = round(max_wz * 2.0 * (1.0 + lt_factor), 6)

    # Calculate Center of Rigidity
    cr_x, cr_y = _calculate_cr_analytical(request)

    return AnalysisResponse(
        success=True,
        nodeDeflections=node_deflections,
        minWz=round(min_wz, 10),
        maxWz=round(max_wz, 10),
        solverTime=round(solver_time, 4),
        crX=round(cr_x, 6),
        crY=round(cr_y, 6),
        adaptive_iterations=1,
        cracked_deflection_max=cracked_wz_max
    )


# UnionFind defined once above at line ~351 â€” no duplicate needed here



def _recover_shears_from_moment_gradients(
    mesh: FEMMesh,
    element_moments: list,
    spr_nodal_moments: dict
) -> Tuple[list, float, float]:
    """
    Compute transverse shear forces Vx, Vy (kN/m) from SPR-smoothed nodal moment
    gradients using isoparametric shape function derivatives at element centroid.

    Vx = dMx/dx + dMxy/dy
    Vy = dMxy/dx + dMy/dy

    Returns (element_shears, min_v, max_v) where element_shears is a list of
    ElementShear objects with the same ordering as element_moments.
    """
    node_coords = {n.id: np.array([n.x, n.y]) for n in mesh.nodes}
    element_shears_out = []
    min_v = float('inf')
    max_v = float('-inf')

    for em in element_moments:
        elem = next((e for e in mesh.elements if e.id == em.elementId), None)
        if not elem or len(elem.nodeIds) < 3:
            element_shears_out.append(ElementShear(elementId=em.elementId, vx=0.0, vy=0.0, v1=0.0, angle=0.0))
            continue

        nids = elem.nodeIds
        coords = np.array([node_coords[nid] for nid in nids if nid in node_coords])
        if len(coords) < 3:
            element_shears_out.append(ElementShear(elementId=em.elementId, vx=0.0, vy=0.0, v1=0.0, angle=0.0))
            continue

        mx_n = np.array([spr_nodal_moments[nid]['mx'] for nid in nids if nid in spr_nodal_moments])
        my_n = np.array([spr_nodal_moments[nid]['my'] for nid in nids if nid in spr_nodal_moments])
        mxy_n = np.array([spr_nodal_moments[nid]['mxy'] for nid in nids if nid in spr_nodal_moments])

        if len(mx_n) < 3:
            element_shears_out.append(ElementShear(elementId=em.elementId, vx=0.0, vy=0.0, v1=0.0, angle=0.0))
            continue

        nn = len(coords)

        # Shape function derivatives at centroid (xi=0, eta=0)
        if nn == 4:
            # Bilinear quad: Ni = (1+/-xi)(1+/-eta)/4
            dN_dxi = np.array([
                [-0.25,  0.25,  0.25, -0.25],
                [-0.25, -0.25,  0.25,  0.25]
            ])
        elif nn == 3:
            # Linear triangle: L1=1-xi-eta, L2=xi, L3=eta
            dN_dxi = np.array([
                [-1.0, 1.0, 0.0],
                [-1.0, 0.0, 1.0]
            ])
        else:
            element_shears_out.append(ElementShear(elementId=em.elementId, vx=0.0, vy=0.0, v1=0.0, angle=0.0))
            continue

        J = dN_dxi @ coords
        detJ = J[0, 0] * J[1, 1] - J[0, 1] * J[1, 0]
        if abs(detJ) < 1e-15:
            element_shears_out.append(ElementShear(elementId=em.elementId, vx=0.0, vy=0.0, v1=0.0, angle=0.0))
            continue

        invJ = np.linalg.inv(J)
        dN_dxy = invJ @ dN_dxi

        dMx_dx = np.dot(dN_dxy[0], mx_n)
        dMx_dy = np.dot(dN_dxy[1], mx_n)
        dMy_dx = np.dot(dN_dxy[0], my_n)
        dMy_dy = np.dot(dN_dxy[1], my_n)
        dMxy_dx = np.dot(dN_dxy[0], mxy_n)
        dMxy_dy = np.dot(dN_dxy[1], mxy_n)

        vx = dMx_dx + dMxy_dy
        vy = dMxy_dx + dMy_dy

        v1 = np.hypot(vx, vy)
        angle_v = np.degrees(np.arctan2(vy, vx)) if (abs(vx) > 1e-12 or abs(vy) > 1e-12) else 0.0

        element_shears_out.append(ElementShear(
            elementId=em.elementId,
            vx=round(vx, 3), vy=round(vy, 3),
            v1=round(v1, 3), angle=round(angle_v, 2)
        ))

        min_v = min(min_v, vx, vy)
        max_v = max(max_v, vx, vy)

    return element_shears_out, min_v, max_v


def _point_in_polygon_2d(px: float, py: float, verts: List[Point2D]) -> bool:
    """Ray-casting point-in-polygon test for a list of Point2D vertices."""
    inside = False
    j = len(verts) - 1
    for i in range(len(verts)):
        xi, yi = verts[i].x, verts[i].y
        xj, yj = verts[j].x, verts[j].y
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def _point_near_or_in_polygons(px: float, py: float, slab_polygons: Optional[List[List[Point2D]]], tol: float = 0.75) -> bool:
    if not slab_polygons:
        return True
    for poly in slab_polygons:
        if not poly or len(poly) < 3:
            continue
        if _point_in_polygon_2d(px, py, poly):
            return True
        for i in range(len(poly)):
            j = (i + 1) % len(poly)
            ax, ay = poly[i].x, poly[i].y
            bx, by = poly[j].x, poly[j].y
            dx, dy = bx - ax, by - ay
            l2 = dx*dx + dy*dy
            if l2 < 1e-12:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax)*dx + (py - ay)*dy) / l2))
                d = math.hypot(px - (ax + t*dx), py - (ay + t*dy))
            if d <= tol:
                return True
    return False


def _find_column_supports(
    mesh: FEMMesh,
    columns: List[ColumnSupport],
    slab_polygons: Optional[List[List[Point2D]]] = None
) -> Tuple[List[int], List[float], List[float], List[float], List[str], List[float], List[str], List[str]]:
    """
    Finds nearest mesh node for each column and returns 1-to-1 aligned tuple of 8 arrays:
    (col_nids, col_widths, col_depths, col_heights, col_shapes, col_diams, col_grades, col_bcs)
    """
    if not columns or not mesh.nodes:
        return [], [], [], [], [], [], [], []

    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    tree = cKDTree(nodes_xy)

    col_nids: List[int] = []
    col_w: List[float] = []
    col_d: List[float] = []
    col_h: List[float] = []
    col_shapes: List[str] = []
    col_diams: List[float] = []
    col_grades: List[str] = []
    col_bcs: List[str] = []

    used_nids: Set[int] = set()

    for c in columns:
        cx = c.position.x if hasattr(c, 'position') else c.get('position', {}).get('x', 0)
        cy = c.position.y if hasattr(c, 'position') else c.get('position', {}).get('y', 0)

        max_dist = max(1.5, (getattr(c, 'width', 0.3) or 0.3) * 3.0)

        dists, indices = tree.query([cx, cy], k=min(8, len(mesh.nodes)))
        if not isinstance(dists, np.ndarray):
            dists, indices = np.array([dists]), np.array([indices])

        chosen_nid = None
        for d, idx in zip(dists, indices):
            nid = mesh.nodes[idx].id
            if d <= max_dist or _point_near_or_in_polygons(cx, cy, slab_polygons, tol=0.75):
                if nid not in used_nids:
                    chosen_nid = nid
                    break
                elif chosen_nid is None:
                    chosen_nid = nid

        if chosen_nid is not None:
            used_nids.add(chosen_nid)
            col_nids.append(chosen_nid)
            col_w.append(getattr(c, 'width', 0.3) or 0.3)
            col_d.append(getattr(c, 'depth', 0.3) or 0.3)
            col_h.append(getattr(c, 'height', 3.0) or 3.0)
            col_shapes.append(getattr(c, 'shape', None) or 'rectangular')
            diam_val = getattr(c, 'diameter', 500) or 500
            if isinstance(diam_val, (int, float)) and diam_val > 10:
                diam_val /= 1000.0
            col_diams.append(float(diam_val))
            col_grades.append(getattr(c, 'concreteGrade', None) or 'M25')
            col_bcs.append(getattr(c, 'boundaryCondition', None) or getattr(c, 'columnBoundaryCondition', None) or 'fixed-fixed')

    return col_nids, col_w, col_d, col_h, col_shapes, col_diams, col_grades, col_bcs

def _find_wall_node_ids(mesh: FEMMesh, walls: List[WallSupport], mesh_size: float = 0.5) -> List[int]:
    """Vectorized wall node lookup using numpy broadcasting (O(W*N) -> O(W+N) effective)."""
    if not walls or not mesh.nodes:
        return []
    tol = max(0.15, mesh_size * 0.45)
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    node_ids = np.array([n.id for n in mesh.nodes])
    wall_nids_set: Set[int] = set()
    for w in walls:
        ax, ay = w.startPoint.x, w.startPoint.y
        bx, by = w.endPoint.x, w.endPoint.y
        dx, dy = bx - ax, by - ay
        len2 = dx*dx + dy*dy
        if len2 < 1e-12:
            dist = np.hypot(nodes_xy[:, 0] - ax, nodes_xy[:, 1] - ay)
        else:
            t = np.clip(((nodes_xy[:, 0] - ax)*dx + (nodes_xy[:, 1] - ay)*dy) / len2, 0.0, 1.0)
            px = ax + t*dx
            py = ay + t*dy
            dist = np.hypot(nodes_xy[:, 0] - px, nodes_xy[:, 1] - py)
        matching = node_ids[dist <= tol]
        wall_nids_set.update(matching.tolist())
    return list(wall_nids_set)


def _find_beam_node_ids(mesh: FEMMesh, beams: List, mesh_size: float = 0.5) -> Tuple[List[int], List[int], List[float], List[float], List[float]]:
    """Return (beamNodeIdA, beamNodeIdB, beamWidths, beamDepths, beamElasticModuli) aligned per-segment for combined mesh."""
    if not beams or not mesh.nodes:
        return [], [], [], [], []
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    node_ids = np.array([n.id for n in mesh.nodes])
    beam_nA, beam_nB, beam_w, beam_d, beam_E = [], [], [], [], []
    tol = max(0.15, mesh_size * 0.5)

    for b in beams:
        ax = b.startPoint.x if hasattr(b, 'startPoint') else b.get('startPoint', {}).get('x', 0)
        ay = b.startPoint.y if hasattr(b, 'startPoint') else b.get('startPoint', {}).get('y', 0)
        bx = b.endPoint.x if hasattr(b, 'endPoint') else b.get('endPoint', {}).get('x', 0)
        by = b.endPoint.y if hasattr(b, 'endPoint') else b.get('endPoint', {}).get('y', 0)
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        if len2 < 1e-12:
            continue
        L = np.sqrt(len2)

        t_vals = ((nodes_xy[:, 0] - ax) * dx + (nodes_xy[:, 1] - ay) * dy) / len2
        mask = (t_vals >= -0.01) & (t_vals <= 1.01)
        if not np.any(mask):
            continue
        cand_indices = np.where(mask)[0]
        cand_t = t_vals[mask]
        cand_clamp = np.clip(cand_t, 0.0, 1.0)
        px = ax + cand_clamp * dx
        py = ay + cand_clamp * dy
        dists = np.hypot(nodes_xy[cand_indices, 0] - px, nodes_xy[cand_indices, 1] - py)
        matched_mask = dists <= tol
        if not np.any(matched_mask):
            continue

        matched_ids = node_ids[cand_indices[matched_mask]]
        matched_t = cand_clamp[matched_mask]
        sort_order = np.argsort(matched_t)
        sorted_ids = matched_ids[sort_order]
        sorted_t = matched_t[sort_order]

        filtered_ids = []
        filtered_t = []
        for i in range(len(sorted_ids)):
            if not filtered_t or (sorted_t[i] - filtered_t[-1]) * L > 0.05:
                filtered_ids.append(sorted_ids[i])
                filtered_t.append(sorted_t[i])

        bw = getattr(b, 'width', 0.3) or 0.3
        bd = getattr(b, 'depth', 0.45) or 0.45
        bE = getattr(b, 'elasticModulus', 25e9) or 25e9
        if bE < 1e8:
            bE *= 1000.0

        for i in range(len(filtered_ids) - 1):
            beam_nA.append(int(filtered_ids[i]))
            beam_nB.append(int(filtered_ids[i + 1]))
            beam_w.append(float(bw))
            beam_d.append(float(bd))
            beam_E.append(float(bE))

    return beam_nA, beam_nB, beam_w, beam_d, beam_E


def _slabs_touch(vertsA: List[Point2D], vertsB: List[Point2D], tol: float = 0.75) -> bool:
    """
    Returns True if slab A and slab B share any boundary proximity within `tol` metres.
    Uses vertex-to-edge, edge-midpoint-to-edge, and vertex-to-vertex proximity checks,
    so partial shared edges, snapped corner joints, or offset adjacent slabs are 100% detected.
    """
    polyA = [(v.x, v.y) for v in vertsA]
    polyB = [(v.x, v.y) for v in vertsB]
    nA, nB = len(polyA), len(polyB)
    if nA < 3 or nB < 3:
        return False

    # 0. Check bounding box overlap with margin
    aMinX = min(v[0] for v in polyA) - tol; aMaxX = max(v[0] for v in polyA) + tol
    aMinY = min(v[1] for v in polyA) - tol; aMaxY = max(v[1] for v in polyA) + tol
    bMinX = min(v[0] for v in polyB); bMaxX = max(v[0] for v in polyB)
    bMinY = min(v[1] for v in polyB); bMaxY = max(v[1] for v in polyB)
    if aMaxX < bMinX or aMinX > bMaxX or aMaxY < bMinY or aMinY > bMaxY:
        return False

    # 1. Check vertex-to-vertex direct proximity
    for (xa, ya) in polyA:
        for (xb, yb) in polyB:
            if math.hypot(xa - xb, ya - yb) <= tol:
                return True

    def _pt_to_seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
        dx, dy = bx - ax, by - ay
        len2 = dx*dx + dy*dy
        if len2 < 1e-14:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax)*dx + (py - ay)*dy) / len2))
        return math.hypot(px - (ax + t*dx), py - (ay + t*dy))

    # 2. Check every vertex of A against every edge of B
    for (xa, ya) in polyA:
        for j in range(nB):
            bx1, by1 = polyB[j]
            bx2, by2 = polyB[(j + 1) % nB]
            if _pt_to_seg_dist(xa, ya, bx1, by1, bx2, by2) <= tol:
                return True

    # 3. Check every vertex of B against every edge of A
    for (xb, yb) in polyB:
        for i in range(nA):
            ax1, ay1 = polyA[i]
            ax2, ay2 = polyA[(i + 1) % nA]
            if _pt_to_seg_dist(xb, yb, ax1, ay1, ax2, ay2) <= tol:
                return True

    # 4. Check every edge midpoint of A against every edge of B
    for i in range(nA):
        ax1, ay1 = polyA[i]
        ax2, ay2 = polyA[(i + 1) % nA]
        midx, midy = (ax1 + ax2) * 0.5, (ay1 + ay2) * 0.5
        for j in range(nB):
            bx1, by1 = polyB[j]
            bx2, by2 = polyB[(j + 1) % nB]
            if _pt_to_seg_dist(midx, midy, bx1, by1, bx2, by2) <= tol:
                return True

    return False


# ────────────────────────────────────────────────────────────────────────────
# ETABS-style automatic edge (line) constraints for non-conformal multi-slab
# joints. Meshes of touching slabs are generated independently, so boundary
# nodes along a shared edge rarely coincide one-to-one (gmsh Delaunay) or align
# only partially (structured grids, T-junctions). For every unshared boundary
# node of slab A lying on slab B's boundary segment, the node is tied by linear
# interpolation of the two bracketing B-side boundary nodes:
#     u_slave = (1−t)·u_B1 + t·u_B2
# Continuous joints tie UZ(W), RX, RY (plate DOFs); discontinuous (hinged)
# joints tie translations only. Master side = the denser boundary (one
# direction per interface) to avoid circular slave↔master webs.
# ────────────────────────────────────────────────────────────────────────────

def _seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    if len2 < 1e-14:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _find_collinear_overlap(vertsB: List[Point2D], a1: Point2D, a2: Point2D, tol: float):
    """Overlap of segment (a1,a2) with any collinear edge of polygon B. Returns (p, q) or None."""
    polyB = [(v.x, v.y) for v in vertsB]
    nB = len(polyB)
    dx, dy = a2.x - a1.x, a2.y - a1.y
    for j in range(nB):
        p1 = polyB[j]
        p2 = polyB[(j + 1) % nB]
        e_dx, e_dy = p2[0] - p1[0], p2[1] - p1[1]
        e_len2 = e_dx * e_dx + e_dy * e_dy
        if e_len2 < 1e-12:
            continue
        if abs(dx * e_dy - dy * e_dx) > tol:
            continue
        # Perpendicular distance to the infinite line (allows partial/T-junction overlaps)
        line_len = math.sqrt(e_len2)
        if abs((a1.x - p1[0]) * e_dy - (a1.y - p1[1]) * e_dx) / line_len > tol:
            continue
        if abs((a2.x - p1[0]) * e_dy - (a2.y - p1[1]) * e_dx) / line_len > tol:
            continue
        t_a = ((a1.x - p1[0]) * e_dx + (a1.y - p1[1]) * e_dy) / e_len2
        t_b = ((a2.x - p1[0]) * e_dx + (a2.y - p1[1]) * e_dy) / e_len2
        t_min = max(0.0, min(t_a, t_b))
        t_max = min(1.0, max(t_a, t_b))
        if t_max - t_min > 1e-6:
            return (
                (p1[0] + t_min * e_dx, p1[1] + t_min * e_dy),
                (p1[0] + t_max * e_dx, p1[1] + t_max * e_dy),
            )
    return None


def _detect_interface_constraints(
    sub_meshes: List[Tuple[Any, FEMMesh]],
    node_orig_map: List[Tuple[int, int, float, float]],
    global_id_map: Dict[Tuple[int, int], int],
    global_nodes: List[FEMNode],
    merge_tol: float,
    mesh_size: float,
    pre_paired: Optional[Set[int]] = None,
    pre_paired_slave: Optional[Set[int]] = None,
) -> Tuple[List[MpcConstraint], List[EqualDofConstraint], int]:
    """Build weighted MPCs + hinge equal-DOF couples for non-conformal slab interfaces.

    Returns (mpc_constraints, hinge_equal_dofs, n_tied_slave_nodes).
    Node ids refer to the 1-indexed global combined mesh ids.
    `pre_paired`: global node ids on either side of hinge equal-DOF pairs — they must
    never become MPC slaves (a DOF can be a slave only once).
    `pre_paired_slave`: the SLAVE-side ids of those pairs — they must never become MPC
    masters either (Kratos cannot chain a slave as master; the term is silently dropped,
    breaking the interpolation). Master brackets expand to the next eligible nodes.
    """
    if pre_paired is None:
        pre_paired = set()
    if pre_paired_slave is None:
        pre_paired_slave = set()
    mpcs: List[MpcConstraint] = []
    eq_dofs: List[EqualDofConstraint] = []
    pos_by_gid = {n.id: (n.x, n.y) for n in global_nodes}

    # owners[gid] = set of submesh indices touching this global node
    owners: Dict[int, Set[int]] = {}
    local_of: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for (item_idx, old_nid, x, y) in node_orig_map:
        gid = global_id_map.get((item_idx, old_nid))
        if gid is None:
            continue
        owners.setdefault(gid, set()).add(item_idx)

    def is_discont(item_idx: int, x: float, y: float, tol: float) -> bool:
        item = sub_meshes[item_idx][0]
        for seg in (getattr(item, 'discontinuousEdges', None) or []):
            if _seg_dist(x, y, seg.startPoint.x, seg.startPoint.y, seg.endPoint.x, seg.endPoint.y) < tol:
                return True
        return False

    edge_tol = max(merge_tol, mesh_size * 0.45)
    tied_slaves: Set[int] = set()

    n_items = len(sub_meshes)
    for ia in range(n_items):
        itemA, meshA = sub_meshes[ia]
        vertsA = itemA.geometry.vertices
        for ib in range(ia + 1, n_items):
            itemB, meshB = sub_meshes[ib]
            if not _slabs_touch(vertsA, itemB.geometry.vertices, tol=max(0.75, mesh_size * 1.5)):
                continue
            b_gids = {g for g, s in owners.items() if ib in s}
            a_gids = {g for g, s in owners.items() if ia in s}

            # 1. Interface overlaps between the two polygons (each shared segment once,
            #    deduplicated — a shared segment appears as an edge of BOTH polygons).
            overlaps: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []
            seen_seg_keys: Set[Tuple] = set()
            for sverts, dverts in ((vertsA, itemB.geometry.vertices), (itemB.geometry.vertices, vertsA)):
                for ei in range(len(sverts)):
                    a1 = sverts[ei]
                    a2 = sverts[(ei + 1) % len(sverts)]
                    ov = _find_collinear_overlap(dverts, a1, a2, edge_tol)
                    if not ov:
                        continue
                    (px, py), (qx, qy) = ov
                    e1 = (round(px, 3), round(py, 3))
                    e2 = (round(qx, 3), round(qy, 3))
                    key = (min(e1, e2), max(e1, e2))
                    if key in seen_seg_keys:
                        continue
                    seen_seg_keys.add(key)
                    overlaps.append(ov)
            if not overlaps:
                continue

            # 2. Per-segment node sets for both sides
            segs = []
            a_total_cnt = 0
            b_total_cnt = 0
            a_free_cnt = 0
            b_free_cnt = 0
            for (px, py), (qx, qy) in overlaps:
                sdx, sdy = qx - px, qy - py
                slen2 = sdx * sdx + sdy * sdy
                if slen2 < 1e-12:
                    continue

                def _mk(sdx=sdx, sdy=sdy, slen2=slen2, px=px, py=py, qx=qx, qy=qy):
                    def param(x, y):
                        return ((x - px) * sdx + (y - py) * sdy) / slen2
                    def on_seg(x, y):
                        s = param(x, y)
                        if s < -0.05 or s > 1.05:
                            return False
                        return _seg_dist(x, y, px, py, qx, qy) < edge_tol
                    return param, on_seg
                param, on_seg = _mk()

                a_on = sorted(
                    ((param(*pos_by_gid[g]), g) for g in a_gids
                     if g in pos_by_gid and g not in pre_paired_slave and on_seg(*pos_by_gid[g])),
                    key=lambda t: t[0])
                b_on = sorted(
                    ((param(*pos_by_gid[g]), g) for g in b_gids
                     if g in pos_by_gid and g not in pre_paired_slave and on_seg(*pos_by_gid[g])),
                    key=lambda t: t[0])
                # Slave candidates: unshared (not merged), not yet tied, and not already
                # translation-tied by an equal-DOF hinge pair (no double slave constraints)
                a_free = [(s, g) for s, g in a_on
                          if g not in b_gids and g not in tied_slaves and g not in pre_paired]
                b_free = [(s, g) for s, g in b_on
                          if g not in a_gids and g not in tied_slaves and g not in pre_paired]
                segs.append((param, on_seg, a_on, b_on, a_free, b_free, px, py, qx, qy))
                a_total_cnt += len(a_on)
                b_total_cnt += len(b_on)
                a_free_cnt += len(a_free)
                b_free_cnt += len(b_free)
            if not segs:
                continue

            # 3. ONE direction per interface pair (bipartite tying — slaves on one side,
            #    masters on the other — so no circular slave<->master constraint webs and
            #    no DOF is ever a slave twice). The side with FEWER interface nodes slaves
            #    to the denser side; equal counts break deterministically (lower index).
            a_slaves_to_b = a_total_cnt <= b_total_cnt

            for (param, on_seg, a_on, b_on, a_free, b_free, px, py, qx, qy) in segs:
                master_cand = b_on if a_slaves_to_b else a_on
                slave_pool = a_free if a_slaves_to_b else b_free
                if len(master_cand) < 2 or not slave_pool:
                    continue
                ia_slave = ia if a_slaves_to_b else ib
                ib_master = ib if a_slaves_to_b else ia

                for sA, g in slave_pool:
                    x, y = pos_by_gid[g]
                    lo = None
                    hi = None
                    for k, (s, bg) in enumerate(master_cand):
                        if s <= sA + 1e-9:
                            lo = k
                        if hi is None and s >= sA - 1e-9:
                            hi = k
                    if lo is None or hi is None:
                        lo = 0 if sA < master_cand[0][0] else len(master_cand) - 2
                        hi = lo + 1
                    if lo == hi:
                        lo = max(0, lo - 1)
                        hi = lo + 1
                    if lo < 0 or hi >= len(master_cand) or master_cand[lo][1] == master_cand[hi][1]:
                        continue
                    s1, g1 = master_cand[lo]
                    s2, g2 = master_cand[hi]
                    if s2 - s1 < 1e-9:
                        continue
                    t = max(0.0, min(1.0, (sA - s1) / (s2 - s1)))

                    # Skip near-coincident pairs (handled by merging / near-pair couples)
                    if (math.hypot(x - pos_by_gid[g1][0], y - pos_by_gid[g1][1]) < merge_tol or
                            math.hypot(x - pos_by_gid[g2][0], y - pos_by_gid[g2][1]) < merge_tol):
                        continue

                    hinge = (is_discont(ia_slave, x, y, edge_tol) or
                             is_discont(ib_master, x, y, edge_tol))
                    dofs = [3] if hinge else [3, 4, 5]  # W | W,RX,RY
                    for d in dofs:
                        mpcs.append(MpcConstraint(
                            slaveNodeId=g,
                            slaveDof=d,
                            masters=[MpcTerm(nodeId=g1, weight=1.0 - t), MpcTerm(nodeId=g2, weight=t)],
                        ))
                    tied_slaves.add(g)

    return mpcs, eq_dofs, len(tied_slaves)


def solve_multi_slab_structure(request: MultiSlabAnalysisRequest) -> MultiSlabAnalysisResponse:
    """
    Dual-scenario multi-slab solver:
    - Scenario 1 (Unconnected Slabs): Solved as independent FEA entities.
    - Scenario 2 (Connected / Large Slabs): Assembled into ONE coupled global matrix equation [K]{u}={F} with C0/C1 boundary node merging.
    """
    if not request.slabs:
        return MultiSlabAnalysisResponse(success=True, results=[])

    n_slabs = len(request.slabs)
    print(f"[Reslo] solve_multi_slab: {n_slabs} slabs, {len(request.columns)} columns, {len(request.walls)} walls", file=sys.stderr, flush=True)

    # Import Python solver for accurate wall spring deflection
    try:
        from solver import analyze_slab as _py_analyze_slab
    except ImportError:
        _py_analyze_slab = None
        print("[Reslo] WARNING: Python solver not available for wall spring correction", file=sys.stderr, flush=True)
    uf = UnionFind(set(range(n_slabs)))

    for i in range(n_slabs):
        for j in range(i + 1, n_slabs):
            if _slabs_touch(request.slabs[i].geometry.vertices, request.slabs[j].geometry.vertices, tol=0.75):
                uf.union(i, j)

    # Group slabs by connected component
    components = {}
    for i in range(n_slabs):
        root = uf.find(i)
        components.setdefault(root, []).append(request.slabs[i])

    results = []
    warnings = []
    disconnected_ids = []

    for root, group in components.items():
        if len(group) == 1:
            # Scenario 1: Isolated Independent Entity
            item = group[0]
            try:
                # Try the requested mesh size; if 0 elements, retry with progressively smaller sizes
                mesh_sizes_to_try = [item.meshSize or request.meshSize, 0.3, 0.2, 0.15]
                mesh = None
                for ms in mesh_sizes_to_try:
                    mesh_req = MeshRequest(geometry=item.geometry, meshSize=ms)
                    mesh = generate_mesh(mesh_req)
                    print(f"[Reslo]   Slab '{item.slabId}': meshSize={ms}m -> {mesh.nodeCount} nodes, {mesh.elementCount} elements", file=sys.stderr, flush=True)
                    if mesh.elementCount > 0:
                        break

                if mesh is None or mesh.elementCount == 0:
                    warnings.append(f"Slab '{item.slabId}' could not be meshed (0 elements at any mesh size). Check the slab geometry.")
                    continue

                col_nids, col_w, col_d, col_heights, col_sh, col_di, col_gr, col_bc = _find_column_supports(mesh, request.columns, [item.geometry.vertices])
                wall_nids = _find_wall_node_ids(mesh, request.walls, mesh_size=item.meshSize or request.meshSize)
                print(f"[Reslo]   Slab '{item.slabId}': {len(col_nids)} columns, {len(wall_nids)} walls found on mesh", file=sys.stderr, flush=True)

                wall_spts = [getattr(w, 'startPoint') for w in request.walls]
                wall_epts = [getattr(w, 'endPoint') for w in request.walls]
                wall_thk = [getattr(w, 'thickness', 0.25) for w in request.walls]
                wall_hgt = [getattr(w, 'height', 3.0) for w in request.walls]
                wall_bcs = [getattr(w, 'boundaryCondition', 'fixed-free') for w in request.walls]
                wall_elastic = [getattr(w, 'elasticModulus', 25e9) for w in request.walls]

                single_req = AnalysisRequest(
                    mesh=mesh,
                    thickness=item.thickness,
                    elasticModulus=item.elasticModulus,
                    poissonRatio=item.poissonRatio,
                    uniformLoad=item.uniformLoad,
                    selfWeight=item.selfWeight,
                    columnNodeIds=col_nids,
                    columnHeights=col_heights,
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
                    beamNodeIdA=getattr(request, 'beamNodeIdA', None) or [],
                    beamNodeIdB=getattr(request, 'beamNodeIdB', None) or [],
                    beamWidths=getattr(request, 'beamWidths', None) or [],
                    beamDepths=getattr(request, 'beamDepths', None) or [],
                    beamElasticModuli=getattr(request, 'beamElasticModuli', None) or [],
                    dropPanels=request.dropPanels,
                    nonStructuralWalls=request.nonStructuralWalls,
                    partitionWallSegments=request.partitionWallSegments,
                    equalDofConstraints=getattr(request, 'equalDofConstraints', None) or [],
                    mpcConstraints=getattr(request, 'mpcConstraints', None) or [],
                    performCrackedAnalysis=getattr(request, 'performCrackedAnalysis', False),
                    adaptiveMeshRefinement=getattr(request, 'adaptiveMeshRefinement', False),
                    maxAdaptivePasses=getattr(request, 'maxAdaptivePasses', 3)
                )
                single_res = None
                if _py_analyze_slab:
                    try:
                        single_res = _py_analyze_slab(single_req)
                    except Exception as py_e:
                        print(f"[Reslo]   Python solver failed for '{item.slabId}': {py_e}, falling back to Kratos", file=sys.stderr, flush=True)
                if single_res is None or not single_res.success:
                    single_res = solve_reslo_structure(single_req)
                if single_res.success:
                    results.append(SlabAnalysisResult(slabId=item.slabId, mesh=mesh, result=single_res))
                else:
                    col_detail = f" ({len(col_nids)} columns, {len(wall_nids)} walls found on mesh)"
                    warnings.append(f"Analysis failed for slab {item.slabId}: {single_res.error}{col_detail}")
            except Exception as e:
                warnings.append(f"Error solving independent slab {item.slabId}: {str(e)}")
        else:
            # Scenario 2: Connected Slabs â€” Unified Whole System Assembly
            try:
                sub_meshes = []
                for item in group:
                    m_req = MeshRequest(geometry=item.geometry, meshSize=item.meshSize or request.meshSize)
                    sm = generate_mesh(m_req)
                    if sm is None or sm.elementCount == 0:
                        for ms in [0.3, 0.2, 0.15]:
                            m_req2 = MeshRequest(geometry=item.geometry, meshSize=ms)
                            sm = generate_mesh(m_req2)
                            if sm and sm.elementCount > 0:
                                break
                    if sm and sm.elementCount > 0:
                        sub_meshes.append((item, sm))

                # 1. Collect all raw mesh nodes from every sub-mesh
                node_orig_map = []  # list of (item_idx, old_nid, x, y)
                all_raw_nodes = []
                for item_idx, (item, sm) in enumerate(sub_meshes):
                    for n in sm.nodes:
                        node_orig_map.append((item_idx, n.id, n.x, n.y))
                        all_raw_nodes.append([n.x, n.y])

                raw_coords = np.array(all_raw_nodes)
                merge_tree = cKDTree(raw_coords)

                # 2. Merge coincident nodes within 0.05m spatial tolerance (C0 continuity)
                global_nodes = []
                global_id_map: Dict[Tuple[int, int], int] = {}  # (item_idx, old_nid) -> global_nid
                visited: Set[int] = set()
                next_global_nid = 1

                # 2. Merge coincident boundary nodes across DIFFERENT sub-meshes within spatial tolerance (C0 continuity)
                merge_tol = max(0.15, (request.meshSize or 0.5) * 0.35)
                global_nodes = []
                global_id_map: Dict[Tuple[int, int], int] = {}  # (item_idx, old_nid) -> global_nid
                visited: Set[int] = set()
                next_global_nid = 1

                # Discontinuous (hinged) interface nodes must stay unmerged (rotations
                # independent); their translations are coupled after merging so the joint
                # acts as a hinge instead of full C0+C1 continuity.
                discont_node_keys: Set[Tuple[int, int]] = set()
                for _di, (_item, _sm) in enumerate(sub_meshes):
                    for seg in (getattr(_item, 'discontinuousEdges', None) or []):
                        for _n in _sm.nodes:
                            if _seg_dist(_n.x, _n.y, seg.startPoint.x, seg.startPoint.y, seg.endPoint.x, seg.endPoint.y) < merge_tol:
                                discont_node_keys.add((_di, _n.id))

                for i, (item_idx, old_nid, x, y) in enumerate(node_orig_map):
                    if i in visited:
                        continue
                    cand_neighbors = merge_tree.query_ball_point([x, y], r=merge_tol)
                    # Filter: keep current node + any node belonging to a DIFFERENT sub-mesh.
                    # Hinged (discontinuous) nodes are never MERGED with other nodes, but the
                    # seed node itself must always stay in its own (singleton) cluster —
                    # otherwise its cluster is empty and the global node becomes NaN.
                    i_discont = (item_idx, old_nid) in discont_node_keys
                    valid_neighbors = []
                    for idx in cand_neighbors:
                        if idx == i:
                            valid_neighbors.append(idx)
                            continue
                        it2, o2, _, _ = node_orig_map[idx]
                        if it2 == item_idx:
                            continue  # never merge within the same sub-mesh
                        if i_discont or (it2, o2) in discont_node_keys:
                            continue  # hinged nodes keep independent rotations
                        valid_neighbors.append(idx)
                    cluster_pts = raw_coords[valid_neighbors]
                    avg_x = float(np.mean(cluster_pts[:, 0]))
                    avg_y = float(np.mean(cluster_pts[:, 1]))
                    global_nodes.append(FEMNode(id=next_global_nid, x=avg_x, y=avg_y))
                    for idx in valid_neighbors:
                        visited.add(idx)
                        it_idx, o_nid, _, _ = node_orig_map[idx]
                        global_id_map[(it_idx, o_nid)] = next_global_nid
                    next_global_nid += 1

                # 2b. Hinge (discontinuous-edge) translation couples + ETABS-style
                # non-conformal edge constraints across independent sub-meshes
                hinge_eq: List[EqualDofConstraint] = []
                if discont_node_keys:
                    seen_pairs: Set[Tuple[int, int]] = set()
                    gid_info = []  # (gid, x, y, item_idx)
                    for (item_idx, old_nid, x, y) in node_orig_map:
                        gid = global_id_map.get((item_idx, old_nid))
                        if gid is not None:
                            gid_info.append((gid, x, y, item_idx))
                    for (item_idx, old_nid) in discont_node_keys:
                        gidA = global_id_map.get((item_idx, old_nid))
                        if gidA is None:
                            continue
                        ax, ay = next((x, y) for (g, x, y, it) in gid_info if g == gidA and it == item_idx)
                        best_g, best_d = None, merge_tol
                        for (g, x, y, it) in gid_info:
                            if it == item_idx or g == gidA:
                                continue
                            d = math.hypot(ax - x, ay - y)
                            if d < best_d:
                                best_d, best_g = d, g
                        if best_g is not None:
                            pair = (min(gidA, best_g), max(gidA, best_g))
                            if pair not in seen_pairs:
                                seen_pairs.add(pair)
                                hinge_eq.append(EqualDofConstraint(nodeIdA=pair[0], nodeIdB=pair[1], dofs=[1, 2, 3]))

                hinge_paired_gids: Set[int] = set()
                hinge_slave_gids: Set[int] = set()
                for c in hinge_eq:
                    hinge_paired_gids.add(int(c.nodeIdA))
                    hinge_paired_gids.add(int(c.nodeIdB))
                    hinge_slave_gids.add(int(c.nodeIdB))
                interface_mpc, _, n_tied = _detect_interface_constraints(
                    sub_meshes, node_orig_map, global_id_map, global_nodes,
                    merge_tol, request.meshSize or 0.5,
                    pre_paired=hinge_paired_gids,
                    pre_paired_slave=hinge_slave_gids
                )
                if n_tied > 0:
                    print(f"[Reslo]   Edge constraints: {n_tied} interface nodes tied ({len(interface_mpc)} MPCs)", file=sys.stderr, flush=True)

                # 3. Build global elements + origin tracking dict for O(1) partition lookup
                global_elements = []
                element_loads = []
                element_elastic_moduli = []
                # global_elem_origin[(item_idx, local_elem_id)] -> global_elem_id
                global_elem_origin: Dict[Tuple[int, int], int] = {}
                next_elem_id = 1
                for item_idx, (item, sm) in enumerate(sub_meshes):
                    q_item = (getattr(item, 'uniformLoad', 5.0) or 5.0) + (getattr(item, 'selfWeight', 0.0) or 0.0)
                    E_item = getattr(item, 'elasticModulus', 25e9) or 25e9
                    for elem in sm.elements:
                        raw_node_ids = [
                            global_id_map[(item_idx, old_nid)]
                            for old_nid in elem.nodeIds
                            if (item_idx, old_nid) in global_id_map
                        ]
                        unique_node_ids = list(dict.fromkeys(raw_node_ids))
                        if len(unique_node_ids) >= 3:
                            global_elements.append(Triangle(id=next_elem_id, nodeIds=unique_node_ids[:3]))
                            element_loads.append(q_item)
                            element_elastic_moduli.append(E_item)
                            global_elem_origin[(item_idx, elem.id)] = next_elem_id
                            next_elem_id += 1

                combined_mesh = FEMMesh(
                    nodes=global_nodes,
                    elements=global_elements,
                    nodeCount=len(global_nodes),
                    elementCount=len(global_elements)
                )

                # 4. Map structural supports (columns/walls) onto combined mesh
                slab_polys = [item.geometry.vertices for item in group]

                col_nids, col_w, col_d, col_heights, col_sh2, col_di2, col_gr2, col_bc2 = _find_column_supports(combined_mesh, request.columns, slab_polys)

                primary_item = group[0]
                wall_nids = _find_wall_node_ids(combined_mesh, request.walls, mesh_size=primary_item.meshSize or request.meshSize)
                b_nA, b_nB, b_w, b_d, b_E = _find_beam_node_ids(combined_mesh, request.beams, mesh_size=primary_item.meshSize or request.meshSize)

                wall_spts2 = [getattr(w, 'startPoint') for w in request.walls]
                wall_epts2 = [getattr(w, 'endPoint') for w in request.walls]
                wall_thk2 = [getattr(w, 'thickness', 0.25) for w in request.walls]
                wall_hgt2 = [getattr(w, 'height', 3.0) for w in request.walls]
                wall_bcs2 = [getattr(w, 'boundaryCondition', 'fixed-free') for w in request.walls]
                wall_elastic2 = [getattr(w, 'elasticModulus', 25e9) for w in request.walls]

                combined_req = AnalysisRequest(
                    mesh=combined_mesh,
                    thickness=primary_item.thickness,
                    elasticModulus=primary_item.elasticModulus,
                    poissonRatio=primary_item.poissonRatio,
                    uniformLoad=primary_item.uniformLoad,
                    selfWeight=primary_item.selfWeight,
                    elementLoads=element_loads,
                    elementElasticModuli=element_elastic_moduli,
                    columnNodeIds=col_nids,
                    columnHeights=col_heights,
                    columnWidths=col_w,
                    columnDepths=col_d,
                    columnShapes=col_sh2,
                    columnDiameters=col_di2,
                    columnGrades=col_gr2,
                    columnBoundaryConditions=col_bc2,
                    wallNodeIds=wall_nids,
                    wallStartPoints=wall_spts2,
                    wallEndPoints=wall_epts2,
                    wallThicknesses=wall_thk2,
                    wallHeights=wall_hgt2,
                    wallBoundaryConditions=wall_bcs2,
                    wallElasticModuli=wall_elastic2,
                    beams=request.beams,
                    beamNodeIdA=b_nA,
                    beamNodeIdB=b_nB,
                    beamWidths=b_w,
                    beamDepths=b_d,
                    beamElasticModuli=b_E,
                    dropPanels=request.dropPanels,
                    nonStructuralWalls=request.nonStructuralWalls,
                    partitionWallSegments=request.partitionWallSegments,
                    equalDofConstraints=(getattr(request, 'equalDofConstraints', None) or []) + hinge_eq,
                    mpcConstraints=(getattr(request, 'mpcConstraints', None) or []) + interface_mpc,
                    performCrackedAnalysis=getattr(request, 'performCrackedAnalysis', False),
                    adaptiveMeshRefinement=getattr(request, 'adaptiveMeshRefinement', False),
                    maxAdaptivePasses=getattr(request, 'maxAdaptivePasses', 3)
                )

                unified_res = solve_reslo_structure(combined_req)
                if unified_res.success:
                    # 5. Partition unified results back to each sub-slab using local node IDs for 1-to-1 canvas mapping
                    global_defl_map = {d.nodeId: d for d in unified_res.nodeDeflections}
                    for item_idx, (item, sm) in enumerate(sub_meshes):
                        part_deflections = []
                        for n in sm.nodes:
                            if (item_idx, n.id) in global_id_map:
                                g_nid = global_id_map[(item_idx, n.id)]
                                if g_nid in global_defl_map:
                                    gd = global_defl_map[g_nid]
                                    part_deflections.append(NodeDeflection(
                                        nodeId=n.id,
                                        u=gd.u, v=gd.v, wz=gd.wz,
                                        rx=gd.rx, ry=gd.ry, rz=gd.rz
                                    ))

                        sub_res = AnalysisResponse(
                            success=True,
                            nodeDeflections=part_deflections,
                            # Use global min/max from unified solve so contour scale is consistent across connected slabs
                            minWz=unified_res.minWz, maxWz=unified_res.maxWz,
                            solverTime=unified_res.solverTime,
                            crX=unified_res.crX, crY=unified_res.crY,
                        )
                        results.append(SlabAnalysisResult(slabId=item.slabId, mesh=sm, result=sub_res))
                else:
                    warnings.append(f"Unified analysis failed for connected group: {unified_res.error}")
            except Exception as e:
                import traceback
                warnings.append(f"Error in unified multi-slab assembly: {str(e)}\n{traceback.format_exc()}")

    return MultiSlabAnalysisResponse(
        success=len(results) > 0,
        results=results,
        warnings=warnings,
        disconnectedIds=disconnected_ids
    )



