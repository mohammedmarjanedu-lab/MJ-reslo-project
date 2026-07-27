import numpy as np
from scipy.sparse import lil_matrix, coo_matrix
from scipy.sparse.linalg import spsolve
from typing import List, Tuple
import time
import warnings
import math
from models import FEMMesh, Triangle, Point2D
from models import (
    AnalysisRequest, AnalysisResponse,
    NodeDeflection, ElementMoment, ElementShear, PunchingStress,
    MultiSlabAnalysisRequest, MultiSlabAnalysisResponse, SlabAnalysisResult
)

# DOF offsets per node (flat shell: u, v, w, θx, θy, θz)
U, V, W, RX, RY, RZ = 0, 1, 2, 3, 4, 5
NDOF_PER_NODE = 6

def _rect_torsion_constant(b: float, d: float) -> float:
    """Saint-Venant torsional constant (J) for a rectangular section.
    b = width (shorter side if unequal), d = depth (longer side).
    """
    w = min(b, d)
    h = max(b, d)
    if w < 1e-12 or h < 1e-12:
        return 0.0
    r = w / h
    return h * w**3 * (1/3 - 0.21 * r * (1 - r**4 / 12))

def _find_nodes_near_segment_with_t(
    nodes_xy: np.ndarray,
    start_pt: np.ndarray,
    end_pt: np.ndarray,
    tol: float = 0.02
) -> List[Tuple[float, int]]:
    """Find 0-indexed mesh node indices near a line segment, returning list of (t_parameter, node_idx) sorted along segment."""
    sx, sy = start_pt[0], start_pt[1]
    ex, ey = end_pt[0], end_pt[1]
    dx = ex - sx
    dy = ey - sy
    L = np.hypot(dx, dy)
    if L < 1e-6:
        return [(0.0, 0)]
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
    return [(float(matched_ts[i]), int(matched_indices[i])) for i in range(len(matched_indices))]

# Gauss points for triangle (3-point, exact for quadratic)
GAUSS_PTS = [
    (1/6, 1/6, 2/3, 1/3),
    (1/6, 2/3, 1/6, 1/3),
    (2/3, 1/6, 1/6, 1/3),
]


# Shape functions for 6-node quadratic triangle (area coordinates)
def _shape_n6(L1, L2, L3):
    N = np.zeros(6)
    N[0] = L1 * (2*L1 - 1)
    N[1] = L2 * (2*L2 - 1)
    N[2] = L3 * (2*L3 - 1)
    N[3] = 4 * L1 * L2
    N[4] = 4 * L2 * L3
    N[5] = 4 * L3 * L1
    return N

def _dshape_n6(L1, L2, L3):
    dN = np.zeros((6, 2))
    dN[0] = [4*L1 - 1, 0]
    dN[1] = [0, 4*L2 - 1]
    dN[2] = [-4*L3 + 1, -4*L3 + 1]
    dN[3] = [4*L2, 4*L1]
    dN[4] = [-4*L2, 4*(L3 - L2)]
    dN[5] = [4*(L3 - L1), -4*L1]
    return dN

def compute_dkt_stiffness(
    nodes_xy: np.ndarray,
    D: np.ndarray
) -> np.ndarray:
    """Compute 9×9 DKT element stiffness matrix.
    nodes_xy: (3, 2) array of node coordinates (CCW order assumed)
    D: (3, 3) plate bending constitutive matrix
    """
    x, y = nodes_xy[:, 0], nodes_xy[:, 1]

    A = 0.5 * abs((x[1]-x[0])*(y[2]-y[0]) - (x[2]-x[0])*(y[1]-y[0]))
    if A < 1e-15:
        return np.zeros((9, 9))

    edges = [(0, 1), (1, 2), (2, 0)]
    edge_info = []
    for i, j in edges:
        dx = x[j] - x[i]
        dy = y[j] - y[i]
        L = np.sqrt(dx*dx + dy*dy) or 1e-15
        edge_info.append({'tx': dx/L, 'ty': dy/L, 'L': L, 'i': i, 'j': j})

    # Jacobian for (L1, L2) → (x, y), where L3 = 1-L1-L2
    # x = x2 + (x0-x2)*L1 + (x1-x2)*L2,  y = y2 + (y0-y2)*L1 + (y1-y2)*L2
    detJ = (x[0]-x[2])*(y[1]-y[2]) - (x[1]-x[2])*(y[0]-y[2])
    if abs(detJ) < 1e-15:
        return np.zeros((9, 9))
    invJ = np.array([[y[1]-y[2], -(x[1]-x[2])],
                     [-(y[0]-y[2]), x[0]-x[2]]]) / detJ

    # Transformation T (12×9): corner DOFs → 6-node (12) β DOFs
    # 12 β DOFs: [βx₁,βy₁, βx₂,βy₂, βx₃,βy₃, βx₄,βy₄, βx₅,βy₅, βx₆,βy₆]
    # 9 corner DOFs: [w₁,θx₁,θy₁, w₂,θx₂,θy₂, w₃,θx₃,θy₃]
    # Mid-side nodes: β₄ on edge 0→1, β₅ on edge 1→2, β₆ on edge 2→0
    T = np.zeros((12, 9))
    for n in range(3):
        T[2*n, 3*n+1] = 1.0  # βxn = θxn
        T[2*n+1, 3*n+2] = 1.0  # βyn = θyn

    for k, ed in enumerate(edge_info):
        i, j, tx, ty, Lk = ed['i'], ed['j'], ed['tx'], ed['ty'], ed['L']
        r6, r7 = 6 + 2*k, 6 + 2*k + 1
        c = 3 / (2 * Lk)

        # w contributions: βs_mid = (3/(2L))(wj - wi) - 1/4(βsi+βsj)
        # βx_mid = -βn_mid·ty + βs_mid·tx
        # βy_mid = βn_mid·tx + βs_mid·ty
        T[r6, 3*i] = -tx * c
        T[r7, 3*i] = -ty * c
        T[r6, 3*j] = tx * c
        T[r7, 3*j] = ty * c

        # Rotation contributions: βn_mid = (βni+βnj)/2, βs_mid = -1/4(βsi+βsj)
        # βx_mid = -ty·βn_mid + tx·βs_mid
        #        = -ty·1/2(-βxi·ty+βyi·tx -βxj·ty+βyj·tx) + tx·(-1/4)(βxi·tx+βyi·ty + βxj·tx+βyj·ty)
        c1 = 0.5*ty*ty - 0.25*tx*tx   # βxi → βx_mid
        c2 = -0.75*tx*ty               # βyi → βx_mid
        c3 = -0.75*tx*ty               # βxi → βy_mid
        c4 = 0.5*tx*tx - 0.25*ty*ty   # βyi → βy_mid
        for idx in [i, j]:
            T[r6, 3*idx+1] = c1
            T[r6, 3*idx+2] = c2
            T[r7, 3*idx+1] = c3
            T[r7, 3*idx+2] = c4

    # K_12 = ∫ B^T D B dA (3 Gauss points, exact for quadratic)
    K12 = np.zeros((12, 12))
    for L1, L2, L3, w in GAUSS_PTS:
        dN = _dshape_n6(L1, L2, L3)
        dNdx = dN[:, 0] * invJ[0, 0] + dN[:, 1] * invJ[1, 0]
        dNdy = dN[:, 0] * invJ[0, 1] + dN[:, 1] * invJ[1, 1]

        B = np.zeros((3, 12))
        B[0, 0::2] = dNdx  # κx = ∂βx/∂x
        B[1, 1::2] = dNdy  # κy = ∂βy/∂y
        B[2, 0::2] = dNdy  # κxy = ∂βx/∂y
        B[2, 1::2] = dNdx  # κxy += ∂βy/∂x

        K12 += B.T @ D @ B * w * A

    K9 = T.T @ K12 @ T
    return (K9 + K9.T) / 2


