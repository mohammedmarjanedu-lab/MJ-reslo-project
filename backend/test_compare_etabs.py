import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from kratos_solver import solve_reslo_structure
from mesher import generate_mesh
from models import MeshRequest, SlabGeometry, Point2D, AnalysisRequest

vertices = [Point2D(x=1.0, y=0.0), Point2D(x=8.0, y=0.0), Point2D(x=8.0, y=7.0), Point2D(x=1.0, y=7.0)]
geometry = SlabGeometry(vertices=vertices, walls=[], beams=[])
mesh_req = MeshRequest(geometry=geometry, meshSize=0.5)

mesh_obj = generate_mesh(mesh_req)
mesh_dict = mesh_obj.model_dump()
print(f"Generated Mesh: {mesh_dict['nodeCount']} nodes, {mesh_dict['elementCount']} elements")

col_positions = [(3.0, 5.0), (6.0, 5.0), (3.0, 2.0), (6.0, 2.0)]
col_node_ids = []

for cx, cy in col_positions:
    best_id = None
    best_d = float('inf')
    for n in mesh_dict['nodes']:
        d = np.hypot(n['x'] - cx, n['y'] - cy)
        if d < best_d:
            best_d = d
            best_id = n['id']
    col_node_ids.append(best_id)

print(f"Column snap node IDs: {col_node_ids}")

col_w, col_dp, H = 0.5, 0.5, 3.0
E_col = 27.386e9
I = (col_w * col_dp**3) / 12.0
k_col = 4 * E_col * I / H

req_dict = {
    "mesh": mesh_dict,
    "thickness": 0.2,
    "elasticModulus": 27.386e9 * 0.25,
    "poissonRatio": 0.16,
    "uniformLoad": 15.0,
    "selfWeight": 0.0,
    "wallNodeIds": [],
    "wallStartPoints": [], "wallEndPoints": [], "wallThicknesses": [], "wallHeights": [],
    "columnNodeIds": col_node_ids,
    "columnHeights": [3.0]*4,
    "columnStiffnesses": [k_col]*4,
    "columnWidths": [0.5]*4,
    "columnDepths": [0.5]*4,
    "columnShapes": ['rectangular']*4,
    "columnDiameters": [0.5]*4,
    "columnBoundaryConditions": ['fixed-fixed']*4,
    "wallBoundaryConditions": [],
    "beamNodeIdA": [], "beamNodeIdB": [], "beamWidths": [], "beamDepths": [], "beamElasticModuli": [],
    "dropPanels": [], "partitionWallSegments": []
}

req = AnalysisRequest(**req_dict)
res = solve_reslo_structure(req)
res_dict = res.model_dump()

print("\n================ Kratos Multiphysics Output Results ================")
print(f"Success: {res_dict['success']}")
print(f"Min Wz (deflection): {res_dict['minWz']*1000:.4f} mm")
print(f"Max Wz (deflection): {res_dict['maxWz']*1000:.4f} mm")
print(f"Min Mx: {res_dict['minMx']:.4f} kN·m/m, Max Mx: {res_dict['maxMx']:.4f} kN·m/m")
print(f"Min My: {res_dict['minMy']:.4f} kN·m/m, Max My: {res_dict['maxMy']:.4f} kN·m/m")

print("\n--- Column Punching & Reaction Forces ---")
for p in res_dict.get('columnPunching', []):
    print(f"Node {p['nodeId']}: Force = {p['force_kN']:.2f} kN, Stress = {p['stress_MPa']:.3f} MPa, Capacity = {p['capacity_MPa']:.3f} MPa, Ratio = {p['ratio']:.3f} ({p['status']})")

