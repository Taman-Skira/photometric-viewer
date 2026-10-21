import type { PhotometricData } from './types';

export type IntensitySampler = (cDeg: number, gDeg: number) => number;

const wrap360 = (c: number) => {
  const r = c % 360;
  return r < 0 ? r + 360 : r;
};

/** Maps an arbitrary C angle into the range stored in the file, applying the symmetry. */
function makeReducer(data: PhotometricData): (c: number) => number {
  const first = data.cAngles[0] ?? 0;
  switch (data.symmetry) {
    case 'rotational':
      return () => first;
    case 'c0-c180':
      return (c) => {
        const w = wrap360(c);
        return w > 180 ? 360 - w : w;
      };
    case 'quadrant':
      return (c) => {
        let w = wrap360(c);
        if (w > 180) w = 360 - w;
        return w > 90 ? 180 - w : w;
      };
    case 'c90-c270':
      if (first >= 90 - 1e-6) {
        return (c) => {
          const w = wrap360(c);
          if (w < 90) return 180 - w;
          if (w > 270) return 540 - w;
          return w;
        };
      }
      return (c) => {
        let w = wrap360(c);
        if (w > 180) w -= 360;
        if (w > 90) return 180 - w;
        if (w < -90) return -180 - w;
        return w;
      };
    default:
      return wrap360;
  }
}

/** Index of the last element <= value (clamped to [0, n-2]) for bracket lookup. */
function bracket(values: number[], value: number): number {
  let lo = 0;
  let hi = values.length - 1;
  if (hi <= 0) return 0;
  if (value <= values[0]) return 0;
  if (value >= values[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= value) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Bilinear candela lookup at any (C, gamma) in degrees. Gamma outside the
 * measured range returns 0; the C axis wraps at 360° for full distributions.
 */
export function createIntensitySampler(data: PhotometricData): IntensitySampler {
  const reduce = makeReducer(data);
  let cAngles = data.cAngles.slice();
  let rows = data.intensity.map((r) => r.slice());
  if (data.symmetry === 'none' && cAngles.length > 0) {
    const last = cAngles[cAngles.length - 1];
    if (last < cAngles[0] + 360 - 1e-6) {
      cAngles = [...cAngles, cAngles[0] + 360];
      rows = [...rows, rows[0]];
    }
  }
  const g = data.gAngles;
  const gMin = g[0] ?? 0;
  const gMax = g[g.length - 1] ?? 0;
  const nG = g.length;

  const sampleRow = (row: number[], gDeg: number) => {
    if (nG === 1) return row[0] ?? 0;
    const j = bracket(g, gDeg);
    const span = g[j + 1] - g[j];
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (gDeg - g[j]) / span)) : 0;
    return row[j] * (1 - t) + row[j + 1] * t;
  };

  return (cDeg, gDeg) => {
    if (gDeg < gMin - 1e-6 || gDeg > gMax + 1e-6) return 0;
    if (rows.length === 1) return sampleRow(rows[0], gDeg);
    let c = reduce(cDeg);
    if (data.symmetry === 'none' && c < cAngles[0]) c += 360;
    const i = bracket(cAngles, c);
    const span = cAngles[i + 1] - cAngles[i];
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (c - cAngles[i]) / span)) : 0;
    return sampleRow(rows[i], gDeg) * (1 - t) + sampleRow(rows[i + 1], gDeg) * t;
  };
}
