/**
 * Correlated color temperature (CCT, kelvin) -> linear sRGB tint.
 * Kim et al. Planckian locus fit, anchored so 6500K is neutral and
 * luminance-normalized so temperature only shifts hue.
 */

type RGB = [number, number, number];

export function kelvinToLinearRgb(kelvin: number): RGB {
  const raw = cctToLinearSrgb(kelvin);
  const rel: RGB = [raw[0] / D65_LINEAR[0], raw[1] / D65_LINEAR[1], raw[2] / D65_LINEAR[2]];
  const y = 0.2126 * rel[0] + 0.7152 * rel[1] + 0.0722 * rel[2];
  if (y <= 1e-6) return [0, 0, 0];
  return [rel[0] / y, rel[1] / y, rel[2] / y];
}

export function kelvinToCssHex(kelvin: number): string {
  const lin = cctToLinearSrgb(kelvin);
  const m = Math.max(lin[0], lin[1], lin[2], 1e-6);
  const toByte = (c: number) =>
    Math.round(Math.max(0, Math.min(1, linearToSrgb(c / m))) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(lin[0])}${toByte(lin[1])}${toByte(lin[2])}`;
}

const D65_LINEAR = cctToLinearSrgbRaw(6500);

function cctToLinearSrgb(K: number): RGB {
  const raw = cctToLinearSrgbRaw(K);
  return [Math.max(0, raw[0]), Math.max(0, raw[1]), Math.max(0, raw[2])];
}

function cctToLinearSrgbRaw(K: number): RGB {
  const T = Math.max(1000, Math.min(15000, K));
  const T2 = T * T;
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T2) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T2);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T2) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T2);
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d;
  const y = (2 * v) / d;
  const X = x / y;
  const Z = (1 - x - y) / y;
  const R = 3.2406 * X - 1.5372 - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 + 1.057 * Z;
  return [R, G, B];
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
