import os
import sys
import math
import json
import asyncio
from typing import Optional, List

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass

# Ensure backend directory is in sys.path when launched from root directory
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from models import (
    MeshRequest, MeshResponse, AnalysisRequest, AnalysisResponse,
    MultiSlabAnalysisRequest, MultiSlabAnalysisResponse
)
from mesher import generate_mesh
import logging

logger = logging.getLogger("uvicorn")

# ---------------------------------------------------------------------------
# Solver selection: DKT (sparse, fast) → Pynite → Kratos (fallback chain)
# DKT is the default: it uses scipy sparse matrices (10-100x faster than
# Pynite's dense solve on large multi-slab meshes) and honors per-element
# loads / thickness / elastic modulus / drop panels / equal-DOF constraints.
# Set SOLVER_BACKEND=pynite to force the Pynite dense path.
# ---------------------------------------------------------------------------
import os as _os
_SOLVER_BACKEND = _os.environ.get("SOLVER_BACKEND", "dkt").lower()

SOLVER_NAME = "Unknown"
solve_reslo_structure = None
solve_multi_slab = None

# Try Pynite first
if _SOLVER_BACKEND in ("pynite", "auto"):
    try:
        import pynite_solver as _pynite_solver
        if not getattr(_pynite_solver, "HAS_PYNITE", False):
            logger.warning("Pynite module not available, trying DKT fallback...")
            _SOLVER_BACKEND = "dkt"
        else:
            solve_reslo_structure = _pynite_solver.solve_reslo_structure
            solve_multi_slab = _pynite_solver.solve_multi_slab_structure
            SOLVER_NAME = "Pynite Shell + Euler-Bernoulli Beam"
            logger.info("Solver backend: Pynite (primary)")
    except ImportError as _e:
        logger.warning(f"Pynite not available ({_e}), trying DKT fallback...")
        _SOLVER_BACKEND = "dkt"

# Fall back to pure Python DKT solver
if _SOLVER_BACKEND in ("dkt", "auto") and solve_reslo_structure is None:
    try:
        from solver import analyze_slab, solve_multi_slab_dkt
        solve_reslo_structure = analyze_slab
        solve_multi_slab = solve_multi_slab_dkt
        SOLVER_NAME = "Pure Python DKT Direct Sparse Solver"
        logger.info("Solver backend: Pure Python DKT")
    except ImportError as _e:
        logger.warning(f"DKT solver not available ({_e})")

# Last resort: Kratos (if explicitly requested)
if _SOLVER_BACKEND == "kratos" and solve_reslo_structure is None:
    try:
        from kratos_solver import solve_reslo_structure, solve_multi_slab_structure
        SOLVER_NAME = "KratosMultiphysics"
        logger.info("Solver backend: KratosMultiphysics")
    except ImportError as _e:
        logger.error(f"Kratos solver requested but not available: {_e}")

if solve_reslo_structure is None:
    logger.error("No FEM solver backend available!")

app = FastAPI(title="Reslo FEM API", version="1.0.0")

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "solver": SOLVER_NAME,
        "backend": _SOLVER_BACKEND,
        "pynite_available": True if SOLVER_NAME == "Pynite Shell + Euler-Bernoulli Beam" else False
    }

@app.get("/api/graphify")
async def get_graphify_graph():
    """Return the complete codebase Graphify knowledge graph JSON."""
    graph_path = os.path.join(os.path.dirname(__file__), "..", "graphify-out", "graph.json")
    if os.path.exists(graph_path):
        with open(graph_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"directed": False, "multigraph": False, "nodes": [], "links": []}

@app.post("/api/graphify/query")
async def query_graphify(request: dict):
    """Query nodes, hotspots, or file dependencies in the codebase graph."""
    query = request.get("query", "").lower()
    kind = request.get("kind", "")
    graph_path = os.path.join(os.path.dirname(__file__), "..", "graphify-out", "graph.json")
    if not os.path.exists(graph_path):
        return {"nodes": [], "links": []}
    
    with open(graph_path, "r", encoding="utf-8") as f:
        graph = json.load(f)
        
    matching_nodes = []
    for node in graph.get("nodes", []):
        nid = str(node.get("id", "")).lower()
        label = str(node.get("label", "")).lower()
        filepath = str(node.get("file", "")).lower()
        if (query and (query in nid or query in label or query in filepath)) or (kind and node.get("kind") == kind):
            matching_nodes.append(node)
            
    return {"query": query, "count": len(matching_nodes), "nodes": matching_nodes}

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

# Run solver in background thread so the event loop stays responsive for health checks
@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze_endpoint(request: AnalysisRequest):
    if solve_reslo_structure is None:
        return AnalysisResponse(success=False, error="No FEM solver backend available. Install Pynite or ensure the DKT solver is present.")
    try:
        result = await asyncio.to_thread(solve_reslo_structure, request)
        return sanitize_analysis_response(result)
    except Exception as e:
        return AnalysisResponse(success=False, error=f"Analysis failed: {str(e)}")

@app.post("/api/analyze_multi", response_model=MultiSlabAnalysisResponse)
async def analyze_multi_endpoint(request: MultiSlabAnalysisRequest):
    if solve_multi_slab is None:
        return MultiSlabAnalysisResponse(success=False, error="No multi-slab solver backend available.")
    try:
        response = await asyncio.to_thread(solve_multi_slab, request)
        if response.results:
            for item in response.results:
                item.result = sanitize_analysis_response(item.result)
        return response
    except Exception as e:
        return MultiSlabAnalysisResponse(success=False, error=str(e))


# Serve built frontend from dist/ directory if present
dist_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dist"))
if os.path.isdir(dist_dir):
    assets_dir = os.path.join(dist_dir, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(dist_dir, "index.html"))

    @app.get("/{full_path:path}")
    async def serve_spa_fallback(full_path: str):
        target_path = os.path.join(dist_dir, full_path)
        if os.path.isfile(target_path):
            return FileResponse(target_path)
        return FileResponse(os.path.join(dist_dir, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

