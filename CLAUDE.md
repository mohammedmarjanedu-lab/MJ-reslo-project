# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reslo is a browser-based structural engineering tool for reinforced-concrete floor systems. The user traces a floor plan (from an uploaded image), places columns / walls / beams / slabs / drop panels, calibrates a real-world scale, and gets live finite-element analysis (deflection, moments, shear, membrane forces, punching shear) plus IS 456:2000 design output (reinforcement, crack width, deflection checks). Results render as 2D contour plots and a 3D deformed view.

The project root for the app is the `reslo/` subdirectory. All commands below assume you are inside `reslo/`.

## Commands

Frontend (run from `reslo/`):
- `npm run dev` — Vite dev server (host `0.0.0.0`, all hosts allowed)
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the built bundle
- `npm run check` — type-check: `svelte-check` against `tsconfig.app.json` plus `tsc -p tsconfig.node.json`. **This is the only lint/typecheck gate; run it before considering frontend work done.**
- `npx vitest run` — run all tests once; `npx vitest run src/lib/engine/femSolver.test.ts` for a single file; `npx vitest` for watch mode. Tests are `src/**/*.test.ts` (Vitest, node environment).

Backend (run from `reslo/backend/`):
- `uvicorn main:app --host 0.0.0.0 --port 8000` — start the FastAPI FEA server (frontend expects it at `http://127.0.0.1:8000`)
- `pip install -r requirements.txt` — installs FastAPI, numpy, scipy, gmsh, and **KratosMultiphysics** (the primary solver)
- `pytest` — backend tests (`test_*.py` and `tests/etabs_parity/`); parity tests validate solver output against ETABS benchmarks

## Two-solver architecture (critical to understand)

FEM analysis has two independent implementations, and the frontend picks between them at runtime:

1. **Python backend (primary)** — `backend/kratos_solver.py` via FastAPI (`backend/main.py`). Uses Gmsh for meshing and KratosMultiphysics StructuralMechanics for the solve. More accurate; supports adaptive refinement, SPR recovery, Wood-Armer, advanced punching shear, cracked-section analysis (the extra `backend/*.py` modules). Endpoints: `/api/health`, `/api/mesh`, `/api/analyze`, `/api/analyze_multi`.
2. **In-browser Web Worker (fallback)** — `src/lib/engine/femSolver.ts` running in `src/workers/fem.worker.ts`. A self-contained TypeScript Mindlin-Reissner plate solver (Q4/Q8/T3 elements, banded LDLᵀ factorization). Runs with zero install so the app works as a pure static site.

The orchestration lives in `App.svelte` → `triggerFEMAnalysis()`. It polls `/api/health` every 15s (`checkBackend`); if the backend is reachable it uses `pyApi.ts` (`meshAndAnalyzeAllSlabs`), otherwise it falls back to the worker. Both paths converge to the same `SlabFEMResult[]` shape (see `src/lib/engine/types.ts`), so **when you change analysis inputs/outputs you almost always need to update both `femSolver.ts` and `pyApi.ts` (and the Python side) to keep them in sync.**

Key numerical conventions shared across both solvers: elastic modulus is stored in kPa-ish units and normalized (`E > 1e8 ⇒ E /= 1000`); columns are modeled as elastic springs (Kz, Krx, Kry) rather than rigid supports; walls/beams constrain the `w` DOF along their length; coincident nodes at slab boundaries are merged (spatial-grid dedup) so adjacent slabs act continuously; discontinuous slab edges get unmerged rotational DOFs to model hinges.

## Frontend architecture

Svelte 5 + TypeScript + Vite + Tailwind v4. **Uses Svelte 5 runes exclusively** (`$state`, `$effect`, `$derived`) — there are no Svelte stores from `svelte/store`. State is organized as singleton class instances exported from `src/lib/stores/*.svelte.ts`:

- `structuralModel.svelte.ts` (`model`) — the source of truth: all structural elements, calibration, view transform, undo/redo (`history.svelte.ts`), and (de)serialization to the `.9e` project file format + localStorage autosave. Every mutating method calls `beginAction()` first to snapshot for undo.
- `uiState.svelte.ts` (`uiState`) — active tool, panels, theme, view mode (2d/3d), FEM settings (mesh size, auto-compute), backend connection status.
- `femResults.svelte.ts` (`femState`) — analysis results, active result type, contour cache, deformed scale.
- `floorLayers.svelte.ts`, `graphStore.svelte.ts` — multi-floor layers and the knowledge-graph overlay.

`App.svelte` wires everything together with `$effect` blocks that watch deep element properties and **debounce** re-analysis (400ms) and graph refresh (300ms). When editing reactivity here, note that effects deliberately touch nested properties (`c.position.x`, etc.) to register fine-grained dependencies — don't "simplify" those reads away.

Rendering: 2D canvas uses **p5.js** (`src/lib/canvas/renderer.ts`, `hitTester.ts`, `drawSheet.ts`); 3D uses **three.js** (`ThreeViewport.svelte`). Pure geometry/math helpers are in `src/lib/engine/mathEngine.ts`.

Directories:
- `src/lib/components/` — Svelte UI (toolbar, panels, canvas host, dialogs, HUD)
- `src/lib/engine/` — solver, meshing, math, IS 456 design (`is456Design.ts`), load combinations, report generation, types
- `src/lib/export/` — DXF and ETABS `.e2k` (E2K) exporters
- `src/lib/ai/` — a self-observing "loop engine" + memory store that emits performance/architecture insights, backed by graphify
- `src/lib/stores/`, `src/workers/`

## graphify integration

`graphify-out/` holds a generated knowledge graph of the codebase (`graph.json`) plus helper Python scripts. `src/lib/ai/graphifyBridge.ts` imports `graph.json` and the AI loop engine (`loopEngine.svelte.ts`) queries it for neighbors/hotspots/communities to surface insights in the UI. This is app runtime behavior, not just tooling — the `.json` is bundled via a Vite `?url` import.

## Deployment

- Frontend deploys to Vercel (`vercel.json`, SPA rewrite to `index.html`); the live app can point at a remote backend via the `?api=<url>` query param or `VITE_API_URL` (see `getInitialApiBase` in `pyApi.ts`). ngrok/cloudflare tunnel URLs are handled specially.
- Backend deploys to Railway (`backend/railway.json`, `backend/Procfile`, `backend/Dockerfile`).

## Units & domain notes

- Internal geometry is in **meters** (calibrated from the traced image via `scaleCalibrator.ts` / pixels-per-meter). Loads are kN/m²; unit weights kN/m³.
- Concrete grades `M20`–`M60` map to E = 5000·√fck·1000; rebar grades `Fe250`–`Fe600`.
- Design output follows **IS 456:2000**; parity is validated against ETABS (`backend/tests/etabs_parity/`).
- Project files use the `.9e` extension (JSON; `serialize`/`deserialize` in `structuralModel.svelte.ts`, which also migrates older non-structural-wall formats on load).

## Team

- **Mohammed Marjan** — Official Structural Engineer & Project Owner
  - Email: mohammedmarjan2015@gmail.com
  - Responsible for all structural engineering decisions, FEM solver validation, ETABS parity verification, and design code compliance (IS 456:2000, ACI 318-19).
