import type { PhotometricData, PhotometricMeta, Symmetry } from './types';

/**
 * IES LM-63 (1986 / 1991 / 1995 / 2002 / 2019) parser.
 * Tokenization follows taman-frontend/src/util/ies.ts; this version also reads
 * keywords, TILT=INCLUDE blocks, ballast factor, units and luminous dimensions.
 */

const FEET_TO_METERS = 0.3048;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === 'end') break;
    for (const part of trimmed.split(/[\s,]+/)) {
      if (part) tokens.push(part);
    }
  }
  return tokens;
}

function detectSymmetry(horizontal: number[]): Symmetry {
  const first = horizontal[0] ?? 0;
  const last = horizontal[horizontal.length - 1] ?? 0;
  if (horizontal.length <= 1 || last - first <= 1e-6) return 'rotational';
  if (Math.abs(first) < 1e-6 && Math.abs(last - 90) < 1e-6) return 'quadrant';
  if (Math.abs(first) < 1e-6 && Math.abs(last - 180) < 1e-6) return 'c0-c180';
  if (Math.abs(first - 90) < 1e-6 && Math.abs(last - 270) < 1e-6) return 'c90-c270';
  return 'none';
}

export function parseIes(text: string, fileName: string): PhotometricData {
  const normalized = text.replace(/\r\n?/g, '\n');
  const tiltMatch = normalized.match(/(^|\n)\s*TILT\s*=\s*([^\n]*)/i);
  if (!tiltMatch || tiltMatch.index === undefined) {
    throw new Error('Invalid IES file: missing TILT= line');
  }

  const header = normalized.slice(0, tiltMatch.index);
  const meta: PhotometricMeta = { fileName };
  const keywords: Record<string, string> = {};
  let lastKey = '';
  for (const raw of header.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      const key = m[1].toUpperCase();
      if (key === 'MORE' && lastKey) {
        keywords[lastKey] = `${keywords[lastKey]} ${m[2]}`.trim();
      } else {
        keywords[key] = m[2].trim();
        lastKey = key;
      }
    }
  }
  meta.manufacturer = keywords.MANUFAC || undefined;
  meta.luminaire = keywords.LUMINAIRE || undefined;
  meta.catalog = keywords.LUMCAT || undefined;
  meta.lamp = keywords.LAMP || keywords.LAMPCAT || undefined;
  meta.date = keywords.ISSUEDATE || keywords.DATE || undefined;
  meta.testLab = keywords.TESTLAB || undefined;

  const warnings: string[] = [];
  const tiltValue = tiltMatch[2].trim().toUpperCase();
  const bodyStart = tiltMatch.index + tiltMatch[0].length;
  const tokens = tokenize(normalized.slice(bodyStart));
  let i = 0;
  const next = (): number => {
    if (i >= tokens.length) throw new Error('Invalid IES file: unexpected end of data');
    const v = parseFloat(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };

  if (tiltValue === 'INCLUDE') {
    next(); // lamp-to-luminaire geometry
    const tiltCount = Math.max(0, Math.floor(next()));
    for (let k = 0; k < tiltCount * 2; k++) next();
    warnings.push('tiltIgnored');
  } else if (tiltValue !== 'NONE') {
    warnings.push('tiltIgnored');
  }

  const lampCount = next();
  const lumensPerLamp = next();
  const multiplier = next() || 1;
  const nV = Math.max(1, Math.floor(next()));
  const nH = Math.max(1, Math.floor(next()));
  const photometricType = Math.floor(next());
  const unitsType = Math.floor(next());
  const width = next();
  const length = next();
  next(); // height
  const ballastFactor = next() || 1;
  next(); // future use / ballast-lamp photometric factor
  const inputWatts = next();

  if (photometricType !== 1) warnings.push('notTypeC');

  const vertical: number[] = [];
  for (let k = 0; k < nV; k++) vertical.push(next());
  const horizontal: number[] = [];
  for (let k = 0; k < nH; k++) horizontal.push(next());

  const scale = multiplier * ballastFactor;
  const intensity: number[][] = [];
  for (let h = 0; h < nH; h++) {
    const row: number[] = [];
    for (let v = 0; v < nV; v++) row.push(Math.max(0, next() * scale));
    intensity.push(row);
  }

  const symmetry = detectSymmetry(horizontal);
  const toMeters = unitsType === 1 ? FEET_TO_METERS : 1;
  const round = width < 0 || length < 0;

  return {
    format: 'ies',
    meta,
    symmetry,
    cAngles: symmetry === 'rotational' ? [0] : horizontal,
    gAngles: vertical,
    intensity: symmetry === 'rotational' ? [intensity[0]] : intensity,
    lampFlux: lumensPerLamp > 0 ? lumensPerLamp * Math.max(1, lampCount) : undefined,
    inputWatts: inputWatts > 0 ? inputWatts : undefined,
    luminousLength: Math.abs(length) * toMeters,
    luminousWidth: Math.abs(width) * toMeters,
    round,
    warnings,
  };
}
