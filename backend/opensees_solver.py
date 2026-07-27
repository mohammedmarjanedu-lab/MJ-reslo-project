import numpy as np
import openseespy.opensees as ops
import time
import warnings
import logging
import sys
import io
from typing import List, Tuple
from scipy.spatial import cKDTree

logger = logging.getLogger("uvicorn")
from models import FEMMesh, Triangle, Point2D
from models import (
    AnalysisRequest, AnalysisResponse,
    NodeDeflection, ElementMoment, ElementStress, ElementShear,
    ElementMembraneForce, PunchingStress
)

def _rect_torsion_constant(b: float, d: float) -> float:
    """Saint-Venant torsional constant (J) for a rectangular section."""
    w = min(b, d)
    h = max(b, d)
    if w < 1e-12 or h < 1e-12:
        return 0.0
    r = w / h
    return h * w**3 * (1/3 - 0.21 * r * (1 - r**4 / 12))

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

def _build_model(request: AnalysisRequest, nodes_xy, nn, elem_nodes, col_node_indices, col_dims_map, col_node_patches, slave_nodes, wall_node_ids_set, elem_thicknesses, G_val, h, E, nu, lateral_cr_mode: bool = False):
    ops.wipe()
    ops.model('basic', '-ndm', 3, '-ndf', 6)
    ops.constraints('Transformation')

    # Collect all nodes that are part of elements or supports to identify isolated nodes
    connected_nodes = set()
    for tri in elem_nodes:
        connected_nodes.add(tri[0] + 1)
        connected_nodes.add(tri[1] + 1)
        connected_nodes.add(tri[2] + 1)
    if hasattr(request, 'beamNodeIdA') and request.beamNodeIdA and request.beamNodeIdB:
        for b_idx in range(len(request.beamNodeIdA)):
            connected_nodes.add(request.beamNodeIdA[b_idx])
            connected_nodes.add(request.beamNodeIdB[b_idx])
    for nidx in col_node_indices:
        connected_nodes.add(nidx + 1)

    node_fixities = {}

    # 1. Add nodes
    for node in request.mesh.nodes:
        ops.node(node.id, node.x, node.y, 0.0)
        node_fixities[node.id] = [0, 0, 0, 0, 0, 0]
        if node.id not in connected_nodes and node.id not in slave_nodes:
            # Completely isolated node (e.g. wall/beam endpoint outside slab). Fully fix to prevent singularity.
            node_fixities[node.id] = [1, 1, 1, 1, 1, 1]
        elif not lateral_cr_mode:
            if node.id not in slave_nodes:
                # ShellDKGT lacks drilling stiffness (Rz). Fix Rz in gravity mode to prevent singularity.
                node_fixities[node.id][5] = 1

    # 2. Columns Setup
    for col_idx, nidx in enumerate(col_node_indices):
        master_id = nidx + 1
        wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
        xc, yc = nodes_xy[nidx]
        col_H = request.columnHeights[col_idx] if col_idx < len(request.columnHeights) else 3.0
        if col_H < 1e-6:
            col_H = 3.0
            
        base_node_id = col_idx + 1000001
        ops.node(base_node_id, xc, yc, -col_H)
        node_fixities[base_node_id] = [1, 1, 1, 1, 1, 1]  # Fixed at the base
        
        # Column element stiffness
        col_grade = request.columnGrades[col_idx] if (hasattr(request, 'columnGrades') and request.columnGrades and col_idx < len(request.columnGrades)) else "M25"
        fck = float(col_grade.replace("M", "")) if col_grade.startswith("M") else 25.0
        E_col = 5000.0 * np.sqrt(fck) * 1e6
        nu_col = 0.2
        G_col = E_col / (2 * (1 + nu_col))
        
        shape = request.columnShapes[col_idx] if col_idx < len(request.columnShapes) else "rectangular"
        if shape == "circular":
            diameter = request.columnDiameters[col_idx] if col_idx < len(request.columnDiameters) else 0.5
            Ac = np.pi * diameter**2 / 4
            Iy = np.pi * diameter**4 / 64
            Iz = Iy
            Jc = np.pi * diameter**4 / 32
        else:
            Ac = wcol * dcol
            Iy = wcol * dcol**3 / 12
            Iz = dcol * wcol**3 / 12
            Jc = _rect_torsion_constant(wcol, dcol)
            
        col_transf_tag = col_idx + 1000000
        col_ele_tag = col_idx + 3000001
        
        ops.geomTransf('Linear', col_transf_tag, 0.0, 1.0, 0.0)
        ops.element('elasticBeamColumn', col_ele_tag, base_node_id, master_id, Ac, E_col, G_col, Jc, Iy, Iz, col_transf_tag)

        if not lateral_cr_mode:
            if master_id not in slave_nodes:
                if master_id not in node_fixities:
                    node_fixities[master_id] = [0, 0, 0, 0, 0, 0]
                # Note: The base node (base_node_id) is fully fixed [1,1,1,1,1,1].
                # The elasticBeamColumn provides the vertical and bending stiffness to the slab.

    # Column footprint rigid links (with duplicate prevention)
    already_linked = set()
    for nidx, patch in col_node_patches.items():
        master_id = nidx + 1
        for n in patch:
            slave_id = n + 1
            if slave_id != master_id:
                if slave_id not in already_linked:
                    ops.rigidLink('beam', master_id, slave_id)
                    already_linked.add(slave_id)

    # 3. Walls Setup
    if not lateral_cr_mode:
        # Gravity mode: rigid translational constraints for all wall nodes
        for nid in wall_node_ids_set:
            if nid not in slave_nodes:
                if nid not in node_fixities:
                    node_fixities[nid] = [0, 0, 0, 0, 0, 0]
                node_fixities[nid][0] = 1  # Ux
                node_fixities[nid][1] = 1  # Uy
                node_fixities[nid][2] = 1  # Uz

        # Rotational fixities (Rx, Ry) for fixed shear wall boundaries
        if hasattr(request, 'wallBoundaryConditions') and request.wallBoundaryConditions and hasattr(request, 'wallStartPoints') and request.wallStartPoints:
            for w_idx, bc in enumerate(request.wallBoundaryConditions):
                if bc in ('fixed-fixed', 'fixed-free', 'fixed') and w_idx < len(request.wallStartPoints) and w_idx < len(request.wallEndPoints):
                    w_start = request.wallStartPoints[w_idx]
                    w_end = request.wallEndPoints[w_idx]
                    w_nodes = find_nodes_near_segment(nodes_xy, (w_start.x, w_start.y), (w_end.x, w_end.y), tol=0.05)
                    for nid in w_nodes:
                        if nid not in slave_nodes and nid in node_fixities:
                            node_fixities[nid][3] = 1  # Rx
                            node_fixities[nid][4] = 1  # Ry
    else:
        # CR mode: equivalent pier model of the walls (wide-column frame method)
        if (len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0
                and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0):
            for w_idx in range(len(request.wallStartPoints)):
                w_start = request.wallStartPoints[w_idx]
                w_end = request.wallEndPoints[w_idx]
                w_t = request.wallThicknesses[w_idx]
                w_H = request.wallHeights[w_idx]
                dx = w_end.x - w_start.x
                dy = w_end.y - w_start.y
                Lw = np.sqrt(dx**2 + dy**2)
                if Lw < 1e-6 or w_H < 1e-6:
                    continue
                cos_a = dx / Lw
                sin_a = dy / Lw
                
                wall_seg_nodes = find_nodes_near_segment(nodes_xy, (w_start.x, w_start.y), (w_end.x, w_end.y), tol=0.05)
                
                if len(wall_seg_nodes) > 0:
                    xc = (w_start.x + w_end.x) / 2.0
                    yc = (w_start.y + w_end.y) / 2.0
                    
                    wall_master_id = 5000000 + w_idx
                    wall_base_id = 6000000 + w_idx
                    
                    ops.node(wall_master_id, xc, yc, 0.0)
                    ops.node(wall_base_id, xc, yc, -w_H)
                    node_fixities[wall_base_id] = [1, 1, 1, 1, 1, 1]
                    
                    Ac = w_t * Lw
                    Iy = w_t * Lw**3 / 12
                    Iz = Lw * w_t**3 / 12
                    Jc = _rect_torsion_constant(w_t, Lw)
                    
                    E_wall = E
                    G_wall = G_val
                    
                    # Shear areas for Timoshenko beam (5/6 * Area)
                    Avy = (5.0 / 6.0) * Ac
                    Avz = (5.0 / 6.0) * Ac
                    
                    wall_transf_tag = 7000000 + w_idx
                    ops.geomTransf('Linear', wall_transf_tag, cos_a, sin_a, 0.0)
                    
                    wall_ele_tag = 8000000 + w_idx
                    # Use ElasticTimoshenkoBeam to account for shear deformation
                    ops.element('ElasticTimoshenkoBeam', wall_ele_tag, wall_base_id, wall_master_id, E_wall, G_wall, Ac, Jc, Iy, Iz, Avy, Avz, wall_transf_tag)
                    
                    # Connect wall segment nodes to the pier centroid via rigid links
                    for nid in wall_seg_nodes:
                        if nid not in slave_nodes and nid not in already_linked:
                            ops.rigidLink('beam', wall_master_id, nid)
                            already_linked.add(nid)
        else:
            # Fall back to horizontal fixed constraints if no geometric wall points are provided (e.g. in test suites)
            for nid in wall_node_ids_set:
                if nid not in slave_nodes:
                    if nid not in node_fixities:
                        node_fixities[nid] = [0, 0, 0, 0, 0, 0]
                    node_fixities[nid][0] = 1
                    node_fixities[nid][1] = 1
                    node_fixities[nid][2] = 1

    # Equal DOF constraints (e.g., for C0-only hinged slab joints)
    if hasattr(request, 'equalDofConstraints') and request.equalDofConstraints:
        for eq_c in request.equalDofConstraints:
            if eq_c.nodeIdA and eq_c.nodeIdB and eq_c.dofs:
                ops.equalDOF(int(eq_c.nodeIdA), int(eq_c.nodeIdB), *[int(d) for d in eq_c.dofs])

    # 4. Slab Shell elements Setup
    sections_map = {}
    sec_counter = 1

    for elem_idx, tri_nodes in enumerate(elem_nodes):
        elem_id = elem_idx + 1
        h_eff = elem_thicknesses.get(elem_idx, h)
        E_eff = request.elementElasticModuli[elem_idx] if (request.elementElasticModuli and elem_idx < len(request.elementElasticModuli)) else E

        sec_key = (round(h_eff, 4), round(E_eff, -4))
        if sec_key not in sections_map:
            sec_tag = sec_counter
            sec_counter += 1
            sections_map[sec_key] = sec_tag
            ops.section('ElasticMembranePlateSection', sec_tag, E_eff, nu, h_eff, 0.0)
        else:
            sec_tag = sections_map[sec_key]

        ops.element('ShellDKGT', elem_id, tri_nodes[0] + 1, tri_nodes[1] + 1, tri_nodes[2] + 1, sec_tag)

    # 5. Beam elements Setup
    beam_forces = {}
    if (len(request.beamNodeIdA) > 0 and len(request.beamNodeIdB) > 0
            and len(request.beamWidths) > 0 and len(request.beamDepths) > 0
            and len(request.beamElasticModuli) > 0):
        for b_idx in range(len(request.beamNodeIdA)):
            nA = request.beamNodeIdA[b_idx]
            nB = request.beamNodeIdB[b_idx]
            b_w = request.beamWidths[b_idx]
            b_d = request.beamDepths[b_idx]
            b_E = request.beamElasticModuli[b_idx]
            if nA == nB:
                continue
            ptA = nodes_xy[nA - 1]
            ptB = nodes_xy[nB - 1]
            dx_beam = ptB[0] - ptA[0]
            dy_beam = ptB[1] - ptA[1]
            L_beam = np.hypot(dx_beam, dy_beam)
            if L_beam < 1e-6:
                continue
            beam_nodes = find_nodes_near_segment_with_t(nodes_xy, ptA, ptB, tol=0.01)
            beam_nodes.sort(key=lambda item: item[0])
            # Filter out nodes that are too close along the beam axis to prevent ill-conditioned tiny elements
            filtered_nodes = []
            for item in beam_nodes:
                if not filtered_nodes or (item[0] - filtered_nodes[-1][0]) * L_beam > 0.05:
                    filtered_nodes.append(item)
            beam_nodes = filtered_nodes

            A_sect = b_w * b_d
            Iy = b_w * b_d**3 / 12
            Iz = b_d * b_w**3 / 12
            J_sect = _rect_torsion_constant(b_w, b_d)
            G_beam = b_E / (2 * (1 + nu))
            e_z = 0.5 * (b_d - h)
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
                beam_transf_tag = b_idx * 1000 + i + 7000000
                beam_ele_tag = b_idx * 1000 + i + 8000000
                ops.geomTransf('Linear', beam_transf_tag, 0.0, 0.0, 1.0,
                                '-jntOffset', 0.0, 0.0, -e_z, 0.0, 0.0, -e_z)
                ops.element('elasticBeamColumn', beam_ele_tag, n_start_id, n_end_id, A_sect, b_E, G_beam, J_sect, Iy, Iz, beam_transf_tag)

    # Ensure numerical stability by identifying floating/unsupported components using Union-Find
    class UnionFind:
        def __init__(self, elements):
            self.parent = {x: x for x in elements}
        def find(self, x):
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
        def union(self, x, y):
            rx = self.find(x)
            ry = self.find(y)
            if rx != ry:
                self.parent[rx] = ry

    all_node_ids = set()
    for node in request.mesh.nodes:
        all_node_ids.add(node.id)
    for col_idx in range(len(col_node_indices)):
        all_node_ids.add(col_idx + 1000001)
    
    if lateral_cr_mode and len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0 and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0:
        for w_idx in range(len(request.wallStartPoints)):
            all_node_ids.add(5000000 + w_idx)
            all_node_ids.add(6000000 + w_idx)

    uf = UnionFind(all_node_ids)

    # 1. Union triangle mesh element connections
    for tri in elem_nodes:
        n0, n1, n2 = tri[0] + 1, tri[1] + 1, tri[2] + 1
        uf.union(n0, n1)
        uf.union(n1, n2)

    # 2. Union beam segment connections
    if len(request.beamNodeIdA) > 0 and len(request.beamNodeIdB) > 0:
        for b_idx in range(len(request.beamNodeIdA)):
            nA = request.beamNodeIdA[b_idx]
            nB = request.beamNodeIdB[b_idx]
            if nA == nB:
                continue
            ptA = nodes_xy[nA - 1]
            ptB = nodes_xy[nB - 1]
            dx_beam = ptB[0] - ptA[0]
            dy_beam = ptB[1] - ptA[1]
            L_beam = np.hypot(dx_beam, dy_beam)
            if L_beam < 1e-6:
                continue
            beam_nodes = find_nodes_near_segment_with_t(nodes_xy, ptA, ptB, tol=0.01)
            beam_nodes.sort(key=lambda item: item[0])
            filtered_nodes = []
            for item in beam_nodes:
                if not filtered_nodes or (item[0] - filtered_nodes[-1][0]) * L_beam > 0.05:
                    filtered_nodes.append(item)
            beam_nodes = filtered_nodes
            for i in range(len(beam_nodes) - 1):
                uf.union(beam_nodes[i][1], beam_nodes[i + 1][1])

    # 3. Union column connections
    for col_idx, nidx in enumerate(col_node_indices):
        master_id = nidx + 1
        base_node_id = col_idx + 1000001
        uf.union(master_id, base_node_id)
        patch = col_node_patches.get(nidx, [])
        for p_nid in patch:
            uf.union(master_id, p_nid + 1)

    # 4. Union wall connections
    if lateral_cr_mode:
        if len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0 and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0:
            for w_idx in range(len(request.wallStartPoints)):
                w_start = request.wallStartPoints[w_idx]
                w_end = request.wallEndPoints[w_idx]
                w_H = request.wallHeights[w_idx]
                dx = w_end.x - w_start.x
                dy = w_end.y - w_start.y
                Lw = np.hypot(dx, dy)
                if Lw < 1e-6 or w_H < 1e-6:
                    continue
                wall_seg_nodes = find_nodes_near_segment(nodes_xy, (w_start.x, w_start.y), (w_end.x, w_end.y), tol=0.25)
                if len(wall_seg_nodes) > 0:
                    wall_master_id = 5000000 + w_idx
                    wall_base_id = 6000000 + w_idx
                    uf.union(wall_master_id, wall_base_id)
                    for nid in wall_seg_nodes:
                        uf.union(wall_master_id, nid)

    # 5. Union equalDOF constraints (e.g. C0 hinges and multi-slab interface constraints)
    if hasattr(request, 'equalDofConstraints') and request.equalDofConstraints:
        for eq_c in request.equalDofConstraints:
            if eq_c.nodeIdA and eq_c.nodeIdB:
                uf.union(int(eq_c.nodeIdA), int(eq_c.nodeIdB))

    # Collect roots of components that have at least one supported node
    supported_roots = set()
    for nid in all_node_ids:
        is_sup = False
        if nid >= 1000001:
            is_sup = True # Column bases or wall bases (fixed to ground)
        else:
            fix = node_fixities.get(nid, [0,0,0,0,0,0])
            if fix[0] == 1 or fix[1] == 1 or fix[2] == 1:
                is_sup = True
        if is_sup:
            supported_roots.add(uf.find(nid))

    # Apply full constraints to all nodes in completely unsupported components
    unsupported_count = 0
    for nid in all_node_ids:
        root = uf.find(nid)
        if root not in supported_roots:
            node_fixities[nid] = [1, 1, 1, 1, 1, 1]
            unsupported_count += 1
    if unsupported_count > 0:
        logger.warning(f"Solver stabilized: fully fixed {unsupported_count} unsupported/floating nodes to prevent singular matrix error.")

    # Apply all collected constraints exactly once per node to prevent duplicate SP constraint errors
    drilling_fixed = 0
    for nid, fixs in node_fixities.items():
        if any(fixs):
            ops.fix(nid, *fixs)
            if fixs[5] == 1:
                drilling_fixed += 1
    logger.info(f"Built model: {len(node_fixities)} nodes constrained, {drilling_fixed} with drilling (Rz) fix")

    return beam_forces

