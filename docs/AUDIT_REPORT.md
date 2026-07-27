# RESLO — Structural, FEM & Commercial-Readiness Audit

**Date**: 2026-07-27  
**Scope**: Full-stack audit of the RESLO web application (frontend, FEM engine, Python backend, deployment, licensing) — defects fixed + commercial-use guidance.  
**Verdict**: The application builds cleanly, all quality gates pass, and the stack is commercially usable with the caveats and actions listed in §5.

---

## 1. Executive Summary

| Area | Before | After |
| :--- | :--- | :--- |
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
**Fix**: Compute the squared point-to-wall distance before the tolerance check.

### 2.2 Save/serialize crash with dimensions
**File**: `src/lib/stores/structuralModel.svelte.ts`  
`serialize()` read `d.p1 / d.p2 / d.label / d.value`, but the canonical `Dimension` type (used by the renderer, hit-tester, and `addDimension`) is `{ startPoint, endPoint, distance }`. **Saving a project containing any dimension annotation would throw** (`d.p1` undefined → `.x` TypeError) and produce a corrupt `.9e` file.  
**Fix**: Serialize with the correct field names.

### 2.3 Production build failure — generated knowledge graph
**File**: `src/lib/ai/graphifyBridge.ts`  
`graphify-out/graph.json` is a *generated, gitignored* artifact, but it was statically `import`ed, so any clean clone (CI, Vercel, a colleague's machine) failed to build.  
**Fix**: Resolve via `import.meta.glob` (no build error when absent). Runtime already falls back to an empty graph — the app works identically, AI insights simply report "no graph data" until `scripts/sync_graphify.ps1` regenerates it.

### 2.4 Type-system debt (would break at runtime or block compilation)
- `WorkspaceCanvas.svelte` — `canvasDragFileOver` used but never declared (drag-and-drop image import highlight broken). **Fixed**: declared `$state(false)`.
- `PropertiesPanel.svelte` — `BoundaryCondition` type used but never imported. **Fixed**: added type import.
- `ThreeViewport.svelte` — referenced `uiState.showNodeNumbers / showElementNumbers` which didn't exist on the store. **Fixed**: added both flags (default `false`) to `uiState` — additive, no behavior change.

### 2.5 Stale physics assertion in validation suite
**File**: `backend/test_deflection_validation.py` (TEST 3)  
The test asserted column-node deflection `w = 0` (rigid columns), contradicting the documented and implemented architecture: **columns are elastic springs** $K_z = \frac{E \cdot A}{H}$. Equilibrium check of the solver output: $R = K_z \cdot w = 7.5 \times 10^8 \times 1.199 \times 10^{-4} \approx 90\text{ kN}$ per column; $4 \times 90 = 360\text{ kN} = q \cdot A$ exactly — the solver was correct; the *test* was stale.  
**Fix**: TEST 3 now validates the real physics — elastic shortening $\delta \approx \frac{q \cdot A}{4 \cdot K_z}$ within 15%, and settlement negligible vs span deflection. **10/10 pass.**

### 2.6 Fragile backend startup
**File**: `backend/mesher.py`  
`gmsh` (which needs system native libs: `libGLU`/`X11`) was imported and initialized at module top level. Missing native libs ⇒ **whole FastAPI app dead**, including endpoints that don't need meshing.  
**Fix**: Defensive import — API always starts; `/api/mesh` returns a clean error and the frontend's built-in TypeScript mesher takes over automatically (fallback already existed in `pyApi.ts`). On properly provisioned hosts (see `backend/Dockerfile`: `libglu1-mesa`, `libgl1` are installed) behavior is unchanged.

### 2.7 Deployment hygiene
**File**: `.env` — a **stale ephemeral `trycloudflare.com` URL was committed**. Any platform (Vercel) building from the repo would point every user at a dead backend. **Fixed**: replaced with documented placeholder; override order remains `?api=` param → `__RESLO_API__` → `VITE_API_URL` → `localhost:8000`. `start_tunnel.ps1` keeps rewriting it during the tunnel workflow as before.

---

## 3. Solver Validation Status (as the structural engineer on record)

| Path | Status | Evidence |
| :--- | :--- | :--- |
| In-browser TS solver (Mindlin plate, Q4/Q8/T3) | ✅ Validated | vitest: Timoshenko Q4 8×8 mesh — deflection error 1.2%, moment error 0.4%; IS 456 design tests pass |
| Python backend DKT solver (`solver.py`) | ✅ Validated | 10/10 deflection validation tests (Kirchhoff-Love analytical, Szilard point-support, symmetry, convergence) |
| Kratos MITC4/DKQ solver (`kratos_solver.py`) | ✅ Live-verified | `/api/analyze` 4×4 m slab: $w_{\max} = 0.579\text{ mm}$, same order as Navier thin-plate estimate; reactions satisfy $\sum R = q \cdot A$ |
| ETABS parity (B1–B6) | ⏸ Env-blocked in audit sandbox only | Requires `libGLU` for Gmsh; provisioned in `backend/Dockerfile`. Existing results in `docs/ETABS_PARITY_REPORT.md` (±3–5% parity) |

Column-as-elastic-spring modeling, wall `w`-DOF restraint, boundary node merging for multi-slab continuity, and cracked-modifier ULS handling were reviewed and are consistent with flat-slab analysis practice (equivalent to SAFE/ETABS spring-supported column modeling).

---

## 4. Commercial-Use Licensing Audit

Licenses of **everything that ships** were inventoried (full dependency walk, frontend + backend + vendored code).

### 4.1 ✅ Clean for commercial use (permissive)
- **Frontend**: Svelte (MIT), Vite (MIT), Three.js (MIT), Tailwind v4 (MIT), jsPDF (MIT), pdfjs-dist (Apache-2.0 — include NOTICE), TypeScript (Apache-2.0), DOMPurify (MPL-2.0 OR Apache-2.0), pako (MIT/Zlib), libtess (SGI-B-2.0, permissive).
- **Backend**: **KratosMultiphysics (BSD-4)** ✅, NumPy (BSD), SciPy (BSD), FastAPI/Uvicorn/Pydantic (MIT/BSD).
- **awatif (MIT)** — vendored in `awatif-main/`, and **not imported by the app** (the bridge is a stub). Safe as long as it stays out of shipped artifacts.

### 4.2 ⚠️ Items needing a decision before commercial release

| Component | License | Exposure | Recommended action |
| :--- | :--- | :--- | :--- |
| **p5.js** (2D canvas renderer) | **LGPL-2.1** | Shipped in frontend bundle | Either **(a)** keep it & comply (ship copyright notice + LGPL library replacement option), or **(b)** replace with **MIT** renderer: **Konva.js** or **PixiJS** or plain Canvas API in `src/lib/canvas/renderer.ts`. |
| **OpenSeesPy** (`backend/opensees_solver.py`) | Academic/Research | **Removed / Disabled** | Removed from codebase to eliminate SaaS commercial license blocker. |
| **Gmsh** (backend meshing) | **GPL-2.0+** | Running server-side | **SaaS/hosted use: OK** (GPL allows commercial SaaS use; obligations trigger on distribution). If on-premise, fallback to built-in TS mesher (`meshGenerator.ts`). |
| **Triangle 1.6** (in `awatif-main/`) | Non-commercial | **Never shipped** | Exclude `awatif-main/` from release distribution artifacts. |

**Bottom line**: The *running* product is commercially viable today (Kratos BSD solver + MIT frontend). Pure "everything permissive" version = swap p5 → Konva/Pixi, confirm OpenSeesPy removal, keep Gmsh server-side only.

---

## 5. Recommended Free & Open-Source Commercial Stack (no paid components needed)

| Function | Recommended (all FOSS, commercial-safe) | Status in project |
| :--- | :--- | :--- |
| Structural solver (server) | **KratosMultiphysics (BSD)** — primary | ✅ in use |
| Structural solver (client, zero-install) | In-repo TS plate solver | ✅ in use |
| Meshing | Built-in TS mesher server-side / Gmsh allowed for SaaS | ✅ fallback exists |
| 2D canvas | **Konva.js or PixiJS (MIT)** if replacing LGPL p5 | ⚠️ optional swap |
| 3D view | **Three.js (MIT)** | ✅ in use |
| PDF reports | **jsPDF (MIT)** | ✅ in use |
| CAD/BIM export | In-repo DXF/E2K writers | ✅ in use |
| Design codes | IS 456 implemented in-repo | ✅ in use |
| Hosting (free tier) | Frontend: Vercel/Netlify/Cloudflare Pages; Backend: Railway/Render | ✅ configured |

---

## 6. Non-blocking Improvements (backlog)

1. **124 a11y warnings** (click-on-div, autofocus, unassociated labels) — cosmetic; worth fixing for accessibility compliance.
2. **Repo hygiene**: `test fem.txt` (29 MB) tracked in git — move to Git LFS or external store.
3. **Bundle size**: Main chunk ~1.9 MB (557 kB gzip) — consider code-splitting Three.js / PDF libraries behind lazy loads.
4. Regenerate `graphify-out/` after refactors (`scripts/sync_graphify.ps1`).
5. **Do not commit** live tunnel URLs in `.env`.
