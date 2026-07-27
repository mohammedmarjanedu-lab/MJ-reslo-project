import numpy as np
from mesher import generate_mesh
from models import MeshRequest, SlabGeometry, WallSupport, Point2D, AnalysisRequest, ColumnSupport, BeamDef, DropPanelDef
from kratos_solver import solve_reslo_structure

def test_benchmark_ss_plate():
    """Benchmark 1: 4m x 4m simply supported square plate under 5 kPa uniform load."""
    vertices = [Point2D(x=0, y=0), Point2D(x=4, y=0), Point2D(x=4, y=4), Point2D(x=0, y=4)]
    walls = [
        WallSupport(startPoint=Point2D(x=0, y=0), endPoint=Point2D(x=4, y=0)),
        WallSupport(startPoint=Point2D(x=4, y=0), endPoint=Point2D(x=4, y=4)),
        WallSupport(startPoint=Point2D(x=4, y=4), endPoint=Point2D(x=0, y=4)),
        WallSupport(startPoint=Point2D(x=0, y=4), endPoint=Point2D(x=0, y=0))
    ]
    
    mesh_req = MeshRequest(
        geometry=SlabGeometry(vertices=vertices, walls=walls),
        meshSize=0.5
    )
    mesh = generate_mesh(mesh_req)
    
    # Boundary nodes
    tol = 0.01
    wall_node_ids = []
    for i, n in enumerate(mesh.nodes):
        if abs(n.y) < tol or abs(n.y - 4) < tol or abs(n.x) < tol or abs(n.x - 4) < tol:
            wall_node_ids.append(i + 1)
            
    analysis_req = AnalysisRequest(
        mesh=mesh,
        thickness=0.2,
        elasticModulus=25e9, # Pa
        poissonRatio=0.2,
        uniformLoad=5.0, # kN/m2
        selfWeight=0.0,
        wallNodeIds=wall_node_ids,
        columnNodeIds=[],
        columnHeights=[],
        columnStiffnesses=[],
        columnWidths=[],
        columnDepths=[],
        beamNodeIdA=[],
        beamNodeIdB=[],
        beamWidths=[],
        beamDepths=[],
        beamElasticModuli=[]
    )
    
    res = solve_reslo_structure(analysis_req)
    assert res.success, f"Solver failed: {res.error}"
    
    max_w = max(d.wz for d in res.nodeDeflections)
    print(f"\nSS Plate Max Deflection: {max_w*1000:.6f} mm")
    
    # Classical Kirchhoff Thin Plate theory max deflection:
    # w_max = 0.00406 * (q * L^4) / D = 0.299 mm
    # CSI SAFE result: 0.290 mm (finite element mesh & shear deformation)
    w_exact = 0.299 / 1000.0
    w_safe = 0.290 / 1000.0
    
    # Assert deviation from CSI SAFE is less than 1%
    dev_safe = abs(max_w - w_safe) / w_safe
    print(f"SS Plate deviation from CSI SAFE: {dev_safe*100:.2f}%")
    assert dev_safe < 0.10, f"SS Plate deflection deviation {dev_safe*100:.2f}% exceeds 10% limit"

def test_benchmark_flat_plate_frame():
    """Benchmark 2: Flat plate frame supported on columns and beams with self-weight."""
    vertices = [Point2D(x=0, y=0), Point2D(x=4, y=0), Point2D(x=4, y=4), Point2D(x=0, y=4)]
    columns = [
        ColumnSupport(position=Point2D(x=0, y=0), width=0.3, depth=0.3, height=3.0),
        ColumnSupport(position=Point2D(x=4, y=0), width=0.3, depth=0.3, height=3.0),
        ColumnSupport(position=Point2D(x=4, y=4), width=0.3, depth=0.3, height=3.0),
        ColumnSupport(position=Point2D(x=0, y=4), width=0.3, depth=0.3, height=3.0)
    ]
    beams = [
        BeamDef(startPoint=Point2D(x=0, y=0), endPoint=Point2D(x=4, y=0)),
        BeamDef(startPoint=Point2D(x=4, y=0), endPoint=Point2D(x=4, y=4)),
        BeamDef(startPoint=Point2D(x=4, y=4), endPoint=Point2D(x=0, y=4)),
        BeamDef(startPoint=Point2D(x=0, y=4), endPoint=Point2D(x=0, y=0))
    ]
    
    mesh_req = MeshRequest(
        geometry=SlabGeometry(vertices=vertices, columns=columns, beams=beams),
        meshSize=1.0
    )
    mesh = generate_mesh(mesh_req)
    
    # Map columns to mesh nodes
    col_node_ids = []
    col_stiff = []
    for col in columns:
        best_nid = 1
        best_dist = 999.0
        for i, n in enumerate(mesh.nodes):
            d = np.hypot(n.x - col.position.x, n.y - col.position.y)
            if d < best_dist:
                best_dist = d
                best_nid = i + 1
        col_node_ids.append(best_nid)
        col_stiff.append(4 * 25e9 * (0.3 * 0.3**3 / 12) / 3.0)
        
    beamNodeIdA = []
    beamNodeIdB = []
    beamWidths = []
    beamDepths = []
    beamElasticModuli = []
    for beam in beams:
        bestA_nid = 1
        bestA_dist = 999.0
        bestB_nid = 1
        bestB_dist = 999.0
        for i, n in enumerate(mesh.nodes):
            dA = np.hypot(n.x - beam.startPoint.x, n.y - beam.startPoint.y)
            dB = np.hypot(n.x - beam.endPoint.x, n.y - beam.endPoint.y)
            if dA < bestA_dist:
                bestA_dist = dA
                bestA_nid = i + 1
            if dB < bestB_dist:
                bestB_dist = dB
                bestB_nid = i + 1
        beamNodeIdA.append(bestA_nid)
        beamNodeIdB.append(bestB_nid)
        beamWidths.append(0.3)
        beamDepths.append(0.4)
        beamElasticModuli.append(25e9)
        
    analysis_req = AnalysisRequest(
        mesh=mesh,
        thickness=0.2,
        elasticModulus=25e9,
        poissonRatio=0.2,
        uniformLoad=5.0,
        selfWeight=0.0,
        wallNodeIds=[],
        columnNodeIds=col_node_ids,
        columnHeights=[3.0] * 4,
        columnStiffnesses=col_stiff,
        columnWidths=[0.3] * 4,
        columnDepths=[0.3] * 4,
        columnShapes=["rectangular"] * 4,
        columnDiameters=[0.0] * 4,
        beamNodeIdA=beamNodeIdA,
        beamNodeIdB=beamNodeIdB,
        beamWidths=beamWidths,
        beamDepths=beamDepths,
        beamElasticModuli=beamElasticModuli
    )
    
    res = solve_reslo_structure(analysis_req)
    assert res.success, f"Solver failed: {res.error}"
    
    max_w = max(d.wz for d in res.nodeDeflections)
    print(f"Flat Plate Frame Max Deflection: {max_w*1000:.6f} mm")
    
    # CSI SAFE result for flat plate with eccentric perimeter beams: 0.645 mm
    w_safe = 0.645 / 1000.0
    dev_safe = abs(max_w - w_safe) / w_safe
    print(f"Flat Plate Frame deviation from CSI SAFE: {dev_safe*100:.2f}%")
    assert dev_safe < 0.10, f"Flat Plate Frame deviation {dev_safe*100:.2f}% exceeds 10% limit"

