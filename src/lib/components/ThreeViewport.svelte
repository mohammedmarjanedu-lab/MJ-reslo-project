<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { model } from '../stores/structuralModel.svelte';
  import { uiState } from '../stores/uiState.svelte';
  import { femState } from '../stores/femResults.svelte';
  import { sampleRamp } from '../engine/colorRamps';
  import type { ColorRampName } from '../engine/types';

  let container: HTMLDivElement;
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let controls: OrbitControls;
  let animId: number;
  let group: THREE.Group;
  let mounted = false;

  // ─── Shared scratch objects (reused every frame to avoid GC) ───
  const _m4 = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _color = new THREE.Color();
  const _raycaster = new THREE.Raycaster();
  const _mouse = new THREE.Vector2();

  const COLORS = {
    dark: { bg: 0x0d1117, ambient: 0x404040, dir: 0xffffff, hemi: 0x88aaff, hemiGround: 0x222222 },
    light: { bg: 0xf0f2f5, ambient: 0x888888, dir: 0xffffff, hemi: 0xccccff, hemiGround: 0x888888 },
  };
  function themeColors() { return uiState.theme === 'light' ? COLORS.light : COLORS.dark; }

  function px(v: number) { return v; }
  function pz(v: number) { return v; }

  // ─── Dynamic instance pools (no hard cap — resize on demand) ───
  let instRectCols: THREE.InstancedMesh | null = null;
  let instCircCols: THREE.InstancedMesh | null = null;
  let instBeams: THREE.InstancedMesh | null = null;
  let instWalls: THREE.InstancedMesh | null = null;
  const POOL_OVERALLOC = 2;

  // ─── Shared materials (PBR for ETABS-grade quality) ───
  const colRectMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.6, metalness: 0.1 });
  const colCircMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.6, metalness: 0.1 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.7, metalness: 0.1 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf43f5e, roughness: 0.75, metalness: 0.05 });

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);

  // ─── FEM meshes ───
  let femMesh: THREE.Mesh | null = null;
  let gridHelper: THREE.GridHelper | null = null;
  let slabGroup: THREE.Group;
  let femGroup: THREE.Group;
  let reactionGroup: THREE.Group;
  let loadGroup: THREE.Group;
  let animationTime = 0;
  let needsRender = true;

  function markRender() { needsRender = true; }

  function computeModelBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    function extend(x: number, y: number) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    for (const c of model.columns) { extend(c.position.x, c.position.y); }
    for (const w of model.walls) { extend(w.startPoint.x, w.startPoint.y); extend(w.endPoint.x, w.endPoint.y); }
    for (const pw of model.polylineWalls) { for (const v of pw.vertices) extend(v.x, v.y); }
    for (const b of model.beams) { extend(b.startPoint.x, b.startPoint.y); extend(b.endPoint.x, b.endPoint.y); }
    for (const s of model.slabs) { for (const v of s.vertices) extend(v.x, v.y); }
    if (minX === Infinity) { minX = -25; maxX = 25; minY = -25; maxY = 25; }
    return { minX, maxX, minY, maxY };
  }

  function rebuildGrid(): void {
    if (!group) return;
    if (gridHelper) { group.remove(gridHelper); gridHelper.geometry.dispose(); }
    const bounds = computeModelBounds();
    const sizeX = Math.max(bounds.maxX - bounds.minX, 50);
    const sizeY = Math.max(bounds.maxY - bounds.minY, 50);
    const maxExtent = Math.max(sizeX, sizeY);
    const gridSize = Math.max(maxExtent * 5, 200);
    const divisions = Math.max(40, Math.min(1000, Math.round(gridSize)));
    gridHelper = new THREE.GridHelper(gridSize, divisions, 0x333333, 0x1a1a1a);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    gridHelper.position.set(cx, -0.01, cy);
    group.add(gridHelper);
  }

  function computeH(): number {
    let H = 3.0;
    const heights: number[] = [];
    for (const c of model.columns) heights.push(c.height);
    for (const w of model.walls) heights.push(w.height);
    for (const pw of model.polylineWalls) heights.push(pw.height);
    for (const b of model.beams) heights.push(b.height);
    if (heights.length > 0) H = Math.max(...heights);
    return H;
  }

  function pointInPolygon(px: number, py: number, verts: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const xi = verts[i].x, yi = verts[i].y;
      const xj = verts[j].x, yj = verts[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ─── Dynamic instanced mesh allocation ───
  function ensureInstancedMesh(
    mesh: THREE.InstancedMesh | null, geo: THREE.BufferGeometry,
    mat: THREE.Material, count: number
  ): THREE.InstancedMesh {
    const needed = Math.max(1, Math.ceil(count * POOL_OVERALLOC));
    if (!mesh || mesh.count > needed * 2 || mesh.count < count) {
      if (mesh) { group.remove(mesh); mesh.dispose(); }
      mesh = new THREE.InstancedMesh(geo, mat, needed);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    return mesh;
  }

  function updateInstances() {
    const H = computeH();
    const rectCols = model.columns.filter(c => c.shape !== 'circular');
    const circCols = model.columns.filter(c => c.shape === 'circular');

    instRectCols = ensureInstancedMesh(instRectCols, boxGeo, colRectMat, rectCols.length);
    instCircCols = ensureInstancedMesh(instCircCols, cylGeo, colCircMat, circCols.length);

    let ri = 0;
    for (const col of rectCols) {
      _pos.set(px(col.position.x), col.height / 2, pz(col.position.y));
      _euler.set(0, col.rotation ? -col.rotation : 0, 0);
      _quat.setFromEuler(_euler);
      _scale.set(col.width, col.height, col.depth);
      _m4.compose(_pos, _quat, _scale);
      instRectCols.setMatrixAt(ri, _m4);
      if (col.color) { _color.set(col.color); instRectCols.setColorAt(ri, _color); }
      ri++;
    }
    instRectCols.count = ri;
    instRectCols.instanceMatrix.needsUpdate = true;
    if (instRectCols.instanceColor) instRectCols.instanceColor.needsUpdate = true;

    let ci = 0;
    for (const col of circCols) {
      const r = (col.diameter || col.width) / 2;
      _pos.set(px(col.position.x), col.height / 2, pz(col.position.y));
      _quat.identity();
      _scale.set(r * 2, col.height, r * 2);
      _m4.compose(_pos, _quat, _scale);
      instCircCols.setMatrixAt(ci, _m4);
      if (col.color) { _color.set(col.color); instCircCols.setColorAt(ci, _color); }
      ci++;
    }
    instCircCols.count = ci;
    instCircCols.instanceMatrix.needsUpdate = true;
    if (instCircCols.instanceColor) instCircCols.instanceColor.needsUpdate = true;

    const beamCount = model.beams.length;
    instBeams = ensureInstancedMesh(instBeams, boxGeo, beamMat, beamCount);
    let bi = 0;
    for (const beam of model.beams) {
      const sx = px(beam.startPoint.x), sz = pz(beam.startPoint.y);
      const ex = px(beam.endPoint.x), ez = pz(beam.endPoint.y);
      const dx = ex - sx, dz = ez - sz;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.001) continue;
      _pos.set((sx + ex) / 2, beam.height - beam.depth / 2, (sz + ez) / 2);
      _euler.set(0, -Math.atan2(dz, dx), 0);
      _quat.setFromEuler(_euler);
      _scale.set(len, beam.depth, beam.width);
      _m4.compose(_pos, _quat, _scale);
      instBeams.setMatrixAt(bi, _m4);
      bi++;
    }
    instBeams.count = bi;
    instBeams.instanceMatrix.needsUpdate = true;

    let wallCount = model.walls.length;
    for (const pw of model.polylineWalls) wallCount += Math.max(0, pw.vertices.length - 1);
    instWalls = ensureInstancedMesh(instWalls, boxGeo, wallMat, wallCount);
    let wi = 0;
    for (const wall of model.walls) {
      const sx = px(wall.startPoint.x), sz = pz(wall.startPoint.y);
      const ex = px(wall.endPoint.x), ez = pz(wall.endPoint.y);
      const dx = ex - sx, dz = ez - sz;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.001) continue;
      _pos.set((sx + ex) / 2, wall.height / 2, (sz + ez) / 2);
      _euler.set(0, -Math.atan2(dz, dx), 0);
      _quat.setFromEuler(_euler);
      _scale.set(len, wall.height, wall.thickness);
      _m4.compose(_pos, _quat, _scale);
      instWalls.setMatrixAt(wi, _m4);
      if (wall.color) { _color.set(wall.color); instWalls.setColorAt(wi, _color); }
      wi++;
    }
    for (const pw of model.polylineWalls) {
      for (let i = 0; i < pw.vertices.length - 1; i++) {
        const a = pw.vertices[i], b = pw.vertices[i + 1];
        const sx = px(a.x), sz = pz(a.y);
        const ex = px(b.x), ez = pz(b.y);
        const dx = ex - sx, dz = ez - sz;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.001) continue;
        _pos.set((sx + ex) / 2, pw.height / 2, (sz + ez) / 2);
        _euler.set(0, -Math.atan2(dz, dx), 0);
        _quat.setFromEuler(_euler);
        _scale.set(len, pw.height, pw.thickness);
        _m4.compose(_pos, _quat, _scale);
        instWalls.setMatrixAt(wi, _m4);
        if (pw.color) { _color.set(pw.color); instWalls.setColorAt(wi, _color); }
        wi++;
      }
    }
    instWalls.count = wi;
    instWalls.instanceMatrix.needsUpdate = true;
    if (instWalls.instanceColor) instWalls.instanceColor.needsUpdate = true;
  }

  function rebuildSlabsAndLabels() {
    if (slabGroup) { group.remove(slabGroup); slabGroup.traverse(c => { const m = c as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material; if (mat) { Array.isArray(mat) ? mat.forEach(mm => mm.dispose()) : (mat as THREE.Material).dispose(); } }); }
    slabGroup = new THREE.Group();
    group.add(slabGroup);

    const H = computeH();
    const slabWireMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 });

    for (const slab of model.slabs) {
      if (slab.vertices.length < 3) continue;
      const t = slab.thickness;
      const topY = H + t;

      const shape = new THREE.Shape();
      shape.moveTo(slab.vertices[0].x, -slab.vertices[0].y);
      for (let i = 1; i < slab.vertices.length; i++) {
        shape.lineTo(slab.vertices[i].x, -slab.vertices[i].y);
      }
      shape.closePath();

      for (const hole of slab.holes || []) {
        if (hole.length < 3) continue;
        const holePath = new THREE.Path();
        holePath.moveTo(hole[0].x, -hole[0].y);
        for (let i = 1; i < hole.length; i++) {
          holePath.lineTo(hole[i].x, -hole[i].y);
        }
        holePath.closePath();
        shape.holes.push(holePath);
      }

      const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
      const color = slab.color ? parseInt(slab.color.replace('#', ''), 16) : 0x64748b;
      const mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.0 });
      const mesh = new THREE.Mesh(geo, mat);
      
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = H;
      slabGroup.add(mesh);

      // Draw wireframes
      const pts = slab.vertices.map(v => new THREE.Vector3(v.x, topY + 0.01, v.y));
      pts.push(pts[0].clone());
      slabGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), slabWireMat));

      for (const hole of slab.holes || []) {
        if (hole.length < 3) continue;
        const hpts = hole.map(v => new THREE.Vector3(v.x, topY + 0.01, v.y));
        hpts.push(hpts[0].clone());
        slabGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(hpts), slabWireMat));
      }
    }

    for (const dp of model.dropPanels) {
      if (dp.vertices.length < 3) continue;
      const extraT = dp.drop;
      if (extraT <= 0) continue;

      const shape = new THREE.Shape();
      shape.moveTo(dp.vertices[0].x, -dp.vertices[0].y);
      for (let i = 1; i < dp.vertices.length; i++) {
        shape.lineTo(dp.vertices[i].x, -dp.vertices[i].y);
      }
      shape.closePath();

      const geo = new THREE.ExtrudeGeometry(shape, { depth: extraT, bevelEnabled: false });
      const color = dp.color ? parseInt(dp.color.replace('#', ''), 16) : 0x475569;
      const mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.0 });
      const mesh = new THREE.Mesh(geo, mat);
      
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = H - extraT;
      slabGroup.add(mesh);
    }

    if (uiState.showLabels) {
      function makeLabelSprite(text: string): THREE.Sprite {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        ctx.font = 'bold 48px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 6; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, 128, 64);
        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.8, 0.4, 1);
        return sprite;
      }
      for (const c of model.columns) {
        if (model.isHidden(c.id)) continue;
        const s = makeLabelSprite(c.label);
        s.position.set(px(c.position.x), H + 0.2, pz(c.position.y));
        slabGroup.add(s);
      }
      for (const w of model.walls) {
        if (model.isHidden(w.id)) continue;
        const mx = (w.startPoint.x + w.endPoint.x) / 2;
        const mz = (w.startPoint.y + w.endPoint.y) / 2;
        const s = makeLabelSprite(w.label);
        s.position.set(px(mx), H + 0.2, pz(mz));
        slabGroup.add(s);
      }
      for (const b of model.beams) {
        if (model.isHidden(b.id)) continue;
        const mx = (b.startPoint.x + b.endPoint.x) / 2;
        const mz = (b.startPoint.y + b.endPoint.y) / 2;
        const s = makeLabelSprite(b.label);
        s.position.set(px(mx), H + 0.2, pz(mz));
        slabGroup.add(s);
      }
      for (const sLab of model.slabs) {
        if (model.isHidden(sLab.id)) continue;
        if (sLab.vertices.length < 3) continue;
        let sx2 = 0, sy2 = 0;
        for (const v of sLab.vertices) { sx2 += v.x; sy2 += v.y; }
        const s = makeLabelSprite(sLab.label);
        s.position.set(px(sx2 / sLab.vertices.length), H + sLab.thickness + 0.2, pz(sy2 / sLab.vertices.length));
        slabGroup.add(s);
      }
    }

    if (uiState.show3DPlanOverlay && model.planImage) {
      const ppm = model.pixelsPerMeter || 100;
      if (ppm > 0) {
        const w_meters = model.imageNaturalWidth / ppm;
        const h_meters = model.imageNaturalHeight / ppm;
        const overlayY = 0.02;
        const overlayGeo = new THREE.BufferGeometry();
        const verts = new Float32Array([0,overlayY,0, 0,overlayY,-h_meters, w_meters,overlayY,-h_meters, w_meters,overlayY,0]);
        const uvs = new Float32Array([0,0, 0,1, 1,1, 1,0]);
        overlayGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        overlayGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        overlayGeo.setIndex([0,2,1, 0,3,2]);
        overlayGeo.computeVertexNormals();
        const tex = new THREE.CanvasTexture(model.planImage);
        tex.colorSpace = THREE.SRGBColorSpace;
        const overlayMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false });
        slabGroup.add(new THREE.Mesh(overlayGeo, overlayMat));
      }
    }

    if (uiState.showNodeNumbers || uiState.showElementNumbers) {
      // Render node/element numbers via sprites (simplified: only on FEM mesh if available)
    }
  }

  function resultValueForType(rt: string, nodeValues: Map<number, number>, nodeId: number): number {
    return nodeValues.get(nodeId) ?? 0;
  }

  // ─── FEM contour mesh with all result types and color ramps ───
  function rebuildFEMMesh() {
    if (femGroup) {
      group.remove(femGroup);
      femGroup.traverse(c => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (mat) { Array.isArray(mat) ? mat.forEach(mm => mm.dispose()) : (mat as THREE.Material).dispose(); }
      });
    }
    femGroup = new THREE.Group();
    const showContour = femState.showFEMContour && femState.hasResults;
    femGroup.visible = showContour;
    group.add(femGroup);
    femMesh = null;

    // Toggle solid undeformed slab geometry so it doesn't clash with deformed mesh
    if (slabGroup) {
      slabGroup.visible = !showContour;
    }

    if (!showContour) return;

    const results = [...femState.slabResults.values()];
    if (results.length === 0) return;

    const rt = femState.resultType;
    const allVerts: number[] = [];
    const allColors: number[] = [];
    const lineVerts: number[] = [];
    const ramp: ColorRampName = uiState.colorRamp;

    const cache = femState.contourCache;
    const gMin = cache.globalMin;
    const gMax = cache.globalMax;
    const range = (gMax - gMin) || 1;
    const H = computeH();

    // Deformation scale factor
    const deflScale = uiState.femAnimationEnabled
      ? femState.deformedScale * (1 + 0.3 * Math.sin(animationTime * 2))
      : femState.deformedScale;

    for (const result of results) {
      const slab = model.slabs.find(s => s.id === result.slabId || s.label === result.slabId);
      if (!slab || model.isHidden(result.slabId)) continue;

      const perSlab = cache.perSlab.get(result.slabId);
      if (!perSlab) continue;

      const nodeValues = perSlab.nodeValues;
      const nodes = result.mesh.nodes;
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      const deflMap = new Map(result.nodeDeflections.map(d => [d.nodeId, d.wz]));

      const thickness = slab.thickness || 0.2;
      const topYBase = H + thickness;
      const botYBase = H;

      for (const elem of result.mesh.elements) {
        const nids = elem.nodeIds;
        if (nids.length < 3) continue;

        // Calculate 3D top & bottom coordinates for element nodes
        const elemNodes = nids.map(nid => {
          const n = nodeMap.get(nid);
          const rawWz = deflMap.get(nid) || 0;
          // Downward displacement magnitude (sagging downward)
          const sag = rawWz * deflScale;

          const x = n ? n.x : 0;
          const z = n ? n.y : 0;
          return {
            nid,
            top: { x, y: topYBase - sag, z },
            bot: { x, y: botYBase - sag, z },
          };
        });

        // Triangulate element (Q4 -> 2 triangles, T3 -> 1 triangle)
        for (let k = 0; k < nids.length - 2; k++) {
          const triIndices = [0, k + 1, k + 2];
          const triNodes = triIndices.map(idx => elemNodes[idx]);

          // --- Top Face Triangles (With Contour Color Ramp) ---
          for (const cn of triNodes) {
            allVerts.push(cn.top.x, cn.top.y, cn.top.z);

            const nodeVal = resultValueForType(rt, nodeValues, cn.nid);
            let norm = (nodeVal - gMin) / range;
            norm = Math.max(0, Math.min(1, norm));

            const [r, g, b] = sampleRamp(ramp, norm);
            allColors.push(r / 255, g / 255, b / 255);
          }



          // --- Top Surface Mesh Wireframe Overlay ---
          for (let eIdx = 0; eIdx < 3; eIdx++) {
            const c1 = triNodes[eIdx].top;
            const c2 = triNodes[(eIdx + 1) % 3].top;
            lineVerts.push(c1.x, c1.y + 0.001, c1.z, c2.x, c2.y + 0.001, c2.z);
          }
        }
      }
    }

    if (allVerts.length === 0) return;

    // Solid deformed 3D slab mesh
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(allVerts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(allColors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      roughness: 0.5,
      metalness: 0.05,
    });
    femMesh = new THREE.Mesh(geo, mat);
    femGroup.add(femMesh);

    // Sharp element edge wireframe overlay
    if (lineVerts.length > 0) {
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.3,
      });
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      femGroup.add(lines);
    }
  }

  /**
   * Fast update: only recompute vertex colors for the current resultType/colorRamp.
   * Does NOT rebuild geometry — just updates the color buffer attribute.
   */
  function updateFEMColors() {
    if (!femMesh || !femMesh.geometry) return;
    const results = [...femState.slabResults.values()];
    if (results.length === 0) return;
    const rt = femState.resultType;
    const cache = femState.contourCache;
    const gMin = cache.globalMin;
    const gMax = cache.globalMax;
    const range = (gMax - gMin) || 1;
    const ramp: ColorRampName = uiState.colorRamp;
    const allColors: number[] = [];

    for (const result of results) {
      const perSlab = cache.perSlab.get(result.slabId);
      if (!perSlab) continue;
      const nodeValues = perSlab.nodeValues;
      for (const elem of result.mesh.elements) {
        const nids = elem.nodeIds;
        if (nids.length < 3) continue;
        for (let k = 0; k < nids.length - 2; k++) {
          const triIndices = [0, k + 1, k + 2];
          for (const idx of triIndices) {
            const nodeVal = nodeValues.get(nids[idx]) ?? 0;
            let norm = (nodeVal - gMin) / range;
            norm = Math.max(0, Math.min(1, norm));
            const [r, g, b] = sampleRamp(ramp, norm);
            allColors.push(r / 255, g / 255, b / 255);
          }
        }
      }
    }

    if (allColors.length > 0) {
      const colorAttr = femMesh.geometry.attributes.color;
      if (colorAttr) {
        (colorAttr.array as Float32Array).set(allColors);
        colorAttr.needsUpdate = true;
      } else {
        femMesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(allColors, 3));
      }
    }
  }

  /**
   * Fast update: only recompute vertex positions for current deformedScale/animation.
   * Does NOT rebuild geometry — just updates the position buffer attribute.
   */
  function updateFEMDeformation() {
    if (!femMesh || !femMesh.geometry) return;
    const results = [...femState.slabResults.values()];
    if (results.length === 0) return;
    const H = computeH();
    const deflScale = uiState.femAnimationEnabled
      ? femState.deformedScale * (1 + 0.3 * Math.sin(animationTime * 2))
      : femState.deformedScale;
    const allVerts: number[] = [];

    for (const result of results) {
      const slab = model.slabs.find(s => s.id === result.slabId || s.label === result.slabId);
      if (!slab || model.isHidden(result.slabId)) continue;
      const deflMap = new Map(result.nodeDeflections.map(d => [d.nodeId, d.wz]));
      const nodeMap = new Map(result.mesh.nodes.map(n => [n.id, n]));
      const thickness = slab.thickness || 0.2;
      const topYBase = H + thickness;
      const botYBase = H;

      for (const elem of result.mesh.elements) {
        const nids = elem.nodeIds;
        if (nids.length < 3) continue;
        const elemNodes = nids.map(nid => {
          const n = nodeMap.get(nid);
          const rawWz = deflMap.get(nid) || 0;
          const sag = rawWz * deflScale;
          return {
            top: { x: n ? n.x : 0, y: topYBase - sag, z: n ? n.y : 0 },
            bot: { x: n ? n.x : 0, y: botYBase - sag, z: n ? n.y : 0 },
          };
        });
        for (let k = 0; k < nids.length - 2; k++) {
          const triIndices = [0, k + 1, k + 2];
          for (const idx of triIndices) {
            const cn = elemNodes[idx];
            allVerts.push(cn.top.x, cn.top.y, cn.top.z);
          }
        }
      }
    }

    if (allVerts.length > 0) {
      const posAttr = femMesh.geometry.attributes.position;
      if (posAttr) {
        (posAttr.array as Float32Array).set(allVerts);
        posAttr.needsUpdate = true;
      }
      femMesh.geometry.computeVertexNormals();
    }
  }

  function rebuildReactions() {
    if (reactionGroup) {
      group.remove(reactionGroup);
      reactionGroup.traverse(c => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (mat) { Array.isArray(mat) ? mat.forEach(mm => mm.dispose()) : (mat as THREE.Material).dispose(); }
      });
    }
    reactionGroup = new THREE.Group();
    group.add(reactionGroup);
  }

  function rebuildLoads() {
    if (loadGroup) {
      group.remove(loadGroup);
      loadGroup.traverse(c => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (mat) { Array.isArray(mat) ? mat.forEach(mm => mm.dispose()) : (mat as THREE.Material).dispose(); }
      });
    }
    loadGroup = new THREE.Group();
    group.add(loadGroup);
  }

  function applyViewPreset() {
    if (!camera || !controls) return;
    const bounds = computeModelBounds();
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const maxDim = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 20);
    const dist = maxDim * 1.5;
    switch (uiState.viewPreset) {
      case 'top': camera.position.set(cx, dist * 2, cy); break;
      case 'front': camera.position.set(cx, maxDim * 0.5, cy + dist); break;
      case 'side': camera.position.set(cx + dist, maxDim * 0.5, cy); break;
      case 'iso': camera.position.set(cx + dist * 0.7, maxDim * 0.8, cy + dist * 0.7); break;
      default: camera.position.set(cx + dist * 0.7, maxDim * 0.8, cy + dist * 0.7); break;
    }
    controls.target.set(cx, 0, cy);
    controls.update();
    markRender();
  }

  function buildBase() {
    if (!scene) return;
    scene.background = new THREE.Color(themeColors().bg);
    group = new THREE.Group();
    scene.add(group);
    group.add(new THREE.AxesHelper(4));

    rebuildGrid();

    const axLine = (a: THREE.Vector3, b: THREE.Vector3, c: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c }));
    };
    function makeTextSprite(text: string, color: string, fontSize = 48): THREE.Sprite {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.font = `bold ${fontSize}px Arial`; ctx.fillStyle = color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 32);
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.6, 0.3, 1);
      return sprite;
    }
    group.add(axLine(new THREE.Vector3(0, 0.02, 0), new THREE.Vector3(4, 0.02, 0), 0xff4444));
    const xLabel = makeTextSprite('X', '#ff4444'); xLabel.position.set(4.3, 0.02, 0); group.add(xLabel);
    group.add(axLine(new THREE.Vector3(0, 0.02, 0), new THREE.Vector3(0, 0.02, 4), 0x44ff44));
    const yLabel = makeTextSprite('Y', '#44ff44'); yLabel.position.set(0, 0.02, 4.3); group.add(yLabel);
    group.add(axLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 4, 0), 0x4444ff));
    const zLabel = makeTextSprite('Z', '#4444ff'); zLabel.position.set(0, 4.3, 0); group.add(zLabel);

    slabGroup = new THREE.Group(); group.add(slabGroup);
    femGroup = new THREE.Group(); femGroup.visible = false; group.add(femGroup);
    reactionGroup = new THREE.Group(); group.add(reactionGroup);
    loadGroup = new THREE.Group(); group.add(loadGroup);

    updateInstances();
    rebuildSlabsAndLabels();
    rebuildFEMMesh();
    rebuildReactions();
    rebuildLoads();
  }

  function onResize() {
    if (!container || !renderer || !camera) return;
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    markRender();
  }

  function animate() {
    animId = requestAnimationFrame(animate);
    if (uiState.femAnimationEnabled) {
      animationTime += 0.016;
      if (femState.showFEMContour && femMesh && femMesh.geometry) updateFEMDeformation();
    }
    controls.update();
    if (needsRender || uiState.femAnimationEnabled) {
      renderer.render(scene, camera);
      needsRender = false;
    }
  }

  $effect(() => {
    uiState.theme;
    if (scene) { scene.background = new THREE.Color(themeColors().bg); markRender(); }
  });

  function initThree() {
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(themeColors().bg);

    const bounds = computeModelBounds();
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const maxDim = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 20);
    const dist = maxDim * 1.5;

    camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, Math.max(50000, maxDim * 20));
    camera.position.set(cx + dist * 0.7, maxDim * 0.8, cy + dist * 0.7);
    camera.lookAt(cx, 0, cy);

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(maxDim, maxDim * 2, maxDim * 0.8);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = maxDim * 10;
    scene.add(dir);
    scene.add(new THREE.HemisphereLight(themeColors().hemi, themeColors().hemiGround, 0.5));

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.target.set(cx, 0, cy);
    controls.minDistance = 0.5;
    controls.maxDistance = Math.max(maxDim * 10, 500);
    controls.addEventListener('change', markRender);
    controls.addEventListener('start', () => {
      uiState.viewPreset = 'perspective';
    });

    buildBase();
    mounted = true;
    animate();
    window.addEventListener('resize', onResize);
  }

  onMount(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => initThree()));
  });

  onDestroy(() => {
    window.removeEventListener('resize', onResize);
    cancelAnimationFrame(animId);
    renderer?.dispose();
  });

  // Model change → update instances + slabs
  $effect(() => {
    model.slabs; model.columns; model.walls; model.polylineWalls;
    model.beams; model.dropPanels; model.planImage; model.isCalibrated; model.pixelsPerMeter;
    uiState.show3DPlanOverlay; uiState.showLabels;
    if (mounted && group && scene) {
      updateInstances();
      rebuildSlabsAndLabels();
      rebuildGrid();
      markRender();
    }
  });

  // FEM results changed → rebuild geometry from scratch
  $effect(() => {
    const r = [...femState.slabResults.values()];
    femState.showFEMContour;
    if (mounted && group) {
      rebuildFEMMesh();
      rebuildReactions();
      rebuildLoads();
      markRender();
    }
  });

  // Result type / display settings → just update colors (fast, no geometry rebuild)
  $effect(() => {
    femState.resultType; uiState.colorRamp;
    // Only run if we already have a mesh with geometry
    if (mounted && femMesh && femMesh.geometry) {
      updateFEMColors();
      markRender();
    }
  });

  // Deformed scale / animation → just update positions (fast, no geometry rebuild)
  $effect(() => {
    femState.deformedScale; uiState.femAnimationEnabled; animationTime;
    if (mounted && femMesh && femMesh.geometry) {
      updateFEMDeformation();
      markRender();
    }
  });

  // View preset / reset view
  $effect(() => {
    uiState.viewPreset;
    uiState.resetViewTrigger;
    if (mounted) {
      if (uiState.viewPreset !== 'perspective') applyViewPreset();
      markRender();
    }
  });
</script>

<div bind:this={container} class="w-full h-full"></div>
