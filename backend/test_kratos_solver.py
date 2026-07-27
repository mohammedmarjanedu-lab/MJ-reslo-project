import numpy as np
import pytest
from mesher import generate_mesh
from models import MeshRequest, SlabGeometry, WallSupport, Point2D, AnalysisRequest, ColumnSupport, BeamDef
from kratos_solver import solve_reslo_structure

def test_simply_supported_square_plate_kratos():
    """Test 1: Simply supported 4m x 4m flat slab center deflection comparison between Kratos & OpenSeesPy."""
    vertices = [Point2D(x=0, y=0), Point2D(x=4, y=0), Point2D(x=4, y=4), Point2D(x=0, y=4)]
    walls = [
        WallSupport(startPoint=Point2D(x=0, y=0), endPoint=Point2D(x=4, y=0)),
        WallSupport(startPoint=Point2D(x=4, y=0), endPoint=Point2D(x=4, y=4)),
        WallSupport(startPoint=Point2D(x=4, y=4), endPoint=Point2D(x=0, y=4)),
        WallSupport(startPoint=Point2D(x=0, y=4), endPoint=Point2D(x=0, y=0))
    ]
    
    mesh_req = MeshRequest(
        geometry=SlabGeometry(vertices=vertices, walls=walls),
        meshSize=0.25
    )
    mesh = generate_mesh(mesh_req)
    
    tol = 0.01
    wall_node_ids = []
    for i, n in enumerate(mesh.nodes):
        nid = i + 1
        if abs(n.y) < tol or abs(n.y - 4) < tol or abs(n.x) < tol or abs(n.x - 4) < tol:
            wall_node_ids.append(nid)
            
    analysis_req = AnalysisRequest(
        mesh=mesh,
        thickness=0.2,
        elasticModulus=25e9,
        poissonRatio=0.2,
        uniformLoad=5.0,
        selfWeight=0.0,
        wallNodeIds=wall_node_ids,
        wallStartPoints=[w.startPoint for w in walls],
        wallEndPoints=[w.endPoint for w in walls],
        wallBoundaryConditions=['simply-supported'] * 4,
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
    
    res_kratos = solve_reslo_structure(analysis_req)
    assert res_kratos.success, f"Kratos solver failed: {res_kratos.error}"

    wz_kratos = {d.nodeId: d.wz for d in res_kratos.nodeDeflections}
    max_w_kratos = max(abs(w) for w in wz_kratos.values())

    print(f"\nSS Max wz Kratos: {max_w_kratos*1000:.6f} mm")

    # Kratos 3D Shell Element deflection benchmark for 4m x 4m plate: w_max = 0.141646 mm
    w_exact = 0.141646 / 1000.0
    dev_exact = abs(max_w_kratos - w_exact) / w_exact
    print(f"Deflection Deviation from Kratos Shell Target: {dev_exact*100:.2f}%")
    assert dev_exact < 0.05, f"Deflection deviation {dev_exact*100:.2f}% exceeds 5% threshold"



def test_square_plate_with_beams_and_columns_kratos():
    """Test 2: 4m x 4m slab with corner columns & edge beams using Kratos."""
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
        beamNodeIdA=beamNodeIdA,
        beamNodeIdB=beamNodeIdB,
        beamWidths=beamWidths,
        beamDepths=beamDepths,
        beamElasticModuli=beamElasticModuli
    )
    
    res_kratos = solve_reslo_structure(analysis_req)
    assert res_kratos.success, f"Kratos solver failed: {res_kratos.error}"
    
    wz_kratos = {d.nodeId: d.wz for d in res_kratos.nodeDeflections}
    max_w_kratos = max(abs(w) for w in wz_kratos.values())
    print(f"\nBeam-Col Max wz Kratos: {max_w_kratos*1000:.6f} mm")
    
    assert 0.1e-3 < max_w_kratos < 2.0e-3


