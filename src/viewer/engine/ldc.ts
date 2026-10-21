import type { IntensitySampler } from '../../photometry';
import { applyMat3, cross, dot, normalize, sub, type Mat3, type Vec3 } from './math';

/** Angular step of the photometric solid. 5° × 3° is smooth without a heavy mesh. */
const C_STEP = 5;
const G_STEP = 3;

const LIME: Vec3 = [0.702, 0.925, 0.286];
const DARK: Vec3 = [0.14, 0.17, 0.07];
const PEAK: Vec3 = [0.97, 1, 0.9];

export interface LdcGeometry {
  solidPos: Float32Array;
  solidNrm: Float32Array;
  solidCol: Float32Array;
  solidIdx: Uint16Array;
  /** Grid, scale rings and axis, as line pairs. Color is RGBA. */
  linePos: Float32Array;
  lineCol: Float32Array;
  ribbonPos: Float32Array;
  ribbonCol: Float32Array;
  ribbonIdx: Uint16Array;
  maxCandela: number;
}

const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Dark olive through brand lime to a white peak, so the lobe reads at a glance. */
function shade(t: number): Vec3 {
  const s = Math.pow(Math.max(0, Math.min(1, t)), 0.42);
  return s < 0.5 ? mix3(DARK, LIME, s / 0.5) : mix3(LIME, PEAK, (s - 0.5) / 0.5);
}

/**
 * Type C direction in the luminaire frame.
 * gamma 0 is nadir (−Z), C0 is +Y, C90 is −X. Inverse of the tracer's lookup.
 */
function photometricDir(cDeg: number, gDeg: number): Vec3 {
  const c = (cDeg * Math.PI) / 180;
  const g = (gDeg * Math.PI) / 180;
  const sg = Math.sin(g);
  return [-sg * Math.sin(c), sg * Math.cos(c), -Math.cos(g)];
}

const place = (rotation: Mat3, cDeg: number, gDeg: number, radius: number): Vec3 => {
  const d = photometricDir(cDeg, gDeg);
  return applyMat3(rotation, [d[0] * radius, d[1] * radius, d[2] * radius]);
};

/** Nudge a point out along its ray so lines sit just above the surface. */
const lift = (p: Vec3, amount: number): Vec3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  if (l < 1e-5) return p;
  const s = (l + amount) / l;
  return [p[0] * s, p[1] * s, p[2] * s];
};

/**
 * Photometric solid: every direction is drawn at a distance proportional to
 * candela, so the outer ring is the peak. `rotation` is the luminaire's
 * local-to-world matrix, the same one the scene uses for tilt and rotation.
 */
