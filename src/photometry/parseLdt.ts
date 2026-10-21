import type { PhotometricData, Symmetry } from './types';

/**
 * EULUMDAT (.ldt) parser.
 *
 * Header fields are line based; everything from the direct ratios onwards is
 * read as a whitespace separated number stream because some writers put
 * several values on one line. Decimal commas are accepted.
 */

const num = (s: string | undefined): number => {
  if (s === undefined) return 0;
  const v = parseFloat(s.trim().replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};

const firstNumberIn = (s: string | undefined): number | undefined => {
  const m = s?.match(/\d+(?:[.,]\d+)?/);
  return m ? num(m[0]) : undefined;
};

const SYMMETRY: Record<number, Symmetry> = {
  0: 'none',
  1: 'rotational',
  2: 'c0-c180',
  3: 'c90-c270',
  4: 'quadrant',
};

export function parseLdt(text: string, fileName: string): PhotometricData {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length < 40) throw new Error('Invalid LDT file: too short');

  const company = lines[0].trim();
  const isym = Math.floor(num(lines[2]));
  const mc = Math.max(1, Math.floor(num(lines[3])));
  const dc = num(lines[4]);
  const ng = Math.max(1, Math.floor(num(lines[5])));
  const dg = num(lines[6]);
  const luminaireName = lines[8]?.trim();
  const luminaireNumber = lines[9]?.trim();
  const dateUser = lines[11]?.trim();
  const luminousLength = num(lines[15]) / 1000;
  const luminousWidth = num(lines[16]) / 1000;
  const lorl = num(lines[22]);
  const conversion = num(lines[23]);
  const setCount = Math.max(1, Math.floor(num(lines[25])));

  const setLine = (field: number, set: number) => lines[26 + field * setCount + set];
  let lampFlux = 0;
  let watts = 0;
  const lampTypes: string[] = [];
  for (let s = 0; s < setCount; s++) {
    lampTypes.push(setLine(1, s)?.trim() ?? '');
    lampFlux += num(setLine(2, s));
    watts += num(setLine(5, s));
  }
  const cctRaw = firstNumberIn(setLine(3, 0));
  const criRaw = firstNumberIn(setLine(4, 0));

  const tailStart = 26 + 6 * setCount;
  const stream: number[] = [];
  for (let l = tailStart; l < lines.length; l++) {
    for (const part of lines[l].trim().split(/\s+/)) {
      if (part) stream.push(num(part));
    }
  }
  let p = 10; // skip direct ratios
  const allC: number[] = [];
  for (let k = 0; k < mc; k++) allC.push(stream[p++] ?? k * dc);
  const gAngles: number[] = [];
  for (let k = 0; k < ng; k++) gAngles.push(stream[p++] ?? k * dg);

  const symmetry = SYMMETRY[isym] ?? 'none';
  let planeIndices: number[];
  switch (symmetry) {
    case 'rotational':
      planeIndices = [0];
      break;
    case 'c0-c180':
      planeIndices = Array.from({ length: Math.floor(mc / 2) + 1 }, (_, k) => k);
      break;
    case 'c90-c270': {
      const start = Math.floor((3 * mc) / 4);
      planeIndices = Array.from({ length: Math.floor(mc / 2) + 1 }, (_, k) => (start + k) % mc);
      break;
    }
    case 'quadrant':
      planeIndices = Array.from({ length: Math.floor(mc / 4) + 1 }, (_, k) => k);
      break;
    default:
      planeIndices = Array.from({ length: mc }, (_, k) => k);
  }

  const expected = planeIndices.length * ng;
  if (stream.length - p < expected) throw new Error('Invalid LDT file: intensity table is incomplete');

  // cd/klm -> cd. Absolute photometry files store the luminaire flux here.
  const factor = (lampFlux > 0 ? lampFlux / 1000 : 1) * (conversion > 0 ? conversion : 1);
  let cAngles = planeIndices.map((idx) => allC[idx] ?? idx * dc);
  if (symmetry === 'c90-c270') cAngles = cAngles.map((c) => (c >= 270 ? c - 360 : c));
  if (symmetry === 'rotational') cAngles = [0];

  const intensity: number[][] = [];
  for (let c = 0; c < planeIndices.length; c++) {
    const row: number[] = [];
    for (let g = 0; g < ng; g++) row.push(Math.max(0, (stream[p++] ?? 0) * factor));
    intensity.push(row);
  }

  const lampCount = num(setLine(0, 0));
  const absolute = lampCount < 0;

  return {
    format: 'ldt',
    meta: {
      fileName,
      manufacturer: company || undefined,
      luminaire: luminaireName || undefined,
      catalog: luminaireNumber || undefined,
      lamp: lampTypes.filter(Boolean).join(', ') || undefined,
      date: dateUser || undefined,
    },
    symmetry,
    cAngles,
    gAngles,
    intensity,
    lampFlux: !absolute && lampFlux > 0 ? lampFlux : undefined,
    inputWatts: watts > 0 ? watts : undefined,
    cct: cctRaw && cctRaw >= 1000 && cctRaw <= 20000 ? cctRaw : undefined,
    cri: criRaw && criRaw >= 50 && criRaw <= 100 ? criRaw : undefined,
    declaredLor: lorl > 0 ? lorl : undefined,
    luminousLength,
    luminousWidth: luminousWidth > 0 ? luminousWidth : luminousLength,
    round: luminousWidth <= 0,
    warnings: [],
  };
}
