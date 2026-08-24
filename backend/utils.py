"""
Shared utility functions for the Reslo FEM backend.

Extracted from kratos_solver.py — zero KratosMultiphysics dependency.
Pure Python geometry helpers, structural calculations, and mesh utilities.
"""

import numpy as np
import math
from typing import List, Tuple, Dict, Set, Optional
from scipy.spatial import cKDTree

from models import (
    AnalysisRequest, AnalysisResponse, Point2D, FEMNode, FEMMesh, Triangle,
    ColumnSupport, WallSupport
)


def _rect_torsion_constant(b: float, d: float) -> float:
    """Saint-Venant torsional constant (J) for a rectangular section.
    b = width, d = depth.
    """
    w = min(b, d)
    h = max(b, d)
    if w < 1e-12 or h < 1e-12:
        return 0.0
    r = w / h
    return h * w ** 3 * (1.0 / 3.0 - 0.21 * r * (1.0 - r ** 4 / 12.0))


def _point_in_polygon_py(x: float, y: float, poly: List[Tuple[float, float]]) -> bool:
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
    """Check if a point is within tolerance of any slab polygon."""
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
            l2 = dx * dx + dy * dy
            if l2 < 1e-12:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d <= tol:
                return True
    return False


def find_nodes_near_segment(
    nodes_xy: np.ndarray,
    start_pt: Tuple[float, float],
    end_pt: Tuple[float, float],
    tol: float = 0.05
) -> List[int]:
    """Find 1-indexed mesh node IDs located near a 2D line segment."""
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
    dist2 = (nx - px) ** 2 + (ny - py) ** 2
    matching_mask = dist2 < tol * tol
    return (indices[matching_mask] + 1).tolist()


def find_nodes_near_segment_with_t(
    nodes_xy: np.ndarray,
    start_pt: Tuple[float, float],
    end_pt: Tuple[float, float],
    tol: float = 0.01
) -> List[Tuple[float, int]]:
    """Find 1-indexed mesh node IDs near a line segment,
    returning (t_parameter, node_id) sorted along segment."""
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


def find_nodes_near_partition_segment(
    nodes_xy: np.ndarray,
    start_pt: Tuple[float, float],
    end_pt: Tuple[float, float],
    tolerance: float = 0.35
) -> List[Tuple[float, int]]:
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


class UnionFind:
    """Disjoint Set Union (Union-Find) for graph connectivity auditing."""

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


def _slabs_touch(vertsA: List[Point2D], vertsB: List[Point2D], tol: float = 0.75) -> bool:
    """
    Returns True if slab A and slab B share any boundary proximity within `tol` metres.
    Uses vertex-to-edge, edge-midpoint-to-edge, and vertex-to-vertex proximity checks.
    """
    polyA = [(v.x, v.y) for v in vertsA]
    polyB = [(v.x, v.y) for v in vertsB]
    nA, nB = len(polyA), len(polyB)
    if nA < 3 or nB < 3:
        return False

    # Bounding box check
    aMinX = min(v[0] for v in polyA) - tol
    aMaxX = max(v[0] for v in polyA) + tol
    aMinY = min(v[1] for v in polyA) - tol
    aMaxY = max(v[1] for v in polyA) + tol
    bMinX = min(v[0] for v in polyB)
    bMaxX = max(v[0] for v in polyB)
    bMinY = min(v[1] for v in polyB)
    bMaxY = max(v[1] for v in polyB)
    if aMaxX < bMinX or aMinX > bMaxX or aMaxY < bMinY or aMinY > bMaxY:
        return False

    def _pt_to_seg_dist(px, py, ax, ay, bx, by):
        dx = bx - ax
        dy = by - ay
        len2 = dx * dx + dy * dy
        if len2 < 1e-14:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    # Vertex-to-vertex
    for (xa, ya) in polyA:
        for (xb, yb) in polyB:
            if math.hypot(xa - xb, ya - yb) <= tol:
                return True

    # Vertex A → edge B
    for (xa, ya) in polyA:
        for j in range(nB):
            bx1, by1 = polyB[j]
            bx2, by2 = polyB[(j + 1) % nB]
            if _pt_to_seg_dist(xa, ya, bx1, by1, bx2, by2) <= tol:
                return True

    # Vertex B → edge A
    for (xb, yb) in polyB:
        for i in range(nA):
            ax1, ay1 = polyA[i]
            ax2, ay2 = polyA[(i + 1) % nA]
            if _pt_to_seg_dist(xb, yb, ax1, ay1, ax2, ay2) <= tol:
                return True

    # Edge midpoint A → edge B
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