export function buildLdcGeometry(sample: IntensitySampler, rotation: Mat3): LdcGeometry {
  const nC = Math.round(360 / C_STEP);
  const nG = Math.round(180 / G_STEP) + 1;
  const at = (ig: number, ic: number) => ig * nC + ((ic % nC) + nC) % nC;

  let maxCd = 0;
  const intensity = new Float32Array(nG * nC);
  for (let ig = 0; ig < nG; ig++) {
    const g = Math.min(180, ig * G_STEP);
    for (let ic = 0; ic < nC; ic++) {
      const I = Math.max(0, sample(ic * C_STEP, g));
      intensity[at(ig, ic)] = I;
      if (I > maxCd) maxCd = I;
    }
  }
  const peak = Math.max(maxCd, 1e-6);

  const pos: Vec3[] = [];
  for (let ig = 0; ig < nG; ig++) {
    const g = Math.min(180, ig * G_STEP);
    for (let ic = 0; ic < nC; ic++) pos.push(place(rotation, ic * C_STEP, g, intensity[at(ig, ic)] / peak));
  }

  const nrm: Vec3[] = [];
  for (let ig = 0; ig < nG; ig++) {
    for (let ic = 0; ic < nC; ic++) {
      const i = at(ig, ic);
      if (ig === 0 || ig === nG - 1) {
        nrm.push(applyMat3(rotation, photometricDir(0, ig === 0 ? 0 : 180)));
        continue;
      }
      const tg = sub(pos[at(ig + 1, ic)], pos[at(ig - 1, ic)]);
      const tc = sub(pos[at(ig, ic + 1)], pos[at(ig, ic - 1)]);
      let n = cross(tg, tc);
      if (dot(n, pos[i]) < 0) n = [-n[0], -n[1], -n[2]];
      nrm.push(normalize(n));
    }
  }

  const solidPos = new Float32Array(pos.length * 3);
  const solidNrm = new Float32Array(pos.length * 3);
  const solidCol = new Float32Array(pos.length * 3);
  pos.forEach((p, i) => {
    solidPos.set(p, i * 3);
    solidNrm.set(nrm[i], i * 3);
    solidCol.set(shade(intensity[i] / peak), i * 3);
  });

  const tris: number[] = [];
  for (let ig = 0; ig < nG - 1; ig++) {
    for (let ic = 0; ic < nC; ic++) {
      const a = at(ig, ic);
      const b = at(ig, ic + 1);
      const c = at(ig + 1, ic);
      const d = at(ig + 1, ic + 1);
      if (ig === 0) tris.push(a, c, d);
      else if (ig === nG - 2) tris.push(a, c, b);
      else tris.push(a, c, b, b, c, d);
    }
  }

  const linePos: number[] = [];
  const lineCol: number[] = [];
  const pushLine = (a: Vec3, b: Vec3, col: number[]) => {
    linePos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    lineCol.push(...col, ...col);
  };
  const grid = [1, 1, 1, 0.4];
  const ring = [1, 1, 1, 0.32];

  for (let ic = 0; ic < nC; ic += 3) {
    for (let ig = 0; ig < nG - 1; ig++) pushLine(lift(pos[at(ig, ic)], 0.012), lift(pos[at(ig + 1, ic)], 0.012), grid);
  }
  for (let ig = 5; ig < nG - 1; ig += 5) {
    for (let ic = 0; ic < nC; ic++) pushLine(lift(pos[at(ig, ic)], 0.012), lift(pos[at(ig, ic + 1)], 0.012), grid);
  }

  const ringPts = (kind: 'c0' | 'c90' | 'horizon'): Vec3[] => {
    const n = 96;
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const local: Vec3 =
        kind === 'c0' ? [0, Math.sin(a), -Math.cos(a)] : kind === 'c90' ? [-Math.sin(a), 0, -Math.cos(a)] : [-Math.sin(a), Math.cos(a), 0];
      pts.push(applyMat3(rotation, local));
    }
    return pts;
  };
  for (const kind of ['c0', 'c90', 'horizon'] as const) {
    const pts = ringPts(kind);
    for (let i = 0; i < pts.length - 1; i++) pushLine(pts[i], pts[i + 1], ring);
  }

  // Nadir axis, so tilt stays readable when the beam leaves the vertical.
  pushLine([0, 0, 0], place(rotation, 0, 0, 1.12), [1, 1, 1, 0.7]);

  const ribPos: number[] = [];
  const ribCol: number[] = [];
  const ribIdx: number[] = [];
  const addRibbon = (points: Vec3[], rgb: Vec3, width: number) => {
    if (points.length < 2) return;
    const base = ribPos.length / 3;
    points.forEach((point, i) => {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const tangent = normalize(sub(next, prev));
      let side = cross(tangent, normalize(point));
      if (Math.hypot(side[0], side[1], side[2]) < 1e-4) side = cross(tangent, [0, 0, 1]);
      side = normalize(side);
      const p = lift(point, 0.016);
      const w = width;
      ribPos.push(p[0] + side[0] * w, p[1] + side[1] * w, p[2] + side[2] * w, p[0] - side[0] * w, p[1] - side[1] * w, p[2] - side[2] * w);
      ribCol.push(rgb[0], rgb[1], rgb[2], 1, rgb[0], rgb[1], rgb[2], 1);
    });
    for (let i = 0; i < points.length - 1; i++) {
      const a = base + i * 2;
      ribIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };

  /** Closed curve of one C-plane: out along C and back along C+180. */
  const planeCurve = (c0: number): Vec3[] => {
    const steps = 120;
    const pts: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 360;
      const g = a <= 180 ? a : 360 - a;
      const c = (a <= 180 ? c0 : c0 + 180) % 360;
      pts.push(place(rotation, c, g, Math.max(0, sample(c, g)) / peak));
    }
    return pts;
  };

  addRibbon(planeCurve(0), LIME, 0.011);
  const c90 = planeCurve(90);
  for (let i = 0; i < c90.length - 1; i += 4) addRibbon(c90.slice(i, Math.min(c90.length, i + 3)), [0.93, 0.94, 0.91], 0.007);

  return {
    solidPos,
    solidNrm,
    solidCol,
    solidIdx: Uint16Array.from(tris),
    linePos: Float32Array.from(linePos),
    lineCol: Float32Array.from(lineCol),
    ribbonPos: Float32Array.from(ribPos),
    ribbonCol: Float32Array.from(ribCol),
    ribbonIdx: Uint16Array.from(ribIdx),
    maxCandela: maxCd,
  };
}
