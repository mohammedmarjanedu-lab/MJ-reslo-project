# RESLO — Structural, FEM & Commercial-Readiness Audit

**Date**: 2026-07-27
**Scope**: Full-stack audit of the RESLO web application (frontend, FEM engine, Python backend, deployment, licensing) — defects fixed + commercial-use guidance.
**Verdict**: The application now builds cleanly, all gates pass, and the stack is commercially usable with the caveats and actions listed in §5.

---

## 1. Executive Summary

| Area | Before | After |
|---|---|---|
| `npm run check` (svelte-check + tsc) | **14 errors**, 124 warnings | **0 errors**, 124 warnings (a11y only, non-blocking) |
| `npm run build` (production) | **FAILED** — unresolvable import | **PASSES** in ~3.4 s |
| Frontend tests (vitest) | 24/24 (unaffected) | 24/24 |
| Backend deflection validation | 1 real failure (stale test) | **10/10 pass** |
| Backend startup without gmsh native libs | **Hard crash at import** | Starts; `/api/mesh` degrades gracefully |
| Live Kratos `/api/analyze` end-to-end | — | **Verified** (equilibrium-checked physics) |
| ETABS parity suite (6 tests) | Env-blocked in audit sandbox | Ready (needs libGLU host — already in Dockerfile) |

---

## 2. Defects Found & Fixed

### 2.1 Critical runtime bug — wall supports silently broken (backend path)
**File**: `src/lib/engine/pyApi.ts`
`dist2` was compared against the wall tolerance but **never computed**. Referencing an undeclared variable throws at runtime, so *every* wall-to-mesh attachment failed whenever the Python-backend analysis path was used (i.e., the primary, more accurate Kratos path). Walls would not have restrained the slab.
**Fix**: compute the squared point-to-wall distance before the tolerance check.

### 2.2 Save/serialize crash with dimensions
**File**: `src/lib/stores/structuralModel.svelte.ts`
`serialize()` read `d.p1 / d.p2 / d.label / d.value`, but the canonical `Dimension` type (used by the renderer, hit-tester, and `addDimension`) is `{ startPoint, endPoint, distance }`. **Saving a project containing any dimension annotation would throw** (`d.p1` undefined → `.x` TypeError) and produce a corrupt `.9e` file.
**Fix**: serialize with the correct field names.

