from pydantic import BaseModel
from typing import List, Optional, Tuple

class Point2D(BaseModel):
    x: float
    y: float

class FEMNode(BaseModel):
    id: int
    x: float
    y: float

class Opening(BaseModel):
    vertices: List[Point2D]

class ColumnSupport(BaseModel):
    position: Point2D
    width: float = 0.3
    depth: float = 0.3
    height: float = 3.0
    shape: str = "rectangular"
    diameter: float = 0.5
    concreteGrade: str = "M25"
    boundaryCondition: str = "fixed-fixed"

class WallSupport(BaseModel):
    startPoint: Point2D
    endPoint: Point2D
    thickness: float = 0.25
    height: float = 3.0
    elasticModulus: float = 25e9

class BeamDef(BaseModel):
    startPoint: Point2D
    endPoint: Point2D

class SlabGeometry(BaseModel):
    vertices: List[Point2D]
    openings: List[Opening] = []
    columns: List[ColumnSupport] = []
    walls: List[WallSupport] = []
    beams: List[BeamDef] = []
    uniformLoad: float = 5.0
    thickness: float = 0.2
    elasticModulus: float = 25e9
    poissonRatio: float = 0.2

class MeshRequest(BaseModel):
    geometry: SlabGeometry
    meshSize: float = 1.0
    refineAtColumns: bool = True
    minMeshSize: float = 0.2
    maxMeshSize: float = 2.0

class Triangle(BaseModel):
    nodeIds: List[int]
    id: int

class FEMMesh(BaseModel):
    nodes: List[FEMNode]
    elements: List[Triangle]
    nodeCount: int
    elementCount: int
    minAngle: float = 60.0
    maxAspectRatio: float = 1.0
    meshQuality: str = "Good"
    unconnectedNodeIds: List[int] = []

class MeshResponse(BaseModel):
    success: bool
    mesh: Optional[FEMMesh] = None
    error: Optional[str] = None

class PunchingStress(BaseModel):
    nodeId: int
    force_kN: float
    stress_MPa: float
    capacity_MPa: float
    ratio: float
    status: str  # "OK", "WARNING", "FAIL"
    gamma_v: Optional[float] = None
    Jc: Optional[float] = None
    M_unbalanced: Optional[float] = None
    v_u_direct: Optional[float] = None
    v_u_eccentric: Optional[float] = None

class DropPanelDef(BaseModel):
    vertices: List[Point2D]
    drop: float

class LineLoadSegment(BaseModel):
    startX: float
    startY: float
    endX: float
    endY: float
    lineLoad: float  # kN/m

class EqualDofConstraint(BaseModel):
    nodeIdA: int
    nodeIdB: int
    dofs: List[int]

class MpcTerm(BaseModel):
    nodeId: int          # 1-indexed global node id
    weight: float        # interpolation weight of this master

class MpcConstraint(BaseModel):
    # ETABS-style edge (line) constraint for non-conformal multi-slab joints:
    # u_slave = Σ weight_i · u_master_i   (linear interpolation along the interface)
    slaveNodeId: int
    slaveDof: int        # 1..6 → UX, UY, UZ(W), RX, RY, RZ
    masters: List[MpcTerm]

class AnalysisRequest(BaseModel):
    mesh: FEMMesh
    thickness: float
    elasticModulus: float
    poissonRatio: float
    uniformLoad: float
    selfWeight: float = 0
    # Multi-slab parallel vectors per mesh element
    elementLoads: List[float] = []        # kN/m²
    elementThicknesses: List[float] = []  # m
    elementElasticModuli: List[float] = [] # Pa
    wallNodeIds: List[int] = []
    wallStartPoints: List[Point2D] = []
    wallEndPoints: List[Point2D] = []
    wallThicknesses: List[float] = []
    wallHeights: List[float] = []
    wallElasticModuli: List[float] = []
    columnNodeIds: List[int] = []
    columnHeights: List[float] = []
    columnStiffnesses: List[float] = []
    columnWidths: List[float] = []
    columnDepths: List[float] = []
    columnShapes: List[str] = []
    columnDiameters: List[float] = []
    columnGrades: List[str] = []
    columnBoundaryConditions: List[str] = []
    wallBoundaryConditions: List[str] = []
    # Beam data: parallel arrays for N beam elements
    # Each beam connects two mesh nodes with given section + material
    beamNodeIdA: List[int] = []   # start node (1-indexed)
    beamNodeIdB: List[int] = []   # end node (1-indexed)
    beamWidths: List[float] = []      # breadth (m)
    beamDepths: List[float] = []      # overall depth (m)
    beamElasticModuli: List[float] = []  # Pa
    dropPanels: List[DropPanelDef] = []
    partitionWallSegments: List[LineLoadSegment] = []  # line loads from partition walls (kN/m)
    equalDofConstraints: List[EqualDofConstraint] = []
    mpcConstraints: List[MpcConstraint] = []
    performCrackedAnalysis: bool = False
    adaptiveMeshRefinement: bool = False
    maxAdaptivePasses: int = 3

