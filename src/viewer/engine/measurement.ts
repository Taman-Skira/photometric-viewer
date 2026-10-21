import type { Vec3 } from './math';
import type { BuiltScene } from './scenes';

/** Height of the measurement points above their surface (m). */
const LIFT = 0.02;

export interface MeasurePoint {
  position: Vec3;
  normal: Vec3;
  grid: number;
  i: number;
  j: number;
}

export interface MeasureLayout {
  points: MeasurePoint[];
  /** Per grid, point index at slot i * nv + j, or -1 where the point sits inside an object. */
  slots: Int32Array[];
}

const inside = (p: Vec3, min: Vec3, max: Vec3) =>
  p[0] > min[0] && p[0] < max[0] && p[1] > min[1] && p[1] < max[1] && p[2] > min[2] && p[2] < max[2];

export function measurementLayout(scene: BuiltScene): MeasureLayout {
  const points: MeasurePoint[] = [];
  const slots = scene.grids.map((g, gi) => {
    const slot = new Int32Array(g.nu * g.nv).fill(-1);
    for (let i = 0; i < g.nu; i++) {
      for (let j = 0; j < g.nv; j++) {
        const s = (i + 0.5) / g.nu;
        const t = (j + 0.5) / g.nv;
        const p: Vec3 = [0, 1, 2].map((a) => g.origin[a] + g.u[a] * s + g.v[a] * t + g.normal[a] * LIFT) as Vec3;
        if (scene.boxes.some((b) => inside(p, b.min, b.max))) continue;
        slot[i * g.nv + j] = points.length;
        points.push({ position: p, normal: g.normal, grid: gi, i, j });
      }
    }
    return slot;
  });
  return { points, slots };
}

export function formatLux(E: number): string {
  if (!(E > 0.005)) return '0';
  if (E >= 10) return Math.round(E).toString();
  if (E >= 1) return E.toFixed(1);
  return E.toFixed(2);
}

export interface Glyph {
  uv: [number, number, number, number];
  width: number;
  advance: number;
}

export interface GlyphAtlas {
  data: Uint8Array;
  width: number;
  height: number;
  glyphs: Map<string, Glyph>;
  pad: number;
  fontSize: number;
}

const ATLAS_CHARS = '0123456789.';
const ATLAS_FONT_PX = 32;

function context2d(w: number, h: number): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(w, h).getContext('2d');
    if (ctx) return ctx;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c.getContext('2d');
  }
  return null;
}

/** White digits with a dark halo, so labels read on both lit and dark surfaces. */
export function buildGlyphAtlas(): GlyphAtlas | null {
  const font = `600 ${ATLAS_FONT_PX}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  const pad = 10;
  const probe = context2d(8, 8);
  if (!probe) return null;
  probe.font = font;
  const ascent = probe.measureText('0').actualBoundingBoxAscent || ATLAS_FONT_PX * 0.72;
  const cellHeight = Math.ceil(ascent) + 2 * pad;
  const widths = [...ATLAS_CHARS].map((ch) => probe.measureText(ch).width);
  const width = Math.ceil(widths.reduce((s, w) => s + w + 2 * pad, 0));
  const ctx = context2d(width, cellHeight);
  if (!ctx) return null;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(4, 6, 10, 0.82)';
  ctx.fillStyle = '#ffffff';
  const glyphs = new Map<string, Glyph>();
  let x = 0;
  [...ATLAS_CHARS].forEach((ch, k) => {
    const w = widths[k];
    const cell = w + 2 * pad;
    ctx.strokeText(ch, x + pad, pad + ascent);
    ctx.fillText(ch, x + pad, pad + ascent);
    glyphs.set(ch, { uv: [x / width, 0, (x + cell) / width, 1], width: cell, advance: w });
    x += cell;
  });
  const image = ctx.getImageData(0, 0, width, cellHeight);
  return { data: new Uint8Array(image.data.buffer), width, height: cellHeight, glyphs, pad, fontSize: ATLAS_FONT_PX };
}
