import { describe, expect, it } from 'vitest';
import { decodePhotometricBytes, iesKeyword, parsePhotometricText, readIes, writeIes } from '../src/photometry';
import { iesAbsoluteLumens } from '../src/photometry/formats/ies';
import { readSample, sampleNames } from './helpers';

// Synthetic file with a fractional luminous opening of 0.368 x 0.673 x 0.094 m.
const SAMPLE = `IESNA:LM-63-2002
[TEST] TR-0001
[MANUFAC] Example Lighting
[LUMINAIRE] Area light 3
[DISTRIBUTION] Type II medium
TILT=NONE
1 6861 1.00 3 2 1 2 0.368 0.673 0.094
1.0 1 37.3
0.0 45.0 90.0
0.0 90.0
300.0 200.0 0.0
300.0 150.0 0.0
`;

describe('readIes', () => {
  it('reads header keywords, dimensions and the candela table', () => {
    const ies = readIes(SAMPLE);
    expect(ies.version).toBe('IESNA:LM-63-2002');
    expect(iesKeyword(ies, 'MANUFAC')).toBe('Example Lighting');
    expect(iesKeyword(ies, 'distribution')).toBe('Type II medium');
    expect([ies.width, ies.length, ies.height]).toEqual([0.368, 0.673, 0.094]);
    expect(ies.inputWatts).toBe(37.3);
    expect(ies.verticalAngles).toEqual([0, 45, 90]);
    expect(ies.horizontalAngles).toEqual([0, 90]);
    expect(ies.candela).toEqual([
      [300, 200, 0],
      [300, 150, 0],
    ]);
  });

  it('joins [MORE] lines and accepts keywords without a space', () => {
    const ies = readIes(SAMPLE.replace('[DISTRIBUTION] Type II medium', '[LUMINAIRE]Area light\n[MORE] with optic B'));
    expect(iesKeyword(ies, 'LUMINAIRE')).toBe('Area light 3');
    expect(ies.keywords.map((k) => k.key)).toEqual(['TEST', 'MANUFAC', 'LUMINAIRE', 'LUMINAIRE', 'MORE']);
  });

  it('accepts comma separated values, CRLF line endings and stops at an "end" line', () => {
    const text = SAMPLE.replace('300.0 200.0 0.0\n300.0 150.0 0.0\n', '300,200,0\n300, 150, 0\nend\n999 999\n').replace(/\n/g, '\r\n');
    expect(readIes(text).candela).toEqual([
      [300, 200, 0],
      [300, 150, 0],
    ]);
  });

  it('reads TILT=INCLUDE blocks', () => {
    const ies = readIes(SAMPLE.replace('TILT=NONE', 'TILT=INCLUDE\n1\n3\n0 45 90\n1 0.95 0.9'));
    expect(ies.tilt).toEqual({ kind: 'include', lampToLuminaireGeometry: 1, angles: [0, 45, 90], factors: [1, 0.95, 0.9] });
    expect(ies.candela[1]).toEqual([300, 150, 0]);
    expect(parsePhotometricText(writeIes(ies), 'x.ies').data.warnings).toContain('tiltIgnored');
  });

  it('reads LM-63-1986 files without a version line', () => {
    const ies = readIes(SAMPLE.replace('IESNA:LM-63-2002\n', 'Some free text header\n'));
    expect(ies.version).toBe('');
    expect(ies.otherHeaderLines).toEqual(['Some free text header']);
    expect(writeIes(ies).startsWith('[TEST] TR-0001')).toBe(true);
  });

  it('reads the luminaire flux from [_ABSOLUTELUMENS] for absolute photometry', () => {
    const ies = readIes(SAMPLE.replace('[TEST]', '[_ABSOLUTELUMENS] 5210.5 lm\n[TEST]').replace('1 6861 1.00', '1 -1 1.00'));
    expect(ies.lumensPerLamp).toBe(-1);
    expect(iesAbsoluteLumens(ies)).toBe(5210.5);
  });

  it('applies the candela multiplier and ballast factor in the viewer model', () => {
    const { data } = parsePhotometricText(SAMPLE.replace('1 6861 1.00', '1 6861 2').replace('1.0 1 37.3', '0.5 1 37.3'), 'x.ies');
    expect(data.intensity[0]).toEqual([300, 200, 0]);
    expect(data.lampFlux).toBe(6861);
  });

  it('decodes Windows-1252 encoded headers', () => {
    const bytes = new TextEncoder().encode(SAMPLE);
    const withDash = new Uint8Array([...bytes.slice(0, 5), 0x96, ...bytes.slice(5)]); // "IESNA–:..."
    expect(decodePhotometricBytes(withDash).startsWith('IESNA–')).toBe(true);
  });

  it('rejects files without a TILT line', () => {
    expect(() => readIes('IESNA:LM-63-2002\n[TEST] x\n')).toThrow(/TILT/);
  });

  it('rejects truncated candela tables', () => {
    expect(() => readIes(SAMPLE.replace('300.0 150.0 0.0\n', ''))).toThrow(/unexpected end/);
  });
});

describe.each(sampleNames('ies'))('sample %s', (name) => {
  const text = readSample(name);

  it('round-trips through writeIes without changes', () => {
    const ies = readIes(text);
    expect(readIes(writeIes(ies))).toEqual(ies);
  });

  it('loads in the viewer', () => {
    const { data, stats } = parsePhotometricText(text, name);
    expect(data.format).toBe('ies');
    expect(stats.flux).toBeGreaterThan(0);
  });
});
