import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from kratos_solver import solve_reslo_structure
from mesher import generate_mesh
from models import MeshRequest, SlabGeometry, Point2D, AnalysisRequest

# Build 7m x 7m slab model with 4 columns
vertices = [Point2D(x=1.0, y=0.0), Point2D(x=8.0, y=0.0), Point2D(x=8.0, y=7.0), Point2D(x=1.0, y=7.0)]
geometry = SlabGeometry(vertices=vertices, walls=[], beams=[])
mesh_req = MeshRequest(geometry=geometry, meshSize=0.5)
mesh_obj = generate_mesh(mesh_req)
mesh_dict = mesh_obj.model_dump()

col_positions = [(3.0, 5.0), (6.0, 5.0), (3.0, 2.0), (6.0, 2.0)]
col_node_ids = []
for cx, cy in col_positions:
    best_id = min(mesh_dict['nodes'], key=lambda n: np.hypot(n['x'] - cx, n['y'] - cy))['id']
    col_node_ids.append(best_id)

col_w, col_dp, H = 0.5, 0.5, 3.0
E_col = 27.386e9
I = (col_w * col_dp**3) / 12.0
k_col = 4 * E_col * I / H

req_dict = {
    "mesh": mesh_dict,
    "thickness": 0.2,
    "elasticModulus": 27.386e9 * 0.25,
    "poissonRatio": 0.16,
    "uniformLoad": 15.0, # 15.0 kN/m²
    "selfWeight": 0.0,
    "wallNodeIds": [], "wallStartPoints": [], "wallEndPoints": [], "wallThicknesses": [], "wallHeights": [],
    "columnNodeIds": col_node_ids, "columnHeights": [3.0]*4, "columnStiffnesses": [k_col]*4,
    "columnWidths": [0.5]*4, "columnDepths": [0.5]*4, "columnShapes": ['rectangular']*4, "columnDiameters": [0.5]*4,
    "columnBoundaryConditions": ['fixed-fixed']*4, "wallBoundaryConditions": [],
    "beamNodeIdA": [], "beamNodeIdB": [], "beamWidths": [], "beamDepths": [], "beamElasticModuli": [],
    "dropPanels": [], "partitionWallSegments": []
}

req = AnalysisRequest(**req_dict)
res = solve_reslo_structure(req)
res_dict = res.model_dump()

print("\n--- ETABS vs Kratos Multiphysics Comparison Summary ---")
print(f"Total Applied Load: {15.0 * 49.0:.2f} kN")
print(f"Kratos Column Reactions Sum: {sum(p['force_kN'] for p in res_dict['columnPunching']):.2f} kN")

print("\n--- Column Reaction Comparison ---")
for p in res_dict['columnPunching']:
    print(f"Col Node {p['nodeId']}: Kratos = {p['force_kN']:.2f} kN, ETABS = 183.75 kN (Diff: {p['force_kN'] - 183.75:+.2f} kN)")

print("\n--- Bending Moments Summary ---")
print(f"Kratos Min Mx = {res_dict['minMx']:.3f} kN·m/m, Max Mx = {res_dict['maxMx']:.3f} kN·m/m")
print(f"Kratos Min My = {res_dict['minMy']:.3f} kN·m/m, Max My = {res_dict['maxMy']:.3f} kN·m/m")