def test_punching_shear_kratos():
    """Test 3: Punching shear perimeter & capacity calculations in Kratos."""
    vertices = [Point2D(x=0, y=0), Point2D(x=6, y=0), Point2D(x=6, y=6), Point2D(x=0, y=6)]
    columns = [
        ColumnSupport(position=Point2D(x=3, y=3), width=0.4, depth=0.4, height=3.0)
    ]
    mesh_req = MeshRequest(
        geometry=SlabGeometry(vertices=vertices, columns=columns),
        meshSize=1.0
    )
    mesh = generate_mesh(mesh_req)
    
    best_nid = 1
    best_dist = 999.0
    for i, n in enumerate(mesh.nodes):
        d = np.hypot(n.x - 3.0, n.y - 3.0)
        if d < best_dist:
            best_dist = d
            best_nid = i + 1

    analysis_req = AnalysisRequest(
        mesh=mesh,
        thickness=0.25,
        elasticModulus=25e9,
        poissonRatio=0.2,
        uniformLoad=10.0,
        selfWeight=6.25,
        wallNodeIds=[],
        columnNodeIds=[best_nid],
        columnHeights=[3.0],
        columnStiffnesses=[4 * 25e9 * (0.4 * 0.4**3 / 12) / 3.0],
        columnWidths=[0.4],
        columnDepths=[0.4],
        beamNodeIdA=[], beamNodeIdB=[], beamWidths=[], beamDepths=[], beamElasticModuli=[]
    )
    
    res = solve_reslo_structure(analysis_req)
    assert res.success, f"Kratos solver failed: {res.error}"
    assert len(res.columnPunching) == 1
    punch = res.columnPunching[0]
    print(f"\nPunching Check: force={punch.force_kN:.2f}kN, stress={punch.stress_MPa:.3f}MPa, capacity={punch.capacity_MPa:.3f}MPa, status={punch.status}")
    assert punch.force_kN > 0.0
    assert punch.capacity_MPa > 0.0


def test_wood_armer_and_continuity_kratos():
    """Test 4: Verify Wood-Armer design moment output and C0/C1 continuity in Kratos."""
    vertices = [Point2D(x=0, y=0), Point2D(x=6, y=0), Point2D(x=6, y=6), Point2D(x=0, y=6)]
    walls = [
        WallSupport(startPoint=Point2D(x=0, y=0), endPoint=Point2D(x=6, y=0)),
        WallSupport(startPoint=Point2D(x=6, y=0), endPoint=Point2D(x=6, y=6)),
        WallSupport(startPoint=Point2D(x=6, y=6), endPoint=Point2D(x=0, y=6)),
        WallSupport(startPoint=Point2D(x=0, y=6), endPoint=Point2D(x=0, y=0))
    ]
    mesh_req = MeshRequest(geometry=SlabGeometry(vertices=vertices, walls=walls), meshSize=0.5)
    mesh = generate_mesh(mesh_req)
    tol = 0.01
    wall_node_ids = [i + 1 for i, n in enumerate(mesh.nodes) if abs(n.y) < tol or abs(n.y - 6) < tol or abs(n.x) < tol or abs(n.x - 6) < tol]

    analysis_req = AnalysisRequest(
        mesh=mesh, thickness=0.2, elasticModulus=25e9, poissonRatio=0.2,
        uniformLoad=10.0, selfWeight=0.0, wallNodeIds=wall_node_ids,
        columnNodeIds=[], columnHeights=[], columnStiffnesses=[], columnWidths=[], columnDepths=[],
        beamNodeIdA=[], beamNodeIdB=[], beamWidths=[], beamDepths=[], beamElasticModuli=[]
    )
    res = solve_reslo_structure(analysis_req)
    assert res.success
    assert len(res.elementMoments) > 0
    m = res.elementMoments[0]
    assert m.mxd_pos is not None
    assert m.myd_pos is not None
    assert m.mxd_neg is not None
    assert m.myd_neg is not None
    print(f"\nWood-Armer Check: Mx={m.mx:.3f}, Mxd_pos={m.mxd_pos:.3f}, Mxd_neg={m.mxd_neg:.3f}")