def _calculate_cr_analytical(request: AnalysisRequest) -> Tuple[float, float]:
    """Calculate Center of Rigidity using pure analytical stiffness formulation (no OpenSeesPy) assembled about the CM."""
    nodes_map = {n.id: n for n in request.mesh.nodes}
    
    # 1. Compute Center of Mass (CM)
    W_slab = 0.0
    slab_cx_sum = 0.0
    slab_cy_sum = 0.0
    
    concrete_density = 25000.0  # N/m³ (concreteDensity = 25 kN/m³)
    t_slab = request.thickness  # thickness in m
    slab_self_weight = concrete_density * t_slab
    
    for tri in request.mesh.elements:
        n1 = nodes_map[tri.nodeIds[0]]
        n2 = nodes_map[tri.nodeIds[1]]
        n3 = nodes_map[tri.nodeIds[2]]
        
        # Area of triangle = 0.5 * |x1(y2-y3) + x2(y3-y1) + x3(y1-y2)|
        area = 0.5 * abs(n1.x * (n2.y - n3.y) + n2.x * (n3.y - n1.y) + n3.x * (n1.y - n2.y))
        xc = (n1.x + n2.x + n3.x) / 3.0
        yc = (n1.y + n2.y + n3.y) / 3.0
        
        # Check if triangle centroid falls inside a drop panel
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
        H = request.columnHeights[i] if i < len(request.columnHeights) else 3.0
        w = request.columnWidths[i] if i < len(request.columnWidths) else 0.3
        d = request.columnDepths[i] if i < len(request.columnDepths) else 0.3
        shape = request.columnShapes[i] if i < len(request.columnShapes) else "rectangular"
        diameter = request.columnDiameters[i] if i < len(request.columnDiameters) else 0.5
        
        if shape == "circular":
            col_area = np.pi * diameter**2 / 4.0
        else:
            col_area = w * d
        weight_col = concrete_density * col_area * H
        
        W_total += weight_col
        CM_num_x += weight_col * node.x
        CM_num_y += weight_col * node.y
        
    # Walls weights
    if (len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0
            and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_t = request.wallThicknesses[w_idx]
            w_H = request.wallHeights[w_idx]
            Lw = np.hypot(w_end.x - w_start.x, w_end.y - w_start.y)
            
            weight_wall = concrete_density * w_t * Lw * w_H
            xc = (w_start.x + w_end.x) / 2.0
            yc = (w_start.y + w_end.y) / 2.0
            
            W_total += weight_wall
            CM_num_x += weight_wall * xc
            CM_num_y += weight_wall * yc
            
    cm_x = CM_num_x / W_total if W_total > 1e-6 else 0.0
    cm_y = CM_num_y / W_total if W_total > 1e-6 else 0.0

    # 2. Accumulate stiffness matrix about the CM
    Kxx = 0.0
    Kyy = 0.0
    Kxy = 0.0
    KxTheta = 0.0
    KyTheta = 0.0
    
    nu = request.poissonRatio
    E = request.elasticModulus  # Young's modulus of slab/columns (Pa)
    G = E / (2.0 * (1.0 + nu))
    
    # Add columns contributions
    for i, col_nid in enumerate(request.columnNodeIds):
        node = nodes_map.get(col_nid)
        if not node:
            continue
        cx, cy = node.x, node.y
        H = request.columnHeights[i] if i < len(request.columnHeights) else 3.0
        w = request.columnWidths[i] if i < len(request.columnWidths) else 0.3
        d = request.columnDepths[i] if i < len(request.columnDepths) else 0.3
        shape = request.columnShapes[i] if i < len(request.columnShapes) else "rectangular"
        diameter = request.columnDiameters[i] if i < len(request.columnDiameters) else 0.5
        
        if H < 1e-6 or E < 1e-6:
            continue
            
        if shape == "circular":
            D = diameter if diameter > 0.0 else 0.5
            Iy = np.pi * D**4 / 64.0
            Ix = Iy
        else:
            Iy = d * w**3 / 12.0
            Ix = w * d**3 / 12.0
            
        bc = request.columnBoundaryConditions[i] if (request.columnBoundaryConditions and i < len(request.columnBoundaryConditions)) else "fixed-fixed"
        col_fixity = 3.0 if bc == "fixed-free" else 12.0
        kx = col_fixity * E * Iy / H**3
        ky = col_fixity * E * Ix / H**3
        kxy = 0.0
        
        Kxx += kx
        Kyy += ky
        Kxy += kxy
        
        xRel = cx - cm_x
        yRel = cy - cm_y
        KxTheta += kx * yRel - kxy * xRel
        KyTheta += ky * xRel - kxy * yRel
        
    # Add walls contributions
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
            G_wall = wall_E / (2.0 * (1.0 + nu))

            dx = w_end.x - w_start.x
            dy = w_end.y - w_start.y
            Lw = np.hypot(dx, dy)
            if Lw < 1e-6 or w_H < 1e-6:
                continue

            cos_a = dx / Lw
            sin_a = dy / Lw
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
            if abs(kxy_w) < 1e-6:
                kxy_w = 0.0
                
            Kxx += kx_w
            Kyy += ky_w
            Kxy += kxy_w
            
            xRel = xc - cm_x
            yRel = yc - cm_y
            KxTheta += kx_w * yRel - kxy_w * xRel
            KyTheta += ky_w * xRel - kxy_w * yRel
            
    # 3. Solve CR coordinates relative to CM
    denom = Kxx * Kyy - Kxy * Kxy
    if abs(denom) < 1e-18:
        cxS = 0.0
        cyS = 0.0
        cwS = 0.0
        for i, col_nid in enumerate(request.columnNodeIds):
            node = nodes_map.get(col_nid)
            if not node:
                continue
            cx, cy = node.x, node.y
            w = request.columnWidths[i] if i < len(request.columnWidths) else 0.3
            cwS += w
            cxS += cx * w
            cyS += cy * w
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            xc = (w_start.x + w_end.x) / 2.0
            yc = (w_start.y + w_end.y) / 2.0
            Lw = np.hypot(w_end.x - w_start.x, w_end.y - w_start.y)
            cwS += Lw
            cxS += xc * Lw
            cyS += yc * Lw
        if cwS > 1e-12:
            return cxS / cwS, cyS / cwS
        else:
            return cm_x, cm_y
            
    # Standard rigid-diaphragm CR derivation (about CM reference).
    # code_KxTheta = Σ(kx·yRel − kxy·xRel) = −Kxθ_CM  (note negated sign)
    # code_KyTheta = Σ(ky·xRel − kxy·yRel) = +Kyθ_CM
    # xCR = cm_x + (Kxx·Kyθ_CM − Kxy·Kxθ_CM)/Δ = cm_x + (Kxx·KyTheta + Kxy·KxTheta)/Δ
    # yCR = cm_y + (Kxy·Kyθ_CM − Kyy·Kxθ_CM)/Δ = cm_y + (Kxy·KyTheta + Kyy·KxTheta)/Δ
    cr_x = cm_x + (Kxx * KyTheta + Kxy * KxTheta) / denom
    cr_y = cm_y + (Kyy * KxTheta + Kxy * KyTheta) / denom
    return cr_x, cr_y

def _calculate_cr_opensees(request: AnalysisRequest, h: float, E: float, nu: float, nodes_xy, nn, elem_nodes, col_node_indices, col_dims_map, col_node_patches, slave_nodes, wall_node_ids_set, elem_thicknesses, G_val) -> Tuple[float, float]:
    """Calculate Center of Rigidity using 3D OpenSees model with temporary rigid diaphragm and 3 lateral load cases, matching ETABS exactly."""
    xs = [n.x for n in request.mesh.nodes]
    ys = [n.y for n in request.mesh.nodes]
    x_mast = sum(xs) / len(xs) if xs else 0.0
    y_mast = sum(ys) / len(ys) if ys else 0.0

    wall_slave_nodes = set()
    if (len(request.wallStartPoints) > 0 and len(request.wallEndPoints) > 0
            and len(request.wallThicknesses) > 0 and len(request.wallHeights) > 0):
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_H = request.wallHeights[w_idx]
            dx = w_end.x - w_start.x
            dy = w_end.y - w_start.y
            Lw = np.sqrt(dx**2 + dy**2)
            if Lw < 1e-6 or w_H < 1e-6:
                continue
            tol = 0.05
            for nidx in range(nn):
                nid = nidx + 1
                nx, ny = nodes_xy[nidx]
                len2 = dx * dx + dy * dy
                t_val = ((nx - w_start.x) * dx + (ny - w_start.y) * dy) / len2
                if 0.0 - tol <= t_val <= 1.0 + tol:
                    px = w_start.x + np.clip(t_val, 0, 1) * dx
                    py = w_start.y + np.clip(t_val, 0, 1) * dy
                    if np.hypot(nx - px, ny - py) < tol:
                        wall_slave_nodes.add(nid)

    def run_unit_case(load_fx, load_fy, load_mz):
        ops.wipe()
        _build_model(request, nodes_xy, nn, elem_nodes, col_node_indices, col_dims_map, col_node_patches, slave_nodes, wall_node_ids_set, elem_thicknesses, G_val, h, E, nu, lateral_cr_mode=True)
        
        master_node_id = 9999999
        ops.node(master_node_id, x_mast, y_mast, 0.0)
        ops.fix(master_node_id, 0, 0, 1, 1, 1, 0)
        
        slave_ids = []
        excluded_nodes = slave_nodes.union(wall_slave_nodes)
        for node in request.mesh.nodes:
            if node.id not in excluded_nodes:
                slave_ids.append(node.id)
                
        for w_idx in range(len(request.wallStartPoints)):
            w_start = request.wallStartPoints[w_idx]
            w_end = request.wallEndPoints[w_idx]
            w_H = request.wallHeights[w_idx]
            Lw = np.hypot(w_end.x - w_start.x, w_end.y - w_start.y)
            if Lw > 1e-6 and w_H > 1e-6:
                slave_ids.append(5000000 + w_idx)
                
        ops.rigidDiaphragm(3, master_node_id, *slave_ids)
        
        ops.timeSeries('Linear', 101)
        ops.pattern('Plain', 101, 101)
        ops.load(master_node_id, load_fx, load_fy, 0.0, 0.0, 0.0, load_mz)
        
        ops.constraints('Transformation')
        ops.numberer('RCM')
        try:
            ops.system('SparseGeneral')
        except Exception:
            ops.system('BandGeneral')
        ops.algorithm('Linear')
        ops.integrator('LoadControl', 1.0)
        ops.analysis('Static')
        
        try:
            ops.analyze(1)
            disp = ops.nodeDisp(master_node_id)
            return disp[5]
        except Exception:
            return 0.0

    theta_zx = run_unit_case(1.0, 0.0, 0.0)
    theta_zy = run_unit_case(0.0, 1.0, 0.0)
    theta_z_theta = run_unit_case(0.0, 0.0, 1.0)
    
    ops.wipe()
    
    if abs(theta_z_theta) < 1e-18:
        return x_mast, y_mast
        
    x_cr = x_mast - theta_zy / theta_z_theta
    y_cr = y_mast - theta_zx / theta_z_theta
    return x_cr, y_cr


def find_nodes_near_segment(nodes_xy, start_pt, end_pt, tol=0.05):
    sx, sy = start_pt[0], start_pt[1]
    ex, ey = end_pt[0], end_pt[1]
    dx = ex - sx
    dy = ey - sy
    L2 = dx*dx + dy*dy
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


def find_nodes_near_segment_with_t(nodes_xy, start_pt, end_pt, tol=0.01):
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


def find_nodes_near_partition_segment(nodes_xy, start_pt, end_pt, tolerance=0.15):
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


def analyze_slab_opensees(request: AnalysisRequest) -> AnalysisResponse:
    t0 = time.time()
    # Guard: check if the structure has any supports to prevent running solver on unstable floating plan
    if not request.columnNodeIds and not request.wallNodeIds:
        return AnalysisResponse(
            success=False,
            error="The structure has no supports. Please add at least one column or wall support before running analysis."
        )
    mesh = request.mesh
    nn = mesh.nodeCount
    ne = len(mesh.elements)
    
    h = request.thickness
    E = request.elasticModulus
    nu = request.poissonRatio
    
    if E < 1e9:
        raise ValueError(f"elasticModulus={E:.2e} Pa is implausibly low. Expected ~25e9 Pa (25 GPa).")

    # Enforce CCW node ordering on mesh elements
    nodes_xy = np.array([[n.x, n.y] for n in mesh.nodes])
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

    # Initialize OpenSees and build the simulation model
    col_node_indices = []
    col_dims_map = {}
    for nid, wcol, dcol in zip(request.columnNodeIds, request.columnWidths, request.columnDepths):
        nidx = nid - 1
        col_node_indices.append(nidx)
        col_dims_map[nidx] = (wcol, dcol)

    tree = cKDTree(nodes_xy)

    col_node_patches = {}
    for col_idx, nidx in enumerate(col_node_indices):
        xc, yc = nodes_xy[nidx]
        shape = request.columnShapes[col_idx] if col_idx < len(request.columnShapes) else "rectangular"
        
        patch = []
        if shape == "circular":
            diameter = request.columnDiameters[col_idx] if col_idx < len(request.columnDiameters) else 0.5
            radius = diameter / 2.0 + 0.01
            candidates = tree.query_ball_point([xc, yc], radius)
            for n in candidates:
                dist = np.hypot(nodes_xy[n, 0] - xc, nodes_xy[n, 1] - yc)
                if dist <= radius:
                    patch.append(n)
        else:
            wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
            r_bound = np.hypot(wcol / 2.0 + 0.01, dcol / 2.0 + 0.01)
            candidates = tree.query_ball_point([xc, yc], r_bound)
            for n in candidates:
                if (abs(nodes_xy[n, 0] - xc) <= wcol / 2.0 + 0.01 and
                        abs(nodes_xy[n, 1] - yc) <= dcol / 2.0 + 0.01):
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
            if slave_id != master_id:
                if slave_id not in already_linked_nodes:
                    slave_nodes.add(slave_id)
                    already_linked_nodes.add(slave_id)

    wall_node_ids_set = set(request.wallNodeIds)
    G_val = E / (2 * (1 + nu))

    elem_thicknesses = {}
    for elem_idx, tri_nodes in enumerate(elem_nodes):
        h_eff = request.elementThicknesses[elem_idx] if (request.elementThicknesses and elem_idx < len(request.elementThicknesses)) else h
        if request.dropPanels:
            n0_c = nodes_xy[tri_nodes[0]]
            n1_c = nodes_xy[tri_nodes[1]]
            n2_c = nodes_xy[tri_nodes[2]]
            xc = (n0_c[0] + n1_c[0] + n2_c[0]) / 3.0
            yc = (n0_c[1] + n1_c[1] + n2_c[1]) / 3.0
            for dp_idx, dp in enumerate(request.dropPanels):
                poly = [(v.x, v.y) for v in dp.vertices]
                if _point_in_polygon(xc, yc, poly):
                    h_eff = h_eff + dp.drop
                    break
        elem_thicknesses[elem_idx] = h_eff

    logger.info(f"Analysis: {nn} nodes, {ne} elements, {len(request.columnNodeIds)} columns, {len(request.wallNodeIds)} walls, {len(request.partitionWallSegments)} partition wall segments")

    # Build primary model for analysis
    beam_forces = _build_model(request, nodes_xy, nn, elem_nodes, col_node_indices, col_dims_map, col_node_patches, slave_nodes, wall_node_ids_set, elem_thicknesses, G_val, h, E, nu)

    # 6. Apply Nodal Loads from uniform pressure and beam self-weights
    nodal_forces = {}
    for elem_idx, tri in enumerate(mesh.elements):
        q_val = request.elementLoads[elem_idx] if (request.elementLoads and elem_idx < len(request.elementLoads)) else (request.uniformLoad + request.selfWeight)
        q = q_val * 1000.0  # kN/m² -> N/m²
        n1 = mesh.nodes[tri.nodeIds[0] - 1]
        n2 = mesh.nodes[tri.nodeIds[1] - 1]
        n3 = mesh.nodes[tri.nodeIds[2] - 1]
        
        # Area = 0.5 * |x1(y2-y3) + x2(y3-y1) + x3(y1-y2)|
        area = 0.5 * abs(n1.x * (n2.y - n3.y) + n2.x * (n3.y - n1.y) + n3.x * (n1.y - n2.y))
        fe = q * area / 3.0
        
        for nid in tri.nodeIds:
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + fe

    # Merge beam self-weight forces
    for nid, fz_beam in beam_forces.items():
        nodal_forces[nid] = nodal_forces.get(nid, 0.0) + fz_beam

    logger.info(f"Partition wall segments: {len(request.partitionWallSegments)}")
    for seg in request.partitionWallSegments:
        logger.info(f"  Wall load: ({seg.startX:.3f},{seg.startY:.3f})->({seg.endX:.3f},{seg.endY:.3f}) load={seg.lineLoad:.3f} kN/m")

    # Apply partition wall line loads as nodal forces
    tolerance = 0.15
    for seg in request.partitionWallSegments:
        sx, sy = seg.startX, seg.startY
        ex, ey = seg.endX, seg.endY
        dx = ex - sx
        dy = ey - sy
        segLen = np.hypot(dx, dy)
        if segLen < 0.001:
            continue
        near_nodes = find_nodes_near_partition_segment(nodes_xy, (sx, sy), (ex, ey), tolerance=tolerance)
        
        if len(near_nodes) == 0:
            # Fallback: Apply to closest node to midpoint
            mx, my = (sx + ex) / 2.0, (sy + ey) / 2.0
            dists = np.hypot(nodes_xy[:, 0] - mx, nodes_xy[:, 1] - my)
            nid = int(np.argmin(dists) + 1)
            force = seg.lineLoad * segLen * 1000.0  # kN -> N
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + force
            continue
            
        if len(near_nodes) == 1:
            # Apply total segment load to that single node
            nid = near_nodes[0][1]
            force = seg.lineLoad * segLen * 1000.0  # kN -> N
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + force
            continue
            
        # Mathematically exact partition using telescoping midpoints (conserves 100% load)
        near_nodes.sort(key=lambda x: x[0])
        for i in range(len(near_nodes)):
            t_val, nid = near_nodes[i]
            left = 0.0 if i == 0 else (near_nodes[i][0] + near_nodes[i - 1][0]) / 2.0
            right = 1.0 if i == len(near_nodes) - 1 else (near_nodes[i][0] + near_nodes[i + 1][0]) / 2.0
            
            tribLen = (right - left) * segLen
            force = seg.lineLoad * tribLen * 1000.0  # kN -> N
            nodal_forces[nid] = nodal_forces.get(nid, 0.0) + force

    logger.info(f"Total nodal forces applied: {len(nodal_forces)} nodes, total load: {sum(nodal_forces.values())/1000:.3f} kN")

    # Define load pattern
    ops.timeSeries('Linear', 1)
    ops.pattern('Plain', 1, 1)
    for nid, fz in nodal_forces.items():
        # Load is vertical, pointing downwards (global -Z direction)
        ops.load(nid, 0.0, 0.0, -fz, 0.0, 0.0, 0.0)

    # 7. Run Analysis using high-performance sparse linear solver (UmfPack/SparseGeneral)
    ops.constraints('Transformation')
    ops.numberer('RCM')
    try:
        ops.system('UMFPack')
    except Exception:
        try:
            ops.system('SparseGeneral')
        except Exception:
            ops.system('BandGeneral')
    ops.algorithm('Linear')
    ops.integrator('LoadControl', 1.0)
    ops.analysis('Static')
    
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            # Capture stderr to log OpenSees solver warnings (e.g., SuperLU singular matrix)
            old_stderr = sys.stderr
            sys.stderr = io.StringIO()
            ok = ops.analyze(1)
            stderr_output = sys.stderr.getvalue()
            sys.stderr = old_stderr
        solver_time = time.time() - t0
        if stderr_output:
            logger.warning(f"OpenSees stderr during analyze: {stderr_output.strip()}")
        if ok < 0:
            logger.error(f"OpenSees analyze failed (code={ok}). stderr: {stderr_output[:500] if stderr_output else 'none'}")
            return AnalysisResponse(success=False, error=f"OpenSees analyze failed (code={ok}).")
    except Exception as e:
        logger.error(f"OpenSees analyze exception: {str(e)}")
        return AnalysisResponse(success=False, error=f"OpenSees analyze exception: {str(e)}")

    # 8. Recover results
    # Displacements
    node_deflections = []
    for node in mesh.nodes:
        disp = ops.nodeDisp(node.id)
        # wz is vertical deflection (positive downwards)
        node_deflections.append(NodeDeflection(
            nodeId=node.id,
            u=disp[0],
            v=disp[1],
            wz=-disp[2],
            rx=disp[3],
            ry=disp[4],
            rz=disp[5]
        ))

    # Shell element forces, stresses, shears, membrane forces
    element_moments = []
    element_stresses = []
    element_shears = []
    element_membrane = []
    
    min_mx = min_my = min_mxy = float('inf')
    max_mx = max_my = max_mxy = float('-inf')
    min_vx = min_vy = float('inf')
    max_vx = max_vy = float('-inf')
    min_nx = min_ny = min_nxy = float('inf')
    max_nx = max_ny = max_nxy = float('-inf')

    for elem_idx, elem in enumerate(mesh.elements):
        elem_tag = elem_idx + 1
        h_elem = elem_thicknesses.get(elem_idx, h)
        forces = ops.eleResponse(elem_tag, 'forces')
        stresses = ops.eleResponse(elem_tag, 'stresses')
        sec_forces = None
        try:
            sec_forces = ops.eleResponse(elem_tag, 'section', 'forces')
            if not sec_forces:
                sec_forces = ops.eleResponse(elem_tag, 'section', '1', 'forces')
        except Exception:
            sec_forces = None

        if sec_forces and len(sec_forces) >= 6:
            nx = sec_forces[0] / 1000.0
            ny = sec_forces[1] / 1000.0
            nxy = sec_forces[2] / 1000.0 if len(sec_forces) > 2 else 0.0
            mx = sec_forces[3] / 1000.0 if len(sec_forces) > 3 else 0.0
            my = sec_forces[4] / 1000.0 if len(sec_forces) > 4 else 0.0
            mxy = sec_forces[5] / 1000.0 if len(sec_forces) > 5 else 0.0
            vx = sec_forces[6] / 1000.0 if len(sec_forces) > 6 else 0.0
            vy = sec_forces[7] / 1000.0 if len(sec_forces) > 7 else 0.0
        elif stresses and len(stresses) >= 32 and any(abs(s) > 1e-12 for s in stresses[:32]):
            arr = np.array(stresses[:32]).reshape(4, 8)
            nx, ny, nxy, mx, my, mxy, vx, vy = arr.mean(axis=0)
            mx = mx / 1000.0
            my = my / 1000.0
            mxy = mxy / 1000.0
            nx = nx / 1000.0
            ny = ny / 1000.0
            nxy = nxy / 1000.0
            vx = vx / 1000.0
            vy = vy / 1000.0
        elif forces and len(forces) >= 15:
            # 15-DOF vector for 3-node ShellDKGT [Nx1, Ny1, Vz1, Mx1, My1, Nx2, ...]
            nx = (forces[0] + forces[5] + forces[10]) / 3.0 / 1000.0
            ny = (forces[1] + forces[6] + forces[11]) / 3.0 / 1000.0
            nxy = 0.0
            vx = (forces[2] + forces[7] + forces[12]) / 3.0 / 1000.0
            vy = 0.0
            mx = (forces[3] + forces[8] + forces[13]) / 3.0 / 1000.0
            my = (forces[4] + forces[9] + forces[14]) / 3.0 / 1000.0
            mxy = 0.0
        elif forces and len(forces) >= 12:
            nx = (forces[0] + forces[4] + forces[8]) / 3.0 / 1000.0
            ny = (forces[1] + forces[5] + forces[9]) / 3.0 / 1000.0
            nxy = 0.0
            vx = 0.0
            vy = 0.0
            mx = (forces[2] + forces[6] + forces[10]) / 3.0 / 1000.0
            my = (forces[3] + forces[7] + forces[11]) / 3.0 / 1000.0
            mxy = 0.0
        else:
            nx = ny = nxy = mx = my = mxy = vx = vy = 0.0

        # Membrane calculations
        n1 = (nx + ny) / 2 + np.sqrt(((nx - ny) / 2)**2 + nxy**2)
        n2 = (nx + ny) / 2 - np.sqrt(((nx - ny) / 2)**2 + nxy**2)
        angle_m = np.degrees(np.arctan2(2 * nxy, nx - ny)) if abs(nx - ny) > 1e-12 or abs(nxy) > 1e-12 else 0.0
        element_membrane.append(ElementMembraneForce(
            elementId=elem.id,
            nx=round(nx, 3), ny=round(ny, 3), nxy=round(nxy, 3),
            n1=round(n1, 3), n2=round(n2, 3), angle=round(angle_m, 2)
        ))

        # Moment calculations (in kNm/m)
        m1 = (mx + my) / 2 + np.sqrt(((mx - my) / 2)**2 + mxy**2)
        m2 = (mx + my) / 2 - np.sqrt(((mx - my) / 2)**2 + mxy**2)
        angle = 0.5 * np.degrees(np.arctan2(2 * mxy, mx - my)) if abs(mx - my) > 1e-12 or abs(mxy) > 1e-12 else 0.0
        element_moments.append(ElementMoment(
            elementId=elem.id,
            mx=round(mx, 6), my=round(my, 6), mxy=round(mxy, 6),
            m1=round(m1, 6), m2=round(m2, 6), angle=round(angle, 2)
        ))

        # Stress calculations (bending stress in MPa using element-specific thickness)
        # 6 * M (kNm/m) / h^2 (m^2) = kPa -> / 1000 = MPa
        s_mx = (6 * mx / (h_elem**2) / 1000.0) if h_elem > 0 else 0.0
        s_my = (6 * my / (h_elem**2) / 1000.0) if h_elem > 0 else 0.0
        s_mxy = (6 * mxy / (h_elem**2) / 1000.0) if h_elem > 0 else 0.0
        s1 = (s_mx + s_my) / 2.0 + np.sqrt(((s_mx - s_my) / 2.0)**2 + s_mxy**2)
        s2 = (s_mx + s_my) / 2.0 - np.sqrt(((s_mx - s_my) / 2.0)**2 + s_mxy**2)
        vm = np.sqrt(s1**2 - s1 * s2 + s2**2)
        element_stresses.append(ElementStress(
            elementId=elem.id,
            s1=round(s1, 3), s2=round(s2, 3), vm=round(vm, 3),
            mx=round(mx, 6), my=round(my, 6), mxy=round(mxy, 6)
        ))

        # Shear calculations (in kN/m)
        v1 = np.hypot(vx, vy)
        angle_v = np.degrees(np.arctan2(vy, vx)) if (abs(vx) > 1e-12 or abs(vy) > 1e-12) else 0.0
        element_shears.append(ElementShear(
            elementId=elem.id,
            vx=round(vx, 3), vy=round(vy, 3), v1=round(v1, 3), angle=round(angle_v, 2)
        ))

        min_mx = min(min_mx, mx)
        max_mx = max(max_mx, mx)
        min_my = min(min_my, my)
        max_my = max(max_my, my)
        min_mxy = min(min_mxy, mxy)
        max_mxy = max(max_mxy, mxy)
        min_vx = min(min_vx, vx)
        max_vx = max(max_vx, vx)
        min_vy = min(min_vy, vy)
        max_vy = max(max_vy, vy)
        min_nx = min(min_nx, nx)
        max_nx = max(max_nx, nx)
        min_ny = min(min_ny, ny)
        max_ny = max(max_ny, ny)
        min_nxy = min(min_nxy, nxy)
        max_nxy = max(max_nxy, nxy)

    # 9. Compute Column Punching Shear Stresses (IS 456:2000 Clause 31.6.3.1 / ETABS Standard)
    column_punching = []
    cover = 0.025
    d_eff = max(0.05, h - cover - 0.012)  # Effective depth in meters
    fck_MPa = (E / 1e6 / 5000.0) ** 2
    fck_MPa = max(20, min(80, fck_MPa))

    ops.reactions()
    for col_idx, nidx in enumerate(col_node_indices):
        master_id = nidx + 1
        base_node_id = col_idx + 1000001
        wcol, dcol = col_dims_map.get(nidx, (0.3, 0.3))
        shape = request.columnShapes[col_idx] if (hasattr(request, 'columnShapes') and request.columnShapes and col_idx < len(request.columnShapes)) else "rectangular"
        diameter = request.columnDiameters[col_idx] if (hasattr(request, 'columnDiameters') and request.columnDiameters and col_idx < len(request.columnDiameters)) else 0.5
        
        # IS 456:2000 Punching Capacity: v_c = k_s * 0.25 * sqrt(fck)
        beta_c = (wcol / dcol) if dcol > 0 else 1.0
        if beta_c < 1.0: beta_c = 1.0 / beta_c
        ks = min(1.0, 0.5 + beta_c)
        v_c = ks * 0.25 * np.sqrt(fck_MPa) * 1e6  # capacity in Pa (IS 456 / ETABS standard)

        # Query vertical axial reaction force of column (Fz at base node in Newtons)
        try:
            rxn = ops.nodeReaction(base_node_id)
            V_col = abs(rxn[2]) if (rxn and len(rxn) >= 3) else 0.0
            if V_col < 1e-3:
                col_ele_tag = col_idx + 3000001
                col_forces = ops.eleForce(col_ele_tag)
                V_col = abs(col_forces[2]) if (col_forces and len(col_forces) >= 3) else 0.0
        except Exception:
            V_col = 0.0
            
        V_col_kN = V_col / 1000.0
        if shape == "circular":
            b0 = np.pi * (diameter + d_eff)
        else:
            b0 = 2.0 * (wcol + dcol + 2.0 * d_eff)
            
        v_u = V_col / (b0 * d_eff) if (b0 > 0 and d_eff > 0) else 0.0
        v_u_MPa = v_u / 1e6
        v_c_MPa = v_c / 1e6
        ratio = v_u / v_c if v_c > 0 else 0.0
        
        if ratio < 0.7:
            status = "OK"
        elif ratio < 1.0:
            status = "WARNING"
        else:
            status = "FAIL"
            
        column_punching.append(PunchingStress(
            nodeId=master_id,
            force_kN=round(V_col_kN, 2),
            stress_MPa=round(v_u_MPa, 3),
            capacity_MPa=round(v_c_MPa, 3),
            ratio=round(ratio, 3),
            status=status
        ))

    all_wz = [d.wz for d in node_deflections]
    min_wz = min(all_wz) if all_wz else 0.0
    max_wz = max(abs(w) for w in all_wz) if all_wz else 0.0
    logger.info(f"Analysis complete in {solver_time:.2f}s: deflection range [{min_wz*1000:.3f}, {max_wz*1000:.3f}] mm")

    # Calculate Center of Rigidity using fast analytical formula (matches ETABS)
    cr_x, cr_y = _calculate_cr_analytical(request)

    ops.wipe() # Clean up model memory

    return AnalysisResponse(
        success=True,
        nodeDeflections=node_deflections,
        elementMoments=element_moments,
        elementStresses=element_stresses,
        elementShears=element_shears,
        elementMembraneForces=element_membrane,
        columnPunching=column_punching,
        minWz=round(min_wz, 10),
        maxWz=round(max_wz, 10),
        minMx=round(min_mx, 6),
        maxMx=round(max_mx, 6),
        minMy=round(min_my, 6),
        maxMy=round(max_my, 6),
        minMxy=round(min_mxy, 6),
        maxMxy=round(max_mxy, 6),
        minVx=round(min_vx, 3),
        maxVx=round(max_vx, 3),
        minVy=round(min_vy, 3),
        maxVy=round(max_vy, 3),
        minNx=round(min_nx, 3),
        maxNx=round(max_nx, 3),
        minNy=round(min_ny, 3),
        maxNy=round(max_ny, 3),
        minNxy=round(min_nxy, 3),
        maxNxy=round(max_nxy, 3),
        solverTime=round(solver_time, 4),
        crX=round(cr_x, 6),
        crY=round(cr_y, 6)
    )