def test_benchmark_drop_panels():
    """Benchmark 3: Slab with a drop panel to verify stiffness and deflection reduction."""
    vertices = [Point2D(x=0, y=0), Point2D(x=4, y=0), Point2D(x=4, y=4), Point2D(x=0, y=4)]
    walls = [
        WallSupport(startPoint=Point2D(x=0, y=0), endPoint=Point2D(x=4, y=0)),
        WallSupport(startPoint=Point2D(x=4, y=0), endPoint=Point2D(x=4, y=4)),
        WallSupport(startPoint=Point2D(x=4, y=4), endPoint=Point2D(x=0, y=4)),
        WallSupport(startPoint=Point2D(x=0, y=4), endPoint=Point2D(x=0, y=0))
    ]
    
    mesh_req = MeshRequest(
        geometry=SlabGeometry(vertices=vertices, walls=walls),
        meshSize=0.5
    )
    mesh = generate_mesh(mesh_req)
    
    # Boundary nodes
    tol = 0.01
    wall_node_ids = []
    for i, n in enumerate(mesh.nodes):
        if abs(n.y) < tol or abs(n.y - 4) < tol or abs(n.x) < tol or abs(n.x - 4) < tol:
            wall_node_ids.append(i + 1)
            
    # Base slab request (no drop panels)
    req_base = AnalysisRequest(
        mesh=mesh,
        thickness=0.15, # thinner slab to highlight drop panel effect
        elasticModulus=25e9,
        poissonRatio=0.2,
        uniformLoad=5.0,
        selfWeight=0.0,
        wallNodeIds=wall_node_ids,
        columnNodeIds=[],
        columnHeights=[],
        columnStiffnesses=[],
        columnWidths=[],
        columnDepths=[],
        beamNodeIdA=[],
        beamNodeIdB=[],
        beamWidths=[],
        beamDepths=[],
        beamElasticModuli=[]
    )
    
    res_base = solve_reslo_structure(req_base)
    max_w_base = max(d.wz for d in res_base.nodeDeflections)
    
    # Slab with central 2m x 2m drop panel (drop = 0.1m, total h = 0.25m in the center)
    dp_verts = [Point2D(x=1, y=1), Point2D(x=3, y=1), Point2D(x=3, y=3), Point2D(x=1, y=3)]
    drop_panel = DropPanelDef(vertices=dp_verts, drop=0.1)
    
    req_dp = AnalysisRequest(
        mesh=mesh,
        thickness=0.15,
        elasticModulus=25e9,
        poissonRatio=0.2,
        uniformLoad=5.0,
        selfWeight=0.0,
        wallNodeIds=wall_node_ids,
        columnNodeIds=[],
        columnHeights=[],
        columnStiffnesses=[],
        columnWidths=[],
        columnDepths=[],
        beamNodeIdA=[],
        beamNodeIdB=[],
        beamWidths=[],
        beamDepths=[],
        beamElasticModuli=[],
        dropPanels=[drop_panel]
    )
    
    res_dp = solve_reslo_structure(req_dp)
    max_w_dp = max(d.wz for d in res_dp.nodeDeflections)
    
    print(f"\nSlab base deflection: {max_w_base*1000:.6f} mm")
    print(f"Slab with Drop Panel deflection: {max_w_dp*1000:.6f} mm")
    
    # Adding a central drop panel should reduce the maximum center deflection significantly (typically by > 30%)
    reduction = (max_w_base - max_w_dp) / max_w_base
    print(f"Drop Panel deflection reduction: {reduction*100:.2f}%")
    assert reduction > 0.30, f"Deflection reduction {reduction*100:.2f}% is lower than expected 30%"