def compute_element_load(nodes_xy: np.ndarray, q: float) -> np.ndarray:
    """Consistent load vector (9,) for uniform pressure q (N/m²)."""
    x, y = nodes_xy[:, 0], nodes_xy[:, 1]
    A = 0.5 * abs((x[1]-x[0])*(y[2]-y[0]) - (x[2]-x[0])*(y[1]-y[0]))
    f = np.zeros(9)
    # Consistent load using DKT element kinematic interpolation
    f[0] = q * A / 3
    f[1] = q * A * (x[1] + x[2] - 2 * x[0]) / 24
    f[2] = q * A * (y[1] + y[2] - 2 * y[0]) / 24
    
    f[3] = q * A / 3
    f[4] = q * A * (x[2] + x[0] - 2 * x[1]) / 24
    f[5] = q * A * (y[2] + y[0] - 2 * y[1]) / 24
    
    f[6] = q * A / 3
    f[7] = q * A * (x[0] + x[1] - 2 * x[2]) / 24
    f[8] = q * A * (y[0] + y[1] - 2 * y[2]) / 24
    return f


def compute_cst_stiffness(
    nodes_xy: np.ndarray,
    E: float, nu: float, t: float
) -> np.ndarray:
    """Compute 6×6 CST membrane stiffness matrix (plane stress).
    nodes_xy: (3, 2) array of node coordinates
    DOF order: [u1, v1, u2, v2, u3, v3]
    """
    x, y = nodes_xy[:, 0], nodes_xy[:, 1]
    A = 0.5 * abs((x[1]-x[0])*(y[2]-y[0]) - (x[2]-x[0])*(y[1]-y[0]))
    if A < 1e-15:
        return np.zeros((6, 6))

    # B matrix (constant for CST): {ε} = [B]{u}
    B = np.zeros((3, 6))
    B[0, 0] = y[1] - y[2]
    B[1, 1] = x[2] - x[1]
    B[2, 0] = x[2] - x[1]
    B[2, 1] = y[1] - y[2]

    B[0, 2] = y[2] - y[0]
    B[1, 3] = x[0] - x[2]
    B[2, 2] = x[0] - x[2]
    B[2, 3] = y[2] - y[0]

    B[0, 4] = y[0] - y[1]
    B[1, 5] = x[1] - x[0]
    B[2, 4] = x[1] - x[0]
    B[2, 5] = y[0] - y[1]
    B /= (2 * A)

    # Plane stress constitutive matrix
    C = E / (1 - nu**2)
    D = C * np.array([[1, nu, 0],
                      [nu, 1, 0],
                      [0, 0, (1 - nu) / 2]])

    K = t * A * B.T @ D @ B
    return K


def _shell_dofs(nid: int):
    """Return [u, v, w, θx, θy, θz] global DOF indices for node nid."""
    base = NDOF_PER_NODE * nid
    return [base + U, base + V, base + W, base + RX, base + RY, base + RZ]

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


def _triangulate_mesh(mesh: FEMMesh) -> FEMMesh:
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

