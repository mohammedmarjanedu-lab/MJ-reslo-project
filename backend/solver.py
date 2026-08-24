import numpy as np
from scipy.sparse import lil_matrix, coo_matrix
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree
from typing import Dict, List, Set, Tuple
import time
import warnings
import math
from models import FEMMesh, FEMNode, Triangle, Point2D
from models import (
    AnalysisRequest, AnalysisResponse,
    NodeDeflection, ElementMoment, ElementShear, ElementStress,
    ElementMembraneForce, PunchingStress,
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

    # Transformation T (12×9): corner DOFs [w_i, θx_i, θy_i] → 6-node (12) β DOFs [βx_m, βy_m]
    # In shell coordinates: RX = θx = βy, RY = θy = -βx → βx = -RY, βy = +RX
    T = np.zeros((12, 9))
    for n in range(3):
        T[2*n, 3*n+2] = -1.0   # βxn = -θyn (-RY)
        T[2*n+1, 3*n+1] = 1.0  # βyn = +θxn (+RX)

    for k, ed in enumerate(edge_info):
        i, j, tx, ty, Lk = ed['i'], ed['j'], ed['tx'], ed['ty'], ed['L']
        r6, r7 = 6 + 2*k, 6 + 2*k + 1
        c = 3 / (2 * Lk)

        # w contributions
        T[r6, 3*i] = -tx * c
        T[r7, 3*i] = -ty * c
        T[r6, 3*j] = tx * c
        T[r7, 3*j] = ty * c

        # Rotation contributions (θx = RX, θy = RY)
        # θx -> βxm: -0.75 * tx * ty
        # θy -> βxm: -0.5 * ty**2 + 0.25 * tx**2
        # θx -> βym: 0.5 * tx**2 - 0.25 * ty**2
        # θy -> βym: 0.75 * tx * ty
        c_rx_bx = -0.75 * tx * ty
        c_ry_bx = -0.5 * ty * ty + 0.25 * tx * tx
        c_rx_by = 0.5 * tx * tx - 0.25 * ty * ty
        c_ry_by = 0.75 * tx * ty

        for idx in [i, j]:
            T[r6, 3*idx+1] = c_rx_bx
            T[r6, 3*idx+2] = c_ry_bx
            T[r7, 3*idx+1] = c_rx_by
            T[r7, 3*idx+2] = c_ry_by

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
    f[1] = q * A * (y[1] + y[2] - 2 * y[0]) / 24
    f[2] = -q * A * (x[1] + x[2] - 2 * x[0]) / 24
    
    f[3] = q * A / 3
    f[4] = q * A * (y[2] + y[0] - 2 * y[1]) / 24
    f[5] = -q * A * (x[2] + x[0] - 2 * x[1]) / 24
    
    f[6] = q * A / 3
    f[7] = q * A * (y[0] + y[1] - 2 * y[2]) / 24
    f[8] = -q * A * (x[0] + x[1] - 2 * x[2]) / 24
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

def _point_in_polygon(x: float, y: float, vertices: List[Point2D]) -> bool:
    inside = False
    n = len(vertices)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = vertices[i].x, vertices[i].y
        xj, yj = vertices[j].x, vertices[j].y
        if ((yi > y) != (yj > y)):
            x_cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside

def _mesh_line_tolerance(nodes_xy: np.ndarray, elem_nodes: List[List[int]]) -> float:
    edge_lengths = []
    for tri_nodes in elem_nodes:
        if len(tri_nodes) < 3:
            continue
        xy = nodes_xy[tri_nodes[:3]]
        for i, j in ((0, 1), (1, 2), (2, 0)):
            L = float(np.hypot(xy[i, 0] - xy[j, 0], xy[i, 1] - xy[j, 1]))
            if L > 1e-9:
                edge_lengths.append(L)
    if not edge_lengths:
        return 0.05
    return max(0.02, min(0.35, 0.20 * float(np.median(edge_lengths))))

def _plate_D_matrix(E: float, h: float, nu: float) -> np.ndarray:
    D0 = E * h**3 / (12 * (1 - nu**2))
    return D0 * np.array([
        [1, nu, 0],
        [nu, 1, 0],
        [0, 0, (1 - nu) / 2]
    ])

def _element_properties(
    request: AnalysisRequest,
    elem_idx: int,
    centroid: Tuple[float, float],
    base_E: float,
    base_h: float,
    base_q_kpa: float
) -> Tuple[float, float, float]:
    E_eff = request.elementElasticModuli[elem_idx] if (
        request.elementElasticModuli and elem_idx < len(request.elementElasticModuli)
    ) else base_E
    if E_eff < 1e9:
        E_eff *= 1000.0

    has_element_thickness = bool(request.elementThicknesses and elem_idx < len(request.elementThicknesses))
    h_eff = request.elementThicknesses[elem_idx] if has_element_thickness else base_h

    if not has_element_thickness and request.dropPanels:
        cx, cy = centroid
        for dp in request.dropPanels:
            if len(dp.vertices) >= 3 and _point_in_polygon(cx, cy, dp.vertices):
                h_eff += dp.drop

    q_kpa = request.elementLoads[elem_idx] if (
        request.elementLoads and elem_idx < len(request.elementLoads)
    ) else base_q_kpa

    return float(E_eff), float(h_eff), float(q_kpa) * 1000.0

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

def _perimeter_node_ids(mesh: FEMMesh) -> List[int]:
    """Return 1-indexed ids of nodes on the mesh boundary.

    An edge on the outer boundary is referenced by exactly one element;
    interior edges are shared by two. Used as a last-resort support set when
    a slab group has no columns or walls attached, so the model still solves
    instead of being skipped entirely.
    """
    edge_count: Dict[Tuple[int, int], int] = {}
    for elem in mesh.elements:
        nids = elem.nodeIds
        k = len(nids)
        if k < 3:
            continue
        for i in range(k):
            a, b = nids[i], nids[(i + 1) % k]
            if a == b:
                continue
            edge_count[(min(a, b), max(a, b))] = edge_count.get((min(a, b), max(a, b)), 0) + 1

    boundary: Set[int] = set()
    for (a, b), count in edge_count.items():
        if count == 1:
            boundary.add(a)
            boundary.add(b)
    return sorted(boundary)


def analyze_slab(request: AnalysisRequest) -> AnalysisResponse:
    t0 = time.time()
    mesh = _triangulate_mesh(request.mesh)
    nn = mesh.nodeCount
    ndof = nn * NDOF_PER_NODE

    if nn == 0 or not mesh.elements:
        return AnalysisResponse(success=False, error="Mesh is empty (no nodes or elements).")

    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])

    # Build element connectivity (0-indexed), enforce CCW orientation.
    # Degenerate elements (out-of-range ids, repeated nodes, ~zero area) are
    # dropped here: they contribute a singular element stiffness matrix and
    # would make the whole global solve fail. `valid_elements` keeps the
    # element list index-aligned with elem_nodes so per-element property
    # lookups (loads, thickness, E) stay correct.
    elem_nodes = []
    valid_elements = []
    dropped_elements = 0
    for tri in mesh.elements:
        nids = [nid - 1 for nid in tri.nodeIds]
        if len(nids) < 3 or any(n < 0 or n >= nn for n in nids) or len(set(nids)) < 3:
            dropped_elements += 1
            continue
        x0, y0 = nodes_xy[nids[0]]
        x1, y1 = nodes_xy[nids[1]]
        x2, y2 = nodes_xy[nids[2]]
        signed_area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(signed_area) < 1e-12:
            dropped_elements += 1
            continue
        if signed_area < 0:
            nids[1], nids[2] = nids[2], nids[1]
        elem_nodes.append(nids)
        valid_elements.append(tri)

    if not elem_nodes:
        return AnalysisResponse(
            success=False,
            error="All mesh elements were degenerate (zero area or duplicate nodes). Check the slab outline for self-intersections."
        )

    mesh = FEMMesh(
        nodes=mesh.nodes, elements=valid_elements,
        nodeCount=nn, elementCount=len(valid_elements)
    )
    ne = len(elem_nodes)

    # Material
    E = request.elasticModulus
    if E < 1e3:
        raise ValueError(f"elasticModulus={E:.2e} is implausibly low for concrete.")
    if E < 1e9:
        E = E * 1000.0  # Convert kPa to Pa

    nu = request.poissonRatio
    h = request.thickness

    # Assembly
    rows_list = []
    cols_list = []
    data_list = []
    f = np.zeros(ndof)
    q_base_kpa = request.uniformLoad + request.selfWeight
    line_tol = _mesh_line_tolerance(nodes_xy, elem_nodes)
    element_prop_cache = []

    # Precalculated constant DOF maps for 3-node shell elements
    cst_to_shell_idx = np.array([0, 1, 6, 7, 12, 13], dtype=np.int32)
    dkt_to_shell_idx = np.array([2, 3, 4, 8, 9, 10, 14, 15, 16], dtype=np.int32)

    for elem_idx, tri_nodes in enumerate(elem_nodes):
        xy = nodes_xy[tri_nodes]
        centroid = (float(np.mean(xy[:, 0])), float(np.mean(xy[:, 1])))
        E_elem, h_elem, q_elem = _element_properties(
            request, elem_idx, centroid, E, h, q_base_kpa
        )
        D_mat = _plate_D_matrix(E_elem, h_elem, nu)
        element_prop_cache.append((E_elem, h_elem, q_elem, D_mat))

        # CST membrane stiffness (6×6)
        Km = compute_cst_stiffness(xy, E_elem, nu, h_elem)
        # DKT bending stiffness (9×9)
        Kb = compute_dkt_stiffness(xy, D_mat)
        # Load vector (bending only — membrane loads are zero for flat slab)
        fe_bend = compute_element_load(xy, q_elem)

        # Assemble 18-DOF shell element DOFs
        dofs_elem = (NDOF_PER_NODE * np.array(tri_nodes)[:, None] + np.arange(NDOF_PER_NODE)).reshape(-1)

        # Assemble membrane stiffness
        nz_m = np.nonzero(Km)
        if len(nz_m[0]) > 0:
            rows_list.extend(dofs_elem[cst_to_shell_idx[nz_m[0]]])
            cols_list.extend(dofs_elem[cst_to_shell_idx[nz_m[1]]])
            data_list.extend(Km[nz_m])

        # Assemble bending load vector
        dkt_dofs = dofs_elem[dkt_to_shell_idx]
        for a in range(9):
            if fe_bend[a] != 0:
                if a % 3 == 0:
                    f[dkt_dofs[a]] -= fe_bend[a]
                else:
                    f[dkt_dofs[a]] += fe_bend[a]

        # Assemble bending stiffness
        nz_b = np.nonzero(Kb)
        if len(nz_b[0]) > 0:
            rows_list.extend(dofs_elem[dkt_to_shell_idx[nz_b[0]]])
            cols_list.extend(dofs_elem[dkt_to_shell_idx[nz_b[1]]])
            data_list.extend(Kb[nz_b])

        # Assemble drilling stiffness to prevent matrix singularity
        A = 0.5 * abs((xy[1,0]-xy[0,0])*(xy[2,1]-xy[0,1]) - (xy[2,0]-xy[0,0])*(xy[1,1]-xy[0,1]))
        k_drill = 1e-6 * E_elem * h_elem * A
        for nid in tri_nodes:
            dof_rz = NDOF_PER_NODE * nid + RZ
            rows_list.append(dof_rz)
            cols_list.append(dof_rz)
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
        tol_w = min(0.08, max(0.02, line_tol))
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
                mask = dists <= tol_w
                matched_indices = np.where(mask)[0]
                if len(matched_indices) == 0:
                    nearest_k = max(2, min(10, len(mesh.nodes)))
                    matched_indices = np.argsort(dists)[:nearest_k]
                for idx in matched_indices:
                    wall_node_ids_set.add(int(idx) + 1)  # 1-indexed

    for nid in wall_node_ids_set:
        wall_nodes_set.add(nid - 1)

    col_node_indices = []
    col_dims_map = {}
    col_heights_map = {}
    col_bcs_map = {}
    col_grades_map = {}
    col_node_ids = request.columnNodeIds or []
    col_widths = request.columnWidths or []
    col_depths = request.columnDepths or []
    col_stiffnesses = request.columnStiffnesses or []
    col_heights = request.columnHeights or []
    col_bcs = request.columnBoundaryConditions or []
    col_grades = request.columnGrades or []

    for ci, nid in enumerate(col_node_ids):
        nidx = nid - 1
        if 0 <= nidx < nn:
            col_node_indices.append(nidx)
            wcol = col_widths[ci] if ci < len(col_widths) else 0.3
            dcol = col_depths[ci] if ci < len(col_depths) else 0.3
            H = col_heights[ci] if (ci < len(col_heights) and col_heights[ci] > 0) else 3.0
            bc = col_bcs[ci] if ci < len(col_bcs) else "fixed-fixed"
            grd = col_grades[ci] if ci < len(col_grades) else "M25"
            col_dims_map[nidx] = (wcol, dcol)
            col_heights_map[nidx] = H
            col_bcs_map[nidx] = bc
            col_grades_map[nidx] = grd

    # Beam elements: discretize along mesh nodes and add 12x12 beam stiffness between adjacent node pairs
    if (len(request.beamNodeIdA) > 0 and len(request.beamNodeIdB) > 0
            and len(request.beamWidths) > 0 and len(request.beamDepths) > 0
            and len(request.beamElasticModuli) > 0):
        nu_beam = request.poissonRatio
        for b_idx in range(len(request.beamNodeIdA)):
            seg_nA = request.beamNodeIdA[b_idx] - 1
            seg_nB = request.beamNodeIdB[b_idx] - 1
            b_w = request.beamWidths[b_idx]
            b_d = request.beamDepths[b_idx]
            b_E = request.beamElasticModuli[b_idx]
            if seg_nA < 0 or seg_nB < 0 or seg_nA >= nn or seg_nB >= nn or seg_nA == seg_nB:
                continue

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

            # Beam self-weight load (downward gravity in W-DOF)
            w_beam_self = b_w * b_d * 25000.0  # N/m
            f[NDOF_PER_NODE * seg_nA + W] -= 0.5 * w_beam_self * L
            f[NDOF_PER_NODE * seg_nB + W] -= 0.5 * w_beam_self * L

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
            # Out-of-plane bending (local x-z plane: w, ry; matching DKT sign convention where θ_y = -∂w/∂x)
            EIy = b_E * Iy
            k_local[2, 2] = 12 * EIy / L**3
            k_local[2, 4] = -6 * EIy / L**2
            k_local[2, 8] = -12 * EIy / L**3
            k_local[2, 10] = -6 * EIy / L**2

            k_local[4, 2] = -6 * EIy / L**2
            k_local[4, 4] = 4 * EIy / L
            k_local[4, 8] = 6 * EIy / L**2
            k_local[4, 10] = 2 * EIy / L

            k_local[8, 2] = -12 * EIy / L**3
            k_local[8, 4] = 6 * EIy / L**2
            k_local[8, 8] = 12 * EIy / L**3
            k_local[8, 10] = 6 * EIy / L**2

            k_local[10, 2] = -6 * EIy / L**2
            k_local[10, 4] = 2 * EIy / L
            k_local[10, 8] = 6 * EIy / L**2
            k_local[10, 10] = 4 * EIy / L

            # In-plane bending (local x-y plane: v, rz)
            EIz = b_E * Iz
            k_local[1, 1] = 12 * EIz / L**3
            k_local[1, 5] = 6 * EIz / L**2
            k_local[1, 7] = -12 * EIz / L**3
            k_local[1, 11] = 6 * EIz / L**2

            k_local[5, 1] = 6 * EIz / L**2
            k_local[5, 5] = 4 * EIz / L
            k_local[5, 7] = -6 * EIz / L**2
            k_local[5, 11] = 2 * EIz / L

            k_local[7, 1] = -12 * EIz / L**3
            k_local[7, 5] = -6 * EIz / L**2
            k_local[7, 7] = 12 * EIz / L**3
            k_local[7, 11] = -6 * EIz / L**2

            k_local[11, 1] = 6 * EIz / L**2
            k_local[11, 5] = 2 * EIz / L
            k_local[11, 7] = -6 * EIz / L**2
            k_local[11, 11] = 4 * EIz / L

            # Beam centerline alignment (matching SAFE standard line beam without membrane lock)
            k_offset = k_local

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
    # KD-tree query instead of scanning every node per column: the old nested
    # loop was O(columns x nodes), which dominated runtime on large models.
    col_node_patches = {}
    # Column rotational and axial springs (anisotropic, applied at column support node)
    _GRADE_TABLE = {'M20': 20, 'M25': 25, 'M30': 30, 'M35': 35, 'M40': 40, 'M45': 45, 'M50': 50, 'M55': 55, 'M60': 60}
    for nidx in col_node_indices:
        wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
        H_col = col_heights_map.get(nidx, 3.0)
        bc_col = col_bcs_map.get(nidx, "fixed-fixed")
        grd_col = col_grades_map.get(nidx, "M25")
        if grd_col in _GRADE_TABLE:
            E_col = 5000.0 * math.sqrt(_GRADE_TABLE[grd_col]) * 1e6
        else:
            E_col = E

        A_col = wcol * dcol
        Ixx = wcol * dcol**3 / 12.0  # bending about X (rotation RX)
        Iyy = dcol * wcol**3 / 12.0  # bending about Y (rotation RY)

        col_factor = 3.0 if bc_col in ("pinned", "fixed-pinned") else 4.0

        kz_col = E_col * A_col / H_col
        kth_x = col_factor * E_col * Ixx / H_col
        kth_y = col_factor * E_col * Iyy / H_col

        dof_w = NDOF_PER_NODE * nidx + W
        dof_rx = NDOF_PER_NODE * nidx + RX
        dof_ry = NDOF_PER_NODE * nidx + RY

        rows_list.append(dof_w)
        cols_list.append(dof_w)
        data_list.append(kz_col)

        rows_list.append(dof_rx)
        cols_list.append(dof_rx)
        data_list.append(kth_x)

        rows_list.append(dof_ry)
        cols_list.append(dof_ry)
        data_list.append(kth_y)

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

    # Wall rotational springs (distributed along each wall segment for fixed walls)
    if (len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0
            and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0):
        wall_bcs_list = request.wallBoundaryConditions or []
        for w_idx in range(len(request.wallStartPoints)):
            w_bc = wall_bcs_list[w_idx] if w_idx < len(wall_bcs_list) else "fixed-fixed"
            # Simply-supported walls provide vertical support (w=0) only, no rotational stiffness
            if w_bc in ("simply-supported", "pinned"):
                continue

            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx]
            w_H = request.wallHeights[w_idx]

            wall_E = E
            if (hasattr(request, 'wallElasticModuli') and request.wallElasticModuli
                    and w_idx < len(request.wallElasticModuli) and request.wallElasticModuli[w_idx] > 0):
                wall_E = request.wallElasticModuli[w_idx]

            dx = w_end.x - w_start.x
            dy = w_end.y - w_start.y
            Lw = np.sqrt(dx**2 + dy**2)
            if Lw < 1e-6 or w_H < 1e-6:
                continue
            cos_a = dx / Lw
            sin_a = dy / Lw

            col_factor = 0.75 if w_bc in ("pinned", "fixed-pinned", "fixed-free") else 1.0
            # Wall out-of-plane flexural stiffness per unit length (calibrated to ETABS 3D shell walls with cracked modifier and joint flexibility)
            k_line = (col_factor * 0.0109 * wall_E * (w_t**3)) / (0.75 * w_H)

            # Find nodes along this wall segment
            tol_wall = min(0.08, max(0.02, line_tol))
            len2 = dx * dx + dy * dy
            t_all = ((nodes_xy[:, 0] - w_start.x) * dx + (nodes_xy[:, 1] - w_start.y) * dy) / len2
            in_range = (t_all >= -0.01) & (t_all <= 1.01)
            t_clamped = np.clip(t_all, 0.0, 1.0)
            px_all = w_start.x + t_clamped * dx
            py_all = w_start.y + t_clamped * dy
            near = np.hypot(nodes_xy[:, 0] - px_all, nodes_xy[:, 1] - py_all) <= tol_wall
            wall_seg_nodes = np.flatnonzero(in_range & near).tolist()

            if len(wall_seg_nodes) > 0:
                # Sort nodes along wall segment by projection parameter s
                s_coords = [t_clamped[nidx] * Lw for nidx in wall_seg_nodes]
                sorted_pairs = sorted(zip(s_coords, wall_seg_nodes))
                M = len(sorted_pairs)
                for k in range(M):
                    s_k, nidx = sorted_pairs[k]
                    s_left = (s_k + sorted_pairs[k - 1][0]) / 2.0 if k > 0 else 0.0
                    s_right = (s_k + sorted_pairs[k + 1][0]) / 2.0 if k < M - 1 else Lw
                    L_trib = max(0.01, s_right - s_left)
                    k_node = k_line * L_trib

                    dof_rx = NDOF_PER_NODE * nidx + RX
                    dof_ry = NDOF_PER_NODE * nidx + RY

                    rows_list.append(dof_rx)
                    cols_list.append(dof_rx)
                    data_list.append(k_node * (cos_a**2))

                    rows_list.append(dof_rx)
                    cols_list.append(dof_ry)
                    data_list.append(k_node * sin_a * cos_a)

                    rows_list.append(dof_ry)
                    cols_list.append(dof_rx)
                    data_list.append(k_node * sin_a * cos_a)

                    rows_list.append(dof_ry)
                    cols_list.append(dof_ry)
                    data_list.append(k_node * (sin_a**2))

    # Establish boundary conditions
    constrained_dofs = set()
    rigid_wall_nodes_set = set()
    if (len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0):
        wall_bcs_list = request.wallBoundaryConditions or []
        for w_idx in range(len(request.wallStartPoints)):
            w_bc = wall_bcs_list[w_idx] if w_idx < len(wall_bcs_list) else "fixed-fixed"
            if w_bc in ("rigid-fixed", "rigid"):
                w_start = request.wallStartPoints[w_idx]
                w_end = request.wallEndPoints[w_idx]
                dx = w_end.x - w_start.x
                dy = w_end.y - w_start.y
                L2 = dx * dx + dy * dy
                if L2 > 1e-12:
                    tol_rigid = min(0.08, max(0.02, line_tol))
                    t_raw = ((nodes_xy[:, 0] - w_start.x) * dx + (nodes_xy[:, 1] - w_start.y) * dy) / L2
                    t_clamped = np.clip(t_raw, 0.0, 1.0)
                    px = w_start.x + t_clamped * dx
                    py = w_start.y + t_clamped * dy
                    dists = np.hypot(nodes_xy[:, 0] - px, nodes_xy[:, 1] - py)
                    mask = dists <= tol_rigid
                    matched = np.where(mask)[0]
                    for nidx in matched:
                        rigid_wall_nodes_set.add(int(nidx))

    for n in range(nn):
        if n in wall_nodes_set:
            constrained_dofs.add(NDOF_PER_NODE * n + U)
            constrained_dofs.add(NDOF_PER_NODE * n + V)
            constrained_dofs.add(NDOF_PER_NODE * n + W)
        if n in rigid_wall_nodes_set:
            constrained_dofs.add(NDOF_PER_NODE * n + RX)
            constrained_dofs.add(NDOF_PER_NODE * n + RY)

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

    free_mask = np.ones(ndof, dtype=bool)
    if constrained_dofs:
        free_mask[np.fromiter(constrained_dofs, dtype=np.int64, count=len(constrained_dofs))] = False
    free_dofs = np.flatnonzero(free_mask)

    if free_dofs.size == 0:
        return AnalysisResponse(success=False, error="Every degree of freedom is constrained — nothing to solve.")

    # Convert directly to CSC for fast column/row slicing (completely bypasses LIL conversions!)
    K = coo_matrix((data_list, (rows_list, cols_list)), shape=(ndof, ndof)).tocsc()
    K_free = K[free_dofs, :][:, free_dofs]
    f_free = f[free_dofs]

    # spsolve returns an all-NaN/inf vector for a singular system *without*
    # raising, so checking the result is required — not just catching
    # exceptions. Otherwise NaNs propagate into deflections and the contour
    # renders as a single flat colour.
    def _try_solve(A, b):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                x = spsolve(A, b)
            return x if np.all(np.isfinite(x)) else None
        except Exception:
            return None

    u_free = _try_solve(K_free, f_free)
    if u_free is None:
        # Regularize for floating/unconnected elements or singular matrices.
        from scipy.sparse import identity
        K_reg = K_free + identity(K_free.shape[0], format="csc") * (1e-5 * E * h)
        u_free = _try_solve(K_reg, f_free)
    if u_free is None:
        return AnalysisResponse(
            success=False,
            error="Solver failed: the stiffness matrix is singular. This usually means part of the model is unsupported or disconnected from the supports."
        )
    solver_time = time.time() - t0

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
            wz=float(u[base + W]),  # negative downward (-ve), positive upward (+ve)
            rx=float(u[base + RX]),
            ry=float(u[base + RY]),
            rz=float(u[base + RZ])
        ))

    all_wz = [d.wz for d in node_deflections]
    min_wz = min(all_wz) if all_wz else 0.0
    max_wz = max(all_wz) if all_wz else 0.0

    # -------------------------------------------------------------
    # Element Bending Moments, Wood-Armer, SPR, Shears & Punching
    # -------------------------------------------------------------
    nodal_mx = [0.0] * nn
    nodal_my = [0.0] * nn
    nodal_mxy = [0.0] * nn
    nodal_area = [0.0] * nn

    raw_element_data = []

    for elem_idx, elem in enumerate(mesh.elements):
        nids = elem.nodeIds
        if len(nids) < 3:
            continue
        _, h_elem, _, D_elem = element_prop_cache[elem_idx] if elem_idx < len(element_prop_cache) else (
            E, h, q_base_kpa * 1000.0, _plate_D_matrix(E, h, nu)
        )
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

        mx = (D_elem[0, 0] * kappa_x + D_elem[0, 1] * kappa_y) / 1000.0
        my = (D_elem[1, 0] * kappa_x + D_elem[1, 1] * kappa_y) / 1000.0
        mxy = (D_elem[2, 2] * chi_xy) / 1000.0

        # Membrane strains & forces (CST, plane stress) — needed for stress output
        u1, v1 = u[NDOF_PER_NODE * (nids[0]-1) + U], u[NDOF_PER_NODE * (nids[0]-1) + V]
        u2, v2 = u[NDOF_PER_NODE * (nids[1]-1) + U], u[NDOF_PER_NODE * (nids[1]-1) + V]
        u3, v3 = u[NDOF_PER_NODE * (nids[2]-1) + U], u[NDOF_PER_NODE * (nids[2]-1) + V]
        du_dx = (b1 * u1 + b2 * u2 + b3 * u3) / twoA
        du_dy = (c1 * u1 + c2 * u2 + c3 * u3) / twoA
        dv_dx = (b1 * v1 + b2 * v2 + b3 * v3) / twoA
        dv_dy = (c1 * v1 + c2 * v2 + c3 * v3) / twoA
        eps_x = du_dx
        eps_y = dv_dy
        gamma_xy = du_dy + dv_dx

        C_mem = E_elem / (1.0 - nu ** 2)
        nx = (C_mem * (eps_x + nu * eps_y)) * h_elem / 1000.0
        ny = (C_mem * (eps_y + nu * eps_x)) * h_elem / 1000.0
        nxy = (C_mem * 0.5 * (1.0 - nu) * gamma_xy) * h_elem / 1000.0

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
            'E': E_elem, 'h': h_elem,
            'mx': mx, 'my': my, 'mxy': mxy,
            'nx': nx, 'ny': ny, 'nxy': nxy,
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
    element_membrane_forces = []
    element_stresses = []
    min_mx = min_my = min_mxy = min_vx = min_vy = float('inf')
    max_mx = max_my = max_mxy = max_vx = max_vy = float('-inf')
    min_nx = min_ny = min_nxy = float('inf')
    max_nx = max_ny = max_nxy = float('-inf')

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

        # Membrane forces (kN/m) — already computed from CST strains above
        nx_v, ny_v, nxy_v = ed['nx'], ed['ny'], ed['nxy']
        n1_v = 0.5 * (nx_v + ny_v) + math.hypot(0.5 * (nx_v - ny_v), nxy_v)
        n2_v = 0.5 * (nx_v + ny_v) - math.hypot(0.5 * (nx_v - ny_v), nxy_v)
        n_angle = 0.5 * math.degrees(math.atan2(2.0 * nxy_v, nx_v - ny_v)) if (abs(nx_v - ny_v) > 1e-12 or abs(nxy_v) > 1e-12) else 0.0
        element_membrane_forces.append(ElementMembraneForce(
            elementId=ed['id'],
            nx=round(nx_v, 4), ny=round(ny_v, 4), nxy=round(nxy_v, 4),
            n1=round(n1_v, 4), n2=round(n2_v, 4), angle=round(n_angle, 2)
        ))
        min_nx = min(min_nx, nx_v); max_nx = max(max_nx, nx_v)
        min_ny = min(min_ny, ny_v); max_ny = max(max_ny, ny_v)
        min_nxy = min(min_nxy, nxy_v); max_nxy = max(max_nxy, nxy_v)

        # Element stresses (MPa): combine membrane + bending at extreme fibers
        h_e = max(ed.get('h', h), 0.01)
        E_e = ed.get('E', E)
        sig_x = (nx_v * 1000.0 / h_e + 6.0 * ed['mx'] * 1000.0 / (h_e ** 2)) / 1e6
        sig_y = (ny_v * 1000.0 / h_e + 6.0 * ed['my'] * 1000.0 / (h_e ** 2)) / 1e6
        tau_xy = (nxy_v * 1000.0 / h_e + 6.0 * ed['mxy'] * 1000.0 / (h_e ** 2)) / 1e6
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

    column_punching = []
    d_eff = max(0.05, h - 0.03)
    fck = 25.0
    vc_capacity = 0.25 * math.sqrt(fck)

    for ci, nidx in enumerate(col_node_indices):
        w_def = u[NDOF_PER_NODE * nidx + W]
        wcol = col_widths[ci] if ci < len(col_widths) else 0.3
        dcol = col_depths[ci] if ci < len(col_depths) else 0.3
        H_col = col_heights_map.get(nidx, 3.0)
        k_spring = E * (wcol * dcol) / H_col
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
        minWz=round(min_wz, 10),
        maxWz=round(max_wz, 10),
        minMx=round(min_mx, 4), maxMx=round(max_mx, 4),
        minMy=round(min_my, 4), maxMy=round(max_my, 4),
        minMxy=round(min_mxy, 4), maxMxy=round(max_mxy, 4),
        minVx=round(min_vx, 3), maxVx=round(max_vx, 3),
        minVy=round(min_vy, 3), maxVy=round(max_vy, 3),
        minNx=round(min_nx, 4), maxNx=round(max_nx, 4),
        minNy=round(min_ny, 4), maxNy=round(max_ny, 4),
        minNxy=round(min_nxy, 4), maxNxy=round(max_nxy, 4),
        solverTime=round(solver_time, 4),
    )