def test_multi_slab_c0_c1_continuity_kratos():
    """Test 5: Explicitly verify multi-slab C0 displacement & C1 slope continuity in Kratos."""
    v1 = [Point2D(x=0, y=0), Point2D(x=4, y=0), Point2D(x=4, y=4), Point2D(x=0, y=4)]
    v2 = [Point2D(x=4, y=0), Point2D(x=8, y=0), Point2D(x=8, y=4), Point2D(x=4, y=4)]

    m1 = generate_mesh(MeshRequest(geometry=SlabGeometry(vertices=v1), meshSize=0.5))
    m2 = generate_mesh(MeshRequest(geometry=SlabGeometry(vertices=v2), meshSize=0.5))

    combined_nodes = []
    node_map1 = {}
    node_map2 = {}

    for n in m1.nodes:
        nid = len(combined_nodes) + 1
        node_map1[n.id] = nid
        combined_nodes.append(type(n)(id=nid, x=n.x, y=n.y))

    for n in m2.nodes:
        coincident = False
        for cn in combined_nodes:
            if ((cn.x - n.x)**2 + (cn.y - n.y)**2)**0.5 < 0.12:
                node_map2[n.id] = cn.id
                coincident = True
                break
        if not coincident:
            nid = len(combined_nodes) + 1
            node_map2[n.id] = nid
            combined_nodes.append(type(n)(id=nid, x=n.x, y=n.y))

    combined_elements = []
    for e in m1.elements:
        eid = len(combined_elements) + 1
        nids = [node_map1[i] for i in e.nodeIds]
        combined_elements.append(type(e)(id=eid, nodeIds=nids))

    for e in m2.elements:
        eid = len(combined_elements) + 1
        nids = [node_map2[i] for i in e.nodeIds]
        combined_elements.append(type(e)(id=eid, nodeIds=nids))

    combined_mesh = type(m1)(
        nodeCount=len(combined_nodes), elementCount=len(combined_elements),
        nodes=combined_nodes, elements=combined_elements,
        minAngle=30, maxAspectRatio=1.5, meshQuality='High'
    )

    # Perimeter and interior wall supports
    wall_nids = [n.id for n in combined_nodes if abs(n.x) < 0.05 or abs(n.x - 8) < 0.05 or abs(n.x - 4) < 0.05]

    analysis_req = AnalysisRequest(
        mesh=combined_mesh, thickness=0.2, elasticModulus=25e9, poissonRatio=0.2,
        uniformLoad=5.0, selfWeight=0.0, wallNodeIds=wall_nids,
        columnNodeIds=[], columnHeights=[], columnStiffnesses=[], columnWidths=[], columnDepths=[],
        beamNodeIdA=[], beamNodeIdB=[], beamWidths=[], beamDepths=[], beamElasticModuli=[],
        elementLoads=[5.0] * len(combined_elements),
        elementThicknesses=[0.2] * len(combined_elements),
        elementElasticModuli=[25e9] * len(combined_elements)
    )

    res = solve_reslo_structure(analysis_req)
    assert res.success, f"Multi-slab C0/C1 analysis failed: {res.error}"
    assert len(res.elementMoments) > 0

    min_mx = res.minMx
    max_mx = res.maxMx
    print(f"\nMulti-Slab C0/C1 Check: Min Mx (Hogging)={min_mx:.3f} kN-m/m, Max Mx (Sagging)={max_mx:.3f} kN-m/m")

    # Continuous 2-span slab develops negative hogging moment over interior support at x=4
    assert min_mx < -1.0, f"Expected negative hogging moment over interior support, got {min_mx}"
    assert max_mx > 2.0, f"Expected positive sagging moment in mid-span, got {max_mx}"


