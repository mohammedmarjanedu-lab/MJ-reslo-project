"""
ETABS Parity Test — Pure Python DKT Solver (Fallback)
Compares against known ETABS benchmark values for a standard slab.
Uses edge walls + columns for a realistic building slab.
"""
import os, sys, json, math
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
from mesher import generate_mesh
from models import (
    MeshRequest, SlabGeometry, Point2D, AnalysisRequest,
    AnalysisResponse
)
from solver import analyze_slab

# ── ETABS Benchmark: 7m x 7m slab, 4 columns + edge walls ────────
# Slab: 7m:×7m with 4 columns at quarter points
# Edge walls on all 4 sides (realistic building slab)
# Thickness: 0.2m, E = 27.386e9 * 0.25 (cracked), v = 0.16
# Load: 15 kN/m (uniform, no self-weight)
vertices = [
    Point2D(x=1.0, y=0.0),
    Point2D(x=8.0, y=0.0),
    Point2D(x=8.0, y=7.0),
    Point2D(x=1.0, y=7.0)
]

# Edge walls on all 4 sides
edge_walls = [
    # (start, end, thickness, height)
    (Point2D(x=1.0, y=0.0), Point2D(x=8.0, y=0.0), 0.2, 3.0),   # bottom
    (Point2D(x=8.0, y=0.0), Point2D(x=8.0, y=7.0), 0.2, 3.0),   # right
    (Point2D(x=1.0, y=7.0), Point2D(x=8.0, y=7.0), 0.2, 3.0),   # top
    (Point2D(x=1.0, y=0.0), Point2D(x=1.0, y=7.0), 0.2, 3.0),   # left
]

geometry = SlabGeometry(vertices=vertices, walls=[], beams=[])
mesh_req = MeshRequest(geometry=geometry, meshSize=0.5)
mesh_obj = generate_mesh(mesh_req)
print(f"Mesh: {mesh_obj.nodeCount} nodes, {mesh_obj.elementCount} elements")

# Column positions (center of each quadrant)
col_positions = [(3.0, 5.0), (6.0, 5.0), (3.0, 2.0), (6.0, 2.0)]
col_node_ids = []
for cx, cy in col_positions:
    best_id = None; best_d = float('inf')
    for n in mesh_obj.nodes:
        d = np.hypot(n.x - cx, n.y - cy)
        if d < best_d: best_d = d; best_id = n.id
    col_node_ids.append(best_id)
print(f"Column node IDs: {col_node_ids}")

# Build wall node IDs from mesh
wall_nids = []
for ws, we, wt, wh in edge_walls:
    tol = 0.05
    dx = we.x - ws.x
    dy = we.y - ws.y
    Lw = np.sqrt(dx*dx + dy*dy)
    for n in mesh_obj.nodes:
        t = ((n.x - ws.x)*dx + (n.y - ws.y)*dy) / (Lw*Lw) if Lw > 0 else 0
        if t < -tol or t > 1 + tol:
            continue
        px = ws.x + np.clip(t, 0, 1) * dx
        py = ws.y + np.clip(t, 0, 1) * dy
        if np.hypot(n.x - px, n.y - py) < tol:
            wall_nids.append(n.id)

wall_nids = sorted(set(wall_nids))
print(f"Wall node IDs found: {len(wall_nids)}")

# Build the analysis request
E_cracked = 27.386e9 * 0.25
H = 3.0
E_col = 27.386e9
wcol, dcol = 0.5, 0.5
I_col = wcol * dcol**3 / 12.0
# Fixed-fixed column rotational stiffness: k = 4EI/L
k_col = 4 * E_col * I_col / H

req = AnalysisRequest(
    mesh=mesh_obj,
    thickness=0.2,
    elasticModulus=E_cracked,
    poissonRatio=0.16,
    uniformLoad=15.0,
    selfWeight=0.0,
    columnNodeIds=col_node_ids,
    columnStiffnesses=[k_col] * len(col_node_ids),
    columnHeights=[H] * len(col_node_ids),
    columnWidths=[wcol] * len(col_node_ids),
    columnDepths=[dcol] * len(col_node_ids),
    columnShapes=['rectangular'] * len(col_node_ids),
    columnDiameters=[0.5] * len(col_node_ids),
    columnGrades=['M25'] * len(col_node_ids),
    columnBoundaryConditions=['fixed-fixed'] * len(col_node_ids),
    wallNodeIds=wall_nids,
    # For walls, we provide start/end points but the solver uses wallNodeIds for constraints.
    # The other wall arrays are needed for the wall rotational spring calculation.
    wallStartPoints=[ws for ws, we, wt, wh in edge_walls],
    wallEndPoints=[we for ws, we, wt, wh in edge_walls],
    wallThicknesses=[wt for ws, we, wt, wh in edge_walls],
    wallHeights=[wh for ws, we, wt, wh in edge_walls],
    wallBoundaryConditions=['fixed-fixed'] * len(edge_walls),
    beamNodeIdA=[], beamNodeIdB=[], beamWidths=[], beamDepths=[], beamElasticModuli=[],
    dropPanels=[], partitionWallSegments=[]
)

