import type { IntensitySampler } from './sampler';
import type { PhotometricData, PhotometricStats } from './types';

const DEG = Math.PI / 180;

/** Full-plane profile from C+180 (negative angles) through nadir to C (positive angles). */
function planeProfile(sample: IntensitySampler, c: number, step: number): { angles: number[]; values: number[] } {
  const angles: number[] = [];
  const values: number[] = [];
  for (let a = -180; a <= 180 + 1e-9; a += step) {
    angles.push(a);
    values.push(a >= 0 ? sample(c, a) : sample(c + 180, -a));
  }
  return { angles, values };
}

/** Full width of the profile at `fraction` of its peak, in degrees. */
function widthAt(angles: number[], values: number[], fraction: number): number | undefined {
  let iMax = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[iMax]) iMax = i;
  const peak = values[iMax];
  if (peak <= 0) return undefined;
  const threshold = peak * fraction;

  const crossing = (dir: 1 | -1): number | undefined => {
    for (let i = iMax; i + dir >= 0 && i + dir < values.length; i += dir) {
      const a = values[i];
      const b = values[i + dir];
      if (b < threshold) {
        const t = (a - threshold) / Math.max(1e-12, a - b);
        return angles[i] + t * (angles[i + dir] - angles[i]);
      }
    }
    return undefined;
  };

  const right = crossing(1);
  const left = crossing(-1);
  if (right === undefined || left === undefined) return undefined;
  return right - left;
}

export function computeStats(data: PhotometricData, sample: IntensitySampler): PhotometricStats {
  const dC = 1;
  const dG = 0.5;
  let flux = 0;
  let downwardFlux = 0;
  let maxIntensity = 0;
  const maxIntensityAt = { c: 0, g: 0 };
  let throwX = 0;
  let throwY = 0;
  let lateral = 0;

  for (let g = dG / 2; g < 180; g += dG) {
    const sinG = Math.sin(g * DEG);
    const solid = sinG * dG * DEG * dC * DEG;
    for (let c = dC / 2; c < 360; c += dC) {
      const I = sample(c, g);
      const phi = I * solid;
      flux += phi;
      if (g < 90) {
        downwardFlux += phi;
        throwX -= Math.sin(c * DEG) * sinG * phi;
        throwY += Math.cos(c * DEG) * sinG * phi;
        lateral += sinG * phi;
      }
    }
  }
  for (let g = 0; g <= 180; g += 0.5) {
    for (let c = 0; c < 360; c += 2.5) {
      const I = sample(c, g);
      if (I > maxIntensity) {
        maxIntensity = I;
        maxIntensityAt.c = c;
        maxIntensityAt.g = g;
      }
    }
  }

  const c0 = planeProfile(sample, 0, 0.25);
  const c90 = planeProfile(sample, 90, 0.25);

  return {
    flux,
    downwardFlux,
    upwardFlux: flux - downwardFlux,
    upwardRatio: flux > 0 ? ((flux - downwardFlux) / flux) * 100 : 0,
    maxIntensity,
    maxIntensityAt,
    lor: data.lampFlux ? (flux / data.lampFlux) * 100 : undefined,
    efficacy: data.inputWatts ? flux / data.inputWatts : undefined,
    beamAngleC0: widthAt(c0.angles, c0.values, 0.5),
    beamAngleC90: widthAt(c90.angles, c90.values, 0.5),
    fieldAngleC0: widthAt(c0.angles, c0.values, 0.1),
    fieldAngleC90: widthAt(c90.angles, c90.values, 0.1),
    throwAngle: ((Math.atan2(-throwX, throwY) / DEG) + 360) % 360,
    asymmetry: lateral > 0 ? Math.hypot(throwX, throwY) / lateral : 0,
  };
}
