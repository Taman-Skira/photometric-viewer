import { iesKeyword, IES_PHOTOMETRIC_TYPE_C, IES_UNITS_FEET, readIes, type IesFile } from './formats/ies';
import type { PhotometricData, Symmetry } from './types';

/** Converts an IES file into the viewer's absolute-candela model. */

const FEET_TO_METERS = 0.3048;

export function iesSymmetry(horizontal: number[]): Symmetry {
  const first = horizontal[0] ?? 0;
  const last = horizontal[horizontal.length - 1] ?? 0;
  if (horizontal.length <= 1 || last - first <= 1e-6) return 'rotational';
  if (Math.abs(first) < 1e-6 && Math.abs(last - 90) < 1e-6) return 'quadrant';
  if (Math.abs(first) < 1e-6 && Math.abs(last - 180) < 1e-6) return 'c0-c180';
  if (Math.abs(first - 90) < 1e-6 && Math.abs(last - 270) < 1e-6) return 'c90-c270';
  return 'none';
}

export function iesToPhotometricData(file: IesFile, fileName: string): PhotometricData {
  const warnings: string[] = [];
  if (file.tilt.kind !== 'none') warnings.push('tiltIgnored');
  if (file.photometricType !== IES_PHOTOMETRIC_TYPE_C) warnings.push('notTypeC');

  const scale = (file.candelaMultiplier || 1) * (file.ballastFactor || 1);
  const intensity = file.candela.map((row) => row.map((v) => Math.max(0, v * scale)));
  const symmetry = iesSymmetry(file.horizontalAngles);
  const toMeters = file.unitsType === IES_UNITS_FEET ? FEET_TO_METERS : 1;

  return {
    format: 'ies',
    meta: {
      fileName,
      manufacturer: iesKeyword(file, 'MANUFAC'),
      luminaire: iesKeyword(file, 'LUMINAIRE'),
      catalog: iesKeyword(file, 'LUMCAT'),
      lamp: iesKeyword(file, 'LAMP') ?? iesKeyword(file, 'LAMPCAT'),
      date: iesKeyword(file, 'ISSUEDATE') ?? iesKeyword(file, 'DATE'),
      testLab: iesKeyword(file, 'TESTLAB'),
    },
    symmetry,
    cAngles: symmetry === 'rotational' ? [0] : file.horizontalAngles,
    gAngles: file.verticalAngles,
    intensity: symmetry === 'rotational' ? [intensity[0]] : intensity,
    lampFlux: file.lumensPerLamp > 0 ? file.lumensPerLamp * Math.max(1, file.lampCount) : undefined,
    inputWatts: file.inputWatts > 0 ? file.inputWatts : undefined,
    luminousLength: Math.abs(file.length) * toMeters,
    luminousWidth: Math.abs(file.width) * toMeters,
    round: file.width < 0 || file.length < 0,
    warnings,
  };
}

export function parseIes(text: string, fileName: string): PhotometricData {
  return iesToPhotometricData(readIes(text), fileName);
}
