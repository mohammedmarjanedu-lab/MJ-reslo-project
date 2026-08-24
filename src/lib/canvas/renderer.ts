import type { Point2D, SlabPolygon, ColumnElement, ShearWallElement, PolylineWallElement, BeamElement, Dimension, DropPanelElement, NonStructuralWallElement, PolylineNonStructuralWallElement, FEMMesh, FEMStressResult, FEMShearResult, FEMMembraneResult, FEMResultType, ColumnPunchingResult, SlabFEMResult, ColorRampName } from '../engine/types';
import { uiState } from '../stores/uiState.svelte';
import { sampleRamp } from '../engine/colorRamps';


const COLORS_DARK = {
  grid: 'rgba(255,255,255,0.08)',
  slabFill: 'rgba(56,189,248,0.20)',
  slabStroke: '#38BDF8',
  columnFill: '#22C55E',
  columnStroke: '#16A34A',
  columnSelected: '#ffffff',
  wallFill: '#D62430',
  wallStroke: '#B01E28',
  wallSelected: '#ffffff',
  beamFill: '#F59E0B',
  beamStroke: '#D97706',
  beamSelected: '#ffffff',
  handle: '#FFFFFF',
  cmFill: '#ffffff',
  cmGlow: 'rgba(255,255,255,0.3)',
  crStroke: '#D62430',
  eccentricity: '#FF6B6B',
  vertex: '#D62430',
  vertexFill: '#ffffff',
  calibrateLine: '#D62430',
  dropPanelFill: 'rgba(244,114,182,0.30)',
  dropPanelStroke: '#f472b6',
  dropPanelSelected: '#ffffff',
  labelText: '#FFFFFF',
  vertexLabelText: '#FFFFFF',
  cmStroke: '#FFFFFF',
  calibrateCross: '#FFFFFF',
  calibrateText: '#FDE68A',
  dimensionText: '#FDE68A',
  measureCross: '#FFFFFF',
  measureText: '#FFFFFF',
  dimNotSelected: '#FFFFFF',
  meshWireframe: 'rgba(255,255,255,0.15)',
  legendBorder: 'rgba(255,255,255,0.3)',
  legendText: '#FFFFFF',
  deformedWireframe: 'rgba(255,255,255,0.6)',
  punchingText: '#fff',
  alignmentLabel: '#FFFFFF',
  jointDot: 'rgba(255,255,255,0.6)',
  snapInner: '#FFFFFF',
};

const COLORS_LIGHT = {
  grid: 'rgba(0,0,0,0.10)',
  slabFill: 'rgba(56,189,248,0.12)',
  slabStroke: '#38BDF8',
  columnFill: '#22C55E',
  columnStroke: '#16A34A',
  columnSelected: '#000000',
  wallFill: '#D62430',
  wallStroke: '#B01E28',
  wallSelected: '#000000',
  beamFill: '#F59E0B',
  beamStroke: '#D97706',
  beamSelected: '#000000',
  handle: '#000000',
  cmFill: '#000000',
  cmGlow: 'rgba(0,0,0,0.2)',
  crStroke: '#D62430',
  eccentricity: '#D62430',
  vertex: '#D62430',
  vertexFill: '#ffffff',
  calibrateLine: '#D62430',
  dropPanelFill: 'rgba(244,114,182,0.20)',
  dropPanelStroke: '#f472b6',
  dropPanelSelected: '#000000',
  labelText: '#000000',
  vertexLabelText: '#D62430',
  cmStroke: '#000000',
  calibrateCross: '#D62430',
  calibrateText: '#D62430',
  dimensionText: '#D62430',
  measureCross: '#D62430',
  measureText: '#000000',
  dimNotSelected: '#000000',
  meshWireframe: 'rgba(0,0,0,0.12)',
  legendBorder: 'rgba(0,0,0,0.2)',
  legendText: '#000000',
  deformedWireframe: 'rgba(0,0,0,0.35)',
  punchingText: '#000000',
  alignmentLabel: '#000000',
  jointDot: 'rgba(0,0,0,0.4)',
  snapInner: '#000000',
};

const COLORS = new Proxy({} as typeof COLORS_DARK, {
  get(_, prop: keyof typeof COLORS_DARK) {
    const isLight = uiState.theme === 'light';
    return isLight ? COLORS_LIGHT[prop] : COLORS_DARK[prop];
  }
});

function drawVertexLabels(ctx: CanvasRenderingContext2D, vertices: Point2D[], elementId: string, editTarget: { elementId: string; vertexIndex: number } | null, radius: number, defaultFill: string, defaultStroke: string, labelColor: string): void {
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const isEditing = editTarget && editTarget.elementId === elementId && editTarget.vertexIndex === i;
    const r = isEditing ? radius * 1.8 : radius;
    ctx.beginPath(); ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isEditing ? '#22C55E' : defaultFill;
    ctx.fill();
    ctx.strokeStyle = isEditing ? '#16A34A' : defaultStroke;
    ctx.lineWidth = isEditing ? 0.08 : 0.04;
    ctx.stroke();
    if (editTarget && editTarget.elementId === elementId) {
      ctx.save();
      ctx.font = 'bold 0.3px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = labelColor;
      const labelX = i === editTarget.vertexIndex ? 0.32 : 0.22;
      const labelY = -r - 0.05;
      ctx.translate(v.x, v.y);
      ctx.scale(1, -1);
      ctx.fillText(String(i), labelX, labelY);
      ctx.restore();
    }
  }
}

export function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = uiState.theme === 'light' ? '#F8FAFC' : '#1E293B';
  ctx.fillRect(0, 0, width, height);
}

export function drawPlanImage(ctx: CanvasRenderingContext2D, image: ImageBitmap, ox: number, oy: number, zoom: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.35;
  ctx.drawImage(image, ox, oy, image.width * zoom, image.height * zoom);
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawGrid(ctx: CanvasRenderingContext2D, gridSizeWorld: number): void {
  if (!gridSizeWorld || isNaN(gridSizeWorld) || gridSizeWorld <= 0 || !isFinite(gridSizeWorld)) return;
  const t = ctx.getTransform();
  const ppm = Math.sqrt(t.a * t.a + t.b * t.b);
  if (ppm < 1) return;
  const stepPx = gridSizeWorld * ppm;
  if (stepPx < 4) return; // avoid drawing excessively dense grids (performance guard)
  const x1 = (0 - t.e) / t.a;
  const x2 = (ctx.canvas.width - t.e) / t.a;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const y1 = (0 - t.f) / t.d;
  const y2 = (ctx.canvas.height - t.f) / t.d;
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const startX = Math.floor(minX / gridSizeWorld) * gridSizeWorld;
  const startY = Math.floor(minY / gridSizeWorld) * gridSizeWorld;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1 / ppm;
  ctx.beginPath();
  for (let x = startX; x <= maxX; x += gridSizeWorld) {
    ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
  }
  for (let y = startY; y <= maxY; y += gridSizeWorld) {
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
  }
  ctx.stroke();
}

export function drawAxes(ctx: CanvasRenderingContext2D): void {
  const originX = 0;
  const originY = 0;
  const axisLen = 1.5;
  const headLen = 0.25;
  const headAngle = Math.PI / 7;

  // X axis (red, pointing right)
  ctx.strokeStyle = '#EF4444';
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + axisLen, originY);
  ctx.stroke();
  ctx.fillStyle = '#EF4444';
  ctx.beginPath();
  ctx.moveTo(originX + axisLen + headLen, originY);
  ctx.lineTo(originX + axisLen, originY - headLen * Math.tan(headAngle));
  ctx.lineTo(originX + axisLen, originY + headLen * Math.tan(headAngle));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#EF4444';
  ctx.font = '0.35px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(originX + axisLen + 0.15, originY);
  ctx.scale(1, -1);
  ctx.fillText('+X', 0, 0);
  ctx.restore();

  // Y axis (green, pointing up)
  ctx.strokeStyle = '#22C55E';
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX, originY + axisLen);
  ctx.stroke();
  ctx.fillStyle = '#22C55E';
  ctx.beginPath();
  ctx.moveTo(originX, originY + axisLen + headLen);
  ctx.lineTo(originX - headLen * Math.tan(headAngle), originY + axisLen);
  ctx.lineTo(originX + headLen * Math.tan(headAngle), originY + axisLen);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#22C55E';
  ctx.font = '0.35px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(originX, originY + axisLen + 0.35);
  ctx.scale(1, -1);
  ctx.fillText('+Y', 0, 0);
  ctx.restore();
}

