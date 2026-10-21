import { parseIes } from './parseIes';
import { parseLdt } from './parseLdt';
import { createIntensitySampler, type IntensitySampler } from './sampler';
import { computeStats } from './stats';
import type { PhotometricData, PhotometricStats } from './types';

export type { PhotometricData, PhotometricStats, Symmetry, PhotometricFormat } from './types';
export type { IntensitySampler } from './sampler';
export { buildIntensityTexture, type IntensityTexture } from './texture';
export { kelvinToLinearRgb, kelvinToCssHex } from './kelvin';

export interface LoadedPhotometry {
  data: PhotometricData;
  sample: IntensitySampler;
  stats: PhotometricStats;
}

export function decodePhotometricBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function detectFormat(text: string, fileName: string): 'ies' | 'ldt' {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'ies') return 'ies';
  if (ext === 'ldt' || ext === 'eul') return 'ldt';
  return /^\s*IESNA|(^|\n)\s*TILT\s*=/i.test(text) ? 'ies' : 'ldt';
}

export function parsePhotometricText(text: string, fileName: string): LoadedPhotometry {
  const data = detectFormat(text, fileName) === 'ies' ? parseIes(text, fileName) : parseLdt(text, fileName);
  if (data.gAngles.length === 0 || data.intensity.length === 0) {
    throw new Error('The file does not contain an intensity table');
  }
  const sample = createIntensitySampler(data);
  const stats = computeStats(data, sample);
  if (!(stats.maxIntensity > 0)) throw new Error('The intensity table contains no light');
  return { data, sample, stats };
}

export async function loadPhotometricFile(file: File): Promise<LoadedPhotometry> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parsePhotometricText(decodePhotometricBytes(bytes), file.name);
}

export async function loadPhotometricUrl(url: string, fileName: string): Promise<LoadedPhotometry> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${fileName} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parsePhotometricText(decodePhotometricBytes(bytes), fileName);
}