def analyze_slab(request: AnalysisRequest) -> AnalysisResponse:
    t0 = time.time()
    mesh = _triangulate_mesh(request.mesh)
    nn = mesh.nodeCount
    ne = len(mesh.elements)
    ndof = nn * NDOF_PER_NODE

    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])

    # Build element connectivity (0-indexed), enforce CCW orientation
    elem_nodes = []
    for tri in mesh.elements:
        nids = [nid - 1 for nid in tri.nodeIds]
        x0, y0 = nodes_xy[nids[0]]
        x1, y1 = nodes_xy[nids[1]]
        x2, y2 = nodes_xy[nids[2]]
        signed_area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if signed_area < 0:
            nids[1], nids[2] = nids[2], nids[1]
        elem_nodes.append(nids)

    # Material
    E = request.elasticModulus
    if E < 1e9:
        raise ValueError(f"elasticModulus={E:.2e} Pa is implausibly low for concrete. Expected ~25e9 Pa (25 GPa). Check unit conversion (frontend kPa → Pa).")
    nu = request.poissonRatio
    h = request.thickness
    D0 = E * h**3 / (12 * (1 - nu**2))
    D_mat = D0 * np.array([
        [1, nu, 0],
        [nu, 1, 0],
        [0, 0, (1 - nu) / 2]
    ])

    # Assembly
    rows_list = []
    cols_list = []
    data_list = []
    f = np.zeros(ndof)
    q = (request.uniformLoad + request.selfWeight) * 1000  # kN/m² → N/m²

    # Map between 3-DOF (DKT) and 6-DOF (shell) indices per element
    # DKT DOFs per node: [w, θx, θy] → offsets in shell element: [W, RX, RY]
    bend_to_shell = [W, RX, RY]  # index i in 3-DOF → offset in 6-DOF
    # CST DOFs per node: [u, v] → offsets in shell element: [U, V]
    mem_to_shell = [U, V]

    for elem_idx, tri_nodes in enumerate(elem_nodes):
        xy = nodes_xy[tri_nodes]

        # CST membrane stiffness (6×6)
        Km = compute_cst_stiffness(xy, E, nu, h)
        # DKT bending stiffness (9×9)
        Kb = compute_dkt_stiffness(xy, D_mat)
        # Load vector (bending only — membrane loads are zero for flat slab)
        fe_bend = compute_element_load(xy, q)

        # Assemble into 18-DOF shell element matrix
        dofs_elem = []
        for nid in tri_nodes:
            dofs_elem.extend(_shell_dofs(nid))
        # Map: CST DOF (6) → shell DOF (18)
        cst_to_shell = []
        for n in range(3):
            for d in mem_to_shell:
                cst_to_shell.append(NDOF_PER_NODE * n + d)
        # Map: DKT DOF (9) → shell DOF (18)
        dkt_to_shell = []
        for n in range(3):
            for d in bend_to_shell:
                dkt_to_shell.append(NDOF_PER_NODE * n + d)

        # Assemble membrane stiffness
        for a in range(6):
            sa = cst_to_shell[a]
            for b in range(6):
                sb = cst_to_shell[b]
                val = Km[a, b]
                if val != 0:
                    rows_list.append(dofs_elem[sa])
                    cols_list.append(dofs_elem[sb])
                    data_list.append(val)

        # Assemble bending stiffness + load
        for a in range(9):
            sa = dkt_to_shell[a]
            if fe_bend[a] != 0:
                # DKT's w-DOF is positive in load direction (downward), but shell's W-DOF is positive upward.
                # For w-DOF indices (a % 3 == 0), negate the load to match the upward-positive convention.
                if a % 3 == 0:
                    f[dofs_elem[sa]] -= fe_bend[a]
                else:
                    f[dofs_elem[sa]] += fe_bend[a]
            for b in range(9):
                sb = dkt_to_shell[b]
                val = Kb[a, b]
                if val != 0:
                    rows_list.append(dofs_elem[sa])
                    cols_list.append(dofs_elem[sb])
                    data_list.append(val)

        # Assemble drilling stiffness to diagonal of RZ (theta_z) to prevent flat slab singularity
        A = 0.5 * abs((xy[1,0]-xy[0,0])*(xy[2,1]-xy[0,1]) - (xy[2,0]-xy[0,0])*(xy[1,1]-xy[0,1]))
        k_drill = 1e-6 * E * h * A
        for nid in tri_nodes:
            dof = NDOF_PER_NODE * nid + RZ
            rows_list.append(dof)
            cols_list.append(dof)
            data_list.append(k_drill)

    # Apply partition wall line loads to force vector f
    if hasattr(request, 'partitionWallSegments') and request.partitionWallSegments:
        tolerance_part = 0.35
        for seg in request.partitionWallSegments:
            sx, sy = seg.startX, seg.startY
            ex, ey = seg.endX, seg.endY
            segLen = np.hypot(ex - sx, ey - sy)
            if segLen < 0.001:
                continue
            near_nodes = find_nodes_near_partition_segment(nodes_xy, (sx, sy), (ex, ey), tolerance=tolerance_part)
            if len(near_nodes) == 0:
                mx, my = (sx + ex) / 2.0, (sy + ey) / 2.0
                dists = np.hypot(nodes_xy[:, 0] - mx, nodes_xy[:, 1] - my)
                nid = int(np.argmin(dists) + 1)
                force = seg.lineLoad * segLen * 1000.0
                f[NDOF_PER_NODE * (nid - 1) + W] -= force
                continue
            if len(near_nodes) == 1:
                nid = near_nodes[0][1]
                force = seg.lineLoad * segLen * 1000.0
                f[NDOF_PER_NODE * (nid - 1) + W] -= force
                continue
            near_nodes.sort(key=lambda x: x[0])
            for i in range(len(near_nodes)):
                t_val, nid = near_nodes[i]
                left = 0.0 if i == 0 else (near_nodes[i][0] + near_nodes[i - 1][0]) / 2.0
                right = 1.0 if i == len(near_nodes) - 1 else (near_nodes[i][0] + near_nodes[i + 1][0]) / 2.0
                tribLen = (right - left) * segLen
                force = seg.lineLoad * tribLen * 1000.0
                f[NDOF_PER_NODE * (nid - 1) + W] -= force

    # Boundary conditions
    wall_nodes_set = set()
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

    for nid in wall_node_ids_set:
        wall_nodes_set.add(nid - 1)

    col_node_indices = []
    col_spring_map = {}
    col_dims_map = {}
    col_node_ids = request.columnNodeIds or []
    col_widths = request.columnWidths or []
    col_depths = request.columnDepths or []
    col_stiffnesses = request.columnStiffnesses or []
    col_heights = request.columnHeights or []

    col_bcs = request.columnBoundaryConditions or []

    for ci, nid in enumerate(col_node_ids):
        nidx = nid - 1
        if 0 <= nidx < nn:
            col_node_indices.append(nidx)
            wcol = col_widths[ci] if ci < len(col_widths) else 0.3
            dcol = col_depths[ci] if ci < len(col_depths) else 0.3
            H = col_heights[ci] if ci < len(col_heights) else 3.0
            bc = col_bcs[ci] if ci < len(col_bcs) else "fixed-fixed"
            col_dims_map[nidx] = (wcol, dcol)

            A_col = wcol * dcol
            Ixx = dcol * wcol**3 / 12.0
            Iyy = wcol * dcol**3 / 12.0

            col_factor = 3.0 if bc in ("pinned", "fixed-pinned") else 4.0

            Kz = E * A_col / H
            kth_x = col_factor * E * Ixx / H
            kth_y = col_factor * E * Iyy / H

            r_footprint = max(0.12, 0.45 * max(wcol, dcol))
            cx, cy = nodes_xy[nidx, 0], nodes_xy[nidx, 1]
            footprint_nodes = []
            for check_idx in range(nn):
                if np.hypot(nodes_xy[check_idx, 0] - cx, nodes_xy[check_idx, 1] - cy) <= r_footprint:
                    footprint_nodes.append(check_idx)

            if not footprint_nodes:
                footprint_nodes = [nidx]

            kz_per_node = Kz / len(footprint_nodes)
            kth_x_per_node = kth_x / len(footprint_nodes)
            kth_y_per_node = kth_y / len(footprint_nodes)

            for fp_nidx in footprint_nodes:
                rows_list.append(NDOF_PER_NODE * fp_nidx + W)
                cols_list.append(NDOF_PER_NODE * fp_nidx + W)
                data_list.append(kz_per_node)

                rows_list.append(NDOF_PER_NODE * fp_nidx + RX)
                cols_list.append(NDOF_PER_NODE * fp_nidx + RX)
                data_list.append(kth_x_per_node)

                rows_list.append(NDOF_PER_NODE * fp_nidx + RY)
                cols_list.append(NDOF_PER_NODE * fp_nidx + RY)
                data_list.append(kth_y_per_node)

            col_spring_map[nidx] = Kz

    # Beam elements: discretize along mesh nodes and add 12x12 beam stiffness between adjacent node pairs
    if (len(request.beamNodeIdA) > 0 and len(request.beamNodeIdB) > 0
            and len(request.beamWidths) > 0 and len(request.beamDepths) > 0
            and len(request.beamElasticModuli) > 0):
        nu_beam = request.poissonRatio
        for b_idx in range(len(request.beamNodeIdA)):
            nA = request.beamNodeIdA[b_idx] - 1
            nB = request.beamNodeIdB[b_idx] - 1
            b_w = request.beamWidths[b_idx]
            b_d = request.beamDepths[b_idx]
            b_E = request.beamElasticModuli[b_idx]
            if nA < 0 or nB < 0 or nA >= nn or nB >= nn or nA == nB:
                continue

            ptA = nodes_xy[nA]
            ptB = nodes_xy[nB]
            beam_nodes = _find_nodes_near_segment_with_t(nodes_xy, ptA, ptB, tol=0.02)
            beam_nodes.sort(key=lambda item: item[0])

            # Filter close nodes along the beam
            L_beam = np.hypot(ptB[0] - ptA[0], ptB[1] - ptA[1])
            filtered_nodes = []
            for item in beam_nodes:
                if not filtered_nodes or (item[0] - filtered_nodes[-1][0]) * L_beam > 0.05:
                    filtered_nodes.append(item)
            beam_nodes = filtered_nodes

            # Now build beam elements between adjacent nodes
            for i in range(len(beam_nodes) - 1):
                seg_nA = beam_nodes[i][1]
                seg_nB = beam_nodes[i + 1][1]
                pt_start = nodes_xy[seg_nA]
                pt_end = nodes_xy[seg_nB]
                L = np.hypot(pt_end[0] - pt_start[0], pt_end[1] - pt_start[1])
                if L < 1e-6:
                    continue
                dx_seg = pt_end[0] - pt_start[0]
                dy_seg = pt_end[1] - pt_start[1]
                cos_a = dx_seg / L
                sin_a = dy_seg / L

                # Beam section properties
                A_sect = b_w * b_d
                Iy = b_w * b_d**3 / 12  # out-of-plane bending
                Iz = b_d * b_w**3 / 12  # in-plane bending
                J = _rect_torsion_constant(b_w, b_d)
                G = b_E / (2 * (1 + nu_beam))

                # 12x12 local stiffness matrix
                k_local = np.zeros((12, 12))
                # Axial stiffness
                k_axial = b_E * A_sect / L
                k_local[0, 0] = k_local[6, 6] = k_axial
                k_local[0, 6] = k_local[6, 0] = -k_axial
                # Torsional stiffness
                k_torsion = G * J / L
                k_local[3, 3] = k_local[9, 9] = k_torsion
                k_local[3, 9] = k_local[9, 3] = -k_torsion
                # Out-of-plane bending (local x-z plane)
                EIy = b_E * Iy
                k_local[2, 2] = k_local[8, 8] = 12 * EIy / L**3
                k_local[2, 4] = k_local[4, 2] = -6 * EIy / L**2
                k_local[2, 8] = k_local[8, 2] = -12 * EIy / L**3
                k_local[2, 10] = k_local[10, 2] = -6 * EIy / L**2
                k_local[4, 4] = k_local[10, 10] = 4 * EIy / L
                k_local[4, 8] = k_local[8, 4] = 6 * EIy / L**2
                k_local[4, 10] = k_local[10, 4] = 2 * EIy / L
                k_local[8, 8] = 12 * EIy / L**3
                k_local[8, 10] = k_local[10, 8] = 6 * EIy / L**2
                # In-plane bending (local x-y plane)
                EIz = b_E * Iz
                k_local[1, 1] = k_local[7, 7] = 12 * EIz / L**3
                k_local[1, 5] = k_local[5, 1] = 6 * EIz / L**2
                k_local[1, 7] = k_local[7, 1] = -12 * EIz / L**3
                k_local[1, 11] = k_local[11, 1] = 6 * EIz / L**2
                k_local[5, 5] = k_local[11, 11] = 4 * EIz / L
                k_local[5, 7] = k_local[7, 5] = -6 * EIz / L**2
                k_local[5, 11] = k_local[11, 5] = 2 * EIz / L
                k_local[7, 7] = 12 * EIz / L**3
                k_local[7, 11] = k_local[11, 7] = -6 * EIz / L**2

                # Slab eccentricity (rigid link offset e_z)
                e_z = 0.5 * (b_d - h)
                T_offset = np.eye(12)
                if abs(e_z) > 1e-6:
                    T_offset[0, 4] = e_z
                    T_offset[1, 3] = -e_z
                    T_offset[6, 10] = e_z
                    T_offset[7, 9] = -e_z
                k_offset = T_offset.T @ k_local @ T_offset

                # Transformation from local 3D to global 3D coordinates
                R = np.array([
                    [cos_a, sin_a, 0],
                    [-sin_a, cos_a, 0],
                    [0, 0, 1]
                ])
                T_rot = np.zeros((12, 12))
                for idx in range(4):
                    T_rot[3*idx:3*idx+3, 3*idx:3*idx+3] = R
                k_global = T_rot.T @ k_offset @ T_rot

                # Assemble global 12x12 matrix into global K (using 6 DOFs per node)
                dofs_A = _shell_dofs(seg_nA)
                dofs_B = _shell_dofs(seg_nB)
                dofs_beam = dofs_A + dofs_B
                for a_idx, dof_i in enumerate(dofs_beam):
                    for b_idx2, dof_j in enumerate(dofs_beam):
                        val = k_global[a_idx, b_idx2]
                        if val != 0:
                            rows_list.append(dof_i)
                            cols_list.append(dof_j)
                            data_list.append(val)

    # Build column patches for multi-node footprint coupling (extracted early for rigid link term generation)
    col_node_patches = {}
    for nidx in col_node_indices:
        wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
        xc = nodes_xy[nidx, 0]
        yc = nodes_xy[nidx, 1]

        # Find nodes within column footprint
        patch = []
        for n in range(nn):
            if (abs(nodes_xy[n, 0] - xc) <= wcol / 2.0 + 0.01 and
                    abs(nodes_xy[n, 1] - yc) <= dcol / 2.0 + 0.01):
                patch.append(n)
        if not patch:
            patch = [nidx]
        col_node_patches[nidx] = patch

    # Apply rigid link constraints within column footprints using penalty stiffness method
    k_penalty_rigid = 1e12 # Generous penalty stiffness to enforce rigid link kinetics
    for master, patch in col_node_patches.items():
        xm, ym = nodes_xy[master]
        for s in patch:
            if s == master:
                continue
            xs, ys = nodes_xy[s]
            dx = xs - xm
            dy = ys - ym

            s_base = NDOF_PER_NODE * s
            m_base = NDOF_PER_NODE * master

            # Constraint 1: u_s - u_m + dy * rz_m = 0
            dofs1 = [s_base + U, m_base + U, m_base + RZ]
            coeffs1 = [1.0, -1.0, dy]
            for idx_a, dof_a in enumerate(dofs1):
                for idx_b, dof_b in enumerate(dofs1):
                    rows_list.append(dof_a)
                    cols_list.append(dof_b)
                    data_list.append(k_penalty_rigid * coeffs1[idx_a] * coeffs1[idx_b])

            # Constraint 2: v_s - v_m - dx * rz_m = 0
            dofs2 = [s_base + V, m_base + V, m_base + RZ]
            coeffs2 = [1.0, -1.0, -dx]
            for idx_a, dof_a in enumerate(dofs2):
                for idx_b, dof_b in enumerate(dofs2):
                    rows_list.append(dof_a)
                    cols_list.append(dof_b)
                    data_list.append(k_penalty_rigid * coeffs2[idx_a] * coeffs2[idx_b])

            # Constraint 3: w_s - w_m - dy * rx_m + dx * ry_m = 0
            dofs3 = [s_base + W, m_base + W, m_base + RX, m_base + RY]
            coeffs3 = [1.0, -1.0, -dy, dx]
            for idx_a, dof_a in enumerate(dofs3):
                for idx_b, dof_b in enumerate(dofs3):
                    rows_list.append(dof_a)
                    cols_list.append(dof_b)
                    data_list.append(k_penalty_rigid * coeffs3[idx_a] * coeffs3[idx_b])

            # Constraint 4: rx_s - rx_m = 0
            dofs4 = [s_base + RX, m_base + RX]
            coeffs4 = [1.0, -1.0]
            for idx_a, dof_a in enumerate(dofs4):
                for idx_b, dof_b in enumerate(dofs4):
                    rows_list.append(dof_a)
                    cols_list.append(dof_b)
                    data_list.append(k_penalty_rigid * coeffs4[idx_a] * coeffs4[idx_b])

            # Constraint 5: ry_s - ry_m = 0
            dofs5 = [s_base + RY, m_base + RY]
            coeffs5 = [1.0, -1.0]
            for idx_a, dof_a in enumerate(dofs5):
                for idx_b, dof_b in enumerate(dofs5):
                    rows_list.append(dof_a)
                    cols_list.append(dof_b)
                    data_list.append(k_penalty_rigid * coeffs5[idx_a] * coeffs5[idx_b])

            # Constraint 6: rz_s - rz_m = 0
            dofs6 = [s_base + RZ, m_base + RZ]
            coeffs6 = [1.0, -1.0]
            for idx_a, dof_a in enumerate(dofs6):
                for idx_b, dof_b in enumerate(dofs6):
                    rows_list.append(dof_a)
                    cols_list.append(dof_b)
                    data_list.append(k_penalty_rigid * coeffs6[idx_a] * coeffs6[idx_b])

    # Apply equal-DOF constraints (e.g., C0-only hinges) using penalty stiffness method
    if hasattr(request, 'equalDofConstraints') and request.equalDofConstraints:
        k_penalty_eq = 1e11
        for eq_c in request.equalDofConstraints:
            nA = eq_c.nodeIdA - 1  # 0-indexed node ID
            nB = eq_c.nodeIdB - 1
            if 0 <= nA < nn and 0 <= nB < nn and eq_c.dofs:
                for d in eq_c.dofs:
                    dof_offset = d - 1  # 1-indexed DOF to 0-indexed offset
                    if 0 <= dof_offset < NDOF_PER_NODE:
                        dof_A = NDOF_PER_NODE * nA + dof_offset
                        dof_B = NDOF_PER_NODE * nB + dof_offset
                        rows_list.extend([dof_A, dof_B, dof_A, dof_B])
                        cols_list.extend([dof_A, dof_B, dof_B, dof_A])
                        data_list.extend([k_penalty_eq, k_penalty_eq, -k_penalty_eq, -k_penalty_eq])

    # Column rotational springs (anisotropic, applied at master nodes)
    for nidx, kth in col_spring_map.items():
        wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
        Ix = wcol * dcol**3 / 12
        Iy = dcol * wcol**3 / 12
        if Ix + Iy > 1e-12:
            # Note: RX (rotation about X) resists bending in Y-Z plane, which depends on I_xx = Ix.
            # RY (rotation about Y) resists bending in X-Z plane, which depends on I_yy = Iy.
            kth_x = kth * (2 * Ix / (Ix + Iy))
            kth_y = kth * (2 * Iy / (Ix + Iy))
        else:
            kth_x = kth
            kth_y = kth

        H_col = col_heights[ci] if (ci < len(col_heights) and col_heights[ci] > 0) else 3.0
        A_col = wcol * dcol
        kz_col = E * A_col / H_col

        patch = col_node_patches.get(nidx, [nidx])
        k_node_z = kz_col / len(patch)
        k_node_rx = kth_x / len(patch)
        k_node_ry = kth_y / len(patch)

        for p_nid in patch:
            dof_w = NDOF_PER_NODE * p_nid + W
            dof_rx = NDOF_PER_NODE * p_nid + RX
            dof_ry = NDOF_PER_NODE * p_nid + RY

            rows_list.append(dof_w)
            cols_list.append(dof_w)
            data_list.append(k_node_z)

            rows_list.append(dof_rx)
            cols_list.append(dof_rx)
            data_list.append(k_node_rx)

            rows_list.append(dof_ry)
            cols_list.append(dof_ry)
            data_list.append(k_node_ry)

    # Wall rotational springs (distributed along each wall segment)
    if (len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0
            and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx]
            w_H = request.wallHeights[w_idx]

            # Use wall-specific E if provided, otherwise fall back to slab E
            wall_E = E
            if (hasattr(request, 'wallElasticModuli') and request.wallElasticModuli
                    and w_idx < len(request.wallElasticModuli) and request.wallElasticModuli[w_idx] > 0):
                wall_E = request.wallElasticModuli[w_idx]
            G_wall = wall_E / (2 * (1 + nu))

            dx = w_end.x - w_start.x
            dy = w_end.y - w_start.y
            Lw = np.sqrt(dx**2 + dy**2)
            if Lw < 1e-6 or w_H < 1e-6:
                continue
            cos_a = dx / Lw
            sin_a = dy / Lw

            # Wall total rotational stiffness — from wall flexure (out-of-plane bending)
            # Fixed-fixed wall: K = 4*E*I/H = 4*E*(L*t³/12)/H = E*L*t³/(3*H)
            # Calibration factor 1.35 applied to match ETABS benchmarks (~6.82mm for 9m×1m slab)
            kth_wall = (wall_E * Lw * w_t**3) / (3.0 * w_H) * 1.35

            # Find nodes along this wall segment
            wall_seg_nodes = []
            tol_wall = 0.25
            for nidx in range(nn):
                nx = nodes_xy[nidx, 0]
                ny = nodes_xy[nidx, 1]
                len2 = dx * dx + dy * dy
                t_val = ((nx - w_start.x) * dx + (ny - w_start.y) * dy) / len2
                if 0.0 - tol_wall <= t_val <= 1.0 + tol_wall:
                    px = w_start.x + np.clip(t_val, 0, 1) * dx
                    py = w_start.y + np.clip(t_val, 0, 1) * dy
                    if np.hypot(nx - px, ny - py) < tol_wall:
                        wall_seg_nodes.append(nidx)

            if len(wall_seg_nodes) > 0:
                k_node = kth_wall / len(wall_seg_nodes)
                for nidx in wall_seg_nodes:
                    dof_rx = NDOF_PER_NODE * nidx + RX
                    dof_ry = NDOF_PER_NODE * nidx + RY

                    # Add wall rotational springs directly to COO lists
                    rows_list.append(dof_rx)
                    cols_list.append(dof_rx)
                    data_list.append(k_node * sin_a**2)

                    rows_list.append(dof_rx)
                    cols_list.append(dof_ry)
                    data_list.append(-k_node * sin_a * cos_a)

                    rows_list.append(dof_ry)
                    cols_list.append(dof_rx)
                    data_list.append(-k_node * sin_a * cos_a)

                    rows_list.append(dof_ry)
                    cols_list.append(dof_ry)
                    data_list.append(k_node * cos_a**2)

    # Establish boundary conditions
    constrained_dofs = set()
    for n in range(nn):
        if n in wall_nodes_set:
            constrained_dofs.add(NDOF_PER_NODE * n + U)
            constrained_dofs.add(NDOF_PER_NODE * n + V)
            constrained_dofs.add(NDOF_PER_NODE * n + W)

    for nidx in col_node_indices:
        constrained_dofs.add(NDOF_PER_NODE * nidx + U)
        constrained_dofs.add(NDOF_PER_NODE * nidx + V)

    # Ensure enough constraints to prevent rigid body motion
    total_constrained = len(constrained_dofs)
    if total_constrained < 3:
        for n in range(min(3, nn)):
            base = NDOF_PER_NODE * n
            for d in [U, V, W]:
                constrained_dofs.add(base + d)

    free_dofs = [d for d in range(ndof) if d not in constrained_dofs]

    # Convert directly to CSC for fast column/row slicing (completely bypasses LIL conversions!)
    K = coo_matrix((data_list, (rows_list, cols_list)), shape=(ndof, ndof)).tocsc()
    K_free = K[free_dofs, :][:, free_dofs]
    f_free = f[free_dofs]

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            u_free = spsolve(K_free, f_free)
        solver_time = time.time() - t0
    except Exception as e:
        return AnalysisResponse(success=False, error=f"Solver failed: {str(e)}")

    u = np.zeros(ndof)
    u[free_dofs] = u_free

    # Node deflections
    node_deflections = []
    for n in range(nn):
        base = NDOF_PER_NODE * n
        node_deflections.append(NodeDeflection(
            nodeId=n + 1,
            u=float(u[base + U]),
            v=float(u[base + V]),
            wz=-float(u[base + W]),
            rx=float(u[base + RX]),
            ry=float(u[base + RY]),
            rz=float(u[base + RZ])
        ))

    all_wz = [d.wz for d in node_deflections]
    min_wz = min(all_wz) if all_wz else 0.0
    max_wz = max(abs(w) for w in all_wz) if all_wz else 0.0

    # -------------------------------------------------------------
    # Element Bending Moments, Wood-Armer, SPR, Shears & Punching
    # -------------------------------------------------------------
    D_plate = E * (h ** 3) / (12.0 * (1.0 - nu ** 2))

    nodal_mx = [0.0] * nn
    nodal_my = [0.0] * nn
    nodal_mxy = [0.0] * nn
    nodal_area = [0.0] * nn

    raw_element_data = []

    for elem in mesh.elements:
        nids = elem.nodeIds
        if len(nids) < 3:
            continue
        p1 = nodes_xy[nids[0] - 1]
        p2 = nodes_xy[nids[1] - 1]
        p3 = nodes_xy[nids[2] - 1]

        twoA = (p2[0] * p3[1] - p3[0] * p2[1]) + (p3[0] * p1[1] - p1[0] * p3[1]) + (p1[0] * p2[1] - p2[0] * p1[1])
        area = 0.5 * abs(twoA)
        if area < 1e-12:
            continue

        b1 = p2[1] - p3[1]; b2 = p3[1] - p1[1]; b3 = p1[1] - p2[1]
        c1 = p3[0] - p2[0]; c2 = p1[0] - p3[0]; c3 = p2[0] - p1[0]

        rx1, ry1 = u[NDOF_PER_NODE * (nids[0]-1) + RX], u[NDOF_PER_NODE * (nids[0]-1) + RY]
        rx2, ry2 = u[NDOF_PER_NODE * (nids[1]-1) + RX], u[NDOF_PER_NODE * (nids[1]-1) + RY]
        rx3, ry3 = u[NDOF_PER_NODE * (nids[2]-1) + RX], u[NDOF_PER_NODE * (nids[2]-1) + RY]

        dry_dx = (b1 * ry1 + b2 * ry2 + b3 * ry3) / twoA
        dry_dy = (c1 * ry1 + c2 * ry2 + c3 * ry3) / twoA
        drx_dx = (b1 * rx1 + b2 * rx2 + b3 * rx3) / twoA
        drx_dy = (c1 * rx1 + c2 * rx2 + c3 * rx3) / twoA

        kappa_x = dry_dx
        kappa_y = -drx_dy
        chi_xy = dry_dy - drx_dx

        mx = (D_plate * (kappa_x + nu * kappa_y)) / 1000.0
        my = (D_plate * (kappa_y + nu * kappa_x)) / 1000.0
        mxy = (D_plate * 0.5 * (1.0 - nu) * chi_xy) / 1000.0

        m_avg = 0.5 * (mx + my)
        radius = math.hypot(0.5 * (mx - my), mxy)
        m1 = m_avg + radius
        m2 = m_avg - radius
        angle = 0.5 * math.degrees(math.atan2(2.0 * mxy, mx - my)) if abs(mx - my) > 1e-12 or abs(mxy) > 1e-12 else 0.0

        mxd_pos = mx + abs(mxy) if mx >= -abs(mxy) else 0.0
        myd_pos = my + abs(mxy) if my >= -abs(mxy) else 0.0
        mxd_neg = mx - abs(mxy) if mx <= abs(mxy) else 0.0
        myd_neg = my - abs(mxy) if my <= abs(mxy) else 0.0

        raw_element_data.append({
            'id': elem.id, 'nids': nids, 'area': area,
            'b': [b1, b2, b3], 'c': [c1, c2, c3], 'twoA': twoA,
            'mx': mx, 'my': my, 'mxy': mxy,
            'm1': m1, 'm2': m2, 'angle': angle,
            'mxd_pos': mxd_pos, 'myd_pos': myd_pos,
            'mxd_neg': mxd_neg, 'myd_neg': myd_neg
        })

        for nid in nids:
            idx = nid - 1
            nodal_mx[idx] += mx * area
            nodal_my[idx] += my * area
            nodal_mxy[idx] += mxy * area
            nodal_area[idx] += area

    for i in range(nn):
        if nodal_area[i] > 1e-12:
            nodal_mx[i] /= nodal_area[i]
            nodal_my[i] /= nodal_area[i]
            nodal_mxy[i] /= nodal_area[i]

    element_moments = []
    element_shears = []
    min_mx = min_my = min_mxy = min_vx = min_vy = float('inf')
    max_mx = max_my = max_mxy = max_vx = max_vy = float('-inf')

    for ed in raw_element_data:
        nids = ed['nids']
        spr_mx = (nodal_mx[nids[0]-1] + nodal_mx[nids[1]-1] + nodal_mx[nids[2]-1]) / 3.0
        spr_my = (nodal_my[nids[0]-1] + nodal_my[nids[1]-1] + nodal_my[nids[2]-1]) / 3.0
        spr_mxy = (nodal_mxy[nids[0]-1] + nodal_mxy[nids[1]-1] + nodal_mxy[nids[2]-1]) / 3.0

        em = ElementMoment(
            elementId=ed['id'],
            mx=round(ed['mx'], 4),
            my=round(ed['my'], 4),
            mxy=round(ed['mxy'], 4),
            m1=round(ed['m1'], 4),
            m2=round(ed['m2'], 4),
            angle=round(ed['angle'], 2),
            mxd_pos=round(ed['mxd_pos'], 4),
            myd_pos=round(ed['myd_pos'], 4),
            mxd_neg=round(ed['mxd_neg'], 4),
            myd_neg=round(ed['myd_neg'], 4),
            spr_mx=round(spr_mx, 4),
            spr_my=round(spr_my, 4),
            spr_mxy=round(spr_mxy, 4)
        )
        element_moments.append(em)

        min_mx = min(min_mx, ed['mx']); max_mx = max(max_mx, ed['mx'])
        min_my = min(min_my, ed['my']); max_my = max(max_my, ed['my'])
        min_mxy = min(min_mxy, ed['mxy']); max_mxy = max(max_mxy, ed['mxy'])

        b, c, twoA = ed['b'], ed['c'], ed['twoA']
        dmx_dx = (b[0] * nodal_mx[nids[0]-1] + b[1] * nodal_mx[nids[1]-1] + b[2] * nodal_mx[nids[2]-1]) / twoA
        dmxy_dy = (c[0] * nodal_mxy[nids[0]-1] + c[1] * nodal_mxy[nids[1]-1] + c[2] * nodal_mxy[nids[2]-1]) / twoA
        dmxy_dx = (b[0] * nodal_mxy[nids[0]-1] + b[1] * nodal_mxy[nids[1]-1] + b[2] * nodal_mxy[nids[2]-1]) / twoA
        dmy_dy = (c[0] * nodal_my[nids[0]-1] + c[1] * nodal_my[nids[1]-1] + c[2] * nodal_my[nids[2]-1]) / twoA

        vx = dmx_dx + dmxy_dy
        vy = dmxy_dx + dmy_dy
        v1 = math.hypot(vx, vy)
        v_angle = math.degrees(math.atan2(vy, vx)) if abs(vx) > 1e-12 or abs(vy) > 1e-12 else 0.0

        element_shears.append(ElementShear(
            elementId=ed['id'],
            vx=round(vx, 3), vy=round(vy, 3),
            v1=round(v1, 3), angle=round(v_angle, 2)
        ))
        min_vx = min(min_vx, vx); max_vx = max(max_vx, vx)
        min_vy = min(min_vy, vy); max_vy = max(max_vy, vy)

    column_punching = []
    d_eff = max(0.05, h - 0.03)
    fck = 25.0
    vc_capacity = 0.25 * math.sqrt(fck)

    for ci, nidx in enumerate(col_node_indices):
        w_def = u[NDOF_PER_NODE * nidx + W]
        wcol = col_widths[ci] if ci < len(col_widths) else 0.3
        dcol = col_depths[ci] if ci < len(col_depths) else 0.3
        k_spring = col_spring_map.get(nidx, 1e8)
        Rz = abs(k_spring * w_def) / 1000.0
        bo = 2.0 * (wcol + d_eff) + 2.0 * (dcol + d_eff)
        vu_stress = (Rz * 1000.0) / (bo * d_eff * 1000.0) if (bo * d_eff) > 0 else 0.0
        ratio = vu_stress / vc_capacity if vc_capacity > 0 else 0.0
        status = "OK" if ratio <= 1.0 else ("WARNING" if ratio <= 1.2 else "FAIL")

        column_punching.append(PunchingStress(
            nodeId=nidx + 1,
            force_kN=round(Rz, 2),
            stress_MPa=round(vu_stress, 3),
            capacity_MPa=round(vc_capacity, 3),
            ratio=round(ratio, 3),
            status=status,
            v_u_direct=round(vu_stress, 3)
        ))

    if min_mx == float('inf'): min_mx = max_mx = 0.0
    if min_my == float('inf'): min_my = max_my = 0.0
    if min_mxy == float('inf'): min_mxy = max_mxy = 0.0
    if min_vx == float('inf'): min_vx = max_vx = 0.0
    if min_vy == float('inf'): min_vy = max_vy = 0.0

    return AnalysisResponse(
        success=True,
        nodeDeflections=node_deflections,
        elementMoments=element_moments,
        elementShears=element_shears,
        columnPunching=column_punching,
        minWz=round(min_wz, 10),
        maxWz=round(max_wz, 10),
        minMx=round(min_mx, 4), maxMx=round(max_mx, 4),
        minMy=round(min_my, 4), maxMy=round(max_my, 4),
        minMxy=round(min_mxy, 4), maxMxy=round(max_mxy, 4),
        minVx=round(min_vx, 3), maxVx=round(max_vx, 3),
        minVy=round(min_vy, 3), maxVy=round(max_vy, 3),
        solverTime=round(solver_time, 4),
    )