def _calculate_cr_analytical(request: AnalysisRequest) -> Tuple[float, float]:
    """Calculate Center of Rigidity using pure analytical stiffness formulation."""
    if not request.mesh or not request.mesh.nodes:
        return 0.0, 0.0
    nodes_map = {n.id: n for n in request.mesh.nodes}

    # 1. Center of Mass (CM)
    W_slab = 0.0
    slab_cx_sum = 0.0
    slab_cy_sum = 0.0

    concrete_density = 25000.0  # N/m³
    t_slab = request.thickness

    for tri in request.mesh.elements:
        if len(tri.nodeIds) < 3 or tri.nodeIds[0] not in nodes_map or \
           tri.nodeIds[1] not in nodes_map or tri.nodeIds[2] not in nodes_map:
            continue
        n1 = nodes_map[tri.nodeIds[0]]
        n2 = nodes_map[tri.nodeIds[1]]
        n3 = nodes_map[tri.nodeIds[2]]

        area = 0.5 * abs(
            n1.x * (n2.y - n3.y) + n2.x * (n3.y - n1.y) + n3.x * (n1.y - n2.y)
        )
        xc = (n1.x + n2.x + n3.x) / 3.0
        yc = (n1.y + n2.y + n3.y) / 3.0

        h_eff = t_slab
        if request.dropPanels:
            for dp in request.dropPanels:
                poly = [(v.x, v.y) for v in dp.vertices]
                if len(poly) >= 3 and _point_in_polygon_py(xc, yc, poly):
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

    # Column weights
    for i, col_nid in enumerate(request.columnNodeIds):
        node = nodes_map.get(col_nid)
        if not node:
            continue
        H = request.columnHeights[i] if (request.columnHeights and i < len(request.columnHeights)) else 3.0
        w = request.columnWidths[i] if (request.columnWidths and i < len(request.columnWidths)) else 0.3
        d = request.columnDepths[i] if (request.columnDepths and i < len(request.columnDepths)) else 0.3
        shape = request.columnShapes[i] if (request.columnShapes and i < len(request.columnShapes)) else "rectangular"
        diameter = request.columnDiameters[i] if (request.columnDiameters and i < len(request.columnDiameters)) else 0.5

        col_area = (np.pi * diameter ** 2 / 4.0) if shape == "circular" else (w * d)
        weight_col = concrete_density * col_area * H

        W_total += weight_col
        CM_num_x += weight_col * node.x
        CM_num_y += weight_col * node.y

    # Wall weights
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

    # 2. Accumulate stiffness about CM
    Kxx = Kyy = Kxy = KxTheta = KyTheta = 0.0
    nu = request.poissonRatio
    E = request.elasticModulus

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
            Iy = Ix = np.pi * D ** 4 / 64.0
        else:
            Iy = d * w ** 3 / 12.0
            Ix = w * d ** 3 / 12.0

        bc = request.columnBoundaryConditions[i] if (
            request.columnBoundaryConditions and i < len(request.columnBoundaryConditions)
        ) else "fixed-fixed"
        col_fixity = 3.0 if bc == "fixed-free" else 12.0
        kx = col_fixity * E * Iy / H ** 3
        ky = col_fixity * E * Ix / H ** 3

        Kxx += kx
        Kyy += ky

        xRel = cx - cm_x
        yRel = cy - cm_y
        KxTheta += kx * yRel
        KyTheta += ky * xRel

    # Wall contributions
    if (request.wallStartPoints and request.wallEndPoints
            and request.wallThicknesses and request.wallHeights):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx] if w_idx < len(request.wallThicknesses) else 0.25
            w_H = request.wallHeights[w_idx] if w_idx < len(request.wallHeights) else 3.0

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

            bc = request.wallBoundaryConditions[w_idx] if (
                request.wallBoundaryConditions and w_idx < len(request.wallBoundaryConditions)
            ) else "fixed-free"
            wall_fixity = 12.0 if bc == "fixed-fixed" else 3.0

            I_in = w_t * Lw ** 3 / 12.0
            A_w = w_t * Lw

            delta_flex_in = w_H ** 3 / (wall_fixity * wall_E * I_in)
            delta_shear_in = 1.2 * w_H / (G_wall * A_w)
            k_in = 1.0 / (delta_flex_in + delta_shear_in)

            D_plate = (wall_E * w_t ** 3) / (12.0 * (1.0 - nu ** 2))
            k_out = (wall_fixity * D_plate * Lw) / w_H ** 3

            cosA2 = np.cos(alpha) ** 2
            sinA2 = np.sin(alpha) ** 2
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


