import { iesSymmetry, iesToPhotometricData } from '../parseIes';
import { createIntensitySampler } from '../sampler';
import { computeStats } from '../stats';
import type { PhotometricFormat, Symmetry } from '../types';
import { detectFormat, replaceExtension } from './detect';
import {
  iesAbsoluteLumens,
  iesKeyword,
  IES_PHOTOMETRIC_TYPE_C,
  IES_UNITS_FEET,
  IES_UNITS_METERS,
  readIes,
  writeIes,
  type IesFile,
  type IesKeyword,
} from './ies';
import {
  ldtCandela,
  ldtIsAbsolute,
  ldtStoredPlaneIndices,
  ldtTotalFlux,
  readLdt,
  writeLdt,
  LDT_ISYM_C0_C180,
  LDT_ISYM_C90_C270,
  LDT_ISYM_NONE,
  LDT_ISYM_QUADRANT,
  LDT_ISYM_ROTATIONAL,
  LDT_TEXT_LIMIT,
  type LdtFile,
} from './ldt';
import { formatNumber, uniformStep } from './numbers';

/**
 * IES <-> EULUMDAT conversion. Intensities, angles, symmetry, flux, power and
 * dimensions are carried over exactly; metadata is mapped field by field and
 * anything the target format has no place for is reported as a warning.
 */

export interface ConversionWarning {
  code: string;
  message: string;
}

export interface Converted<T> {
  file: T;
  warnings: ConversionWarning[];
}

export interface ConversionResult {
  format: PhotometricFormat;
  fileName: string;
  text: string;
  warnings: ConversionWarning[];
}

const EPS = 1e-6;
const FEET_TO_METERS = 0.3048;
const DEFAULT_IES_VERSION = 'IESNA:LM-63-2002';

const wrap360 = (c: number) => ((c % 360) + 360) % 360;
const sameAngle = (a: number, b: number) => Math.abs(wrap360(a - b + 180) - 180) < EPS;

/** IES color / CRI have no standard keyword; these user keywords round-trip the LDT lamp fields. */
const COLOR_KEYWORD = '_COLOR';
const CRI_KEYWORD = '_CRI';

const LDT_ISYM: Record<Symmetry, number> = {
  none: LDT_ISYM_NONE,
  rotational: LDT_ISYM_ROTATIONAL,
  'c0-c180': LDT_ISYM_C0_C180,
  'c90-c270': LDT_ISYM_C90_C270,
  quadrant: LDT_ISYM_QUADRANT,
};

/** Every C angle in [0, 360) that the stored angles describe under `symmetry`. */
function mirroredAngles(stored: number[], symmetry: Symmetry): number[] {
  const all: number[] = [];
  for (const c of stored) {
    all.push(c);
    if (symmetry === 'c0-c180' || symmetry === 'quadrant') all.push(360 - c);
    if (symmetry === 'quadrant') all.push(180 - c, 180 + c);
    if (symmetry === 'c90-c270') all.push(180 - c);
  }
  const sorted = all.map(wrap360).sort((a, b) => a - b);
  return sorted.filter((c, i) => i === 0 || c - sorted[i - 1] > EPS);
}

/** Row of the stored IES plane that describes C angle `c` under `symmetry`, or -1. */
function storedRowFor(c: number, stored: number[], symmetry: Symmetry): number {
  const candidates = [c];
  if (symmetry === 'c0-c180' || symmetry === 'quadrant') candidates.push(360 - c);
  if (symmetry === 'quadrant') candidates.push(180 - c, c - 180);
  if (symmetry === 'c90-c270') candidates.push(180 - c);
  for (const candidate of candidates) {
    const index = stored.findIndex((s) => sameAngle(s, candidate));
    if (index >= 0) return index;
  }
  return -1;
}

function checkText(value: string, field: string, warnings: ConversionWarning[]): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (clean.length > LDT_TEXT_LIMIT) {
    warnings.push({
      code: 'truncated',
      message: `${field} is longer than ${LDT_TEXT_LIMIT} characters and was truncated.`,
    });
  }
  return clean.slice(0, LDT_TEXT_LIMIT);
}

