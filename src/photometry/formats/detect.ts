import type { PhotometricFormat } from '../types';

/** Windows-1252 characters for bytes 0x80..0x9F (undefined bytes keep their Latin-1 code point). */
const CP1252_HIGH = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8DŽ\x8F\x90‘’“”•–—˜™š›œ\x9DžŸ';

/** Strict UTF-8 first, then Windows-1252, which many lighting vendors still write. A UTF-8 BOM is dropped. */
export function decodePhotometricBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Node decodes "windows-1252" as Latin-1, so map the 0x80..0x9F range by hand.
    return new TextDecoder('windows-1252')
      .decode(bytes)
      .replace(/[\x80-\x9F]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
  }
}

export function formatFromFileName(fileName: string): PhotometricFormat | undefined {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'ies') return 'ies';
  if (ext === 'ldt' || ext === 'eul') return 'ldt';
  return undefined;
}

export function detectFormat(text: string, fileName: string): PhotometricFormat {
  return formatFromFileName(fileName) ?? (/^\s*IESNA|(^|\n)\s*TILT\s*=/i.test(text) ? 'ies' : 'ldt');
}

/** `name.ies` -> `name.ldt`; a name without a known extension gets one appended. */
export function replaceExtension(fileName: string, format: PhotometricFormat): string {
  const base = formatFromFileName(fileName) ? fileName.replace(/\.[^./\\]+$/, '') : fileName;
  return `${base}.${format}`;
}