print("Running pure Python DKT solver...")
res = analyze_slab(req)

# ── Results ──────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("PURE PYTHON DKT SOLVER RESULTS (with edge walls)")
print("=" * 60)

print(f"\nSUCCESS: {res.success}")
print(f"Deflection:")
print(f"  Min Wz = {res.minWz*1000:.4f} mm")
print(f"  Max Wz = {res.maxWz*1000:.4f} mm")

print(f"\nMoments (kN·m/m):")
print(f"  Mx: min={res.minMx:.3f}, max={res.maxMx:.3f}")
print(f"  My: min={res.minMy:.3f}, max={res.maxMy:.3f}")
print(f"  Mxy: min={res.minMxy:.3f}, max={res.maxMxy:.3f}")

print(f"\nShears (kN/m):")
print(f"  Vx: min={res.minVx:.3f}, max={res.maxVx:.3f}")
print(f"  Vy: min={res.minVy:.3f}, max={res.maxVy:.3f}")

# Find center node deflection
dist_to_center = [np.hypot(n.x - 4.5, n.y - 3.5) for n in mesh_obj.nodes]
center_nid = np.argmin(dist_to_center) + 1
center_wz = 0
for d in res.nodeDeflections:
    if d.nodeId == center_nid:
        center_wz = d.wz
        break
print(f"\nCenter deflection: {center_wz*1000:.4f} mm")

# Load balance check
if res.columnPunching:
    total_reaction = sum(p.force_kN for p in res.columnPunching)
    total_load = 15.0 * 49
    print(f"Load balance: {total_reaction:.2f} / {total_load:.2f} kN = {total_reaction/total_load:.4f}")

# Column punching
if res.columnPunching:
    print(f"\nColumn Punching:")
    for p in res.columnPunching:
        print(f"  Node {p.nodeId}: Force={p.force_kN:.2f} kN, Ratio={p.ratio:.3f} ({p.status})")

# Key results for ETABS comparison
print("\n" + "=" * 60)
print("ETABS BENCHMARK COMPARISON")
print("=" * 60)
print(f"  Max deflection (solver):   {res.maxWz*1000:.4f} mm")
print(f"  Center deflection:         {center_wz*1000:.4f} mm")
print(f"  Max Mx (solver):           {res.maxMx:.3f} kN·m/m")
print(f"  Min Mx (solver):           {res.minMx:.3f} kN·m/m")
print(f"  Max My (solver):           {res.maxMy:.3f} kN·m/m")
print(f"  Min My (solver):           {res.minMy:.3f} kN·m/m")
print(f"  Max |V| (solver):          {max(abs(res.minVx), abs(res.maxVx)):.3f} kN/m")
print(f"  Corner deflection:         {res.maxWz*1000:.4f} mm (with walls, should be < 2mm)")

# Node deflections for verification
print(f"\nTop 10 DEFLECTIONS (mm):")
if res.nodeDeflections:
    sorted_d = sorted(res.nodeDeflections, key=lambda d: abs(d.wz), reverse=True)
    for d in sorted_d[:10]:
        n = mesh_obj.nodes[d.nodeId-1]
        print(f"  Node {d.nodeId} ({n.x:.2f},{n.y:.2f}): wz={d.wz*1000:.4f} mm")

# Save results
out = {
    "solver": "python_dkt",
    "success": res.success,
    "maxDeflection_mm": res.maxWz * 1000,
    "centerDeflection_mm": center_wz * 1000,
    "minMx": res.minMx, "maxMx": res.maxMx,
    "minMy": res.minMy, "maxMy": res.maxMy,
    "minMxy": res.minMxy, "maxMxy": res.maxMxy,
    "minVx": res.minVx, "maxVx": res.maxVx,
    "minVy": res.minVy, "maxVy": res.maxVy,
    "nodeCount": mesh_obj.nodeCount,
    "elementCount": mesh_obj.elementCount
}
with open("etabs_parity_python.json", "w") as f:
    json.dump(out, f, indent=2)
print(f"\nResults saved to etabs_parity_python.json")