export function iesToLdt(ies: IesFile, fileName: string): Converted<LdtFile> {
  if (ies.photometricType !== IES_PHOTOMETRIC_TYPE_C) {
    throw new Error('Only Type C photometry can be written as LDT; this IES file uses Type A or B.');
  }
  const warnings: ConversionWarning[] = [];
  const data = iesToPhotometricData(ies, fileName);
  const stats = computeStats(data, createIntensitySampler(data));

  const absolute = !(ies.lumensPerLamp > 0);
  const referenceFlux = absolute ? (iesAbsoluteLumens(ies) ?? stats.flux) : ies.lumensPerLamp * Math.max(1, ies.lampCount);
  if (!(referenceFlux > 0)) throw new Error('The intensity table contains no light');
  if (absolute) {
    warnings.push({
      code: 'absolutePhotometry',
      message: `Absolute photometry: the luminaire flux (${formatNumber(referenceFlux, 0)} lm) is written as the lamp flux with lamp count -1.`,
    });
  }

  // C planes: LDT always lists all Mc planes over 0..360 and stores the subset Isym asks for.
  const symmetry = iesSymmetry(ies.horizontalAngles);
  const stored = data.cAngles;
  let isym = LDT_ISYM[symmetry];
  let cAngles: number[];
  let rows: number[];
  if (symmetry === 'rotational') {
    cAngles = [0];
    rows = [0];
  } else {
    cAngles = mirroredAngles(stored, symmetry);
    const storedIndices = ldtStoredPlaneIndices(isym, cAngles.length);
    rows = storedIndices.map((i) => storedRowFor(cAngles[i], stored, symmetry));
    const fits = symmetry === 'none' || (rows.every((r) => r >= 0) && new Set(rows).size === stored.length);
    if (!fits) {
      // The planes don't line up with the LDT layout for this symmetry: store every plane instead.
      isym = LDT_ISYM_NONE;
      rows = cAngles.map((c) => storedRowFor(c, stored, symmetry));
    }
  }
  const toCdPerKlm = 1000 / referenceFlux;
  const intensity = rows.map((r) => data.intensity[r].map((v) => v * toCdPerKlm));

  // Metadata
  const used = new Set(['MANUFAC', 'TEST', 'LUMINAIRE', 'LUMCAT', 'TESTLAB', COLOR_KEYWORD, CRI_KEYWORD, '_ABSOLUTELUMENS']);
  const date = iesKeyword(ies, 'ISSUEDATE') ?? iesKeyword(ies, 'DATE');
  used.add(iesKeyword(ies, 'ISSUEDATE') !== undefined ? 'ISSUEDATE' : 'DATE');
  const lamp = iesKeyword(ies, 'LAMP') ?? iesKeyword(ies, 'LAMPCAT');
  used.add(iesKeyword(ies, 'LAMP') !== undefined ? 'LAMP' : 'LAMPCAT');
  const testLab = iesKeyword(ies, 'TESTLAB');

  const dropped: string[] = [];
  let owner = '';
  for (const k of ies.keywords) {
    if (k.key !== 'MORE') owner = k.key;
    if (!used.has(owner) && !dropped.includes(`[${owner}]`)) dropped.push(`[${owner}]`);
  }
  if (dropped.length) {
    warnings.push({ code: 'keywordsDropped', message: `LDT has no field for ${dropped.join(', ')}; dropped.` });
  }
  if (ies.otherHeaderLines.length) {
    warnings.push({ code: 'headerDropped', message: `${ies.otherHeaderLines.length} free-text header line(s) dropped.` });
  }
  if (ies.tilt.kind !== 'none') {
    warnings.push({ code: 'tiltDropped', message: 'LDT cannot store IES TILT data (lamp tilt factors); dropped.' });
  }
  if (ies.ballastFactor && Math.abs(ies.ballastFactor - 1) > EPS) {
    warnings.push({
      code: 'ballastFactorApplied',
      message: `Ballast factor ${formatNumber(ies.ballastFactor)} has no LDT field; it was applied to the intensities.`,
    });
  }
  if (ies.ballastLampPhotometricFactor && Math.abs(ies.ballastLampPhotometricFactor - 1) > EPS) {
    warnings.push({
      code: 'ballastLampFactorDropped',
      message: `Ballast-lamp photometric factor ${formatNumber(ies.ballastLampPhotometricFactor)} has no LDT field; dropped.`,
    });
  }

  // Dimensions: IES stores the luminous opening (negative = round), LDT mm with width 0 = round.
  const toMm = (ies.unitsType === IES_UNITS_FEET ? FEET_TO_METERS : 1) * 1000;
  const round = data.round;
  const length = (round ? Math.max(Math.abs(ies.length), Math.abs(ies.width)) : Math.abs(ies.length)) * toMm;
  const width = round ? 0 : Math.abs(ies.width) * toMm;
  const height = Math.abs(ies.height) * toMm;

  const file: LdtFile = {
    company: checkText(iesKeyword(ies, 'MANUFAC') ?? '', 'Manufacturer', warnings),
    typeIndicator: symmetry === 'rotational' ? 1 : 3,
    symmetry: isym,
    cStep: uniformStep(cAngles),
    gStep: uniformStep(ies.verticalAngles),
    reportNumber: checkText(iesKeyword(ies, 'TEST') ?? '', 'Test report', warnings),
    luminaireName: checkText(iesKeyword(ies, 'LUMINAIRE') ?? '', 'Luminaire name', warnings),
    luminaireNumber: checkText(iesKeyword(ies, 'LUMCAT') ?? '', 'Catalog number', warnings),
    fileName: checkText(fileName, 'File name', warnings),
    dateUser: checkText([date, testLab].filter(Boolean).join(' / '), 'Date / test lab', warnings),
    length,
    width,
    height,
    luminousLength: length,
    luminousWidth: width,
    luminousHeights: [height, height, height, height],
    downwardFluxFraction: stats.flux > 0 ? (stats.downwardFlux / stats.flux) * 100 : 0,
    lightOutputRatio: absolute ? 100 : (stats.flux / referenceFlux) * 100,
    conversionFactor: 1,
    tilt: 0,
    lampSets: [
      {
        count: absolute ? -1 : Math.max(1, ies.lampCount),
        type: checkText(lamp ?? '', 'Lamp type', warnings),
        flux: referenceFlux,
        color: checkText(iesKeyword(ies, COLOR_KEYWORD) ?? '', 'Lamp color', warnings),
        cri: checkText(iesKeyword(ies, CRI_KEYWORD) ?? '', 'CRI', warnings),
        watts: Math.max(0, ies.inputWatts),
      },
    ],
    directRatios: Array.from({ length: 10 }, () => 0),
    cAngles,
    gAngles: ies.verticalAngles.slice(),
    intensity,
  };
  return { file, warnings };
}