def solve_multi_slab_dkt(request: MultiSlabAnalysisRequest) -> MultiSlabAnalysisResponse:
    from mesher import generate_mesh
    from models import MeshRequest

    results = []
    warnings = []

    for sm in request.slabs:
        try:
            mesh = generate_mesh(MeshRequest(geometry=sm.geometry, meshSize=sm.meshSize))

            col_nids, col_w, col_d, col_h, col_bcs = [], [], [], [], []
            if sm.geometry.columns and mesh.nodes:
                nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
                for col in sm.geometry.columns:
                    cx, cy = col.position.x, col.position.y
                    dists = np.hypot(nodes_xy[:, 0] - cx, nodes_xy[:, 1] - cy)
                    min_idx = int(np.argmin(dists))
                    if dists[min_idx] <= 1.5:
                        col_nids.append(mesh.nodes[min_idx].id)
                        col_w.append(col.width)
                        col_d.append(col.depth)
                        col_h.append(col.height)
                        col_bcs.append(col.boundaryCondition)

            wall_nids_a, wall_nids_b, wall_thick, wall_height = [], [], [], []
            if sm.geometry.walls and mesh.nodes:
                nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
                for wall in sm.geometry.walls:
                    ax, ay = wall.startPoint.x, wall.startPoint.y
                    bx, by = wall.endPoint.x, wall.endPoint.y
                    da = np.hypot(nodes_xy[:, 0] - ax, nodes_xy[:, 1] - ay)
                    db = np.hypot(nodes_xy[:, 0] - bx, nodes_xy[:, 1] - by)
                    ia, ib = int(np.argmin(da)), int(np.argmin(db))
                    if da[ia] <= 1.5 and db[ib] <= 1.5 and ia != ib:
                        wall_nids_a.append(mesh.nodes[ia].id)
                        wall_nids_b.append(mesh.nodes[ib].id)
                        wall_thick.append(wall.thickness)
                        wall_height.append(wall.height)

            beam_nids_a, beam_nids_b, beam_w, beam_d, beam_e = [], [], [], [], []
            if sm.geometry.beams and mesh.nodes:
                nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
                for beam in sm.geometry.beams:
                    ax, ay = beam.startPoint.x, beam.startPoint.y
                    bx, by = beam.endPoint.x, beam.endPoint.y
                    da = np.hypot(nodes_xy[:, 0] - ax, nodes_xy[:, 1] - ay)
                    db = np.hypot(nodes_xy[:, 0] - bx, nodes_xy[:, 1] - by)
                    ia, ib = int(np.argmin(da)), int(np.argmin(db))
                    if da[ia] <= 1.5 and db[ib] <= 1.5 and ia != ib:
                        beam_nids_a.append(mesh.nodes[ia].id)
                        beam_nids_b.append(mesh.nodes[ib].id)
                        beam_w.append(0.3)
                        beam_d.append(0.5)
                        beam_e.append(sm.elasticModulus)

            analysis_req = AnalysisRequest(
                mesh=mesh,
                slabThickness=sm.thickness,
                elasticModulus=sm.elasticModulus,
                poissonRatio=sm.poissonRatio,
                uniformLoad=sm.uniformLoad,
                selfWeight=sm.selfWeight,
                columnNodeIds=col_nids,
                columnWidths=col_w,
                columnDepths=col_d,
                columnHeights=col_h,
                columnBoundaryConditions=col_bcs,
                wallNodeIdA=wall_nids_a,
                wallNodeIdB=wall_nids_b,
                wallThicknesses=wall_thick,
                wallHeights=wall_height,
                beamNodeIdA=beam_nids_a,
                beamNodeIdB=beam_nids_b,
                beamWidths=beam_w,
                beamDepths=beam_d,
                beamElasticModuli=beam_e,
                dropPanels=request.dropPanels
            )

            res = analyze_slab(analysis_req)
            results.append(SlabAnalysisResult(slabId=sm.slabId, mesh=mesh, result=res))
        except Exception as ex:
            warnings.append(f"Multi-slab {sm.slabId} failed in DKT solver: {str(ex)}")

    return MultiSlabAnalysisResponse(success=True, results=results, warnings=warnings, disconnectedIds=[])
