import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePhotometricBytes } from '../src/photometry';

export const SAMPLES_DIR = join(import.meta.dirname, '..', 'public', 'photometry');

export const sampleNames = (ext: 'ies' | 'ldt') => readdirSync(SAMPLES_DIR).filter((f) => f.endsWith(`.${ext}`));

export const readSample = (name: string) => decodePhotometricBytes(readFileSync(join(SAMPLES_DIR, name)));

export const GAMMA_ANGLES = [0, 30, 60, 90, 120, 150, 180];
export const C_STEP = 30;
export const C_ANGLES = Array.from({ length: 12 }, (_, k) => k * C_STEP);
export const TOTAL_LUMENS = 2000;

/** Synthetic distribution that is asymmetric in C so symmetry handling is testable. */
export const cdPerKlm = (c: number, g: number) =>
  100 + 50 * Math.cos((c * Math.PI) / 180) + 10 * Math.sin((c * Math.PI) / 180) + g / 10;

interface SyntheticLdt {
  isym: number;
  stored: number[];
  intensity?: (c: number, g: number) => number;
  conversionFactor?: number;
  lampCount?: number;
  lines?: (lines: string[]) => void;
}

/** Synthetic EULUMDAT text with one value per line. */
export function syntheticLdt({ isym, stored, intensity = cdPerKlm, conversionFactor = 1, lampCount = 1, lines: edit }: SyntheticLdt): string {
  const lines = [
    'ACME Lighting',
    '3',
    String(isym),
    String(C_ANGLES.length),
    String(C_STEP),
    String(GAMMA_ANGLES.length),
    '30',
    'REPORT-1',
    'Test Luminaire',
    'LUM-42',
    'lamp.ldt',
    '2026-01-01 / tester',
    '1200',
    '300',
    '100',
    '1100',
    '250',
    '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    String(conversionFactor),
    '0',
    '1',
    String(lampCount),
    'LED',
    String(TOTAL_LUMENS),
    '4000K',
    '80',
    '25.5',
    ...Array.from({ length: 10 }, () => '0'),
    ...C_ANGLES.map(String),
    ...GAMMA_ANGLES.map(String),
  ];
  for (const c of stored) lines.push(...GAMMA_ANGLES.map((g) => intensity(c, g).toFixed(4)));
  edit?.(lines);
  return `${lines.join('\n')}\n`;
}