class NodeDeflection(BaseModel):
    nodeId: int
    u: float = 0
    v: float = 0
    wz: float
    rx: float
    ry: float
    rz: float = 0

class ElementMoment(BaseModel):
    elementId: int
    mx: float
    my: float
    mxy: float
    m1: float
    m2: float
    angle: float
    mxd_pos: Optional[float] = 0.0
    myd_pos: Optional[float] = 0.0
    mxd_neg: Optional[float] = 0.0
    myd_neg: Optional[float] = 0.0
    spr_mx: Optional[float] = None
    spr_my: Optional[float] = None
    spr_mxy: Optional[float] = None
    ast_x_bot: Optional[float] = None
    ast_y_bot: Optional[float] = None
    ast_x_top: Optional[float] = None
    ast_y_top: Optional[float] = None


class ElementStress(BaseModel):
    elementId: int
    s1: float
    s2: float
    vm: float
    mx: float
    my: float
    mxy: float

class ElementShear(BaseModel):
    elementId: int
    vx: float
    vy: float
    v1: float  # principal shear magnitude
    angle: float  # principal shear direction (degrees)

class ElementMembraneForce(BaseModel):
    elementId: int
    nx: float  # membrane force N/m
    ny: float
    nxy: float
    n1: float  # principal tension
    n2: float  # principal compression
    angle: float  # principal direction (degrees)

class AnalysisResponse(BaseModel):
    success: bool
    nodeDeflections: List[NodeDeflection] = []
    elementMoments: List[ElementMoment] = []
    elementStresses: List[ElementStress] = []
    elementShears: List[ElementShear] = []
    elementMembraneForces: List[ElementMembraneForce] = []
    columnPunching: List[PunchingStress] = []
    minWz: float = 0
    maxWz: float = 0
    minMx: float = 0
    maxMx: float = 0
    minMy: float = 0
    maxMy: float = 0
    minMxy: float = 0
    maxMxy: float = 0
    minVx: float = 0
    maxVx: float = 0
    minVy: float = 0
    maxVy: float = 0
    minNx: float = 0
    maxNx: float = 0
    minNy: float = 0
    maxNy: float = 0
    minNxy: float = 0
    maxNxy: float = 0
    solverTime: float = 0
    crX: Optional[float] = None
    crY: Optional[float] = None
    zz_error_eta: Optional[float] = None
    adaptive_iterations: Optional[int] = None
    cracked_deflection_max: Optional[float] = None
    error: Optional[str] = None

class DiscontinuousEdge(BaseModel):
    startPoint: Point2D
    endPoint: Point2D

class SingleSlabPayload(BaseModel):
    slabId: str
    geometry: SlabGeometry
    meshSize: float = 0.5
    thickness: float = 0.2
    elasticModulus: float = 25e9
    poissonRatio: float = 0.2
    uniformLoad: float = 5.0
    selfWeight: float = 0.0
    discontinuousEdges: List[DiscontinuousEdge] = []

class MultiSlabAnalysisRequest(BaseModel):
    slabs: List[SingleSlabPayload]
    walls: List[WallSupport] = []
    columns: List[ColumnSupport] = []
    beams: List[BeamDef] = []
    dropPanels: List[DropPanelDef] = []
    nonStructuralWalls: List[LineLoadSegment] = []
    partitionWallSegments: List[LineLoadSegment] = []
    meshSize: float = 0.5
    mpcConstraints: List[MpcConstraint] = []

class SlabAnalysisResult(BaseModel):
    slabId: str
    mesh: FEMMesh
    result: AnalysisResponse

class MultiSlabAnalysisResponse(BaseModel):
    success: bool
    results: List[SlabAnalysisResult] = []
    warnings: List[str] = []
    disconnectedIds: List[str] = []
    error: Optional[str] = None