export function ldtToIes(ldt: LdtFile): Converted<IesFile> {
  const warnings: ConversionWarning[] = [];
  const candela = ldtCandela(ldt);
  const storedIndices = ldtStoredPlaneIndices(ldt.symmetry, ldt.cAngles.length);
  const storedAngles = storedIndices.map((i) => ldt.cAngles[i] ?? i * ldt.cStep);

  let planes: { angle: number; row: number[] }[];
  switch (ldt.symmetry) {
    case LDT_ISYM_ROTATIONAL:
      planes = [{ angle: 0, row: candela[0] }];
      break;
    case LDT_ISYM_C90_C270:
      // LDT stores C270..C0..C90, IES the mirrored half C90..C270: C(a) = C(180 - a).
      planes = storedAngles.map((a, k) => ({ angle: wrap360(180 - a), row: candela[k] }));
      planes.sort((a, b) => a.angle - b.angle);
      break;
    default:
      planes = storedAngles.map((angle, k) => ({ angle, row: candela[k] }));
  }
  if (ldt.symmetry === LDT_ISYM_NONE && planes.length > 1) {
    // Close the circle so readers that expect a final 360° plane see the full distribution.
    const step = uniformStep(planes.map((p) => p.angle));
    const last = planes[planes.length - 1].angle;
    if (Math.abs(planes[0].angle) < EPS && step > 0 && Math.abs(last + step - 360) < EPS) {
      planes.push({ angle: 360, row: planes[0].row });
    }
  }

  const absolute = ldtIsAbsolute(ldt);
  const totalFlux = ldtTotalFlux(ldt);
  const lampCount = ldt.lampSets.reduce((sum, s) => sum + Math.max(0, s.count), 0);
  if (ldt.lampSets.length > 1) {
    warnings.push({
      code: 'lampSetsMerged',
      message: `${ldt.lampSets.length} lamp sets were merged into one (IES has a single lamp entry).`,
    });
  }

  const keywords: IesKeyword[] = [];
  const add = (key: string, value: string | undefined, always = false) => {
    const v = value?.replace(/[\r\n]+/g, ' ').trim() ?? '';
    if (v || always) keywords.push({ key, value: v });
  };
  const dateUser = ldt.dateUser.match(/^(.*?)\s+\/\s+(.*)$/);
  add('TEST', ldt.reportNumber, true);
  add('TESTLAB', dateUser?.[2]);
  add('ISSUEDATE', dateUser ? dateUser[1] : ldt.dateUser);
  add('MANUFAC', ldt.company, true);
  add('LUMCAT', ldt.luminaireNumber);
  add('LUMINAIRE', ldt.luminaireName);
  add('LAMP', [...new Set(ldt.lampSets.map((s) => s.type).filter(Boolean))].join(', '));
  add(COLOR_KEYWORD, [...new Set(ldt.lampSets.map((s) => s.color).filter(Boolean))].join(', '));
  add(CRI_KEYWORD, [...new Set(ldt.lampSets.map((s) => s.cri).filter(Boolean))].join(', '));
  if (absolute && totalFlux > 0) add('_ABSOLUTELUMENS', formatNumber(totalFlux));

  if (Math.abs(ldt.tilt) > EPS) {
    warnings.push({ code: 'tiltDropped', message: `IES has no field for the measurement tilt (${formatNumber(ldt.tilt)}°); dropped.` });
  }
  if (ldt.directRatios.some((r) => Math.abs(r) > EPS)) {
    warnings.push({ code: 'directRatiosDropped', message: 'IES has no field for the direct ratios (utilization factors); dropped.' });
  }

  // Dimensions: IES only describes the luminous opening.
  const round = ldt.luminousWidth <= 0;
  const heights = ldt.luminousHeights;
  const height = Math.max(...heights);
  if (heights.some((h) => Math.abs(h - height) > EPS)) {
    warnings.push({
      code: 'luminousHeights',
      message: `IES has a single luminous height; the largest of C0/C90/C180/C270 (${heights.map((h) => formatNumber(h, 1)).join(' / ')} mm) was used.`,
    });
  }
  const luminaireDims = [ldt.length, ldt.width, ldt.height];
  const luminousDims = [ldt.luminousLength, ldt.luminousWidth, height];
  if (luminaireDims.some((d, i) => d > 0 && Math.abs(d - luminousDims[i]) > EPS)) {
    warnings.push({
      code: 'luminaireDimensions',
      message: `IES has no field for the luminaire dimensions (${luminaireDims.map((d) => formatNumber(d, 1)).join(' × ')} mm); only the luminous area was kept.`,
    });
  }
  const m = (mm: number) => mm / 1000;

  const file: IesFile = {
    version: DEFAULT_IES_VERSION,
    keywords,
    otherHeaderLines: [],
    tilt: { kind: 'none' },
    lampCount: absolute || lampCount <= 0 ? 1 : lampCount,
    lumensPerLamp: absolute || !(totalFlux > 0) ? -1 : totalFlux / Math.max(1, lampCount),
    candelaMultiplier: 1,
    photometricType: IES_PHOTOMETRIC_TYPE_C,
    unitsType: IES_UNITS_METERS,
    width: round ? -m(ldt.luminousLength) : m(ldt.luminousWidth),
    length: round ? -m(ldt.luminousLength) : m(ldt.luminousLength),
    height: m(height),
    ballastFactor: 1,
    ballastLampPhotometricFactor: 1,
    inputWatts: ldt.lampSets.reduce((sum, s) => sum + s.watts, 0),
    verticalAngles: ldt.gAngles.slice(),
    horizontalAngles: planes.map((p) => p.angle),
    candela: planes.map((p) => p.row),
  };
  return { file, warnings };
}

/**
 * Converts IES text to LDT text or back. The target defaults to the other format and the
 * output name (also written into the LDT file name field) to `fileName` with its extension.
 */
export function convertPhotometricText(
  text: string,
  fileName: string,
  target?: PhotometricFormat,
  outputName?: string,
): ConversionResult {
  const source = detectFormat(text, fileName);
  const format = target ?? (source === 'ies' ? 'ldt' : 'ies');
  const outName = outputName ?? replaceExtension(fileName.split(/[\\/]/).pop() ?? fileName, format);
  if (source === format) throw new Error(`The file is already ${format.toUpperCase()}`);
  if (source === 'ies') {
    const { file, warnings } = iesToLdt(readIes(text), outName);
    return { format, fileName: outName, text: writeLdt(file), warnings };
  }
  const { file, warnings } = ldtToIes(readLdt(text));
  return { format, fileName: outName, text: writeIes(file), warnings };
}
