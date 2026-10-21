import type { IntensitySampler } from './sampler';

export interface IntensityTexture {
  /** Azimuth (C) resolution; texel i is centered at C = i * 360 / azSize. */
  azSize: number;
  /** Elevation (gamma) resolution; row j is centered at gamma = j * 180 / (elSize - 1). */
  elSize: number;
  /** Half-float texels, normalized to maxCandela, row-major (elevation rows). */
  data: Uint16Array;
  maxCandela: number;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = (mant | 0x800000) >> (1 - exp);
    return sign | ((m + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >> 13);
}

/**
 * Resample the distribution onto a uniform (C, gamma) grid for GPU lookup.
 * The shader uses hardware bilinear filtering with REPEAT on C and CLAMP on gamma.
 */
export function buildIntensityTexture(sample: IntensitySampler, azSize = 360, elSize = 361): IntensityTexture {
  const values = new Float32Array(azSize * elSize);
  let maxCandela = 0;
  for (let j = 0; j < elSize; j++) {
    const g = (j / (elSize - 1)) * 180;
    for (let i = 0; i < azSize; i++) {
      const v = sample((i / azSize) * 360, g);
      values[j * azSize + i] = v;
      if (v > maxCandela) maxCandela = v;
    }
  }
  const inv = maxCandela > 0 ? 1 / maxCandela : 0;
  const data = new Uint16Array(values.length);
  for (let k = 0; k < values.length; k++) data[k] = toHalf(values[k] * inv);
  return { azSize, elSize, data, maxCandela };
}
