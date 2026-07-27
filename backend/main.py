import os
import sys
import math
from typing import Optional, List

# Ensure backend directory is in sys.path when launched from root directory
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from models import (
    MeshRequest, MeshResponse, AnalysisRequest, AnalysisResponse,
    MultiSlabAnalysisRequest, MultiSlabAnalysisResponse
)
from mesher import generate_mesh
from solver import analyze_slab
from kratos_solver import solve_reslo_structure, solve_multi_slab_structure
# from opensees_solver import analyze_slab_opensees  # Kept as fallback reference during migration validation
import logging

logger = logging.getLogger("uvicorn")

app = FastAPI(title="Reslo FEM API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    try:
        import KratosMultiphysics as KM
        version = getattr(KM, 'KM_PARSER_VERSION', None) or str(getattr(KM.KratosGlobals, 'Version', 'unknown'))
    except Exception:
        version = 'unknown'
    return {"status": "ok", "solver": "KratosMultiphysics StructuralMechanicsApplication", "kratos_version": version}

@app.post("/api/mesh", response_model=MeshResponse)
def mesh_endpoint(request: MeshRequest):
    try:
        mesh = generate_mesh(request)
        return MeshResponse(success=True, mesh=mesh)
    except Exception as e:
        return MeshResponse(success=False, error=str(e))

def sanitize_float(val: Optional[float], default: float = 0.0) -> float:
    if val is None or math.isnan(val) or math.isinf(val):
        return default
    return float(val)

def sanitize_analysis_response(res: AnalysisResponse) -> AnalysisResponse:
    if not res:
        return res
    res.minWz = sanitize_float(res.minWz)
    res.maxWz = sanitize_float(res.maxWz)
    res.minMx = sanitize_float(res.minMx)
    res.maxMx = sanitize_float(res.maxMx)
    res.minMy = sanitize_float(res.minMy)
    res.maxMy = sanitize_float(res.maxMy)
    res.minMxy = sanitize_float(res.minMxy)
    res.maxMxy = sanitize_float(res.maxMxy)
    res.minVx = sanitize_float(res.minVx)
    res.maxVx = sanitize_float(res.maxVx)
    res.minVy = sanitize_float(res.minVy)
    res.maxVy = sanitize_float(res.maxVy)
    res.minNx = sanitize_float(res.minNx)
    res.maxNx = sanitize_float(res.maxNx)
    res.minNy = sanitize_float(res.minNy)
    res.maxNy = sanitize_float(res.maxNy)
    res.minNxy = sanitize_float(res.minNxy)
    res.maxNxy = sanitize_float(res.maxNxy)
    if res.crX is not None: res.crX = sanitize_float(res.crX)
    if res.crY is not None: res.crY = sanitize_float(res.crY)
    if res.zz_error_eta is not None: res.zz_error_eta = sanitize_float(res.zz_error_eta)

    if res.nodeDeflections:
        for nd in res.nodeDeflections:
            nd.u = sanitize_float(nd.u)
            nd.v = sanitize_float(nd.v)
            nd.wz = sanitize_float(nd.wz)
            nd.rx = sanitize_float(nd.rx)
            nd.ry = sanitize_float(nd.ry)
            nd.rz = sanitize_float(nd.rz)

    return res

@app.post("/api/analyze", response_model=AnalysisResponse)
def analyze_endpoint(request: AnalysisRequest):
    try:
        # Primary solver: Python DKT (has correct wall rotational spring implementation)
        result = analyze_slab(request)
        return sanitize_analysis_response(result)
    except Exception as e:
        return AnalysisResponse(success=False, error=f"Analysis failed: {str(e)}")

@app.post("/api/analyze_multi", response_model=MultiSlabAnalysisResponse)
def analyze_multi_endpoint(request: MultiSlabAnalysisRequest):
    try:
        # Use Kratos for multi-slab (handles connected/disconnected slab grouping)
        response = solve_multi_slab_structure(request)
        if response.results:
            for item in response.results:
                item.result = sanitize_analysis_response(item.result)
        return response
    except Exception as e:
        return MultiSlabAnalysisResponse(success=False, error=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
