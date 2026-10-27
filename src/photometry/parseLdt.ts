import {
  ldtCandela,
  ldtIsAbsolute,
  ldtStoredPlaneIndices,
  ldtTotalFlux,
  readLdt,
  LDT_ISYM_C90_C270,
  type LdtFile,
} from './formats/ldt';
import type { PhotometricData, Symmetry } from './types';

/** Converts an EULUMDAT file into the viewer's absolute-candela model. */

const firstNumberIn = (s: string | undefined): number | undefined => {
  const m = s?.match(/\d+(?:[.,]\d+)?/);
  return m ? parseFloat(m[0].replace(',', '.')) : undefined;
};

const SYMMETRY: Record<number, Symmetry> = {
  0: 'none',
  1: 'rotational',
  2: 'c0-c180',
  3: 'c90-c270',
  4: 'quadrant',
};

export function ldtToPhotometricData(file: LdtFile, fileName: string): PhotometricData {
  const symmetry = SYMMETRY[file.symmetry] ?? 'none';
  const mc = file.cAngles.length;
  let cAngles = ldtStoredPlaneIndices(file.symmetry, mc).map((idx) => file.cAngles[idx] ?? idx * file.cStep);
  if (file.symmetry === LDT_ISYM_C90_C270) cAngles = cAngles.map((c) => (c >= 270 ? c - 360 : c));
  if (symmetry === 'rotational') cAngles = [0];

  const lampFlux = ldtTotalFlux(file);
  const watts = file.lampSets.reduce((sum, s) => sum + s.watts, 0);
  const cct = firstNumberIn(file.lampSets[0]?.color);
  const cri = firstNumberIn(file.lampSets[0]?.cri);
  const luminousLength = file.luminousLength / 1000;
  const luminousWidth = file.luminousWidth / 1000;

  return {
    format: 'ldt',
    meta: {
      fileName,
      manufacturer: file.company || undefined,
      luminaire: file.luminaireName || undefined,
      catalog: file.luminaireNumber || undefined,
      lamp: file.lampSets.map((s) => s.type).filter(Boolean).join(', ') || undefined,
      date: file.dateUser || undefined,
    },
    symmetry,
    cAngles,
    gAngles: file.gAngles,
    intensity: ldtCandela(file).map((row) => row.map((v) => Math.max(0, v))),
    lampFlux: !ldtIsAbsolute(file) && lampFlux > 0 ? lampFlux : undefined,
    inputWatts: watts > 0 ? watts : undefined,
    cct: cct && cct >= 1000 && cct <= 20000 ? cct : undefined,
    cri: cri && cri >= 50 && cri <= 100 ? cri : undefined,
    declaredLor: file.lightOutputRatio > 0 ? file.lightOutputRatio : undefined,
    luminousLength,
    luminousWidth: luminousWidth > 0 ? luminousWidth : luminousLength,
    round: luminousWidth <= 0,
    warnings: [],
  };
}

export function parseLdt(text: string, fileName: string): PhotometricData {
  return ldtToPhotometricData(readLdt(text), fileName);
}
