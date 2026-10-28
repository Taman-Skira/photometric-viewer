import { formatNumber } from './numbers';

/**
 * EULUMDAT (.ldt) file model, reader and writer.
 *
 * Layout (one value per line, numbers as in the spec):
 *   1  company            2  type indicator      3  symmetry Isym     4  Mc   5  Dc   6  Ng   7  Dg
 *   8  report number      9  luminaire name     10  luminaire number  11  file name     12  date / user
 *  13-15 luminaire length, width, height (mm)   16-17 luminous area length, width (mm)
 *  18-21 luminous area height at C0, C90, C180, C270 (mm)
 *  22  downward flux fraction (%)   23  light output ratio (%)   24  intensity conversion factor
 *  25  tilt during measurement      26  number of lamp sets n
 *  26a-f per set: lamp count, lamp type, total flux (lm), color, CRI, wattage (W)
 *  27  10 direct ratios, then Mc C angles, Ng gamma angles and the stored intensities (cd/klm).
 *
 * The header is read line by line; everything from the direct ratios on is read as a
 * number stream because some writers put several values on one line. Decimal commas
 * and blank dimension lines (some writers leave them empty) are accepted.
 */

export const LDT_ISYM_NONE = 0;
export const LDT_ISYM_ROTATIONAL = 1;
export const LDT_ISYM_C0_C180 = 2;
export const LDT_ISYM_C90_C270 = 3;
export const LDT_ISYM_QUADRANT = 4;

const LAMP_SET_FIELDS = 6;
const DIRECT_RATIOS = 10;
/** Line length limit for the free text header fields. */
export const LDT_TEXT_LIMIT = 78;

export interface LdtLampSet {
  /** Negative for absolute photometry; `flux` is then the luminaire flux. */
  count: number;
  type: string;
  flux: number;
  color: string;
  cri: string;
  watts: number;
}

export interface LdtFile {
  company: string;
  /** 1 point source with rotational symmetry, 2 linear luminaire, 3 point source with other symmetry. */
  typeIndicator: number;
  /** Isym: 0 none, 1 rotational, 2 about C0-C180, 3 about C90-C270, 4 about both planes. */
  symmetry: number;
  /** Distance between C planes in degrees, 0 when not equidistant. */
  cStep: number;
  /** Distance between gamma angles in degrees, 0 when not equidistant. */
  gStep: number;
  reportNumber: string;
  luminaireName: string;
  luminaireNumber: string;
  fileName: string;
  dateUser: string;
  /** Luminaire dimensions in mm. Width 0 means a round luminaire with diameter `length`. */
  length: number;
  width: number;
  height: number;
  /** Luminous area dimensions in mm. Width 0 means a round luminous area. */
  luminousLength: number;
  luminousWidth: number;
  /** Luminous area heights at C0, C90, C180, C270 in mm. */
  luminousHeights: [number, number, number, number];
  downwardFluxFraction: number;
  lightOutputRatio: number;
  conversionFactor: number;
  tilt: number;
  lampSets: LdtLampSet[];
  directRatios: number[];
  /** All Mc C plane angles, ascending from 0. */
  cAngles: number[];
  gAngles: number[];
  /** Stored planes only (see `ldtStoredPlaneIndices`), in cd/klm, indexed [storedPlane][gammaIndex]. */
  intensity: number[][];
}