export function drawSlab(ctx: CanvasRenderingContext2D, slab: SlabPolygon, selected: boolean, selectedHoleIndex: number | null = null, vertexEditTarget: { elementId: string; vertexIndex: number } | null = null): void {
  if (slab.vertices.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(slab.vertices[0].x, slab.vertices[0].y);
  for (let i = 1; i < slab.vertices.length; i++) ctx.lineTo(slab.vertices[i].x, slab.vertices[i].y);
  ctx.closePath();
  // Draw holes (openings) using same winding direction
  for (const hole of slab.holes) {
    if (hole.length < 3) continue;
    ctx.moveTo(hole[0].x, hole[0].y);
    for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
    ctx.closePath();
  }
  if (slab.vertices.length >= 3) {
    ctx.fillStyle = slab.color ? hexToRgba(slab.color, 0.2) : COLORS.slabFill;
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = selected ? '#10B981' : (slab.color ?? COLORS.slabStroke);
  ctx.lineWidth = 0.04;
  ctx.stroke();

  // Draw cross mark (X) in each opening
  for (const hole of slab.holes) {
    if (hole.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of hole) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2 * 0.7, ry = (maxY - minY) / 2 * 0.7;
    ctx.save();
    ctx.strokeStyle = selected ? '#10B981' : '#94A3B8';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy - ry); ctx.lineTo(cx + rx, cy + ry);
    ctx.moveTo(cx + rx, cy - ry); ctx.lineTo(cx - rx, cy + ry);
    ctx.stroke();
    ctx.restore();
  }

  // If a hole is selected, draw a highlight overlay inside/around it
  if (selectedHoleIndex !== null && selectedHoleIndex >= 0 && selectedHoleIndex < slab.holes.length) {
    const hole = slab.holes[selectedHoleIndex];
    if (hole.length >= 3) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hole[0].x, hole[0].y);
      for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(245, 158, 11, 0.25)'; // Highlight fill
      ctx.fill();
      ctx.strokeStyle = '#F59E0B'; // Highlight stroke color
      ctx.lineWidth = 0.05;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (selected) {
    drawVertexLabels(ctx, slab.vertices, slab.id, vertexEditTarget, 0.16, COLORS.vertexFill, COLORS.vertex, COLORS.vertexLabelText);
  }
  // Draw hole vertices when slab is selected or when a specific hole is selected
  for (let h = 0; h < slab.holes.length; h++) {
    const hole = slab.holes[h];
    const isHoleSelected = selected || (selectedHoleIndex === h);
    if (isHoleSelected) {
      for (const v of hole) {
        ctx.beginPath(); ctx.arc(v.x, v.y, 0.12, 0, Math.PI * 2);
        ctx.fillStyle = (selectedHoleIndex === h) ? '#10B981' : '#F59E0B';
        ctx.fill();
        ctx.strokeStyle = (selectedHoleIndex === h) ? '#059669' : '#D97706';
        ctx.lineWidth = 0.03;
        ctx.stroke();
      }
    }
  }
}

export function drawSlabs(ctx: CanvasRenderingContext2D, slabs: SlabPolygon[], selectedIds: string[], selectedHoleIndex: number | null = null, vertexEditTarget: { elementId: string; vertexIndex: number } | null = null): void {
  for (const slab of slabs) {
    drawSlab(ctx, slab, selectedIds.includes(slab.id), selectedHoleIndex, vertexEditTarget);
  }
}

export function drawColumn(ctx: CanvasRenderingContext2D, col: ColumnElement): void {
  const { x, y } = col.position;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(col.rotation);
  ctx.fillStyle = col.color ?? COLORS.columnFill;
  ctx.strokeStyle = col.color ?? COLORS.columnStroke;
  ctx.lineWidth = 0.03;

  if (col.shape === 'circular') {
    const radius = Math.max((col.diameter || col.width || 0.5) / 2, 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    let halfW = Math.max(col.width / 2, 0.08);
    let halfD = Math.max(col.depth / 2, 0.08);
    ctx.fillRect(-halfW, -halfD, halfW * 2, halfD * 2);
    ctx.strokeRect(-halfW, -halfD, halfW * 2, halfD * 2);
  }
  ctx.restore();
}

export function drawColumnSelected(ctx: CanvasRenderingContext2D, col: ColumnElement): void {
  drawColumn(ctx, col);
  ctx.save();
  ctx.strokeStyle = '#10B981';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  if (col.shape === 'circular') {
    const radius = Math.max((col.diameter || col.width || 0.5) / 2, 0.08);
    ctx.arc(col.position.x, col.position.y, radius + 0.05, 0, Math.PI * 2);
  } else {
    ctx.arc(col.position.x, col.position.y, 0.15, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawColumnDisconnected(ctx: CanvasRenderingContext2D, col: ColumnElement): void {
  ctx.save();
  const { x, y } = col.position;
  ctx.translate(x, y);
  ctx.rotate(col.rotation);
  ctx.fillStyle = 'rgba(239,68,68,0.25)';
  ctx.strokeStyle = '#EF4444';
  ctx.lineWidth = 0.04;
  ctx.setLineDash([0.06, 0.04]);

  if (col.shape === 'circular') {
    const radius = Math.max((col.diameter || col.width || 0.5) / 2, 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, radius + 0.04, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    const halfW = Math.max(col.width / 2, 0.08);
    const halfD = Math.max(col.depth / 2, 0.08);
    ctx.beginPath();
    ctx.rect(-halfW - 0.04, -halfD - 0.04, (halfW + 0.04) * 2, (halfD + 0.04) * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawShearWall(ctx: CanvasRenderingContext2D, wall: ShearWallElement): void {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfT = Math.max(wall.thickness / 2, 0.04);
  const px = -uy * halfT, py = ux * halfT;
  ctx.beginPath();
  ctx.moveTo(wall.startPoint.x + px, wall.startPoint.y + py);
  ctx.lineTo(wall.endPoint.x + px, wall.endPoint.y + py);
  ctx.lineTo(wall.endPoint.x - px, wall.endPoint.y - py);
  ctx.lineTo(wall.startPoint.x - px, wall.startPoint.y - py);
  ctx.closePath();
  ctx.fillStyle = wall.color ?? COLORS.wallFill; ctx.fill();
  ctx.strokeStyle = wall.color ?? COLORS.wallStroke; ctx.lineWidth = 0.03; ctx.stroke();
}

export function drawShearWallSelected(ctx: CanvasRenderingContext2D, wall: ShearWallElement): void {
  drawShearWall(ctx, wall);
  const midX = (wall.startPoint.x + wall.endPoint.x) / 2;
  const midY = (wall.startPoint.y + wall.endPoint.y) / 2;
  ctx.save();
  ctx.strokeStyle = '#10B981'; ctx.lineWidth = 0.05;
  const r = 0.12;
  for (const p of [wall.startPoint, wall.endPoint, { x: midX, y: midY }]) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = COLORS.handle; ctx.fill();
  }
  ctx.restore();
}

export function drawShearWallDisconnected(ctx: CanvasRenderingContext2D, wall: ShearWallElement): void {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfT = Math.max(wall.thickness / 2, 0.04) + 0.04;
  const px = -uy * halfT, py = ux * halfT;
  ctx.save();
  ctx.setLineDash([0.08, 0.05]);
  ctx.strokeStyle = '#EF4444';
  ctx.lineWidth = 0.04;
  ctx.fillStyle = 'rgba(239,68,68,0.2)';
  ctx.beginPath();
  ctx.moveTo(wall.startPoint.x + px, wall.startPoint.y + py);
  ctx.lineTo(wall.endPoint.x + px, wall.endPoint.y + py);
  ctx.lineTo(wall.endPoint.x - px, wall.endPoint.y - py);
  ctx.lineTo(wall.startPoint.x - px, wall.startPoint.y - py);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawBeam(ctx: CanvasRenderingContext2D, beam: BeamElement): void {
  const dx = beam.endPoint.x - beam.startPoint.x;
  const dy = beam.endPoint.y - beam.startPoint.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfW = Math.max(beam.width / 2, 0.08);
  const px = -uy * halfW, py = ux * halfW;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(beam.startPoint.x + px, beam.startPoint.y + py);
  ctx.lineTo(beam.endPoint.x + px, beam.endPoint.y + py);
  ctx.lineTo(beam.endPoint.x - px, beam.endPoint.y - py);
  ctx.lineTo(beam.startPoint.x - px, beam.startPoint.y - py);
  ctx.closePath();
  ctx.fillStyle = beam.color ?? COLORS.beamFill; ctx.fill();
  ctx.strokeStyle = beam.color ?? COLORS.beamStroke; ctx.lineWidth = 0.03; ctx.stroke();
  ctx.restore();
}

export function drawBeamSelected(ctx: CanvasRenderingContext2D, beam: BeamElement): void {
  drawBeam(ctx, beam);
  const midX = (beam.startPoint.x + beam.endPoint.x) / 2;
  const midY = (beam.startPoint.y + beam.endPoint.y) / 2;
  ctx.save();
  ctx.strokeStyle = '#10B981'; ctx.lineWidth = 0.05;
  const r = 0.12;
  for (const p of [beam.startPoint, beam.endPoint, { x: midX, y: midY }]) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = COLORS.handle; ctx.fill();
  }
  ctx.restore();
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function drawNonStructuralWall(ctx: CanvasRenderingContext2D, wall: { startPoint: Point2D; endPoint: Point2D; thickness: number; color?: string }): void {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfT = Math.max(wall.thickness / 2, 0.04);
  const px = -uy * halfT, py = ux * halfT;
  const c = wall.color ?? '#f97316';
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = hexToRgba(c, 0.15);
  ctx.lineWidth = 0.03;
  ctx.setLineDash([0.1, 0.08]);
  ctx.beginPath();
  ctx.moveTo(wall.startPoint.x + px, wall.startPoint.y + py);
  ctx.lineTo(wall.endPoint.x + px, wall.endPoint.y + py);
  ctx.lineTo(wall.endPoint.x - px, wall.endPoint.y - py);
  ctx.lineTo(wall.startPoint.x - px, wall.startPoint.y - py);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawNonStructuralWallSelected(ctx: CanvasRenderingContext2D, wall: { startPoint: Point2D; endPoint: Point2D; thickness: number; color?: string }): void {
  drawNonStructuralWall(ctx, wall);
  const midX = (wall.startPoint.x + wall.endPoint.x) / 2;
  const midY = (wall.startPoint.y + wall.endPoint.y) / 2;
  ctx.save();
  ctx.strokeStyle = '#10B981'; ctx.lineWidth = 0.05;
  const r = 0.12;
  for (const p of [wall.startPoint, wall.endPoint, { x: midX, y: midY }]) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = COLORS.handle; ctx.fill();
  }
  ctx.restore();
}

export function drawNonStructuralPolylineWall(ctx: CanvasRenderingContext2D, wall: { vertices: Point2D[]; thickness: number; color?: string }): void {
  if (wall.vertices.length < 2) return;
  const halfT = Math.max(wall.thickness / 2, 0.04);
  const c = wall.color ?? '#f97316';
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = hexToRgba(c, 0.15);
  ctx.lineWidth = 0.03;
  ctx.setLineDash([0.1, 0.08]);
  for (let i = 0; i < wall.vertices.length - 1; i++) {
    const start = wall.vertices[i];
    const end = wall.vertices[i + 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;
    const ux = dx / len, uy = dy / len;
    const px = -uy * halfT, py = ux * halfT;
    ctx.beginPath();
    ctx.moveTo(start.x + px, start.y + py);
    ctx.lineTo(end.x + px, end.y + py);
    ctx.lineTo(end.x - px, end.y - py);
    ctx.lineTo(start.x - px, start.y - py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawNonStructuralWallPreview(ctx: CanvasRenderingContext2D, start: Point2D, end: Point2D, thicknessM = 0.2, color?: string): void {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfT = Math.max(thicknessM / 2, 0.04);
  const px = -uy * halfT, py = ux * halfT;
  const c = color ?? '#f97316';
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = hexToRgba(c, 0.15);
  ctx.lineWidth = 0.03;
  ctx.setLineDash([0.1, 0.08]);
  ctx.beginPath();
  ctx.moveTo(start.x + px, start.y + py);
  ctx.lineTo(end.x + px, end.y + py);
  ctx.lineTo(end.x - px, end.y - py);
  ctx.lineTo(start.x - px, start.y - py);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawPolylineWall(ctx: CanvasRenderingContext2D, wall: PolylineWallElement): void {
  if (wall.vertices.length < 2) return;
  const halfT = Math.max(wall.thickness / 2, 0.04);
  ctx.save();
  for (let i = 0; i < wall.vertices.length - 1; i++) {
    const start = wall.vertices[i];
    const end = wall.vertices[i + 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;
    const ux = dx / len, uy = dy / len;
    const px = -uy * halfT, py = ux * halfT;
    ctx.beginPath();
    ctx.moveTo(start.x + px, start.y + py);
    ctx.lineTo(end.x + px, end.y + py);
    ctx.lineTo(end.x - px, end.y - py);
    ctx.lineTo(start.x - px, start.y - py);
    ctx.closePath();
    ctx.fillStyle = wall.color ?? COLORS.wallFill; ctx.fill();
    ctx.strokeStyle = wall.color ?? COLORS.wallStroke; ctx.lineWidth = 0.03; ctx.stroke();
  }
  ctx.restore();
}

export function drawPolylineWallSelected(ctx: CanvasRenderingContext2D, wall: PolylineWallElement, vertexEditTarget: { elementId: string; vertexIndex: number } | null = null): void {
  drawPolylineWall(ctx, wall);
  drawVertexLabels(ctx, wall.vertices, wall.id, vertexEditTarget, 0.12, COLORS.handle, '#10B981', '#10B981');
}

export function drawNonStructuralPolylineWallSelected(ctx: CanvasRenderingContext2D, wall: { id: string; vertices: Point2D[]; thickness: number; color?: string }, vertexEditTarget: { elementId: string; vertexIndex: number } | null = null): void {
  drawNonStructuralPolylineWall(ctx, wall);
  drawVertexLabels(ctx, wall.vertices, wall.id, vertexEditTarget, 0.12, COLORS.handle, '#10B981', '#10B981');
}

export function drawSnapCoordinateLabel(ctx: CanvasRenderingContext2D, sx: number, sy: number, worldX: number, worldY: number, snapType: string | null): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const label = snapType ? `${snapType}: (${worldX.toFixed(2)}, ${worldY.toFixed(2)})` : `(${worldX.toFixed(2)}, ${worldY.toFixed(2)})`;
  ctx.font = '11px "JetBrains Mono", monospace';
  const m = ctx.measureText(label);
  const pad = 6;
  const lx = sx + 16;
  const ly = sy - 16;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(lx - pad, ly - 14, m.width + pad * 2, 18);
  ctx.fillStyle = '#22C55E';
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

export function drawCMmarker(ctx: CanvasRenderingContext2D, sx: number, sy: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath(); ctx.arc(sx, sy, 16, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34, 197, 94, 0.3)'; ctx.fill();
  ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#22C55E'; ctx.fill();
  ctx.strokeStyle = COLORS.cmStroke; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

export function drawCRmarker(ctx: CanvasRenderingContext2D, sx: number, sy: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  
  // Outer glow diamond
  ctx.beginPath();
  ctx.moveTo(sx, sy - 18);
  ctx.lineTo(sx + 18, sy);
  ctx.lineTo(sx, sy + 18);
  ctx.lineTo(sx - 18, sy);
  ctx.closePath();
  ctx.fillStyle = 'rgba(249, 115, 22, 0.3)';
  ctx.fill();
  
  // Inner diamond
  ctx.beginPath();
  ctx.moveTo(sx, sy - 9);
  ctx.lineTo(sx + 9, sy);
  ctx.lineTo(sx, sy + 9);
  ctx.lineTo(sx - 9, sy);
  ctx.closePath();
  ctx.fillStyle = '#F97316';
  ctx.fill();
  ctx.strokeStyle = COLORS.crStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  
  ctx.restore();
}

export function drawEccentricityVector(ctx: CanvasRenderingContext2D, cmSx: number, cmSy: number, crSx: number, crSy: number, ex: number, ey: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = COLORS.eccentricity; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cmSx, cmSy); ctx.lineTo(crSx, crSy);
  ctx.stroke();
  ctx.setLineDash([]);
  const ang = Math.atan2(crSy - cmSy, crSx - cmSx);
  const al = 10;
  ctx.fillStyle = COLORS.eccentricity;
  ctx.beginPath();
  ctx.moveTo(crSx, crSy);
  ctx.lineTo(crSx - al * Math.cos(ang - 0.4), crSy - al * Math.sin(ang - 0.4));
  ctx.lineTo(crSx - al * Math.cos(ang + 0.4), crSy - al * Math.sin(ang + 0.4));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

export function drawCalibrationLine(
  ctx: CanvasRenderingContext2D,
  p1Screen: Point2D,
  p2Screen: Point2D,
  labelText?: string
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const dx = p2Screen.x - p1Screen.x;
  const dy = p2Screen.y - p1Screen.y;
  const midX = (p1Screen.x + p2Screen.x) / 2;
  const midY = (p1Screen.y + p2Screen.y) / 2;

  // Dashed measurement line
  ctx.strokeStyle = '#F59E0B';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(p1Screen.x, p1Screen.y);
  ctx.lineTo(p2Screen.x, p2Screen.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Crosshair at point 1
  ctx.strokeStyle = COLORS.calibrateCross;
  ctx.lineWidth = 1.5;
  const cs = 6;
  ctx.beginPath();
  ctx.moveTo(p1Screen.x - cs, p1Screen.y); ctx.lineTo(p1Screen.x + cs, p1Screen.y);
  ctx.moveTo(p1Screen.x, p1Screen.y - cs); ctx.lineTo(p1Screen.x, p1Screen.y + cs);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p1Screen.x, p1Screen.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#F59E0B';
  ctx.fill();

  // Crosshair at point 2
  ctx.beginPath();
  ctx.moveTo(p2Screen.x - cs, p2Screen.y); ctx.lineTo(p2Screen.x + cs, p2Screen.y);
  ctx.moveTo(p2Screen.x, p2Screen.y - cs); ctx.lineTo(p2Screen.x, p2Screen.y + cs);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p2Screen.x, p2Screen.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#F59E0B';
  ctx.fill();

  // Dimension label
  if (labelText) {
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const m = ctx.measureText(labelText);
    const pad = 5;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(midX - m.width / 2 - pad, midY - 18 - pad, m.width + pad * 2, 18 + pad * 2);
    ctx.fillStyle = COLORS.calibrateText;
    ctx.fillText(labelText, midX, midY - 4);
  }

  ctx.restore();
}

export function drawSelectionRect(ctx: CanvasRenderingContext2D, start: Point2D, end: Point2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawDimensionLabel(ctx: CanvasRenderingContext2D, worldPos: Point2D, text: string): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const t = ctx.getTransform();
  const sx = worldPos.x * t.a + t.e;
  const sy = worldPos.y * t.d + t.f;
  ctx.font = '12px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const m = ctx.measureText(text);
  const pad = 4;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(sx - m.width / 2 - pad, sy - 18 - pad, m.width + pad * 2, 18 + pad * 2);
  ctx.fillStyle = COLORS.dimensionText;
  ctx.fillText(text, sx, sy - 4);
  ctx.restore();
}

export function drawMeasureLine(
  ctx: CanvasRenderingContext2D,
  p1Screen: Point2D,
  p2Screen: Point2D,
  distanceMeters: number
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const dx = p2Screen.x - p1Screen.x;
  const dy = p2Screen.y - p1Screen.y;
  const midX = (p1Screen.x + p2Screen.x) / 2;
  const midY = (p1Screen.y + p2Screen.y) / 2;

  // Dashed measurement line (green)
  ctx.strokeStyle = '#10B981';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(p1Screen.x, p1Screen.y);
  ctx.lineTo(p2Screen.x, p2Screen.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Crosshair at point 1
  ctx.strokeStyle = COLORS.measureCross;
  ctx.lineWidth = 1.5;
  const cs = 6;
  ctx.beginPath();
  ctx.moveTo(p1Screen.x - cs, p1Screen.y); ctx.lineTo(p1Screen.x + cs, p1Screen.y);
  ctx.moveTo(p1Screen.x, p1Screen.y - cs); ctx.lineTo(p1Screen.x, p1Screen.y + cs);
  ctx.stroke();

  // Crosshair at point 2
  ctx.beginPath();
  ctx.moveTo(p2Screen.x - cs, p2Screen.y); ctx.lineTo(p2Screen.x + cs, p2Screen.y);
  ctx.moveTo(p2Screen.x, p2Screen.y - cs); ctx.lineTo(p2Screen.x, p2Screen.y + cs);
  ctx.stroke();

  // Distance label
  const label = `${distanceMeters.toFixed(3)} m`;
  ctx.font = '14px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const m = ctx.measureText(label);
  const pad = 6;
  ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
  ctx.fillRect(midX - m.width / 2 - pad, midY - 22 - pad, m.width + pad * 2, 22 + pad * 2);
  ctx.fillStyle = COLORS.measureText;
  ctx.fillText(label, midX, midY - 4);

  ctx.restore();
}

export function drawDimension(
  ctx: CanvasRenderingContext2D,
  startPx: Point2D,
  endPx: Point2D,
  distanceMeters: number,
  selected: boolean
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const dx = endPx.x - startPx.x;
  const dy = endPx.y - startPx.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) { ctx.restore(); return; }

  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const offsetPx = 18;

  // Calculate the offset line positions (shifted perpendicular from the line)
  const s1x = startPx.x + nx * offsetPx;
  const s1y = startPx.y + ny * offsetPx;
  const e1x = endPx.x + nx * offsetPx;
  const e1y = endPx.y + ny * offsetPx;

  const color = selected ? '#10B981' : '#60A5FA';
  const lineW = selected ? 2 : 1.5;

  // Extension lines (thin, from original points to offset line)
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(startPx.x, startPx.y);
  ctx.lineTo(s1x, s1y);
  ctx.moveTo(endPx.x, endPx.y);
  ctx.lineTo(e1x, e1y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Main dimension line (solid, between the two offset points)
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.moveTo(s1x, s1y);
  ctx.lineTo(e1x, e1y);
  ctx.stroke();

  // Tick marks at ends (small lines at 45 degrees)
  const tickLen = 8;
  for (const p of [{ x: s1x, y: s1y }, { x: e1x, y: e1y }]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - tickLen * 0.7, p.y - tickLen * 0.7);
    ctx.lineTo(p.x + tickLen * 0.7, p.y + tickLen * 0.7);
    ctx.moveTo(p.x - tickLen * 0.7, p.y + tickLen * 0.7);
    ctx.lineTo(p.x + tickLen * 0.7, p.y - tickLen * 0.7);
    ctx.stroke();
  }

  // Dimension text label (centered on the line)
  const midX = (s1x + e1x) / 2;
  const midY = (s1y + e1y) / 2;
  const label = `${distanceMeters.toFixed(2)} m`;
  ctx.font = 'bold 11px "Inter", "Segoe UI", "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // High-contrast stroke halo instead of ugly black box
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3;
  ctx.strokeText(label, midX, midY);
  ctx.fillStyle = selected ? '#10B981' : '#38BDF8';
  ctx.fillText(label, midX, midY);

  ctx.restore();
}

export function drawDimensions(
  ctx: CanvasRenderingContext2D,
  dimensions: Dimension[],
  selectedIds: string[],
  ppm: number,
  zoom: number,
  offsetX: number,
  offsetY: number
): void {
  for (const d of dimensions) {
    const sx = d.startPoint.x * ppm * zoom + offsetX;
    const sy = -d.startPoint.y * ppm * zoom + offsetY;
    const ex = d.endPoint.x * ppm * zoom + offsetX;
    const ey = -d.endPoint.y * ppm * zoom + offsetY;
    drawDimension(ctx, { x: sx, y: sy }, { x: ex, y: ey }, d.distance, selectedIds.includes(d.id));
  }
}

export function drawStructuralGrids(
  ctx: CanvasRenderingContext2D,
  columns: { position: Point2D }[],
  slabs: { vertices: Point2D[] }[],
  ppm: number,
  zoom: number,
  offsetX: number,
  offsetY: number
): void {
  if (columns.length === 0 && slabs.length === 0) return;

  const rawX = columns.map(c => c.position.x);
  const rawY = columns.map(c => c.position.y);
  if (rawX.length === 0 || rawY.length === 0) return;

  const sortUnique = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const unique: number[] = [];
    for (const v of sorted) {
      if (!unique.some(u => Math.abs(u - v) < 0.05)) {
        unique.push(v);
      }
    }
    return unique;
  };

  const xCoords = sortUnique(rawX);
  const yCoords = sortUnique(rawY);
  if (xCoords.length === 0 || yCoords.length === 0) return;

  const minX = xCoords[0];
  const maxX = xCoords[xCoords.length - 1];
  const minY = yCoords[0];
  const maxY = yCoords[yCoords.length - 1];

  const gridMargin = 1.0;
  const yStartWorld = minY - gridMargin;
  const yEndWorld = maxY + gridMargin;
  const xStartWorld = minX - gridMargin;
  const xEndWorld = maxX + gridMargin;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const bubbleRadius = 11;

  // 1. Draw Vertical Grid Lines (A, B, C...)
  xCoords.forEach((xVal, idx) => {
    const sx = xVal * ppm * zoom + offsetX;
    const sy1 = -yStartWorld * ppm * zoom + offsetY;
    const sy2 = -yEndWorld * ppm * zoom + offsetY;
    const name = String.fromCharCode(65 + (idx % 26));

    ctx.strokeStyle = '#64748B';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sx, sy1);
    ctx.lineTo(sx, sy2);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const sy of [sy1, sy2]) {
      ctx.fillStyle = '#1E293B';
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, bubbleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 10px "Inter", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, sx, sy);
    }
  });

  // 2. Draw Horizontal Grid Lines (1, 2, 3...)
  yCoords.forEach((yVal, idx) => {
    const sy = -yVal * ppm * zoom + offsetY;
    const sx1 = xStartWorld * ppm * zoom + offsetX;
    const sx2 = xEndWorld * ppm * zoom + offsetX;
    const name = String(idx + 1);

    ctx.strokeStyle = '#64748B';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sx1, sy);
    ctx.lineTo(sx2, sy);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const sx of [sx1, sx2]) {
      ctx.fillStyle = '#1E293B';
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, bubbleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 10px "Inter", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, sx, sy);
    }
  });

  ctx.restore();
}

let previewAlpha = 0;

export function drawColumnPreview(
  ctx: CanvasRenderingContext2D,
  pos: Point2D,
  width = 0.5,
  depth = 0.5,
  shape: 'rectangular' | 'circular' = 'rectangular'
): void {
  previewAlpha = 0.35 + 0.15 * Math.sin(Date.now() / 200);
  ctx.save();
  ctx.globalAlpha = previewAlpha;
  ctx.fillStyle = COLORS.columnFill;
  ctx.strokeStyle = COLORS.columnStroke;
  ctx.lineWidth = 0.03;
  ctx.setLineDash([0.06, 0.06]);

  if (shape === 'circular') {
    const radius = Math.max(width / 2, 0.08);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    const halfW = Math.max(width / 2, 0.08);
    const halfD = Math.max(depth / 2, 0.08);
    ctx.fillRect(pos.x - halfW, pos.y - halfD, halfW * 2, halfD * 2);
    ctx.strokeRect(pos.x - halfW, pos.y - halfD, halfW * 2, halfD * 2);
  }

  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawBeamPreview(ctx: CanvasRenderingContext2D, start: Point2D, end: Point2D, widthM = 0.23): void {
  previewAlpha = 0.35 + 0.15 * Math.sin(Date.now() / 200);
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfW = Math.max(widthM / 2, 0.08);
  const px = -uy * halfW, py = ux * halfW;
  ctx.save();
  ctx.globalAlpha = previewAlpha;
  ctx.beginPath();
  ctx.moveTo(start.x + px, start.y + py);
  ctx.lineTo(end.x + px, end.y + py);
  ctx.lineTo(end.x - px, end.y - py);
  ctx.lineTo(start.x - px, start.y - py);
  ctx.closePath();
  ctx.fillStyle = COLORS.beamFill; ctx.fill();
  ctx.strokeStyle = COLORS.beamStroke; ctx.lineWidth = 0.03;
  ctx.setLineDash([0.06, 0.06]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawDropPanel(ctx: CanvasRenderingContext2D, dp: DropPanelElement): void {
  if (dp.vertices.length < 3) return;
  const c = dp.color ?? COLORS.dropPanelStroke;
  ctx.beginPath();
  ctx.moveTo(dp.vertices[0].x, dp.vertices[0].y);
  for (let i = 1; i < dp.vertices.length; i++) ctx.lineTo(dp.vertices[i].x, dp.vertices[i].y);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(c, 0.3);
  ctx.fill();
  ctx.strokeStyle = c;
  ctx.lineWidth = 0.04;
  ctx.setLineDash([0.06, 0.04]);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawDropPanelSelected(ctx: CanvasRenderingContext2D, dp: DropPanelElement, vertexEditTarget: { elementId: string; vertexIndex: number } | null = null): void {
  drawDropPanel(ctx, dp);
  ctx.strokeStyle = COLORS.dropPanelSelected;
  ctx.lineWidth = 0.05;
  ctx.stroke();
  drawVertexLabels(ctx, dp.vertices, dp.id, vertexEditTarget, 0.16, COLORS.vertexFill, COLORS.vertex, COLORS.vertexLabelText);
}

export function drawDropPanelPreview(ctx: CanvasRenderingContext2D, center: Point2D, width: number, depth: number, rotation: number): void {
  const hw = width / 2, hd = depth / 2;
  const cosT = Math.cos(rotation), sinT = Math.sin(rotation);
  const local = [{ x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd }];
  const verts = local.map(p => ({
    x: center.x + p.x * cosT - p.y * sinT,
    y: center.y + p.x * sinT + p.y * cosT,
  }));
  previewAlpha = 0.35 + 0.15 * Math.sin(Date.now() / 200);
  ctx.save();
  ctx.globalAlpha = previewAlpha;
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(COLORS.dropPanelStroke, 0.3);
  ctx.fill();
  ctx.strokeStyle = COLORS.dropPanelStroke;
  ctx.lineWidth = 0.04;
  ctx.setLineDash([0.06, 0.06]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── FEM Contour Rendering ──────────────────────────────────────────

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

const COLOR_LUT_SIZE = 256;
const _colorLUTs = new Map<ColorRampName, string[]>();

export function getLUT(ramp: ColorRampName = 'jet'): string[] {
  let lut = _colorLUTs.get(ramp);
  if (!lut) {
    lut = new Array<string>(COLOR_LUT_SIZE);
    for (let i = 0; i < COLOR_LUT_SIZE; i++) {
      const t = i / (COLOR_LUT_SIZE - 1);
      const [r, g, b] = sampleRamp(ramp, t);
      lut[i] = `rgb(${r},${g},${b})`;
    }
    _colorLUTs.set(ramp, lut);
  }
  return lut;
}

/** Fast color index from value — returns 0..255 index into the LUT */
function colorIndex(value: number, min: number, range: number): number {
  const t = (value - min) / range;
  return t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0;
}

/**
 * Map a value in [min, max] to a color on the active color ramp.
 * Values below min → minColor, above max → maxColor.
 */
function resultToColor(value: number, min: number, max: number, ramp: ColorRampName = 'jet'): string {
  const range = max - min;
  const lut = getLUT(ramp);
  if (range < 1e-12) return lut[0];
  return lut[colorIndex(value, min, range)];
}


/** Bilinear interpolation on a quadrilateral: f(ξ,η) with ξ,η ∈ [0,1] */
function bilerp(
  f00: number, f10: number, f11: number, f01: number,
  ξ: number, η: number
): number {
  const top = f00 + (f10 - f00) * ξ;
  const bot = f01 + (f11 - f01) * ξ;
  return top + (bot - top) * η;
}

/** Compute world (x,y) from element-local (ξ,η) for a Q4 element */
function q4InterpPos(
  pts: { x: number; y: number }[],
  ξ: number, η: number
): { x: number; y: number } {
  const N = [
    (1 - ξ) * (1 - η),
    ξ * (1 - η),
    ξ * η,
    (1 - ξ) * η,
  ];
  return {
    x: N[0] * pts[0].x + N[1] * pts[1].x + N[2] * pts[2].x + N[3] * pts[3].x,
    y: N[0] * pts[0].y + N[1] * pts[1].y + N[2] * pts[2].y + N[3] * pts[3].y,
  };
}

/**
 * Draw FEM contour overlay with smooth per-element interpolation.
 * PERFORMANCE: Batches all sub-triangles by color-LUT index into Path2D objects,
 * reducing canvas draw calls from O(elements × subdiv²) to O(256).
 */
type FEMContourMeshInput = {
  nodes: { id: number; x: number; y: number }[];
  elements: { id: number; nodeIds: number[] }[];
};

export interface FEMContourPathCache {
  paths: Path2D[];
}

export function buildFEMContourPathCache(
  mesh: FEMContourMeshInput,
  nodeValues: Map<number, number>,
  minVal: number,
  maxVal: number,
  subdiv = 3,
  invert = false,
  ramp: ColorRampName = 'jet'
): FEMContourPathCache | null {
  if (nodeValues.size === 0) return null;
  if (!isFinite(minVal) || !isFinite(maxVal)) return null;
  const range = maxVal - minVal;
  if (range < 1e-15) return null;

  // Build fast node position lookup: id → {x, y}
  const nodePos = new Map<number, { x: number; y: number }>();
  for (const n of mesh.nodes) nodePos.set(n.id, n);

  // Batch triangles by color index (0..255) → Path2D
  const paths: Path2D[] = new Array(COLOR_LUT_SIZE);
  for (let k = 0; k < COLOR_LUT_SIZE; k++) paths[k] = new Path2D();

  for (const elem of mesh.elements) {
    const ids = elem.nodeIds;
    if (ids.length === 3) {
      const p0 = nodePos.get(ids[0]), p1 = nodePos.get(ids[1]), p2 = nodePos.get(ids[2]);
      if (!p0 || !p1 || !p2) continue;
      const v0 = nodeValues.get(ids[0]) ?? 0;
      const v1 = nodeValues.get(ids[1]) ?? 0;
      const v2 = nodeValues.get(ids[2]) ?? 0;

      const n = subdiv * 2;
      const invN = 1 / n;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i + j < n; i++) {
          const L1_a = (n - i - j) * invN, L2_a = i * invN, L3_a = j * invN;
          const L1_b = (n - i - 1 - j) * invN, L2_b = (i + 1) * invN;
          const L1_c = (n - i - j - 1) * invN, L3_c = (j + 1) * invN;

          const avg1 = (v0 * (L1_a + L1_b + L1_c) + v1 * (L2_a + L2_b + L2_a) + v2 * (L3_a + L3_a + L3_c)) / 3;
          const t1 = invert ? (maxVal - avg1) / range : (avg1 - minVal) / range;
          const ci = t1 <= 0 ? 0 : t1 >= 1 ? 255 : (t1 * 255) | 0;
          const path = paths[ci];

          const x_a = p0.x * L1_a + p1.x * L2_a + p2.x * L3_a;
          const y_a = p0.y * L1_a + p1.y * L2_a + p2.y * L3_a;
          const x_b = p0.x * L1_b + p1.x * L2_b + p2.x * L3_a;
          const y_b = p0.y * L1_b + p1.y * L2_b + p2.y * L3_a;
          const x_c = p0.x * L1_c + p1.x * L2_a + p2.x * L3_c;
          const y_c = p0.y * L1_c + p1.y * L2_a + p2.y * L3_c;

          path.moveTo(x_a, y_a);
          path.lineTo(x_b, y_b);
          path.lineTo(x_c, y_c);
          path.closePath();

          // Inverted sub-triangle
          if (i + j + 1 < n) {
            const L1_d = (n - i - 1 - j - 1) * invN, L2_d = (i + 1) * invN, L3_d = (j + 1) * invN;
            const avg2 = (v0 * (L1_b + L1_c + L1_d) + v1 * (L2_b + L2_a + L2_d) + v2 * (L3_a + L3_c + L3_d)) / 3;
            const t2 = invert ? (maxVal - avg2) / range : (avg2 - minVal) / range;
            const ci2 = t2 <= 0 ? 0 : t2 >= 1 ? 255 : (t2 * 255) | 0;
            const path2 = paths[ci2];

            const x_d = p0.x * L1_d + p1.x * L2_d + p2.x * L3_d;
            const y_d = p0.y * L1_d + p1.y * L2_d + p2.y * L3_d;

            path2.moveTo(x_b, y_b);
            path2.lineTo(x_d, y_d);
            path2.lineTo(x_c, y_c);
            path2.closePath();
          }
        }
      }
    } else if (ids.length >= 4) {
      const p = ids.map(id => nodePos.get(id)) as { x: number; y: number }[];
      if (!p[0] || !p[1] || !p[2] || !p[3]) continue;
      const vals = ids.map(id => nodeValues.get(id) ?? 0);
      const invS = 1 / subdiv;
      for (let j = 0; j < subdiv; j++) {
        for (let i = 0; i < subdiv; i++) {
          const ξ0 = i * invS, ξ1 = (i + 1) * invS;
          const η0 = j * invS, η1 = (j + 1) * invS;
          const avg = (bilerp(vals[0], vals[1], vals[2], vals[3], ξ0, η0) +
                       bilerp(vals[0], vals[1], vals[2], vals[3], ξ1, η0) +
                       bilerp(vals[0], vals[1], vals[2], vals[3], ξ1, η1) +
                       bilerp(vals[0], vals[1], vals[2], vals[3], ξ0, η1)) * 0.25;
          const t = invert ? (maxVal - avg) / range : (avg - minVal) / range;
          const ci = t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0;
          const path = paths[ci];
          const p00 = q4InterpPos(p, ξ0, η0);
          const p10 = q4InterpPos(p, ξ1, η0);
          const p11 = q4InterpPos(p, ξ1, η1);
          const p01 = q4InterpPos(p, ξ0, η1);
          path.moveTo(p00.x, p00.y);
          path.lineTo(p10.x, p10.y);
          path.lineTo(p11.x, p11.y);
          path.lineTo(p01.x, p01.y);
          path.closePath();
        }
      }
    }
  }

  return { paths };
}

export function drawFEMContourPathCache(
  ctx: CanvasRenderingContext2D,
  cache: FEMContourPathCache,
  opacity: number,
  ramp: ColorRampName = 'jet'
): void {
  // Flush: one fill() per color bucket (max 256 calls instead of 18000+)
  const lut = getLUT(ramp);
  ctx.save();
  ctx.globalAlpha = opacity;
  for (let k = 0; k < COLOR_LUT_SIZE; k++) {
    if (cache.paths[k]) {
      ctx.fillStyle = lut[k];
      ctx.fill(cache.paths[k]);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawFEMContour(
  ctx: CanvasRenderingContext2D,
  mesh: FEMContourMeshInput,
  nodeValues: Map<number, number>,
  minVal: number,
  maxVal: number,
  opacity: number,
  subdiv = 3,
  invert = false,
  ramp: ColorRampName = 'jet'
): void {
  const cache = buildFEMContourPathCache(mesh, nodeValues, minVal, maxVal, subdiv, invert, ramp);
  if (!cache) return;
  drawFEMContourPathCache(ctx, cache, opacity, ramp);
}

/**
 * Draw FEM mesh wireframe overlay.
 */
export function drawFEMMesh(
  ctx: CanvasRenderingContext2D,
  mesh: { nodes: { id: number; x: number; y: number }[]; elements: { id: number; nodeIds: number[] }[]; unconnectedNodeIds?: number[] }
): void {
  const nodePos = new Map<number, { x: number; y: number }>();
  for (const n of mesh.nodes) nodePos.set(n.id, n);
  if (nodePos.size === 0) return;

  ctx.save();
  ctx.strokeStyle = COLORS.meshWireframe;
  ctx.lineWidth = 0.015;

  for (const elem of mesh.elements) {
    const ids = elem.nodeIds;
    const pts = ids.map(id => nodePos.get(id));
    if (pts.length < 3 || !pts[0] || !pts[1] || !pts[2]) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    ctx.lineTo(pts[1]!.x, pts[1]!.y);
    ctx.lineTo(pts[2]!.x, pts[2]!.y);
    if (pts[3]) ctx.lineTo(pts[3]!.x, pts[3]!.y);
    ctx.closePath();
    ctx.stroke();
  }

  // Draw unconnected nodes highlighted with premium visual styling
  if (mesh.unconnectedNodeIds && mesh.unconnectedNodeIds.length > 0) {
    for (const nid of mesh.unconnectedNodeIds) {
      const node = nodePos.get(nid);
      if (node) {
        // Soft red outer warning halo
        ctx.beginPath();
        ctx.arc(node.x, node.y, 0.22, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
        ctx.fill();

        // Inner solid red warning dot
        ctx.beginPath();
        ctx.arc(node.x, node.y, 0.12, 0, 2 * Math.PI);
        ctx.fillStyle = '#EF4444';
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 0.025;
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

/**
 * Draw warning circle for unconnected structural joints (live or offline)
 */
export function drawUnconnectedJointNode(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  // Soft red outer warning halo
  ctx.beginPath();
  ctx.arc(x, y, 0.22, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
  ctx.fill();

  // Inner solid red warning dot
  ctx.beginPath();
  ctx.arc(x, y, 0.12, 0, 2 * Math.PI);
  ctx.fillStyle = '#EF4444';
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 0.025;
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw a vertical color legend bar.
 */
export function drawColorLegend(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  minVal: number,
  maxVal: number,
  label: string,
  formatFn?: (v: number) => string,
  invert = false,
  ramp: ColorRampName = 'jet'
): void {
  if (!isFinite(minVal) || !isFinite(maxVal)) return;
  if (Math.abs(maxVal - minVal) < 1e-15) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const lut = getLUT(ramp);
  const fmt = formatFn ?? ((v: number) => isFinite(v) ? v.toFixed(2) : '—');

  // Draw horizontal gradient bar
  const steps = 40;
  const stepW = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const val = minVal + t * (maxVal - minVal);
    const range = maxVal - minVal;
    const ct = invert ? (maxVal - val) / range : (val - minVal) / range;
    const ci = ct <= 0 ? 0 : ct >= 1 ? 255 : (ct * 255) | 0;
    ctx.fillStyle = lut[ci];
    ctx.fillRect(x + i * stepW, y, stepW + 0.5, h);
  }


  // Border
  ctx.strokeStyle = COLORS.legendBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // Tick labels below the bar
  ctx.fillStyle = COLORS.legendText;
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const nLabels = 5;
  for (let i = 0; i < nLabels; i++) {
    const t = i / (nLabels - 1);
    // The gradient bar above already applies `invert` when choosing colors, so
    // position t always corresponds to value minVal + t*range. Re-applying the
    // inversion here would flip the labels a second time and mislabel the ramp.
    const val = minVal + t * (maxVal - minVal);
    const lx = x + t * w;
    ctx.fillText(fmt(val), lx, y + h + 4);
  }

  // Title above the bar
  ctx.font = 'bold 11px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x + w / 2, y - 4);

  ctx.restore();
}

/**
 * Draw deformed shape wireframe overlay.
 */
export function drawDeformedShape(
  ctx: CanvasRenderingContext2D,
  mesh: FEMMesh,
  deflections: Map<number, number>,
  scale: number
): void {
  const nodePos = new Map<number, { x: number; y: number }>();
  for (const n of mesh.nodes) nodePos.set(n.id, n);

  ctx.save();
  ctx.strokeStyle = COLORS.deformedWireframe;
  ctx.lineWidth = 0.025;

  for (const elem of mesh.elements) {
    const ids = elem.nodeIds;
    const pts = ids.map(id => {
      const p = nodePos.get(id);
      if (!p) return null;
      const d = deflections.get(id) ?? 0;
      return { x: p.x, y: p.y + (isFinite(d) ? d * scale : 0) };
    });
    if (pts.length < 3 || !pts[0] || !pts[1] || !pts[2]) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    if (pts[3]) ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Get FEM result value for a point from the mesh.
 * Returns interpolated value using bilinear interpolation.
 */
export function sampleFEMResultAtPoint(
  slabResults: Map<string, SlabFEMResult>,
  resultType: FEMResultType,
  point: Point2D
): { slabId: string; value: number; label: string } | null {
  for (const [slabId, result] of slabResults) {
    const nodePos = new Map<number, { x: number; y: number }>();
    for (const n of result.mesh.nodes) nodePos.set(n.id, n);

    const nodeValues = extractNodeValues(result, resultType);
    if (nodeValues.size === 0) continue;

    for (const elem of result.mesh.elements) {
      const ids = elem.nodeIds;
      const pts = ids.map(id => nodePos.get(id));
      let value: number;

      if (ids.length === 3) {
        if (!pts[0] || !pts[1] || !pts[2]) continue;
        const e0x = pts[1]!.x - pts[0]!.x, e0y = pts[1]!.y - pts[0]!.y;
        const e1x = pts[2]!.x - pts[0]!.x, e1y = pts[2]!.y - pts[0]!.y;
        const dxx = point.x - pts[0]!.x, dyy = point.y - pts[0]!.y;
        const den = e0x * e1y - e0y * e1x;
        if (Math.abs(den) < 1e-15) continue;
        const u = (dxx * e1y - dyy * e1x) / den;
        const v = (e0x * dyy - e0y * dxx) / den;
        const w = 1 - u - v;
        if (u < -0.01 || v < -0.01 || w < -0.01) continue;
        const vals = ids.map(id => nodeValues.get(id) ?? 0);
        value = vals[0] * w + vals[1] * u + vals[2] * v;
      } else if (ids.length >= 4) {
        if (!pts[0] || !pts[1] || !pts[2] || !pts[3]) continue;
        let inside = false;
        for (let i = 0, j = 3; i < 4; j = i++) {
          if ((pts[i]!.y > point.y) !== (pts[j]!.y > point.y) &&
              point.x < ((pts[j]!.x - pts[i]!.x) * (point.y - pts[i]!.y)) / (pts[j]!.y - pts[i]!.y) + pts[i]!.x) {
            inside = !inside;
          }
        }
        if (!inside) continue;
        const p = [pts[0]!, pts[1]!, pts[2]!, pts[3]!];
        let ξ = 0.5, η = 0.5;
        for (let iter = 0; iter < 20; iter++) {
          const N = [(1 - ξ) * (1 - η), ξ * (1 - η), ξ * η, (1 - ξ) * η];
          const dNdξ = [-(1 - η), (1 - η), η, -η];
          const dNdη = [-(1 - ξ), -ξ, ξ, (1 - ξ)];
          const Fx = N[0] * p[0].x + N[1] * p[1].x + N[2] * p[2].x + N[3] * p[3].x - point.x;
          const Fy = N[0] * p[0].y + N[1] * p[1].y + N[2] * p[2].y + N[3] * p[3].y - point.y;
          const Jxx = dNdξ[0] * p[0].x + dNdξ[1] * p[1].x + dNdξ[2] * p[2].x + dNdξ[3] * p[3].x;
          const Jxy = dNdη[0] * p[0].x + dNdη[1] * p[1].x + dNdη[2] * p[2].x + dNdη[3] * p[3].x;
          const Jyx = dNdξ[0] * p[0].y + dNdξ[1] * p[1].y + dNdξ[2] * p[2].y + dNdξ[3] * p[3].y;
          const Jyy = dNdη[0] * p[0].y + dNdη[1] * p[1].y + dNdη[2] * p[2].y + dNdη[3] * p[3].y;
          const detJ = Jxx * Jyy - Jxy * Jyx;
          if (Math.abs(detJ) < 1e-15) break;
          ξ -= (Jyy * Fx - Jxy * Fy) / detJ;
          η -= (-Jyx * Fx + Jxx * Fy) / detJ;
          ξ = Math.max(-1.2, Math.min(1.2, ξ));
          η = Math.max(-1.2, Math.min(1.2, η));
          if (Math.abs(Fx) < 1e-10 && Math.abs(Fy) < 1e-10) break;
        }
        const vals = ids.map(id => nodeValues.get(id) ?? 0);
        value = bilerp(vals[0], vals[1], vals[2], vals[3], Math.max(-1, Math.min(1, ξ)), Math.max(-1, Math.min(1, η)));
      } else { continue; }
      const unitMap: Record<string, string> = { deflection: 'mm', mx: 'kN·m/m', my: 'kN·m/m', mxy: 'kN·m/m', stress_s1: 'kPa', stress_s2: 'kPa', stress_vm: 'kPa', shear_vx: 'kN/m', shear_vy: 'kN/m', shear_v1: 'kN/m', membrane_nx: 'kN/m', membrane_ny: 'kN/m', membrane_nxy: 'kN/m', membrane_n1: 'kN/m', punching: 'ratio' };
      const labelMap: Record<string, string> = { deflection: 'Defl', mx: 'Mx', my: 'My', mxy: 'Mxy', stress_s1: 'σ₁', stress_s2: 'σ₂', stress_vm: 'σᵥₘ', shear_vx: 'Vx', shear_vy: 'Vy', shear_v1: 'V₁', membrane_nx: 'Nx', membrane_ny: 'Ny', membrane_nxy: 'Nxy', membrane_n1: 'N₁', punching: 'Punch' };
      const unit = unitMap[resultType] || '';
      const label = `${labelMap[resultType] || resultType}`;
      return { slabId, value, label: `${label} = ${isFinite(value) ? value.toFixed(3) : '—'} ${unit}` };
    }
  }
  return null;
}

function extractNodeValues(
  result: SlabFEMResult,
  resultType: FEMResultType
): Map<number, number> {
  const nodeValues = new Map<number, number>();

  if (resultType === 'deflection') {
    for (const d of result.nodeDeflections) nodeValues.set(d.nodeId, d.wz);
    return nodeValues;
  }


  if (resultType === 'punching') {
    const r = result as any;
    if (r.columnPunching) {
      for (const p of r.columnPunching) nodeValues.set(p.nodeId, p.ratio);
    }
    return nodeValues;
  }

  // Helper: average element-based values to nodes
  function averageToNodes(values: { elementId: number; value: number }[]): void {
    const elemToNode = new Map<number, number[]>();
    for (const m of values) {
      const el = (result.mesh as any)?.elements?.find((e: { id: number }) => e.id === m.elementId);
      if (el) for (const nid of el.nodeIds) {
        if (!elemToNode.has(nid)) elemToNode.set(nid, []);
        elemToNode.get(nid)!.push(m.value);
      }
    }
    for (const [nid, vals] of elemToNode) nodeValues.set(nid, vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Shear result types
  if (resultType.startsWith('shear_')) {
    const shearKey = resultType === 'shear_vx' ? 'vx' : resultType === 'shear_vy' ? 'vy' : 'v1';
    const values = (result.shears || []).map(s => ({ elementId: s.elementId, value: (s as any)[shearKey] }));
    averageToNodes(values);
    return nodeValues;
  }

  // Membrane result types
  if (resultType.startsWith('membrane_')) {
    const memKey = resultType === 'membrane_nx' ? 'nx' : resultType === 'membrane_ny' ? 'ny' : resultType === 'membrane_nxy' ? 'nxy' : 'n1';
    const values = (result.membraneForces || []).map(m => ({ elementId: m.elementId, value: (m as any)[memKey] }));
    averageToNodes(values);
    return nodeValues;
  }

  // For element-based values (moments, stresses), average to nodes
  let elementValues: { elementId: number; value: number }[];
  let key: string | undefined;
  if (resultType === 'mx') elementValues = result.momentMx;
  else if (resultType === 'my') elementValues = result.momentMy;
  else if (resultType === 'mxy') elementValues = result.momentMxy;
  else { key = resultType === 'stress_s1' ? 's1' : resultType === 'stress_s2' ? 's2' : 'vm'; elementValues = []; }

  if (key && result.stresses.length > 0) {
    const elemToNode = new Map<number, number[]>();
    for (const s of result.stresses) {
      for (const elem of [s]) {
        const el = (result.mesh as any)?.elements?.find((e: { id: number }) => e.id === s.elementId);
        if (el) for (const nid of el.nodeIds) {
          if (!elemToNode.has(nid)) elemToNode.set(nid, []);
          elemToNode.get(nid)!.push(s[key as 's1' | 's2' | 'vm']);
        }
      }
    }
    for (const [nid, vals] of elemToNode) nodeValues.set(nid, vals.reduce((a, b) => a + b, 0) / vals.length);
  } else if (elementValues) {
    averageToNodes(elementValues);
  }

  return nodeValues;
}

export function drawWallPreview(ctx: CanvasRenderingContext2D, start: Point2D, end: Point2D, thicknessM = 0.2): void {
  previewAlpha = 0.35 + 0.15 * Math.sin(Date.now() / 200);
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;
  const ux = dx / len, uy = dy / len;
  const halfT = Math.max(thicknessM / 2, 0.04);
  const px = -uy * halfT, py = ux * halfT;
  ctx.save();
  ctx.globalAlpha = previewAlpha;
  ctx.beginPath();
  ctx.moveTo(start.x + px, start.y + py);
  ctx.lineTo(end.x + px, end.y + py);
  ctx.lineTo(end.x - px, end.y - py);
  ctx.lineTo(start.x - px, start.y - py);
  ctx.closePath();
  ctx.fillStyle = COLORS.wallFill; ctx.fill();
  ctx.strokeStyle = COLORS.wallStroke; ctx.lineWidth = 0.03;
  ctx.setLineDash([0.06, 0.06]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawPunchingMarkers(
  ctx: CanvasRenderingContext2D,
  mesh: FEMMesh,
  columns: ColumnElement[],
  punching: ColumnPunchingResult[]
): void {
  for (const p of punching) {
    const node = mesh.nodes.find(n => n.id === p.nodeId);
    if (!node) continue;
    const col = columns.find(c => {
      const dx = c.position.x - node.x, dy = c.position.y - node.y;
      return Math.hypot(dx, dy) < 0.3;
    });
    const r = (col ? Math.max(col.width, col.depth) : 0.3) * 0.5;
    const fill = p.status === 'FAIL' ? 'rgba(239,68,68,0.6)' : p.status === 'WARNING' ? 'rgba(234,179,8,0.6)' : 'rgba(34,197,94,0.6)';
    const stroke = p.status === 'FAIL' ? '#EF4444' : p.status === 'WARNING' ? '#EAB308' : '#22C55E';
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(r, 0.15), 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.03;
    ctx.stroke();
    if (p.ratio > 0.5) {
      ctx.save();
      ctx.fillStyle = COLORS.punchingText;
      ctx.font = `${Math.max(r * 0.6, 0.12)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(node.x, node.y);
      ctx.scale(1, -1);
      ctx.fillText(`${(p.ratio * 100).toFixed(0)}%`, 0, 0);
      ctx.restore();
    }
  }
}

function drawLabelAt(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, color: string): void {
  ctx.save();
  ctx.font = 'bold 0.22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.scale(1, -1);
  ctx.fillStyle = color;
  ctx.fillText(label, x, -y - 0.08);
  ctx.restore();
}

export function drawElementLabels(
  ctx: CanvasRenderingContext2D,
  columns: ColumnElement[],
  walls: ShearWallElement[],
  polylineWalls: PolylineWallElement[],
  beams: BeamElement[],
  slabs: SlabPolygon[],
  dropPanels: DropPanelElement[],
  nonStructuralWalls: NonStructuralWallElement[],
  polylineNonStructuralWalls: PolylineNonStructuralWallElement[],
  hiddenIds: string[],
): void {
  const labelColor = uiState.theme === 'light' ? '#1a1a1a' : '#FFFFFF';
  const labelShadow = uiState.theme === 'light' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.6)';

  ctx.save();
  // Shadow for readability
  ctx.shadowColor = labelShadow;
  ctx.shadowBlur = 0.06;

  for (const c of columns) {
    if (hiddenIds.includes(c.id)) continue;
    drawLabelAt(ctx, c.label, c.position.x, c.position.y, labelColor);
  }
  for (const w of walls) {
    if (hiddenIds.includes(w.id)) continue;
    const mx = (w.startPoint.x + w.endPoint.x) / 2;
    const my = (w.startPoint.y + w.endPoint.y) / 2;
    drawLabelAt(ctx, w.label, mx, my, labelColor);
  }
  for (const pw of polylineWalls) {
    if (hiddenIds.includes(pw.id)) continue;
    let sx = 0, sy = 0;
    for (const v of pw.vertices) { sx += v.x; sy += v.y; }
    drawLabelAt(ctx, pw.label, sx / pw.vertices.length, sy / pw.vertices.length, labelColor);
  }
  for (const b of beams) {
    if (hiddenIds.includes(b.id)) continue;
    const mx = (b.startPoint.x + b.endPoint.x) / 2;
    const my = (b.startPoint.y + b.endPoint.y) / 2;
    drawLabelAt(ctx, b.label, mx, my, labelColor);
  }
  for (const s of slabs) {
    if (hiddenIds.includes(s.id)) continue;
    if (s.vertices.length < 3) continue;
    let sx = 0, sy = 0;
    for (const v of s.vertices) { sx += v.x; sy += v.y; }
    drawLabelAt(ctx, s.label, sx / s.vertices.length, sy / s.vertices.length, labelColor);
  }
  for (const dp of dropPanels) {
    if (hiddenIds.includes(dp.id)) continue;
    drawLabelAt(ctx, dp.label, dp.center.x, dp.center.y, labelColor);
  }
  for (const w of nonStructuralWalls) {
    if (hiddenIds.includes(w.id)) continue;
    const mx = (w.startPoint.x + w.endPoint.x) / 2;
    const my = (w.startPoint.y + w.endPoint.y) / 2;
    drawLabelAt(ctx, w.label, mx, my, labelColor);
  }
  for (const pw of polylineNonStructuralWalls) {
    if (hiddenIds.includes(pw.id)) continue;
    let sx = 0, sy = 0;
    for (const v of pw.vertices) { sx += v.x; sy += v.y; }
    drawLabelAt(ctx, pw.label, sx / pw.vertices.length, sy / pw.vertices.length, labelColor);
  }

  ctx.restore();
}