def _find_column_supports(
    mesh: FEMMesh,
    columns: List[ColumnSupport],
    slab_polygons: Optional[List[List[Point2D]]] = None
) -> Tuple[List[int], List[float], List[float], List[float], List[str], List[float], List[str], List[str]]:
    """
    Find nearest mesh node for each column.
    Returns (col_nids, widths, depths, heights, shapes, diams, grades, bcs).
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
        cx = c.position.x if hasattr(c, 'position') else 0.0
        cy = c.position.y if hasattr(c, 'position') else 0.0

        dists, indices = tree.query([cx, cy], k=min(4, len(mesh.nodes)))
        if not isinstance(dists, np.ndarray):
            dists, indices = np.array([dists]), np.array([indices])

        chosen_nid = None
        for idx in indices:
            nid = mesh.nodes[idx].id
            if nid not in used_nids:
                chosen_nid = nid
                break
        if chosen_nid is None and len(indices) > 0:
            chosen_nid = mesh.nodes[indices[0]].id

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
            col_bcs.append(getattr(c, 'boundaryCondition', None) or
                           getattr(c, 'columnBoundaryCondition', None) or 'fixed-fixed')

    return col_nids, col_w, col_d, col_h, col_shapes, col_diams, col_grades, col_bcs


def _find_wall_node_ids(mesh: FEMMesh, walls: List[WallSupport], mesh_size: float = 0.5) -> List[int]:
    """Vectorized wall node lookup with nearest-node fallback for unaligned walls."""
    if not walls or not mesh.nodes:
        return []
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    node_ids = np.array([n.id for n in mesh.nodes])
    wall_nids_set: Set[int] = set()
    for w in walls:
        w_thick = getattr(w, 'thickness', 0.2) or 0.2
        tol = max(0.25, mesh_size * 0.75, (w_thick / 2.0) + 0.05)
        ax, ay = w.startPoint.x, w.startPoint.y
        bx, by = w.endPoint.x, w.endPoint.y
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        if len2 < 1e-12:
            dist = np.hypot(nodes_xy[:, 0] - ax, nodes_xy[:, 1] - ay)
        else:
            t = np.clip(((nodes_xy[:, 0] - ax) * dx + (nodes_xy[:, 1] - ay) * dy) / len2, 0.0, 1.0)
            px = ax + t * dx
            py = ay + t * dy
            dist = np.hypot(nodes_xy[:, 0] - px, nodes_xy[:, 1] - py)
        matching = node_ids[dist <= tol]
        if len(matching) == 0:
            # Fallback: if no nodes within tolerance, pick nearest nodes along wall line
            nearest_k = max(2, min(12, len(mesh.nodes)))
            matching = node_ids[np.argsort(dist)[:nearest_k]]
        wall_nids_set.update(matching.tolist())
    return list(wall_nids_set)


def _find_beam_node_ids(
    mesh: FEMMesh,
    beams: List,
    mesh_size: float = 0.5
) -> Tuple[List[int], List[int], List[float], List[float], List[float]]:
    """Return (beamNodeIdA, beamNodeIdB, beamWidths, beamDepths, beamElasticModuli) with nearest-node fallback."""
    if not beams or not mesh.nodes:
        return [], [], [], [], []
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
    node_ids = np.array([n.id for n in mesh.nodes])
    beam_nA, beam_nB, beam_w, beam_d, beam_E = [], [], [], [], []
    tol = max(0.25, mesh_size * 0.75)

    for b in beams:
        ax = b.startPoint.x if hasattr(b, 'startPoint') else 0.0
        ay = b.startPoint.y if hasattr(b, 'startPoint') else 0.0
        bx = b.endPoint.x if hasattr(b, 'endPoint') else 0.0
        by = b.endPoint.y if hasattr(b, 'endPoint') else 0.0
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        if len2 < 1e-12:
            continue
        L = np.sqrt(len2)

        t_vals = ((nodes_xy[:, 0] - ax) * dx + (nodes_xy[:, 1] - ay) * dy) / len2
        mask = (t_vals >= -0.05) & (t_vals <= 1.05)
        if not np.any(mask):
            # Fallback: find nearest nodes to start and end
            distA = np.hypot(nodes_xy[:, 0] - ax, nodes_xy[:, 1] - ay)
            distB = np.hypot(nodes_xy[:, 0] - bx, nodes_xy[:, 1] - by)
            nA_idx = int(node_ids[np.argmin(distA)])
            nB_idx = int(node_ids[np.argmin(distB)])
            if nA_idx != nB_idx:
                bw = getattr(b, 'width', 0.3) or 0.3
                bd = getattr(b, 'depth', 0.45) or 0.45
                bE = getattr(b, 'elasticModulus', 25e9) or 25e9
                beam_nA.append(nA_idx)
                beam_nB.append(nB_idx)
                beam_w.append(float(bw))
                beam_d.append(float(bd))
                beam_E.append(float(bE))
            continue

        cand_indices = np.where(mask)[0]
        cand_t = t_vals[mask]
        cand_clamp = np.clip(cand_t, 0.0, 1.0)
        px = ax + cand_clamp * dx
        py = ay + cand_clamp * dy
        dists = np.hypot(nodes_xy[cand_indices, 0] - px, nodes_xy[cand_indices, 1] - py)
        matched_mask = dists <= tol
        if not np.any(matched_mask):
            # Fallback to nearest node among candidates
            best_idx = cand_indices[np.argmin(dists)]
            matched_mask = (cand_indices == best_idx)

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
