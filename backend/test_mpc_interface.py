"""
ETABS-style Edge (Line) Constraint — MPC Interface Continuity Tests
====================================================================
Validates the weighted multi-master MPC implementation used to tie non-conformal
multi-slab joints (T-junctions, offset grids) so connected slabs act as one
continuous slab even where boundary nodes do not coincide.

Test structure (same geometry as the TypeScript-worker test suite):
  Slab A: [0,4] x [0,4],      0.5 m structured grid  (dx=0.5, dy=0.5)
  Slab B: [4,8] x [1.25,4.5], 0.5 x 0.46428 m grid   (dy = 3.25/7 m)
Interface along x=4 misaligns: A nodes at y=1.5 and y=2.0 have NO coincident
B-side partner — they are the true T-slaves tied by edge constraints:
  A(4,1.5) = 0.4615 * B(4,1.25 ) + 0.5385 * B(4,1.7143)
  A(4,2.0) = 0.3846 * B(4,1.7143) + 0.6154 * B(4,2.1786)
Near-coincident pairs (A2.5-B2.643, A3.0-B3.107, A3.5-B3.571, A4.0-B4.036)
are tied by equal-DOF constraints, mirroring the frontend merge/coupling logic.

Both solver backends are exercised:
  1. Python DKT solver (solver.analyze_slab)          — penalty MPCs
  2. Kratos shell solver (kratos_solver.solve_reslo_structure) — master-slave constraints

Author: Structural Engineering Audit
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import math
import pytest
from solver import analyze_slab
from models import (
    AnalysisRequest, FEMMesh, FEMNode, Triangle, Point2D,
    EqualDofConstraint, MpcConstraint, MpcTerm
)

E_concrete = 25e9
NU = 0.2
H_SLAB = 0.2
Q_KPA = 10.0


# ─────────────────────────── mesh construction ───────────────────────────
def rect_grid(x0, x1, y0, y1, nx, ny, nodes, elements, nid_offset=None):
    """Append a structured triangular grid to shared node/element lists.
    Returns (node_id_map[(i,j)] = global_id, next_free_id)."""
    start = len(nodes)
    idmap = {}
    for j in range(ny + 1):
        for i in range(nx + 1):
            gid = len(nodes) + 1
            idmap[(i, j)] = gid
            nodes.append(FEMNode(id=gid, x=x0 + i * (x1 - x0) / nx, y=y0 + j * (y1 - y0) / ny))
    eid = len(elements) + 1
    for j in range(ny):
        for i in range(nx):
            n0 = idmap[(i, j)]
            n1 = idmap[(i + 1, j)]
            n2 = idmap[(i + 1, j + 1)]
            n3 = idmap[(i, j + 1)]
            elements.append(Triangle(id=eid, nodeIds=[n0, n1, n2])); eid += 1
            elements.append(Triangle(id=eid, nodeIds=[n0, n2, n3])); eid += 1
    return idmap


def build_t_junction():
    """Global combined mesh for slab A + slab B (NO interface nodes merged — the
    two grids never coincide on x=4, which is exactly the T-junction case)."""
    nodes, elements = [], []
    a_map = rect_grid(0, 4, 0, 4, 8, 8, nodes, elements)               # dx=dy=0.5
    b_map = rect_grid(4, 8, 1.25, 4.5, 8, 7, nodes, elements)          # dx=0.5, dy=0.464286
    mesh = FEMMesh(nodes=nodes, elements=elements, nodeCount=len(nodes), elementCount=len(elements))
    return mesh, a_map, b_map


def a_iface_id(a_map, y):
    j = int(round(y / 0.5))
    return a_map[(8, j)]

def b_iface_id(b_map, y):
    j = int(round((y - 1.25) / (3.25 / 7)))
    return b_map[(0, j)]


def wall_node_ids(mesh):
    """Fixed support on the union outer perimeter (interface x=4, y in [1.25,4] is NOT a wall)."""
    tol = 1e-6
    ids = set()
    for n in mesh.nodes:
        on_a = n.x <= 4.0 + tol and n.y <= 4.0 + tol
        if on_a:
            if abs(n.y - 0.0) < tol or abs(n.x - 0.0) < tol or abs(n.y - 4.0) < tol:
                ids.add(n.id); continue
            if abs(n.x - 4.0) < tol and n.y < 1.25:   # A right edge below B
                ids.add(n.id); continue
        on_b = n.x >= 4.0 - tol and n.y >= 1.25 - tol
        if on_b:
            if abs(n.y - 1.25) < tol or abs(n.x - 8.0) < tol or abs(n.y - 4.5) < tol:
                ids.add(n.id); continue
            if abs(n.x - 4.0) < tol and n.y > 4.0:     # B left edge above A
                ids.add(n.id); continue
    return sorted(ids)


def near_pair_equal_dofs(a_map, b_map, continuous=True, merge_tol=0.175):
    """equalDOF ties for near-coincident interface node pairs (mirrors pyApi merge+tie)."""
    eqs = []
    dofs = [1, 2, 3, 4, 5, 6] if continuous else [1, 2, 3, 6]
    a_ys = [j * 0.5 for j in range(9)]
    b_ys = [1.25 + j * (3.25 / 7) for j in range(8)]
    for ya in a_ys:
        for yb in b_ys:
            if abs(ya - yb) < merge_tol:
                eqs.append(EqualDofConstraint(
                    nodeIdA=a_iface_id(a_map, ya),
                    nodeIdB=b_iface_id(b_map, yb),
                    dofs=dofs
                ))
    return eqs


def edge_constraint_mpcs(a_map, b_map, continuous=True):
    """Weighted MPC ties for the two true T-slaves A(4,1.5), A(4,2.0)."""
    dofs = [3, 4, 5] if continuous else [3]
    specs = [
        # (slave_y, [(master_y, weight), ...])
        (1.5, [(1.25, 0.25 / (0.25 + 0.2142857143)), (1.25 + 3.25 / 7, 0.2142857143 / (0.25 + 0.2142857143))]),
        (2.0, [(1.25 + 3.25 / 7, 1.0 - (2.0 - (1.25 + 3.25 / 7)) / (3.25 / 7)),
                (1.25 + 2 * 3.25 / 7, (2.0 - (1.25 + 3.25 / 7)) / (3.25 / 7))]),
    ]
    mpcs = []
    for slave_y, masters in specs:
        for d in dofs:
            mpcs.append(MpcConstraint(
                slaveNodeId=a_iface_id(a_map, slave_y),
                slaveDof=d,
                masters=[MpcTerm(nodeId=b_iface_id(b_map, my), weight=w) for my, w in masters]
            ))
    return specs, mpcs


def make_request(continuous):
    mesh, a_map, b_map = build_t_junction()
    specs, mpcs = edge_constraint_mpcs(a_map, b_map, continuous)
    req = AnalysisRequest(
        mesh=mesh, thickness=H_SLAB,
        elasticModulus=E_concrete, poissonRatio=NU,
        uniformLoad=Q_KPA, selfWeight=0,
        wallNodeIds=wall_node_ids(mesh),
        wallStartPoints=[], wallEndPoints=[], wallThicknesses=[], wallHeights=[],
        equalDofConstraints=near_pair_equal_dofs(a_map, b_map, continuous),
        mpcConstraints=mpcs,
    )
    return req, mesh, a_map, b_map, specs


def defl_map(result):
    return {d.nodeId: d for d in result.nodeDeflections}


# ════════════════════════════════════════════════════════════════════════
# TEST 1: Python DKT solver — continuous joint MPC interpolation
# ════════════════════════════════════════════════════════════════════════
def test_1_dkt_continuous_edge_constraints():
    req, mesh, a_map, b_map, specs = make_request(continuous=True)
    res = analyze_slab(req)
    assert res.success, f"DKT solve failed: {res.error}"

    dmap = defl_map(res)
    max_abs = max(abs(d.wz) for d in res.nodeDeflections)

    print(f"\n[TEST 1] DKT continuous joint: max |w| = {max_abs*1000:.4f} mm")
    # Deflection sanity band (TS 3-DOF solver reference ≈ 0.35–0.9 mm for this structure)
    assert 0.0002 < max_abs < 0.004, f"Implausible peak deflection {max_abs*1000:.3f} mm"

    for slave_y, masters in specs:
        sid = a_iface_id(a_map, slave_y)
        w_slave = dmap[sid].wz
        w_interp = sum(dmap[b_iface_id(b_map, my)].wz * w for my, w in masters)
        err = abs(w_slave - w_interp)
        print(f"  A(4,{slave_y}): w={w_slave*1000:.5f} mm | interp={w_interp*1000:.5f} mm | err={err*1000:.6f} mm")
        # Penalty MPC holds to ~1e-3 of peak deflection
        assert err < max(1e-6, 0.005 * max_abs), (
            f"Edge constraint violated at A(4,{slave_y}): err={err*1000:.6f} mm")


# ════════════════════════════════════════════════════════════════════════
# TEST 2: Python DKT solver — hinge ties translations only
# ════════════════════════════════════════════════════════════════════════
def test_2_dkt_hinge_translations_only():
    req_h, mesh_h, a_map_h, b_map_h, specs_h = make_request(continuous=False)
    req_c, _, a_map_c, b_map_c, _ = make_request(continuous=True)

    res_h = analyze_slab(req_h)
    res_c = analyze_slab(req_c)
    assert res_h.success and res_c.success

    dmap_h = defl_map(res_h)
    # Hinge still ties W (translation) via dof-3 MPC
    for slave_y, masters in specs_h:
        sid = a_iface_id(a_map_h, slave_y)
        w_slave = dmap_h[sid].wz
        w_interp = sum(dmap_h[b_iface_id(b_map_h, my)].wz * w for my, w in masters)
        err = abs(w_slave - w_interp)
        max_abs_h = max(abs(d.wz) for d in res_h.nodeDeflections)
        print(f"  HINGE A(4,{slave_y}): w={w_slave*1000:.5f} mm | interp={w_interp*1000:.5f} mm | err={err*1000:.6f} mm")
        assert err < max(1e-6, 0.005 * max_abs_h)

    # Hinge releases moments -> joint softens -> peak deflection must grow
    max_h = max(abs(d.wz) for d in res_h.nodeDeflections)
    max_c = max(abs(d.wz) for d in res_c.nodeDeflections)
    print(f"[TEST 2] peak deflection: hinge={max_h*1000:.4f} mm vs continuous={max_c*1000:.4f} mm"
          f" (ratio {max_h/max_c:.3f})")
    assert max_h > max_c * 1.05, "Hinge joint did not soften the structure (rotations may be wrongly tied)"


# ════════════════════════════════════════════════════════════════════════
# TEST 3: Kratos shell solver — continuous joint MPC interpolation
# ════════════════════════════════════════════════════════════════════════
def test_3_kratos_continuous_edge_constraints():
    kratos = pytest.importorskip("KratosMultiphysics")
    from kratos_solver import solve_reslo_structure

    req, mesh, a_map, b_map, specs = make_request(continuous=True)
    res = solve_reslo_structure(req)
    assert res.success, f"Kratos solve failed: {res.error}"

    dmap = defl_map(res)
    max_abs = max(abs(d.wz) for d in res.nodeDeflections)
    print(f"\n[TEST 3] Kratos continuous joint: max |w| = {max_abs*1000:.4f} mm")
    assert 0.0002 < max_abs < 0.004, f"Implausible peak deflection {max_abs*1000:.3f} mm"

    for slave_y, masters in specs:
        sid = a_iface_id(a_map, slave_y)
        w_slave = dmap[sid].wz
        w_interp = sum(dmap[b_iface_id(b_map, my)].wz * w for my, w in masters)
        # Master-slave constraints are exact in Kratos (up to solver tolerance)
        err = abs(w_slave - w_interp)
        print(f"  A(4,{slave_y}): w={w_slave*1000:.5f} mm | interp={w_interp*1000:.5f} mm | err={err*1000:.6f} mm")
        assert err < max(1e-6, 0.01 * max_abs), (
            f"Kratos master-slave constraint violated at A(4,{slave_y}): err={err*1000:.6f} mm")


# ════════════════════════════════════════════════════════════════════════
# TEST 4: Full /api/analyze_multi Scenario-2 pipeline (Kratos, gmsh bypassed)
# Connected slabs → unified coupled system → auto edge constraints → continuity
# ════════════════════════════════════════════════════════════════════════
def _fake_rect_mesher(m_req):
    """gmsh-free structured-grid mesher compatible with kratos_solver.generate_mesh."""
    verts = m_req.geometry.vertices
    xs = [v.x for v in verts]
    ys = [v.y for v in verts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    ms = getattr(m_req, 'meshSize', 0.5) or 0.5
    nx = max(4, int(round((x1 - x0) / ms)))
    ny = max(4, int(round((y1 - y0) / ms)))
    nodes, elements = [], []
    rect_grid(x0, x1, y0, y1, nx, ny, nodes, elements)
    return FEMMesh(nodes=nodes, elements=elements, nodeCount=len(nodes), elementCount=len(elements))


def _multi_request(discontinuous=False):
    from models import (MultiSlabAnalysisRequest, SingleSlabPayload, SlabGeometry,
                        WallSupport, DiscontinuousEdge)
    a_verts = [Point2D(x=0, y=0), Point2D(x=4, y=0), Point2D(x=4, y=4), Point2D(x=0, y=4)]
    b_verts = [Point2D(x=4, y=1.25), Point2D(x=8, y=1.25), Point2D(x=8, y=4.5), Point2D(x=4, y=4.5)]
    slab_a = SingleSlabPayload(
        slabId="A", geometry=SlabGeometry(vertices=a_verts),
        meshSize=0.5, thickness=H_SLAB, elasticModulus=E_concrete,
        poissonRatio=NU, uniformLoad=Q_KPA, selfWeight=0.0)
    slab_b = SingleSlabPayload(
        slabId="B", geometry=SlabGeometry(vertices=b_verts),
        meshSize=0.5, thickness=H_SLAB, elasticModulus=E_concrete,
        poissonRatio=NU, uniformLoad=Q_KPA, selfWeight=0.0)
    if discontinuous:
        slab_a.discontinuousEdges = [DiscontinuousEdge(
            startPoint=Point2D(x=4, y=0), endPoint=Point2D(x=4, y=4))]
    # Union outer perimeter walls (interface x=4, y∈[1.25,4] is NOT a wall)
    seg = [(0, 0, 4, 0), (4, 0, 4, 1.25), (4, 1.25, 8, 1.25), (8, 1.25, 8, 4.5),
           (8, 4.5, 4, 4.5), (4, 4.5, 4, 4), (4, 4, 0, 4), (0, 4, 0, 0)]
    walls = [WallSupport(startPoint=Point2D(x=s[0], y=s[1]),
                         endPoint=Point2D(x=s[2], y=s[3])) for s in seg]
    return MultiSlabAnalysisRequest(slabs=[slab_a, slab_b], walls=walls, meshSize=0.5)


def _iface_w_by_y(result_item):
    """y -> w (m) for interface nodes (x ≈ 4) of a partitioned slab result."""
    dmap = {d.nodeId: d.wz for d in result_item.result.nodeDeflections}
    out = {}
    for n in result_item.mesh.nodes:
        if abs(n.x - 4.0) < 1e-6 and n.id in dmap:
            out[n.y] = dmap[n.id]
    return out


def _check_interface_continuity(resp, tol_frac=0.10):
    """Nodes of A on x=4 must follow the linear interpolation of bracketing B nodes.

    Tolerance rationale (10% of peak deflection):
    - MPC-tied T-slaves hold EXACTLY (master-slave constraints, verified in test 3);
    - merged nodes are re-positioned at the cluster centroid, so comparing against
      interpolation of their original coordinates carries a merge-drift residual of
      order (merge_tol * |dw/dy|), concentrated near wall gradients;
    - the non-slave side of the bipartite edge constraint keeps its own discretization
      values (O(h^2) residual), exactly as ETABS auto line constraints do.
    A 10%-of-peak envelope verifies true C0 contour continuity without confusing
    discretization noise for a broken joint.
    """
    res_a = next(r for r in resp.results if r.slabId == "A")
    res_b = next(r for r in resp.results if r.slabId == "B")
    wa = _iface_w_by_y(res_a)
    wb = _iface_w_by_y(res_b)
    max_abs = max(
        max(abs(d.wz) for d in res_a.result.nodeDeflections),
        max(abs(d.wz) for d in res_b.result.nodeDeflections),
    )
    bys = sorted(wb)
    worst = 0.0
    for ya, w_a in sorted(wa.items()):
        if ya < bys[0] - 1e-9 or ya > bys[-1] + 1e-9:
            continue  # outside B coverage (A-only boundary)
        lo = max(y for y in bys if y <= ya + 1e-9)
        hi = min(y for y in bys if y >= ya - 1e-9)
        if abs(hi - lo) < 1e-12:
            w_interp = wb[lo]
        else:
            t = (ya - lo) / (hi - lo)
            w_interp = wb[lo] * (1 - t) + wb[hi] * t
        disc = abs(w_a - w_interp)
        worst = max(worst, disc)
        assert disc < max(1e-6, tol_frac * max_abs), (
            f"Interface discontinuity at A(4,{ya:.4f}): "
            f"w_A={w_a*1000:.5f} mm vs interp={w_interp*1000:.5f} mm "
            f"(disc {disc*1000:.5f} mm)")
    print(f"  interface max W-discontinuity: {worst*1000:.6f} mm "
          f"(peak |w| = {max_abs*1000:.4f} mm)")
    return max_abs


def test_4_multi_slab_scenario2_auto_edge_constraints(monkeypatch):
    pytest.importorskip("KratosMultiphysics")
    import kratos_solver
    monkeypatch.setattr(kratos_solver, "generate_mesh", _fake_rect_mesher)

    resp = kratos_solver.solve_multi_slab_structure(_multi_request(discontinuous=False))
    assert resp.success, f"Multi-slab solve failed: {resp.warnings}"
    assert len(resp.results) == 2, f"Expected 2 slab results, got {len(resp.results)}"

    print("\n[TEST 4] Scenario-2 unified solve, continuous joint:")
    max_abs = _check_interface_continuity(resp, tol_frac=0.10)
    assert 0.0002 < max_abs < 0.004, f"Implausible peak deflection {max_abs*1000:.3f} mm"


def test_5_multi_slab_scenario2_hinge_joint(monkeypatch):
    pytest.importorskip("KratosMultiphysics")
    import kratos_solver
    monkeypatch.setattr(kratos_solver, "generate_mesh", _fake_rect_mesher)

    resp_h = kratos_solver.solve_multi_slab_structure(_multi_request(discontinuous=True))
    resp_c = kratos_solver.solve_multi_slab_structure(_multi_request(discontinuous=False))
    assert resp_h.success and resp_c.success

    print("\n[TEST 5] Scenario-2 unified solve, HINGE joint (translations tied):")
    max_h = _check_interface_continuity(resp_h, tol_frac=0.10)
    max_c = _check_interface_continuity(resp_c, tol_frac=0.10)
    print(f"  peak deflection: hinge={max_h*1000:.4f} mm vs continuous={max_c*1000:.4f} mm")
    # Hinge releases interface moments -> structure softens
    assert max_h > max_c * 1.02, "Hinge joint did not soften the structure"


if __name__ == "__main__":
    test_1_dkt_continuous_edge_constraints()
    test_2_dkt_hinge_translations_only()
    test_3_kratos_continuous_edge_constraints()

    class _MP:
        def setattr(self, obj, name, val): setattr(obj, name, val)
    test_4_multi_slab_scenario2_auto_edge_constraints(_MP())
    test_5_multi_slab_scenario2_hinge_joint(_MP())
    print("\nAll MPC interface tests PASSED")