### 2.3 Production build failure — generated knowledge graph
**File**: `src/lib/ai/graphifyBridge.ts`
`graphify-out/graph.json` is a *generated, gitignored* artifact, but it was statically `import`ed, so any clean clone (CI, Vercel, a colleague's machine) failed to build.
**Fix**: resolve via `import.meta.glob` (no build error when absent). Runtime already falls back to an empty graph — the app works identically, AI insights simply report "no graph data" until `scripts/sync_graphify.ps1` regenerates it.

### 2.4 Type-system debt (would break at runtime or block compilation)
- `WorkspaceCanvas.svelte` — `canvasDragFileOver` used but never declared (drag-and-drop image import highlight broken). **Fixed**: declared `$state(false)`.
- `PropertiesPanel.svelte` — `BoundaryCondition` type used but never imported. **Fixed**: added type import.
- `ThreeViewport.svelte` — referenced `uiState.showNodeNumbers / showElementNumbers` which didn't exist on the store. **Fixed**: added both flags (default `false`) to `uiState` — additive, no behavior change.

### 2.5 Stale physics assertion in validation suite
**File**: `backend/test_deflection_validation.py` (TEST 3)
The test asserted column-node deflection `w = 0` (rigid columns), contradicting the documented and implemented architecture: **columns are elastic springs** `Kz = E·A/H`. Equilibrium check of the solver output: `R = Kz·w = 7.5×10⁸ × 1.199×10⁻⁴ ≈ 90 kN` per column; `4 × 90 = 360 kN = q·A` exactly — the solver was correct; the *test* was stale.
**Fix**: TEST 3 now validates the real physics — elastic shortening `δ ≈ q·A/(4·Kz)` within 15 %, and settlement negligible vs span deflection. **10/10 pass.**

### 2.6 Fragile backend startup
**File**: `backend/mesher.py`
`gmsh` (which needs system native libs: libGLU/X11) was imported and initialized at module top level. Missing native libs ⇒ **whole FastAPI app dead**, including endpoints that don't need meshing.
**Fix**: defensive import — API always starts; `/api/mesh` returns a clean error and the frontend's built-in TypeScript mesher takes over automatically (fallback already existed in `pyApi.ts`). On properly provisioned hosts (see `backend/Dockerfile`: `libglu1-mesa`, `libgl1` are installed) behavior is unchanged.

### 2.7 Deployment hygiene
**File**: `.env` — a **stale ephemeral `trycloudflare.com` URL was committed**. Any platform (Vercel) building from the repo would point every user at a dead backend. **Fixed**: replaced with documented placeholder; override order remains `?api=` param → `__RESLO_API__` → `VITE_API_URL` → `localhost:8000`. `start_tunnel.ps1` keeps rewriting it during the tunnel workflow as before.

---

## 3. Solver Validation Status (as the structural engineer on record)

| Path | Status | Evidence |
|---|---|---|
| In-browser TS solver (Mindlin plate, Q4/Q8/T3) | ✅ Validated | vitest: Timoshenko Q4 8×8 mesh — deflection error 1.2 %, moment error 0.4 %; IS 456 design tests pass |
| Python backend DKT solver (`solver.py`) | ✅ Validated | 10/10 deflection validation tests (Kirchhoff-Love analytical, Szilard point-support, symmetry, convergence) |
| Kratos MITC4/DKQ solver (`kratos_solver.py`) | ✅ Live-verified | `/api/analyze` 4×4 m slab: w_max = 0.579 mm, same order as Navier thin-plate estimate; reactions satisfy ΣR = q·A |
| ETABS parity (B1–B6) | ⏸ Env-blocked in audit sandbox only | Requires libGLU for Gmsh; provisioned in `backend/Dockerfile`. Existing results in `docs/ETABS_PARITY_REPORT.md` (±3–5 % parity) |

Column-as-elastic-spring modeling, wall `w`-DOF restraint, boundary node merging for multi-slab continuity, and cracked-modifier ULS handling were reviewed and are consistent with flat-slab analysis practice (equivalent to SAFE/ETABS spring-supported column modeling).

---

## 4. Commercial-Use Licensing Audit

Licenses of **everything that ships** were inventoried (full dependency walk, frontend + backend + vendored code).

### 4.1 ✅ Clean for commercial use (permissive)
- **Frontend**: Svelte (MIT), Vite (MIT), three.js (MIT), Tailwind v4 (MIT), jsPDF (MIT), pdfjs-dist (Apache-2.0 — include its NOTICE), TypeScript (Apache-2.0), DOMPurify (MPL-2.0 OR Apache-2.0), pako (MIT/Zlib), libtess (SGI-B-2.0, permissive).
- **Backend**: **KratosMultiphysics (BSD-4)** ✅, numpy (BSD), scipy (BSD), FastAPI/uvicorn/pydantic (MIT/BSD).
- **awatif (MIT)** — **vendored copy deleted** (was never imported by the app; the bridge is a stub). If a client-side solver is ever wanted it can be re-added from npm as a clean MIT dependency — but **without** its `triangle-wasm` meshing addon (Triangle 1.6 is commercial-by-arrangement only); the in-repo TS mesher covers that role.

### 4.2 ⚠️ Items needing a decision before commercial release

| Component | License | Exposure | Recommended action |
|---|---|---|---|
| **p5.js** (2D canvas renderer) | **LGPL-2.1** | Shipped in the frontend bundle | Either **(a)** keep it and comply: ship copyright/license notice + make library replaceable (standard corporate practice for LGPL in web apps), or **(b)** replace with an **MIT** renderer: **Konva.js** or **PixiJS** (both MIT, canvas-based), or plain Canvas API — the p5 usage is concentrated in `src/lib/canvas/renderer.ts`, so a swap is feasible but is the largest piece of optional remaining work |
| **OpenSeesPy** (`backend/opensees_solver.py`) | OpenSees license — **academic/research/non-profit only**; commercial use needs written UC Regents permission | **REMOVED from the repository** (solver + all dependent test/probe files deleted; no live production import ever existed) | Done. Do not re-introduce; Kratos (BSD-4) is the sole backend structural engine, cross-checked by the in-repo scipy DKT solver |
| **Gmsh** (backend meshing) | **GPL-2.0+** | Running server-side | **SaaS/hosted use: fine** (GPL allows commercial use; obligations trigger on *distribution*, and network use isn't distribution). If you ever ship the backend on-premise/appliance, the backend effectively falls under GPL → then switch meshing to the **existing in-repo TS mesher** (`meshGenerator.ts`, already the runtime fallback), `scipy.spatial.Delaunay` (BSD/Qhull), or mapbox **delaunator** (ISC) |
| **Triangle 1.6** (inside vendored `awatif-main/…/triangle-mesh`) | Copyright J.R. Shewchuk — **"distribution as part of a commercial system permissible ONLY BY DIRECT ARRANGEMENT WITH THE AUTHOR"** | **REMOVED** — the entire unused `awatif-main/` vendor tree (incl. the `triangle.out.wasm` binary) has been deleted from the repo | Done. The app never imported awatif; nothing to replace |

**Bottom line**: the *running* product is commercially viable today (Kratos BSD solver + MIT frontend, with the LGPL-p5 caveat handled per 4.2-a). ~~delete `opensees_solver.py`, drop `awatif-main/`~~ — **both done**. The only remaining optional item for a "everything permissive" bill of materials is the p5 → Konva/Pixi renderer swap; keep gmsh server-side only (or use the built-in mesher).

---

## 5. Recommended Free & Open-Source Commercial Stack (no paid components needed)

| Function | Recommended (all FOSS, commercial-safe) | Status in project |
|---|---|---|
| Structural solver (server) | **KratosMultiphysics (BSD)** — already primary | ✅ in use |
| Structural solver (client, zero-install) | In-repo TS plate solver / **awatif (MIT)** if activated | ✅ in use / optional |
| Meshing | Built-in TS mesher (in repo) server-side; Gmsh allowed for SaaS | ✅ fallback exists |
| 2D canvas | **Konva.js or PixiJS (MIT)** if replacing LGPL p5 | ⚠️ optional swap |
| 3D view | **three.js (MIT)** | ✅ in use |
| PDF reports | **jsPDF (MIT)** | ✅ in use |
| CAD/BIM export | In-repo DXF/E2K writers; IFC via **IfcOpenShell** (LGPL, server-side) if ever needed | ✅ in use |
| Design codes | IS 456 implemented in-repo; EC2 steel/concrete/timber available via awatif if activated | ✅ in use |
| Hosting (free tier) | Frontend: Vercel/Netlify/Cloudflare Pages; Backend: Railway/Render (see `FREE_HOSTING_GUIDE.md`) | ✅ configured |

---

## 6. Non-blocking Improvements (backlog)

1. **124 a11y warnings** (click-on-div, autofocus, unassociated labels) — cosmetic; worth fixing for a commercial product's accessibility posture.
2. **Repo hygiene**: `test fem.txt` (29 MB) is tracked in git — move to Git LFS or an external store and add to `.gitignore`.
3. **Bundle size**: main chunk ~1.9 MB (557 kB gzip) — consider code-splitting three.js/pdf libs behind lazy loads.
4. Regenerate `graphify-out/` after refactors (`scripts/sync_graphify.ps1`) so the AI-insight panel stays accurate.
5. **Do not commit** live tunnel URLs in `.env` (see §2.7).
