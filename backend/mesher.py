import gmsh
import numpy as np
import threading
from typing import List, Tuple, Set
from models import SlabGeometry, FEMMesh, Triangle, Point2D, FEMNode, MeshRequest

_lock = threading.Lock()

# Initialize Gmsh at import time (main thread)
gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)


def _ensure_gmsh():
    pass

def _point_on_segment(px: float, py: float, ax: float, ay: float,
                      bx: float, by: float, tol: float = 1e-8) -> bool:
    """Check if point (px,py) lies on segment AB (excluding endpoints)."""
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 < tol:
        return False
    t = ((px - ax) * dx + (py - ay) * dy) / length2
    if t < tol or t > 1 - tol:
        return False
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    return (px - proj_x) ** 2 + (py - proj_y) ** 2 < tol


def _point_in_polygon_xy(px: float, py: float, poly: List[Tuple[float, float]]) -> bool:
    inside = False
    if len(poly) < 3:
        return False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > py) != (yj > py):
            x_cross = (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi
            if px < x_cross:
                inside = not inside
        j = i
    return inside


def _point_segment_distance_xy(px: float, py: float, ax: float, ay: float,
                               bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 < 1e-12:
        return float(np.hypot(px - ax, py - ay))
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    qx = ax + t * dx
    qy = ay + t * dy
    return float(np.hypot(px - qx, py - qy))


def _point_polygon_distance_xy(px: float, py: float, poly: List[Tuple[float, float]]) -> float:
    if not poly:
        return float("inf")
    return min(
        _point_segment_distance_xy(px, py, poly[i][0], poly[i][1], poly[(i + 1) % len(poly)][0], poly[(i + 1) % len(poly)][1])
        for i in range(len(poly))
    )


def _point_relevant_to_slab(px: float, py: float, poly: List[Tuple[float, float]], tol: float) -> bool:
    return _point_in_polygon_xy(px, py, poly) or _point_polygon_distance_xy(px, py, poly) <= tol


def _orientation(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (by - ay) * (cx - bx) - (bx - ax) * (cy - by)


def _segments_intersect_xy(a: Tuple[float, float], b: Tuple[float, float],
                           c: Tuple[float, float], d: Tuple[float, float],
                           tol: float = 1e-9) -> bool:
    ax, ay = a
    bx, by = b
    cx, cy = c
    dx, dy = d
    o1 = _orientation(ax, ay, bx, by, cx, cy)
    o2 = _orientation(ax, ay, bx, by, dx, dy)
    o3 = _orientation(cx, cy, dx, dy, ax, ay)
    o4 = _orientation(cx, cy, dx, dy, bx, by)
    if o1 * o2 < -tol and o3 * o4 < -tol:
        return True
    return (
        _point_on_segment(cx, cy, ax, ay, bx, by, tol)
        or _point_on_segment(dx, dy, ax, ay, bx, by, tol)
        or _point_on_segment(ax, ay, cx, cy, dx, dy, tol)
        or _point_on_segment(bx, by, cx, cy, dx, dy, tol)
    )


def _segment_relevant_to_slab(ax: float, ay: float, bx: float, by: float,
                              poly: List[Tuple[float, float]], tol: float) -> bool:
    if _point_relevant_to_slab(ax, ay, poly, tol) or _point_relevant_to_slab(bx, by, poly, tol):
        return True
    if not poly:
        return False
    if _point_in_polygon_xy((ax + bx) * 0.5, (ay + by) * 0.5, poly):
        return True
    min_x, max_x = min(p[0] for p in poly) - tol, max(p[0] for p in poly) + tol
    min_y, max_y = min(p[1] for p in poly) - tol, max(p[1] for p in poly) + tol
    if max(ax, bx) < min_x or min(ax, bx) > max_x or max(ay, by) < min_y or min(ay, by) > max_y:
        return False
    for i in range(len(poly)):
        cx, cy = poly[i]
        dx, dy = poly[(i + 1) % len(poly)]
        if _segments_intersect_xy((ax, ay), (bx, by), (cx, cy), (dx, dy), tol):
            return True
        if _point_segment_distance_xy(cx, cy, ax, ay, bx, by) <= tol:
            return True
    return False


def generate_mesh(request: MeshRequest) -> FEMMesh:
    geo = request.geometry
    _ensure_gmsh()
    with _lock:
        try:
            gmsh.model.add("slab")

            slab_verts = []
            for v in geo.vertices:
                if not slab_verts or np.hypot(v.x - slab_verts[-1][0], v.y - slab_verts[-1][1]) > 1e-6:
                    slab_verts.append((v.x, v.y))
            if len(slab_verts) >= 3 and np.hypot(slab_verts[0][0] - slab_verts[-1][0], slab_verts[0][1] - slab_verts[-1][1]) < 1e-6:
                slab_verts.pop()

            support_tol = max(0.25, request.meshSize * 1.5)
            relevant_beams = [
                beam for beam in (geo.beams or [])
                if _segment_relevant_to_slab(
                    beam.startPoint.x, beam.startPoint.y,
                    beam.endPoint.x, beam.endPoint.y,
                    slab_verts, support_tol
                )
            ]
            relevant_walls = [
                wall for wall in (geo.walls or [])
                if _segment_relevant_to_slab(
                    wall.startPoint.x, wall.startPoint.y,
                    wall.endPoint.x, wall.endPoint.y,
                    slab_verts, support_tol
                )
            ]
            relevant_columns = [
                col for col in (geo.columns or [])
                if _point_relevant_to_slab(col.position.x, col.position.y, slab_verts, support_tol)
            ]

            # --- Build boundary points, splitting edges at beam and wall endpoints ---
            support_endpoints = []
            if relevant_beams:
                for beam in relevant_beams:
                    support_endpoints.append((beam.startPoint.x, beam.startPoint.y))
                    support_endpoints.append((beam.endPoint.x, beam.endPoint.y))
            if relevant_walls:
                for wall in relevant_walls:
                    support_endpoints.append((wall.startPoint.x, wall.startPoint.y))
                    support_endpoints.append((wall.endPoint.x, wall.endPoint.y))
            if relevant_columns:
                for col in relevant_columns:
                    support_endpoints.append((col.position.x, col.position.y))

            # For each slab edge, check if any support endpoint lies on it
            split_edges = []  # list of list of (x, y) along each original edge (including endpoints)
            nv = len(slab_verts)
            for i in range(nv):
                ax, ay = slab_verts[i]
                bx, by = slab_verts[(i + 1) % nv]
                pts = [(ax, ay)]
                for ep_x, ep_y in support_endpoints:
                    if _point_on_segment(ep_x, ep_y, ax, ay, bx, by):
                        pts.append((ep_x, ep_y))
                pts.append((bx, by))
                # Sort along the edge by distance from A
                dx, dy = bx - ax, by - ay
                len2 = dx * dx + dy * dy
                if len2 > 1e-12:
                    pts.sort(key=lambda p: ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)
                split_edges.append(pts)

            # Create Gmsh points (deduplicated) — boundary vertices first
            point_tags = {}
            next_pt_tag = 1000
            for edge_pts in split_edges:
                for (x, y) in edge_pts:
                    key = (x, y)
                    if key not in point_tags:
                        point_tags[key] = next_pt_tag
                        gmsh.model.occ.addPoint(x, y, 0, tag=next_pt_tag)
                        next_pt_tag += 1

            # Add interior beam and wall endpoints (not on boundary)
            if relevant_beams:
                for beam in relevant_beams:
                    for (ep_x, ep_y) in [(beam.startPoint.x, beam.startPoint.y),
                                         (beam.endPoint.x, beam.endPoint.y)]:
                        key = (ep_x, ep_y)
                        if key not in point_tags:
                            point_tags[key] = next_pt_tag
                            gmsh.model.occ.addPoint(ep_x, ep_y, 0, tag=next_pt_tag)
                            next_pt_tag += 1
            if relevant_walls:
                for wall in relevant_walls:
                    for (ep_x, ep_y) in [(wall.startPoint.x, wall.startPoint.y),
                                         (wall.endPoint.x, wall.endPoint.y)]:
                        key = (ep_x, ep_y)
                        if key not in point_tags:
                            point_tags[key] = next_pt_tag
                            gmsh.model.occ.addPoint(ep_x, ep_y, 0, tag=next_pt_tag)
                            next_pt_tag += 1

            # Create boundary lines from split edges (strictly ordered head-to-tail closed loop)
            line_tags = []
            existing_edges = set()
            next_line_tag = 2000
            
            # Flatten split_edges into a continuous ordered sequence of boundary points
            ordered_boundary_pts = []
            for edge_pts in split_edges:
                for pt in edge_pts[:-1]:  # omit last point of edge since it's the start point of next edge
                    if not ordered_boundary_pts or np.hypot(pt[0] - ordered_boundary_pts[-1][0], pt[1] - ordered_boundary_pts[-1][1]) > 1e-6:
                        ordered_boundary_pts.append(pt)
            
            # Ensure loop closes
            if len(ordered_boundary_pts) >= 3 and np.hypot(ordered_boundary_pts[0][0] - ordered_boundary_pts[-1][0], ordered_boundary_pts[0][1] - ordered_boundary_pts[-1][1]) < 1e-6:
                ordered_boundary_pts.pop()

            for i in range(len(ordered_boundary_pts)):
                pa = ordered_boundary_pts[i]
                pb = ordered_boundary_pts[(i + 1) % len(ordered_boundary_pts)]
                ta = point_tags.get(pa)
                tb = point_tags.get(pb)
                if ta is None or tb is None or ta == tb:
                    continue
                gmsh.model.occ.addLine(ta, tb, tag=next_line_tag)
                line_tags.append(next_line_tag)
                existing_edges.add((min(ta, tb), max(ta, tb)))
                next_line_tag += 1

            if len(line_tags) < 3:
                return FEMMesh(nodes=[], elements=[], nodeCount=0, elementCount=0, minAngle=0, maxAspectRatio=1, meshQuality="poor")

            curve_loop = gmsh.model.occ.addCurveLoop(line_tags, tag=3000)
            slab_surf = gmsh.model.occ.addPlaneSurface([curve_loop], tag=4000)

            for i, opening in enumerate(geo.openings):
                hole_verts = []
                for v in opening.vertices:
                    if not hole_verts or np.hypot(v.x - hole_verts[-1][0], v.y - hole_verts[-1][1]) > 1e-6:
                        hole_verts.append((v.x, v.y))
                if len(hole_verts) >= 3 and np.hypot(hole_verts[0][0] - hole_verts[-1][0], hole_verts[0][1] - hole_verts[-1][1]) < 1e-6:
                    hole_verts.pop()
                
                if len(hole_verts) < 3:
                    continue

                hole_pt_tags = []
                for j, (x, y) in enumerate(hole_verts):
                    pt = gmsh.model.occ.addPoint(x, y, 0, tag=5000 + i * 100 + j)
                    hole_pt_tags.append(pt)
                hole_line_tags = []
                for j in range(len(hole_pt_tags)):
                    k = (j + 1) % len(hole_pt_tags)
                    if hole_pt_tags[j] == hole_pt_tags[k]:
                        continue
                    line = gmsh.model.occ.addLine(hole_pt_tags[j], hole_pt_tags[k], tag=6000 + i * 100 + j)
                    hole_line_tags.append(line)
                    existing_edges.add((min(hole_pt_tags[j], hole_pt_tags[k]), max(hole_pt_tags[j], hole_pt_tags[k])))
                hole_loop = gmsh.model.occ.addCurveLoop(hole_line_tags, tag=7000 + i)
                gmsh.model.occ.cut([(2, slab_surf)], [(2, gmsh.model.occ.addPlaneSurface([hole_loop]))], removeObject=True)

            # --- Create beam and wall lines (embedded curves for mesh alignment) ---
            embedded_curve_tags = []
            if relevant_beams:
                for beam in relevant_beams:
                    p1 = point_tags.get((beam.startPoint.x, beam.startPoint.y))
                    p2 = point_tags.get((beam.endPoint.x, beam.endPoint.y))
                    if p1 and p2 and p1 != p2:
                        edge_key = (min(p1, p2), max(p1, p2))
                        if edge_key not in existing_edges:
                            gmsh.model.occ.addLine(p1, p2, tag=next_line_tag)
                            embedded_curve_tags.append(next_line_tag)
                            existing_edges.add(edge_key)
                            next_line_tag += 1
            if relevant_walls:
                for wall in relevant_walls:
                    p1 = point_tags.get((wall.startPoint.x, wall.startPoint.y))
                    p2 = point_tags.get((wall.endPoint.x, wall.endPoint.y))
                    if p1 and p2 and p1 != p2:
                        edge_key = (min(p1, p2), max(p1, p2))
                        if edge_key not in existing_edges:
                            gmsh.model.occ.addLine(p1, p2, tag=next_line_tag)
                            embedded_curve_tags.append(next_line_tag)
                            existing_edges.add(edge_key)
                            next_line_tag += 1

            col_pt_tags = []
            if request.refineAtColumns and relevant_columns:
                for col in relevant_columns:
                    col_key = (col.position.x, col.position.y)
                    if col_key in point_tags:
                        pt = point_tags[col_key]
                    else:
                        pt = next_pt_tag
                        gmsh.model.occ.addPoint(col.position.x, col.position.y, 0, tag=next_pt_tag)
                        point_tags[col_key] = next_pt_tag
                        next_pt_tag += 1
                    if pt not in col_pt_tags:
                        col_pt_tags.append(pt)

            # Fragment plane surface with beam and wall lines for exact mesh alignment and 100x faster meshing
            if embedded_curve_tags:
                try:
                    gmsh.model.occ.fragment([(2, slab_surf)], [(1, c) for c in embedded_curve_tags])
                except Exception:
                    pass

            gmsh.model.occ.synchronize()

            if col_pt_tags:
                try:
                    gmsh.model.mesh.embed(0, col_pt_tags, 2, slab_surf)
                except Exception:
                    pass

            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", request.meshSize * 0.3)
            gmsh.option.setNumber("Mesh.CharacteristicLengthMax", request.meshSize)
            gmsh.option.setNumber("Mesh.MinimumCirclePoints", 12)

            # Triangle mesh: compatible with both DKT and Pynite solvers
            # (Pynite's MITC4 quads give overly stiff results for thin RC slabs)
            gmsh.option.setNumber("Mesh.RecombineAll", 0)
            gmsh.option.setNumber("Mesh.Algorithm", 6)  # Frontal-Delaunay for Triangles

            # Uniform mesh field matching ETABS standard area meshing
            const_field = gmsh.model.mesh.field.add("Constant")
            gmsh.model.mesh.field.setNumber(const_field, "VIn", request.meshSize)
            gmsh.model.mesh.field.setAsBackgroundMesh(const_field)

            gmsh.model.mesh.generate(2)

            # Extract nodes and elements BEFORE clear
            node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
            elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(dim=2)
        finally:
            gmsh.clear()

    # --- Deduplicate nodes ---
    coord_to_tag: dict = {}
    unique_tags = []
    for i in range(0, len(node_coords), 3):
        key = (round(node_coords[i], 10), round(node_coords[i+1], 10))
        if key not in coord_to_tag:
            coord_to_tag[key] = node_tags[i // 3]
            unique_tags.append(node_tags[i // 3])

    node_id_map = {old: new for new, old in enumerate(unique_tags, 1)}
    nodes_list = []
    new_id = 1
    for i in range(0, len(node_coords), 3):
        if node_tags[i // 3] in unique_tags:
            nodes_list.append(FEMNode(id=new_id, x=node_coords[i], y=node_coords[i+1]))
            new_id += 1

    # --- Extract triangles and quadrilaterals with deduped node IDs ---
    triangles = []
    seen_elem = set()
    elem_id = 0
    for typ, tags, conn in zip(elem_types, elem_tags, elem_node_tags):
        # typ == 2: 3-node triangle, typ == 3: 4-node quadrilateral
        if typ in (2, 3):
            npe = 3 if typ == 2 else 4
            for i in range(0, len(conn), npe):
                elem_nodes = [node_id_map[conn[i+j]] for j in range(npe) if conn[i+j] in node_id_map]
                elem_tuple = tuple(sorted(elem_nodes))
                if len(elem_nodes) == npe and elem_tuple not in seen_elem:
                    seen_elem.add(elem_tuple)
                    triangles.append(Triangle(nodeIds=elem_nodes, id=elem_id))
                    elem_id += 1

    min_angle, max_ar = _compute_mesh_quality(nodes_list, triangles) if triangles else (90, 1)
    quality = "excellent" if min_angle > 25 else "good" if min_angle > 15 else "poor"

    # Identify unconnected node IDs (nodes not in any element)
    connected_node_ids = set()
    for tri in triangles:
        for nid in tri.nodeIds:
            connected_node_ids.add(nid)
    unconnected_node_ids = [n.id for n in nodes_list if n.id not in connected_node_ids]

    return FEMMesh(
        nodes=nodes_list, elements=triangles,
        nodeCount=len(nodes_list), elementCount=len(triangles),
        minAngle=round(min_angle, 1), maxAspectRatio=round(max_ar, 2),
        meshQuality=quality,
        unconnectedNodeIds=unconnected_node_ids
    )


def _compute_mesh_quality(nodes: List[FEMNode], elements: List[Triangle]) -> Tuple[float, float]:
    min_angle = 180.0
    max_ar = 0.0
    node_map = {n.id: np.array([n.x, n.y]) for n in nodes}
    for tri in elements:
        ids = tri.nodeIds
        p = [node_map[i] for i in ids]
        edge_lens = [np.linalg.norm(p[(i+1) % 3] - p[i]) for i in range(3)]
        angles = []
        for i in range(3):
            v1 = p[(i+1) % 3] - p[i]
            v2 = p[(i-1) % 3] - p[i]
            dot = np.dot(v1, v2)
            norm = np.linalg.norm(v1) * np.linalg.norm(v2)
            if norm > 1e-15:
                ang = np.degrees(np.arccos(np.clip(dot / norm, -1, 1)))
                angles.append(ang)
        if angles:
            min_angle = min(min_angle, min(angles))
        s = sum(edge_lens) / 2
        if s > 0:
            area = np.sqrt(max(0, s * (s - edge_lens[0]) * (s - edge_lens[1]) * (s - edge_lens[2])))
            if area > 0:
                r_circum = edge_lens[0] * edge_lens[1] * edge_lens[2] / (4 * area)
                r_in = area / s
                ar = r_circum / r_in if r_in > 0 else 100
                max_ar = max(max_ar, ar)
    return min_angle, max_ar
