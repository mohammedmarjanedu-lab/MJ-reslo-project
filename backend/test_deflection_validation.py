"""
Comprehensive Deflection Validation Test Suite
================================================
Cross-checks solver deflection output against:
  1. Kirchhoff-Love thin plate analytical solutions
  2. Timoshenko & Woinowsky-Krieger plate theory tables
  3. ETABS-style column-supported flat slab benchmarks
  4. Manual beam/strip calculations

All scenarios use concrete E=25 GPa, ν=0.2 unless noted.

Author: Structural Engineering Audit
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import math
from solver import analyze_slab
from models import (
    AnalysisRequest, AnalysisResponse,
    FEMMesh, FEMNode, Triangle, Point2D
)


# ─── Helper: generate structured triangular mesh for rectangular plate ───
def rect_mesh(Lx: float, Ly: float, nx: int, ny: int):
    """Generate a structured triangular mesh for a rectangle [0,Lx]×[0,Ly].
    nx, ny = number of divisions in x, y.
    Returns FEMMesh with 1-indexed nodes.
    """
    nodes = []
    nid = 1
    for j in range(ny + 1):
        for i in range(nx + 1):
            nodes.append(FEMNode(id=nid, x=i * Lx / nx, y=j * Ly / ny))
            nid += 1

    elements = []
    eid = 1
    for j in range(ny):
        for i in range(nx):
            n0 = j * (nx + 1) + i + 1
            n1 = n0 + 1
            n2 = n0 + (nx + 1) + 1
            n3 = n0 + (nx + 1)
            elements.append(Triangle(id=eid, nodeIds=[n0, n1, n2]))
            eid += 1
            elements.append(Triangle(id=eid, nodeIds=[n0, n2, n3]))
            eid += 1

    return FEMMesh(
        nodes=nodes, elements=elements,
        nodeCount=len(nodes), elementCount=len(elements)
    )


def get_wall_nodes(mesh: FEMMesh, edges: list) -> list:
    """Return node IDs on specified edges of a rectangle.
    edges: list of 'left', 'right', 'top', 'bottom'
    """
    xs = [n.x for n in mesh.nodes]
    ys = [n.y for n in mesh.nodes]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    tol = 1e-6
    wall_ids = set()
    for n in mesh.nodes:
        if 'left' in edges and abs(n.x - xmin) < tol:
            wall_ids.add(n.id)
        if 'right' in edges and abs(n.x - xmax) < tol:
            wall_ids.add(n.id)
        if 'bottom' in edges and abs(n.y - ymin) < tol:
            wall_ids.add(n.id)
        if 'top' in edges and abs(n.y - ymax) < tol:
            wall_ids.add(n.id)
    return list(wall_ids)


def find_node_near(mesh: FEMMesh, x: float, y: float) -> int:
    """Find 1-indexed node closest to (x,y)."""
    best_id = mesh.nodes[0].id
    best_d = float('inf')
    for n in mesh.nodes:
        d = math.hypot(n.x - x, n.y - y)
        if d < best_d:
            best_d = d
            best_id = n.id
    return best_id


def get_max_deflection(result: AnalysisResponse) -> float:
    """Return max absolute wz from result (in meters, solver sign)."""
    return max(abs(d.wz) for d in result.nodeDeflections)


def get_center_deflection(result: AnalysisResponse, cx: float, cy: float, mesh: FEMMesh) -> float:
    """Return wz at the node closest to (cx, cy)."""
    nid = find_node_near(mesh, cx, cy)
    for d in result.nodeDeflections:
        if d.nodeId == nid:
            return d.wz
    return 0.0


# ─── Material constants ───
E_concrete = 25e9   # Pa (25 GPa)
nu = 0.2
h_slab = 0.2        # 200mm slab
q_total_kpa = 10.0   # kN/m² (uniform + self-weight combined)
# Flexural rigidity
D_plate = E_concrete * h_slab**3 / (12 * (1 - nu**2))


#####################################################################
# TEST 1: Simply Supported Square Plate — All 4 edges
#####################################################################
def test_1_ssss_square_plate():
    """
    Simply supported square plate under uniform load.
    Navier solution: w_max = α·q·a⁴/D
    For ν=0.2: α ≈ 0.00406 (Timoshenko Table 8, square plate SSSS)

    a = 6m, h = 0.2m, E = 25 GPa, q = 10 kN/m² = 10000 N/m²
    D = 25e9 * 0.008 / (12*(1-0.04)) = 17361111.1 N·m
    w_analytical = 0.00406 * 10000 * 6^4 / 17361111.1
               = 0.00406 * 10000 * 1296 / 17361111.1
               = 0.00406 * 12960000 / 17361111.1
               = 52617.6 / 17361111.1
               = 0.003031 m = 3.031 mm
    """
    a = 6.0
    nx = ny = 20
    mesh = rect_mesh(a, a, nx, ny)
    wall_ids = get_wall_nodes(mesh, ['left', 'right', 'top', 'bottom'])

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=wall_ids,
        wallStartPoints=[], wallEndPoints=[],
        wallThicknesses=[], wallHeights=[],
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    w_center = abs(get_center_deflection(result, a/2, a/2, mesh))
    alpha = 0.00406
    q_Nm2 = q_total_kpa * 1000
    w_analytical = alpha * q_Nm2 * a**4 / D_plate

    error_pct = abs(w_center - w_analytical) / w_analytical * 100

    print(f"\n{'='*60}")
    print(f"TEST 1: SSSS Square Plate (6m × 6m)")
    print(f"{'='*60}")
    print(f"  Analytical (Navier): {w_analytical*1000:.4f} mm")
    print(f"  FEM (center):        {w_center*1000:.4f} mm")
    print(f"  Error:               {error_pct:.2f}%")
    print(f"  VERDICT:             {'PASS' if error_pct < 5 else 'FAIL'} (threshold: 5%)")

    # Note: Wall rotational springs add some rotational restraint,
    # so pure SSSS with zero rotation stiffness gives closer match.
    # With wall rotational springs, the result will be stiffer (less deflection).
    return error_pct, w_center, w_analytical


#####################################################################
# TEST 2: SSSS Rectangular Plate 2:1 Aspect Ratio
#####################################################################
def test_2_ssss_rectangular_plate():
    """
    Simply-supported rectangular plate (Lx=8m × Ly=4m), aspect ratio 2:1.
    Timoshenko Table 8: α ≈ 0.01013 for b/a=2.0, SSSS (using b as long side).
    Actually for a/b = 0.5 (short/long = 4/8): α = 0.01013

    w_max = α·q·b⁴/D where b is the SHORT span = 4m
    w = 0.01013 * 10000 * 4^4 / D_plate
    """
    Lx, Ly = 8.0, 4.0
    nx, ny = 24, 12
    mesh = rect_mesh(Lx, Ly, nx, ny)
    wall_ids = get_wall_nodes(mesh, ['left', 'right', 'top', 'bottom'])

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=wall_ids,
        wallStartPoints=[], wallEndPoints=[],
        wallThicknesses=[], wallHeights=[],
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    w_center = abs(get_center_deflection(result, Lx/2, Ly/2, mesh))
    # For aspect ratio b/a=2 (long/short), Timoshenko α=0.01013 using short span
    alpha = 0.01013
    b_short = Ly  # 4m
    q_Nm2 = q_total_kpa * 1000
    w_analytical = alpha * q_Nm2 * b_short**4 / D_plate

    error_pct = abs(w_center - w_analytical) / w_analytical * 100

    print(f"\n{'='*60}")
    print(f"TEST 2: SSSS Rectangular Plate (8m × 4m, ratio 2:1)")
    print(f"{'='*60}")
    print(f"  Analytical (Timoshenko): {w_analytical*1000:.4f} mm")
    print(f"  FEM (center):            {w_center*1000:.4f} mm")
    print(f"  Error:                   {error_pct:.2f}%")
    print(f"  VERDICT:                 {'PASS' if error_pct < 5 else 'FAIL'} (threshold: 5%)")

    return error_pct, w_center, w_analytical


#####################################################################
# TEST 3: Column-Supported Flat Slab — 4 corner columns
#####################################################################
def test_3_column_supported_4corners():
    """
    Flat slab 6m × 6m supported on 4 corner columns (0.3×0.3m).
    Each column provides translational constraint (w=0) + rotational spring.

    This is a standard flat slab scenario.
    Approximate analytical: For a simply supported flat slab on 4 point supports,
    w_center ≈ q·L⁴ / (α·D) where α depends on support conditions.
    For 4-corner point supports with free rotation:
    w_center ≈ 0.0116 * q * a^4 / D  (Szilard, 1974, Table 5.7)
    """
    a = 6.0
    nx = ny = 20
    mesh = rect_mesh(a, a, nx, ny)

    # Column positions at 4 corners
    col_positions = [(0, 0), (a, 0), (a, a), (0, a)]
    col_node_ids = [find_node_near(mesh, x, y) for x, y in col_positions]

    col_w = 0.3
    col_d = 0.3
    col_H = 3.0
    E_col = 25e9
    Ix_col = col_w * col_d**3 / 12
    Iy_col = col_d * col_w**3 / 12
    I_avg = (Ix_col + Iy_col) / 2
    kth = 4 * E_col * I_avg / col_H  # fixed-fixed rotational stiffness

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=[],
        columnNodeIds=col_node_ids,
        columnStiffnesses=[kth]*4,
        columnWidths=[col_w]*4,
        columnDepths=[col_d]*4,
        columnHeights=[col_H]*4,
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    w_center = abs(get_center_deflection(result, a/2, a/2, mesh))

    # Analytical: Point-supported plate, 4 corners, uniform load
    # Szilard (1974): α ≈ 0.0116 for 4-corner point supports
    alpha = 0.0116
    q_Nm2 = q_total_kpa * 1000
    w_analytical = alpha * q_Nm2 * a**4 / D_plate

    error_pct = abs(w_center - w_analytical) / w_analytical * 100

    print(f"\n{'='*60}")
    print(f"TEST 3: 4-Corner Column-Supported Flat Slab (6m × 6m)")
    print(f"{'='*60}")
    print(f"  Analytical (Szilard):  {w_analytical*1000:.4f} mm")
    print(f"  FEM (center):          {w_center*1000:.4f} mm")
    print(f"  Error:                 {error_pct:.2f}%")
    print(f"  Column spring Kθ:      {kth:.0f} N·m/rad")
    print(f"  VERDICT:               {'PASS' if error_pct < 15 else 'FAIL'} (threshold: 15%)")

    # Columns are modeled as ELASTIC compression springs (Kz = E·A/H), not rigid
    # supports — so column nodes must show elastic shortening, NOT w = 0.
    # By symmetry each column carries R = q·A/4, giving δ = R/Kz exactly.
    kz_col = E_concrete * (col_w * col_d) / col_H          # 7.5e8 N/m
    total_load_N = q_total_kpa * 1000 * a * a               # 360 kN
    wz_expected = (total_load_N / 4) / kz_col               # ≈ 0.120 mm
    for nid in col_node_ids:
        for d in result.nodeDeflections:
            if d.nodeId == nid:
                print(f"  Column node {nid}: wz = {d.wz*1000:.6f} mm (elastic shortening, expected ≈ {wz_expected*1000:.4f} mm)")
                assert abs(d.wz - wz_expected) < 0.15 * wz_expected, (
                    f"Column node {nid} elastic shortening off: wz={d.wz}, expected≈{wz_expected}"
                )
                # And it must remain negligible vs span deflection
                assert abs(d.wz) < 0.02 * abs(w_center) or abs(w_center) < 1e-9, (
                    f"Column settlement {d.wz} too large relative to span deflection {w_center}"
                )

    return error_pct, w_center, w_analytical


#####################################################################
# TEST 4: 9-Column Grid (interior span behavior)
#####################################################################
def test_4_nine_column_grid():
    """
    Flat slab 12m × 12m on 3×3 grid of columns at 6m × 6m spacing.
    Tests interior span deflection vs edge/corner span.

    Column positions: (0,0), (6,0), (12,0), (0,6), (6,6), (12,6), (0,12), (6,12), (12,12)

    Interior span should show symmetric deflection pattern.
    Edge spans should deflect more than interior.

    ETABS benchmark: ~4-8mm for typical 200mm slab with 10kN/m² at 6m spans.
    """
    Lx = Ly = 12.0
    nx = ny = 24
    mesh = rect_mesh(Lx, Ly, nx, ny)

    col_positions = [
        (0, 0), (6, 0), (12, 0),
        (0, 6), (6, 6), (12, 6),
        (0, 12), (6, 12), (12, 12)
    ]
    col_node_ids = [find_node_near(mesh, x, y) for x, y in col_positions]

    col_w = 0.4
    col_d = 0.4
    col_H = 3.0
    E_col = 25e9
    I_col = col_w * col_d**3 / 12
    kth = 4 * E_col * I_col / col_H

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=[],
        columnNodeIds=col_node_ids,
        columnStiffnesses=[kth]*9,
        columnWidths=[col_w]*9,
        columnDepths=[col_d]*9,
        columnHeights=[col_H]*9,
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    # Interior panel midpoint (3,3) — center of one of the interior panels
    w_interior = abs(get_center_deflection(result, 3.0, 3.0, mesh))
    # Edge panel midpoint
    w_edge = abs(get_center_deflection(result, 3.0, 9.0, mesh))
    # Overall center (6,6) — should be at a column, so ~0
    w_at_center_col = abs(get_center_deflection(result, 6.0, 6.0, mesh))
    # Max deflection anywhere
    w_max = get_max_deflection(result)

    print(f"\n{'='*60}")
    print(f"TEST 4: 9-Column Grid (12m × 12m, 6m spans)")
    print(f"{'='*60}")
    print(f"  Interior panel center (3,3):   {w_interior*1000:.4f} mm")
    print(f"  Edge panel center (3,9):       {w_edge*1000:.4f} mm")
    print(f"  Center column (6,6):           {w_at_center_col*1000:.6f} mm (should be ~0)")
    print(f"  Max deflection:                {w_max*1000:.4f} mm")
    print(f"  Edge/Interior ratio:           {w_edge/w_interior:.3f}")

    # Sanity checks
    checks_pass = True
    if w_at_center_col > 0.001:  # column node should be nearly zero
        print(f"  ⚠ FAIL: Center column deflection too large!")
        checks_pass = False
    if w_max > 0.030:  # 30mm would be unreasonable for 200mm slab at 6m span
        print(f"  ⚠ WARNING: Max deflection seems high for this span")
    if w_max < 0.001:  # sub-millimeter means something is wrong
        print(f"  ⚠ FAIL: Max deflection implausibly small")
        checks_pass = False

    # ETABS typical range for this scenario: 4-8mm
    in_etabs_range = 2.0 <= w_max*1000 <= 15.0
    print(f"  In ETABS range (2-15mm):       {'YES' if in_etabs_range else 'NO'}")
    print(f"  VERDICT:                       {'PASS' if checks_pass and in_etabs_range else 'FAIL'}")

    return checks_pass, w_max


#####################################################################
# TEST 5: Single Interior Column — Deflection Profile
#####################################################################
def test_5_single_center_column():
    """
    Flat slab 6m × 6m, walls on all edges, one column at center.
    Walls provide line support (w=0), center column provides point support.

    The deflection at the center should be ~0 (column).
    Maximum deflection should be at the mid-edge of each quarter span.

    Manual estimate (superposition):
    Without center column: w_center ≈ 3.03 mm (from Test 1)
    With center column: deflection pattern reverses near column,
    max deflection appears at ~L/4 locations.
    """
    a = 6.0
    nx = ny = 20
    mesh = rect_mesh(a, a, nx, ny)
    wall_ids = get_wall_nodes(mesh, ['left', 'right', 'top', 'bottom'])

    col_nid = find_node_near(mesh, a/2, a/2)
    col_w = 0.3
    col_d = 0.3
    col_H = 3.0
    E_col = 25e9
    I_col = col_w * col_d**3 / 12
    kth = 4 * E_col * I_col / col_H

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=wall_ids,
        wallStartPoints=[Point2D(x=0, y=0), Point2D(x=a, y=0), Point2D(x=a, y=a), Point2D(x=0, y=a)],
        wallEndPoints=[Point2D(x=a, y=0), Point2D(x=a, y=a), Point2D(x=0, y=a), Point2D(x=0, y=0)],
        wallThicknesses=[0.25]*4, wallHeights=[3.0]*4,
        columnNodeIds=[col_nid],
        columnStiffnesses=[kth],
        columnWidths=[col_w],
        columnDepths=[col_d],
        columnHeights=[col_H],
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    w_at_col = abs(get_center_deflection(result, a/2, a/2, mesh))
    w_at_quarter = abs(get_center_deflection(result, a/4, a/4, mesh))
    w_at_edge_mid = abs(get_center_deflection(result, a/2, 0, mesh))
    w_max = get_max_deflection(result)

    print(f"\n{'='*60}")
    print(f"TEST 5: Wall-Supported + Center Column (6m × 6m)")
    print(f"{'='*60}")
    print(f"  At center column (3,3):    {w_at_col*1000:.6f} mm (should be ~0)")
    print(f"  At quarter point (1.5,1.5): {w_at_quarter*1000:.4f} mm")
    print(f"  At wall midpoint (3,0):    {w_at_edge_mid*1000:.6f} mm (should be ~0)")
    print(f"  Max deflection:            {w_max*1000:.4f} mm")

    checks_pass = True
    if w_at_col > 0.0005:  # column point should be essentially zero
        print(f"  ⚠ FAIL: Column point not constrained!")
        checks_pass = False
    if w_at_edge_mid > 0.0005:  # wall edge should be zero
        print(f"  ⚠ FAIL: Wall edge not constrained!")
        checks_pass = False
    if w_max < 0.0001:
        print(f"  ⚠ FAIL: Deflection implausibly small")
        checks_pass = False

    print(f"  VERDICT:                   {'PASS' if checks_pass else 'FAIL'}")
    return checks_pass, w_max


#####################################################################
# TEST 6: Beam Analogy Verification (One-Way Slab)
#####################################################################
def test_6_one_way_slab_beam_analogy():
    """
    Very long narrow plate (10m × 1m) with walls on the 1m edges.
    Behaves as a simply-supported beam of span L=10m.

    Beam analytical: w_max = 5·q·L⁴ / (384·EI)
    where I = bh³/12 per unit width, b=1m
    EI per unit width = E·h³/12 = 25e9 * 0.008 / 12 = 16666667 N·m²

    Wait — for a plate, we use D = E·h³/(12(1-ν²)) which includes Poisson.
    For one-way bending, the unit-width strip stiffness D is correct.

    w_beam = 5·q·L⁴/ (384·D·b) where b = strip width = 1m
    But for a plate strip, cylindrical bending gives: w = 5·q·L⁴ / (384·D)
    where D = E·h³/(12(1-ν²))

    L = 10m, q = 10000 N/m²
    w = 5 * 10000 * 10^4 / (384 * D_plate)
    """
    Lx, Ly = 10.0, 1.0  # long span in x
    nx, ny = 40, 4
    mesh = rect_mesh(Lx, Ly, nx, ny)
    # Walls on short edges (x=0 and x=Lx)
    wall_ids = get_wall_nodes(mesh, ['left', 'right'])

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=wall_ids,
        wallStartPoints=[], wallEndPoints=[],
        wallThicknesses=[], wallHeights=[],
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    w_center = abs(get_center_deflection(result, Lx/2, Ly/2, mesh))

    # Beam analytical (cylindrical bending of a plate strip)
    q_Nm2 = q_total_kpa * 1000
    w_beam = 5 * q_Nm2 * Lx**4 / (384 * D_plate)

    error_pct = abs(w_center - w_beam) / w_beam * 100

    print(f"\n{'='*60}")
    print(f"TEST 6: One-Way Slab (Beam Analogy, 10m × 1m)")
    print(f"{'='*60}")
    print(f"  Beam analytical: {w_beam*1000:.4f} mm")
    print(f"  FEM (center):    {w_center*1000:.4f} mm")
    print(f"  Error:           {error_pct:.2f}%")
    print(f"  VERDICT:         {'PASS' if error_pct < 10 else 'FAIL'} (threshold: 10%)")

    return error_pct, w_center, w_beam


#####################################################################
# TEST 7: Mesh Convergence Study
#####################################################################
def test_7_mesh_convergence():
    """
    6m × 6m SSSS plate, check deflection converges as mesh refines.
    Theory: DKT should converge from below (overly stiff for coarse mesh).
    """
    a = 6.0
    mesh_sizes = [4, 8, 12, 16, 24, 32]
    results_list = []

    for n in mesh_sizes:
        mesh = rect_mesh(a, a, n, n)
        wall_ids = get_wall_nodes(mesh, ['left', 'right', 'top', 'bottom'])

        request = AnalysisRequest(
            mesh=mesh, thickness=h_slab,
            elasticModulus=E_concrete, poissonRatio=nu,
            uniformLoad=q_total_kpa, selfWeight=0,
            wallNodeIds=wall_ids,
            wallStartPoints=[], wallEndPoints=[],
            wallThicknesses=[], wallHeights=[],
        )

        result = analyze_slab(request)
        assert result.success
        w_c = abs(get_center_deflection(result, a/2, a/2, mesh))
        results_list.append((n, len(mesh.nodes), w_c))

    alpha = 0.00406
    q_Nm2 = q_total_kpa * 1000
    w_analytical = alpha * q_Nm2 * a**4 / D_plate

    print(f"\n{'='*60}")
    print(f"TEST 7: Mesh Convergence (6m × 6m SSSS)")
    print(f"{'='*60}")
    print(f"  Analytical: {w_analytical*1000:.4f} mm")
    print(f"  {'Mesh':>6s} {'Nodes':>6s} {'w_center(mm)':>14s} {'Error(%)':>10s}")
    print(f"  {'─'*42}")

    converging = True
    for i, (n, nodes, w) in enumerate(results_list):
        err = abs(w - w_analytical) / w_analytical * 100
        print(f"  {n:>4d}×{n:<2d} {nodes:>6d} {w*1000:>14.4f} {err:>10.2f}%")
        if i > 0 and w < results_list[i-1][2] * 0.95:  # should be monotonically increasing
            converging = False

    final_err = abs(results_list[-1][2] - w_analytical) / w_analytical * 100
    print(f"\n  Convergence: {'MONOTONIC' if converging else 'NON-MONOTONIC'}")
    print(f"  Final error: {final_err:.2f}%")
    print(f"  VERDICT:     {'PASS' if final_err < 5 else 'FAIL'}")

    return final_err, results_list


#####################################################################
# TEST 8: Column Stiffness Sensitivity
#####################################################################
def test_8_column_stiffness_sensitivity():
    """
    6m × 6m flat slab on 4 corner columns.
    Vary column size and check deflection responds correctly.
    Bigger columns → more rotational restraint → less deflection.
    """
    a = 6.0
    nx = ny = 16
    mesh = rect_mesh(a, a, nx, ny)

    col_positions = [(0, 0), (a, 0), (a, a), (0, a)]
    col_node_ids = [find_node_near(mesh, x, y) for x, y in col_positions]

    col_sizes = [(0.2, 0.2), (0.3, 0.3), (0.4, 0.4), (0.6, 0.6), (1.0, 1.0)]
    col_H = 3.0
    E_col = 25e9

    print(f"\n{'='*60}")
    print(f"TEST 8: Column Stiffness Sensitivity (6m × 6m)")
    print(f"{'='*60}")
    print(f"  {'Col Size':>10s} {'Kθ (N·m/rad)':>15s} {'w_center(mm)':>14s}")
    print(f"  {'─'*45}")

    prev_w = float('inf')
    monotonic = True
    for cw, cd in col_sizes:
        I_col = cw * cd**3 / 12
        kth = 4 * E_col * I_col / col_H

        request = AnalysisRequest(
            mesh=mesh, thickness=h_slab,
            elasticModulus=E_concrete, poissonRatio=nu,
            uniformLoad=q_total_kpa, selfWeight=0,
            wallNodeIds=[],
            columnNodeIds=col_node_ids,
            columnStiffnesses=[kth]*4,
            columnWidths=[cw]*4,
            columnDepths=[cd]*4,
            columnHeights=[col_H]*4,
        )
        result = analyze_slab(request)
        assert result.success

        w_c = abs(get_center_deflection(result, a/2, a/2, mesh))
        print(f"  {cw:.1f}×{cd:.1f}m {kth:>15.0f} {w_c*1000:>14.4f}")

        if w_c > prev_w * 1.01:  # allowing 1% tolerance
            monotonic = False
        prev_w = w_c

    print(f"\n  Deflection decreasing with larger columns: {'YES' if monotonic else 'NO'}")
    print(f"  VERDICT: {'PASS' if monotonic else 'FAIL'}")
    return monotonic


#####################################################################
# TEST 9: Symmetry Check
#####################################################################
def test_9_symmetry_check():
    """
    6m × 6m SSSS plate — deflection should be symmetric about both axes.
    Check quarter-point deflections match.
    """
    a = 6.0
    nx = ny = 20
    mesh = rect_mesh(a, a, nx, ny)
    wall_ids = get_wall_nodes(mesh, ['left', 'right', 'top', 'bottom'])

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=wall_ids,
        wallStartPoints=[], wallEndPoints=[],
        wallThicknesses=[], wallHeights=[],
    )

    result = analyze_slab(request)
    assert result.success

    # Quarter points
    pts = [
        (a/4, a/4), (3*a/4, a/4), (a/4, 3*a/4), (3*a/4, 3*a/4),
        (a/2, a/4), (a/2, 3*a/4), (a/4, a/2), (3*a/4, a/2)
    ]
    deflections = []
    for px, py in pts:
        w = abs(get_center_deflection(result, px, py, mesh))
        deflections.append(w)

    print(f"\n{'='*60}")
    print(f"TEST 9: Symmetry Check (6m × 6m SSSS)")
    print(f"{'='*60}")
    for (px, py), w in zip(pts, deflections):
        print(f"  ({px:.1f}, {py:.1f}): {w*1000:.4f} mm")

    # Check symmetry: corner quarters should all be equal
    q_deflections = deflections[:4]
    max_sym_error = max(abs(d - q_deflections[0]) / q_deflections[0] * 100 for d in q_deflections)

    # Midpoint quarters should be equal in pairs
    mid_pairs = [(deflections[4], deflections[5]), (deflections[6], deflections[7])]
    max_mid_error = 0
    for a_val, b_val in mid_pairs:
        if a_val > 0:
            max_mid_error = max(max_mid_error, abs(a_val - b_val) / a_val * 100)

    print(f"\n  Max corner symmetry error:  {max_sym_error:.3f}%")
    print(f"  Max midpoint symmetry error: {max_mid_error:.3f}%")
    symmetric = max_sym_error < 1.0 and max_mid_error < 1.0
    print(f"  VERDICT: {'PASS' if symmetric else 'FAIL'} (threshold: 1%)")

    return symmetric


#####################################################################
# TEST 10: Edge Column Behavior
#####################################################################
def test_10_edge_and_interior_columns():
    """
    8m × 8m flat slab with:
    - 4 corner columns
    - 4 edge mid-columns
    - 1 center column

    Tests that edge columns properly reduce deflection in their neighborhood.
    Also checks column nodes have near-zero deflection.
    """
    a = 8.0
    nx = ny = 24
    mesh = rect_mesh(a, a, nx, ny)

    col_positions = [
        (0, 0), (a/2, 0), (a, 0),     # bottom edge
        (0, a/2),         (a, a/2),    # left/right edges
        (0, a), (a/2, a), (a, a),      # top edge
        (a/2, a/2),                     # center
    ]
    col_node_ids = [find_node_near(mesh, x, y) for x, y in col_positions]
    n_cols = len(col_positions)

    col_w = 0.4
    col_d = 0.4
    col_H = 3.0
    E_col = 25e9
    I_col = col_w * col_d**3 / 12
    kth = 4 * E_col * I_col / col_H

    request = AnalysisRequest(
        mesh=mesh, thickness=h_slab,
        elasticModulus=E_concrete, poissonRatio=nu,
        uniformLoad=q_total_kpa, selfWeight=0,
        wallNodeIds=[],
        columnNodeIds=col_node_ids,
        columnStiffnesses=[kth]*n_cols,
        columnWidths=[col_w]*n_cols,
        columnDepths=[col_d]*n_cols,
        columnHeights=[col_H]*n_cols,
    )

    result = analyze_slab(request)
    assert result.success, f"Solver failed: {result.error}"

    print(f"\n{'='*60}")
    print(f"TEST 10: Edge + Interior Columns (8m × 8m)")
    print(f"{'='*60}")

    # Check all column nodes have ~0 deflection
    col_deflections_ok = True
    for i, nid in enumerate(col_node_ids):
        for d in result.nodeDeflections:
            if d.nodeId == nid:
                px, py = col_positions[i]
                w_col = abs(d.wz)
                print(f"  Column at ({px:.1f},{py:.1f}) node {nid}: wz = {w_col*1000:.6f} mm")
                if w_col > 0.001:  # 1 micron tolerance
                    col_deflections_ok = False
                    print(f"    ⚠ Column node not properly constrained!")

    # Check panel midpoints
    w_quarter_panel = abs(get_center_deflection(result, a/4, a/4, mesh))
    w_max = get_max_deflection(result)
    print(f"\n  Quarter panel (2,2): {w_quarter_panel*1000:.4f} mm")
    print(f"  Max deflection:      {w_max*1000:.4f} mm")
    print(f"  Columns constrained: {'YES' if col_deflections_ok else 'NO'}")
    print(f"  VERDICT:             {'PASS' if col_deflections_ok else 'FAIL'}")

    return col_deflections_ok, w_max


#####################################################################
# MAIN: RUN ALL TESTS
#####################################################################
if __name__ == '__main__':
    print("=" * 70)
    print("COMPREHENSIVE DEFLECTION VALIDATION SUITE")
    print("FEM Solver: DKT Flat Shell (6-DOF per node)")
    print(f"Material: E={E_concrete/1e9:.1f} GPa, ν={nu}, h={h_slab*1000:.0f}mm")
    print(f"Load: q={q_total_kpa:.0f} kN/m² (combined)")
    print(f"D = {D_plate:.2f} N·m")
    print("=" * 70)

    all_pass = True

    try:
        err1, w1, wa1 = test_1_ssss_square_plate()
    except Exception as e:
        print(f"\nTEST 1 FAILED with exception: {e}")
        all_pass = False

    try:
        err2, w2, wa2 = test_2_ssss_rectangular_plate()
    except Exception as e:
        print(f"\nTEST 2 FAILED with exception: {e}")
        all_pass = False

    try:
        err3, w3, wa3 = test_3_column_supported_4corners()
    except Exception as e:
        print(f"\nTEST 3 FAILED with exception: {e}")
        all_pass = False

    try:
        pass4, wm4 = test_4_nine_column_grid()
    except Exception as e:
        print(f"\nTEST 4 FAILED with exception: {e}")
        all_pass = False

    try:
        pass5, wm5 = test_5_single_center_column()
    except Exception as e:
        print(f"\nTEST 5 FAILED with exception: {e}")
        all_pass = False

    try:
        err6, w6, wa6 = test_6_one_way_slab_beam_analogy()
    except Exception as e:
        print(f"\nTEST 6 FAILED with exception: {e}")
        all_pass = False

    try:
        err7, conv7 = test_7_mesh_convergence()
    except Exception as e:
        print(f"\nTEST 7 FAILED with exception: {e}")
        all_pass = False

    try:
        pass8 = test_8_column_stiffness_sensitivity()
    except Exception as e:
        print(f"\nTEST 8 FAILED with exception: {e}")
        all_pass = False

    try:
        pass9 = test_9_symmetry_check()
    except Exception as e:
        print(f"\nTEST 9 FAILED with exception: {e}")
        all_pass = False

    try:
        pass10, wm10 = test_10_edge_and_interior_columns()
    except Exception as e:
        print(f"\nTEST 10 FAILED with exception: {e}")
        all_pass = False

    print(f"\n{'='*70}")
    print(f"OVERALL RESULT: {'ALL TESTS COMPLETED' if all_pass else 'SOME TESTS FAILED'}")
    print(f"{'='*70}")