def solve_multi_slab_dkt(request: MultiSlabAnalysisRequest) -> MultiSlabAnalysisResponse:
    from mesher import generate_mesh
    from models import MeshRequest
    from utils import (
        UnionFind, _find_column_supports, _find_wall_node_ids,
        _find_beam_node_ids, _slabs_touch
    )

    if not request.slabs:
        return MultiSlabAnalysisResponse(success=True, results=[])

    def _wall_data():
        return (
            [getattr(w, "startPoint") for w in request.walls],
            [getattr(w, "endPoint") for w in request.walls],
            [getattr(w, "thickness", 0.25) for w in request.walls],
            [getattr(w, "height", 3.0) for w in request.walls],
            [getattr(w, "boundaryCondition", "fixed-fixed") for w in request.walls],
            [getattr(w, "elasticModulus", 25e9) for w in request.walls],
        )

    def _copy_moment(em: ElementMoment, element_id: int) -> ElementMoment:
        return ElementMoment(
            elementId=element_id,
            mx=em.mx, my=em.my, mxy=em.mxy,
            m1=em.m1, m2=em.m2, angle=em.angle,
            mxd_pos=em.mxd_pos, myd_pos=em.myd_pos,
            mxd_neg=em.mxd_neg, myd_neg=em.myd_neg,
            spr_mx=em.spr_mx, spr_my=em.spr_my, spr_mxy=em.spr_mxy,
            ast_x_bot=em.ast_x_bot, ast_y_bot=em.ast_y_bot,
            ast_x_top=em.ast_x_top, ast_y_top=em.ast_y_top,
        )

    def _copy_shear(es: ElementShear, element_id: int) -> ElementShear:
        return ElementShear(
            elementId=element_id,
            vx=es.vx, vy=es.vy, v1=es.v1, angle=es.angle,
        )

    results = []
    warnings_list = []
    disconnected_ids: List[str] = []

    uf = UnionFind(set(range(len(request.slabs))))
    for i in range(len(request.slabs)):
        for j in range(i + 1, len(request.slabs)):
            mesh_size = request.slabs[i].meshSize or request.slabs[j].meshSize or request.meshSize or 0.5
            if _slabs_touch(
                request.slabs[i].geometry.vertices,
                request.slabs[j].geometry.vertices,
                tol=max(0.15, mesh_size * 0.75),
            ):
                uf.union(i, j)

    components: Dict[int, List[int]] = {}
    for i in range(len(request.slabs)):
        components.setdefault(uf.find(i), []).append(i)

    wall_spts, wall_epts, wall_thk, wall_hgt, wall_bcs, wall_elastic = _wall_data()

    for component_indices in components.values():
        try:
            sub_meshes = []
            for slab_idx in component_indices:
                item = request.slabs[slab_idx]
                mesh_sizes = [item.meshSize or request.meshSize, 0.3, 0.2, 0.15]
                mesh = None
                for ms in mesh_sizes:
                    mesh_req = MeshRequest(geometry=item.geometry, meshSize=ms)
                    mesh = generate_mesh(mesh_req)
                    if mesh and mesh.elementCount > 0:
                        break
                if mesh is None or mesh.elementCount == 0:
                    warnings_list.append(f"Slab '{item.slabId}' could not be meshed.")
                    disconnected_ids.append(item.slabId)
                else:
                    sub_meshes.append((slab_idx, item, mesh))

            if not sub_meshes:
                continue

            if len(sub_meshes) == 1:
                slab_idx, item, mesh = sub_meshes[0]
                slab_polys = [item.geometry.vertices]
                mesh_size = item.meshSize or request.meshSize
                combined_mesh = mesh
                node_origin = {(0, n.id): n.id for n in mesh.nodes}
                elem_origin: Dict[int, Tuple[int, int]] = {
                    analysis_eid: (0, elem.id)
                    for analysis_eid, elem in enumerate(mesh.elements, start=1)
                }
                global_to_local_node = {n.id: n.id for n in mesh.nodes}
                group = [(slab_idx, item, mesh)]
            else:
                group = sub_meshes
                slab_polys = [item.geometry.vertices for _, item, _ in group]
                mesh_size = request.meshSize or group[0][1].meshSize or 0.5

                node_refs: List[Tuple[int, int, float, float]] = []
                for local_group_idx, (_, _, sm) in enumerate(group):
                    for n in sm.nodes:
                        node_refs.append((local_group_idx, n.id, n.x, n.y))

                merge_tol = max(0.05, min(0.20, mesh_size * 0.25))
                global_nodes = []
                node_origin: Dict[Tuple[int, int], int] = {}
                next_gid = 1

                # Build KD-Tree for O(n log n) spatial merge
                coords = np.array([[x, y] for _, _, x, y in node_refs])
                tree = cKDTree(coords)
                neighbors = tree.query_ball_tree(tree, merge_tol)
                visited = np.zeros(len(node_refs), dtype=bool)

                for i in range(len(node_refs)):
                    if visited[i]:
                        continue
                    local_group_idx_i = node_refs[i][0]
                    cluster = [i]
                    # Only merge nodes from DIFFERENT sub-meshes
                    for j in neighbors[i]:
                        if j > i and not visited[j] and node_refs[j][0] != local_group_idx_i:
                            cluster.append(j)

                    avg_x = float(np.mean(coords[cluster, 0]))
                    avg_y = float(np.mean(coords[cluster, 1]))
                    global_nodes.append(FEMNode(id=next_gid, x=avg_x, y=avg_y))
                    for c in cluster:
                        visited[c] = True
                        c_group_idx, c_old_nid, _, _ = node_refs[c]
                        node_origin[(c_group_idx, c_old_nid)] = next_gid
                    next_gid += 1

                global_elements = []
                elem_origin: Dict[int, Tuple[int, int]] = {}
                next_eid = 1
                for local_group_idx, (_, _, sm) in enumerate(group):
                    for elem in sm.elements:
                        gnids = [
                            node_origin[(local_group_idx, nid)]
                            for nid in elem.nodeIds
                            if (local_group_idx, nid) in node_origin
                        ]
                        gnids = list(dict.fromkeys(gnids))
                        if len(gnids) >= 3:
                            global_elements.append(Triangle(id=next_eid, nodeIds=gnids[:3]))
                            elem_origin[next_eid] = (local_group_idx, elem.id)
                            next_eid += 1

                combined_mesh = FEMMesh(
                    nodes=global_nodes,
                    elements=global_elements,
                    nodeCount=len(global_nodes),
                    elementCount=len(global_elements),
                )
                global_to_local_node = {}

            col_nids, col_w, col_d, col_h, col_sh, col_di, col_gr, col_bc = _find_column_supports(
                combined_mesh, request.columns, slab_polys
            )
            wall_nids = _find_wall_node_ids(combined_mesh, request.walls, mesh_size=mesh_size)
            b_nA, b_nB, b_w, b_d, b_E = _find_beam_node_ids(
                combined_mesh, request.beams, mesh_size=mesh_size
            )

            if not col_nids and not wall_nids:
                # No explicit supports found. Rather than skipping the group
                # outright (which leaves the user with no results at all),
                # fall back to supporting the slab-group perimeter. The soft
                # ground springs assembled per element keep the system
                # non-singular; the perimeter constraint gives a physically
                # meaningful "supported on its edges" answer and we warn.
                names = ", ".join(item.slabId for _, item, _ in group)
                perimeter_nids = _perimeter_node_ids(combined_mesh)
                if perimeter_nids:
                    wall_nids = perimeter_nids
                    warnings_list.append(
                        f"Slab group [{names}] has no connected column or wall supports. "
                        f"Analyzed with its outer boundary treated as simply supported — "
                        f"place columns/walls inside the slab for accurate results."
                    )
                else:
                    warnings_list.append(f"Slab group [{names}] has no supports and could not be analyzed.")
                    disconnected_ids.extend(item.slabId for _, item, _ in group)
                    continue

            primary = group[0][1]
            element_loads = []
            element_thicknesses = []
            element_elastic_moduli = []
            for eid in range(1, combined_mesh.elementCount + 1):
                local_group_idx, _ = elem_origin[eid]
                item = group[local_group_idx][1]
                element_loads.append((item.uniformLoad or 0.0) + (item.selfWeight or 0.0))
                element_thicknesses.append(item.thickness)
                element_elastic_moduli.append(item.elasticModulus)

            analysis_req = AnalysisRequest(
                mesh=combined_mesh,
                thickness=primary.thickness,
                elasticModulus=primary.elasticModulus,
                poissonRatio=primary.poissonRatio,
                uniformLoad=primary.uniformLoad,
                selfWeight=primary.selfWeight,
                elementLoads=element_loads,
                elementThicknesses=element_thicknesses,
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
                wallElasticModuli=wall_elastic,
                wallBoundaryConditions=wall_bcs,
                beamNodeIdA=b_nA,
                beamNodeIdB=b_nB,
                beamWidths=b_w,
                beamDepths=b_d,
                beamElasticModuli=b_E,
                dropPanels=request.dropPanels,
                partitionWallSegments=request.partitionWallSegments,
            )

            result = analyze_slab(analysis_req)
            if not result.success:
                names = ", ".join(item.slabId for _, item, _ in group)
                warnings_list.append(f"Analysis failed for slab group [{names}]: {result.error}")
                disconnected_ids.extend(item.slabId for _, item, _ in group)
                continue

            global_def = {d.nodeId: d for d in result.nodeDeflections}
            global_mom = {m.elementId: m for m in result.elementMoments}
            global_shear = {s.elementId: s for s in result.elementShears}

            elem_ids_by_group: Dict[int, List[Tuple[int, int]]] = {}
            for geid, (local_group_idx, local_eid) in elem_origin.items():
                elem_ids_by_group.setdefault(local_group_idx, []).append((geid, local_eid))

            for local_group_idx, (_, item, sm) in enumerate(group):
                node_deflections = []
                for n in sm.nodes:
                    gnid = node_origin.get((local_group_idx, n.id), global_to_local_node.get(n.id))
                    if gnid in global_def:
                        gd = global_def[gnid]
                        node_deflections.append(NodeDeflection(
                            nodeId=n.id,
                            u=gd.u, v=gd.v, wz=gd.wz,
                            rx=gd.rx, ry=gd.ry, rz=gd.rz,
                        ))

                element_moments = []
                element_shears = []
                for geid, local_eid in elem_ids_by_group.get(local_group_idx, []):
                    if geid in global_mom:
                        element_moments.append(_copy_moment(global_mom[geid], local_eid))
                    if geid in global_shear:
                        element_shears.append(_copy_shear(global_shear[geid], local_eid))

                wz_vals = [d.wz for d in node_deflections]
                mx_vals = [m.mx for m in element_moments]
                my_vals = [m.my for m in element_moments]
                mxy_vals = [m.mxy for m in element_moments]
                vx_vals = [s.vx for s in element_shears]
                vy_vals = [s.vy for s in element_shears]

                sub_res = AnalysisResponse(
                    success=True,
                    nodeDeflections=node_deflections,
                    elementMoments=element_moments,
                    elementShears=element_shears,
                    minWz=min(wz_vals) if wz_vals else 0.0,
                    maxWz=max(abs(w) for w in wz_vals) if wz_vals else 0.0,
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
                    solverTime=result.solverTime,
                )
                results.append(SlabAnalysisResult(slabId=item.slabId, mesh=sm, result=sub_res))
        except Exception as exc:
            names = ", ".join(request.slabs[i].slabId for i in component_indices)
            warnings_list.append(f"Error solving slab group [{names}]: {str(exc)}")
            disconnected_ids.extend(request.slabs[i].slabId for i in component_indices)

    return MultiSlabAnalysisResponse(
        success=len(results) > 0,
        results=results,
        warnings=warnings_list,
        disconnectedIds=sorted(set(disconnected_ids)),
    )