const num = (s: string | undefined): number => {
  if (s === undefined) return 0;
  const v = parseFloat(s.trim().replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};

/** Indices into `cAngles` of the planes stored in the file, in file order. */
export function ldtStoredPlaneIndices(symmetry: number, mc: number): number[] {
  const range = (count: number, start = 0) => Array.from({ length: count }, (_, k) => (start + k) % mc);
  switch (symmetry) {
    case LDT_ISYM_ROTATIONAL:
      return [0];
    case LDT_ISYM_C0_C180:
      return range(Math.floor(mc / 2) + 1);
    case LDT_ISYM_C90_C270:
      // Spec: Mc1 = 3·Mc/4 + 1 (1-based), i.e. C270 through C0 to C90.
      return range(Math.floor(mc / 2) + 1, Math.floor((3 * mc) / 4));
    case LDT_ISYM_QUADRANT:
      return range(Math.floor(mc / 4) + 1);
    default:
      return range(mc);
  }
}

export function readLdt(text: string): LdtFile {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length < 32) throw new Error('Invalid LDT file: too short');
  const str = (index: number) => lines[index]?.trim() ?? '';

  const symmetry = Math.floor(num(lines[2]));
  if (symmetry < 0 || symmetry > 4) throw new Error(`Invalid LDT file: unsupported symmetry indicator ${symmetry}`);
  const mc = Math.max(1, Math.floor(num(lines[3])));
  const cStep = num(lines[4]);
  const ng = Math.max(1, Math.floor(num(lines[5])));
  const gStep = num(lines[6]);
  const setCount = Math.max(1, Math.floor(num(lines[25])));

  const lampSets: LdtLampSet[] = [];
  for (let s = 0; s < setCount; s++) {
    const field = (f: number) => lines[26 + f * setCount + s];
    lampSets.push({
      count: num(field(0)),
      type: field(1)?.trim() ?? '',
      flux: num(field(2)),
      color: field(3)?.trim() ?? '',
      cri: field(4)?.trim() ?? '',
      watts: num(field(5)),
    });
  }

  const stream: number[] = [];
  for (let l = 26 + LAMP_SET_FIELDS * setCount; l < lines.length; l++) {
    for (const part of lines[l].trim().split(/\s+/)) {
      if (part) stream.push(num(part));
    }
  }
  let p = 0;
  const directRatios = Array.from({ length: DIRECT_RATIOS }, () => stream[p++] ?? 0);
  const cAngles = Array.from({ length: mc }, (_, k) => stream[p++] ?? k * cStep);
  const gAngles = Array.from({ length: ng }, (_, k) => stream[p++] ?? k * gStep);

  const stored = ldtStoredPlaneIndices(symmetry, mc).length;
  if (stream.length - p < stored * ng) throw new Error('Invalid LDT file: intensity table is incomplete');
  const intensity = Array.from({ length: stored }, () => Array.from({ length: ng }, () => stream[p++]));

  return {
    company: str(0),
    typeIndicator: Math.floor(num(lines[1])),
    symmetry,
    cStep,
    gStep,
    reportNumber: str(7),
    luminaireName: str(8),
    luminaireNumber: str(9),
    fileName: str(10),
    dateUser: str(11),
    length: num(lines[12]),
    width: num(lines[13]),
    height: num(lines[14]),
    luminousLength: num(lines[15]),
    luminousWidth: num(lines[16]),
    luminousHeights: [num(lines[17]), num(lines[18]), num(lines[19]), num(lines[20])],
    downwardFluxFraction: num(lines[21]),
    lightOutputRatio: num(lines[22]),
    conversionFactor: num(lines[23]),
    tilt: num(lines[24]),
    lampSets,
    directRatios,
    cAngles,
    gAngles,
    intensity,
  };
}

/** Sum of the lamp set fluxes, the reference flux for the cd/klm values. */
export function ldtTotalFlux(file: LdtFile): number {
  return file.lampSets.reduce((sum, s) => sum + s.flux, 0);
}

/** True when the file uses absolute photometry (negative lamp count). */
export function ldtIsAbsolute(file: LdtFile): boolean {
  return (file.lampSets[0]?.count ?? 0) < 0;
}

/** Stored intensities in absolute candela. */
export function ldtCandela(file: LdtFile): number[][] {
  const flux = ldtTotalFlux(file);
  const factor = (flux > 0 ? flux / 1000 : 1) * (file.conversionFactor > 0 ? file.conversionFactor : 1);
  return file.intensity.map((row) => row.map((v) => v * factor));
}

const text = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, LDT_TEXT_LIMIT);

export function writeLdt(file: LdtFile): string {
  const n = (v: number, decimals = 4) => formatNumber(v, decimals);
  const out: string[] = [
    text(file.company),
    String(file.typeIndicator),
    String(file.symmetry),
    String(file.cAngles.length),
    n(file.cStep),
    String(file.gAngles.length),
    n(file.gStep),
    text(file.reportNumber),
    text(file.luminaireName),
    text(file.luminaireNumber),
    text(file.fileName),
    text(file.dateUser),
    n(file.length, 1),
    n(file.width, 1),
    n(file.height, 1),
    n(file.luminousLength, 1),
    n(file.luminousWidth, 1),
    ...file.luminousHeights.map((h) => n(h, 1)),
    n(file.downwardFluxFraction, 2),
    n(file.lightOutputRatio, 2),
    n(file.conversionFactor),
    n(file.tilt, 1),
    String(file.lampSets.length),
  ];
  const sets = file.lampSets;
  out.push(...sets.map((s) => n(s.count, 0)));
  out.push(...sets.map((s) => text(s.type)));
  out.push(...sets.map((s) => n(s.flux)));
  out.push(...sets.map((s) => text(s.color)));
  out.push(...sets.map((s) => text(s.cri)));
  out.push(...sets.map((s) => n(s.watts, 2)));
  out.push(...Array.from({ length: DIRECT_RATIOS }, (_, k) => n(file.directRatios[k] ?? 0)));
  out.push(...file.cAngles.map((c) => n(c)));
  out.push(...file.gAngles.map((g) => n(g)));
  for (const row of file.intensity) out.push(...row.map((v) => n(v)));
  return `${out.join('\r\n')}\r\n`;
}
