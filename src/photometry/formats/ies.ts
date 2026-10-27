import { formatNumber, wrapValues } from './numbers';

/**
 * IES LM-63 (1986 / 1991 / 1995 / 2002 / 2019) file model, reader and writer.
 *
 * The model keeps every field of the file as written (raw candela values,
 * multiplier, ballast factor, units) so that a file can be written back
 * without losing information.
 */

export interface IesKeyword {
  /** Upper-case keyword without brackets, e.g. `MANUFAC`, `MORE`, `_ABSOLUTELUMENS`. */
  key: string;
  value: string;
}

export type IesTilt =
  | { kind: 'none' }
  | { kind: 'include'; lampToLuminaireGeometry: number; angles: number[]; factors: number[] }
  | { kind: 'file'; fileName: string };

export const IES_UNITS_FEET = 1;
export const IES_UNITS_METERS = 2;
export const IES_PHOTOMETRIC_TYPE_C = 1;

export interface IesFile {
  /** First line, e.g. `IESNA:LM-63-2002`. Empty for LM-63-1986 files, which have no version line. */
  version: string;
  /** Keyword lines in file order. `[MORE]` lines are kept as their own entries. */
  keywords: IesKeyword[];
  /** Header lines that are neither the version nor a keyword (free text in LM-63-1986). */
  otherHeaderLines: string[];
  tilt: IesTilt;
  lampCount: number;
  /** -1 means absolute photometry. */
  lumensPerLamp: number;
  candelaMultiplier: number;
  /** 1 = Type C, 2 = Type B, 3 = Type A. */
  photometricType: number;
  /** 1 = feet, 2 = meters. */
  unitsType: number;
  /** Luminous opening dimensions in `unitsType` units. Negative width and length mean a round opening. */
  width: number;
  length: number;
  height: number;
  ballastFactor: number;
  /** "Future use" in LM-63-2002, ballast-lamp photometric factor in older versions. */
  ballastLampPhotometricFactor: number;
  inputWatts: number;
  verticalAngles: number[];
  horizontalAngles: number[];
  /** Candela values as written in the file, indexed [horizontalIndex][verticalIndex]. */
  candela: number[][];
}

/** Splits on whitespace and commas, stopping at an `end` line. */
function tokenize(lines: string[]): string[] {
  const tokens: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === 'end') break;
    for (const part of trimmed.split(/[\s,]+/)) {
      if (part) tokens.push(part);
    }
  }
  return tokens;
}

export function readIes(text: string): IesFile {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const tiltIndex = lines.findIndex((l) => /^\s*TILT\s*=/i.test(l));
  if (tiltIndex < 0) throw new Error('Invalid IES file: missing TILT= line');

  let version = '';
  const keywords: IesKeyword[] = [];
  const otherHeaderLines: string[] = [];
  for (const raw of lines.slice(0, tiltIndex)) {
    const line = raw.trim();
    const keyword = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    const first = !version && keywords.length === 0 && otherHeaderLines.length === 0;
    if (first && /^IESNA/i.test(line)) version = line;
    else if (keyword) keywords.push({ key: keyword[1].trim().toUpperCase(), value: keyword[2].trim() });
    else if (line) otherHeaderLines.push(line);
  }

  const tokens = tokenize(lines.slice(tiltIndex + 1));
  let i = 0;
  const next = (): number => {
    if (i >= tokens.length) throw new Error('Invalid IES file: unexpected end of data');
    const v = parseFloat(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };
  const list = (count: number) => Array.from({ length: count }, next);

  const tiltValue = lines[tiltIndex].replace(/^\s*TILT\s*=\s*/i, '').trim();
  let tilt: IesTilt;
  if (tiltValue.toUpperCase() === 'NONE') {
    tilt = { kind: 'none' };
  } else if (tiltValue.toUpperCase() === 'INCLUDE') {
    const lampToLuminaireGeometry = next();
    const count = Math.max(0, Math.floor(next()));
    tilt = { kind: 'include', lampToLuminaireGeometry, angles: list(count), factors: list(count) };
  } else {
    tilt = { kind: 'file', fileName: tiltValue };
  }

  const lampCount = next();
  const lumensPerLamp = next();
  const candelaMultiplier = next();
  const nV = Math.max(1, Math.floor(next()));
  const nH = Math.max(1, Math.floor(next()));
  const photometricType = Math.floor(next());
  const unitsType = Math.floor(next());
  const width = next();
  const length = next();
  const height = next();
  const ballastFactor = next();
  const ballastLampPhotometricFactor = next();
  const inputWatts = next();
  const verticalAngles = list(nV);
  const horizontalAngles = list(nH);
  const candela = Array.from({ length: nH }, () => list(nV));

  return {
    version,
    keywords,
    otherHeaderLines,
    tilt,
    lampCount,
    lumensPerLamp,
    candelaMultiplier,
    photometricType,
    unitsType,
    width,
    length,
    height,
    ballastFactor,
    ballastLampPhotometricFactor,
    inputWatts,
    verticalAngles,
    horizontalAngles,
    candela,
  };
}

/** Value of a keyword with its `[MORE]` continuation lines joined, or undefined when absent or empty. */
export function iesKeyword(file: IesFile, key: string): string | undefined {
  const wanted = key.toUpperCase();
  const parts: string[] = [];
  let collecting = false;
  for (const k of file.keywords) {
    if (k.key === wanted && parts.length === 0) {
      parts.push(k.value);
      collecting = true;
    } else if (collecting && k.key === 'MORE') {
      parts.push(k.value);
    } else {
      collecting = false;
    }
  }
  const value = parts.join(' ').trim();
  return value || undefined;
}

/**
 * Lumen output declared through the `[_ABSOLUTELUMENS]` keyword, which some vendors use
 * for absolute photometry instead of `lumensPerLamp`.
 */
export function iesAbsoluteLumens(file: IesFile): number | undefined {
  const m = iesKeyword(file, '_ABSOLUTELUMENS')?.match(/[+-]?\d+(?:\.\d+)?/);
  const v = m ? parseFloat(m[0]) : NaN;
  return v > 0 ? v : undefined;
}

export function writeIes(file: IesFile): string {
  const out: string[] = [];
  if (file.version) out.push(file.version);
  for (const k of file.keywords) out.push(k.value ? `[${k.key}] ${k.value}` : `[${k.key}]`);
  out.push(...file.otherHeaderLines);

  const tilt = file.tilt;
  if (tilt.kind === 'none') out.push('TILT=NONE');
  else if (tilt.kind === 'file') out.push(`TILT=${tilt.fileName}`);
  else {
    out.push('TILT=INCLUDE', formatNumber(tilt.lampToLuminaireGeometry), String(tilt.angles.length));
    out.push(...wrapValues(tilt.angles), ...wrapValues(tilt.factors));
  }

  out.push(
    [
      file.lampCount,
      file.lumensPerLamp,
      file.candelaMultiplier,
      file.verticalAngles.length,
      file.horizontalAngles.length,
      file.photometricType,
      file.unitsType,
      file.width,
      file.length,
      file.height,
    ]
      .map((v) => formatNumber(v, 6))
      .join(' '),
    [file.ballastFactor, file.ballastLampPhotometricFactor, file.inputWatts].map((v) => formatNumber(v, 6)).join(' '),
  );
  out.push(...wrapValues(file.verticalAngles), ...wrapValues(file.horizontalAngles));
  for (const row of file.candela) out.push(...wrapValues(row));
  return `${out.join('\r\n')}\r\n`;
}
