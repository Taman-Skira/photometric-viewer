import { describe, expect, it } from 'vitest';
import { parsePhotometricText, readLdt, writeLdt } from '../src/photometry';
import { ldtCandela, ldtStoredPlaneIndices } from '../src/photometry/formats/ldt';
import { C_ANGLES, cdPerKlm, GAMMA_ANGLES, readSample, sampleNames, syntheticLdt, TOTAL_LUMENS } from './helpers';

const candela = (c: number, g: number, conversionFactor = 1) => (cdPerKlm(c, g) * conversionFactor * TOTAL_LUMENS) / 1000;

describe('readLdt', () => {
  it.each([
    [0, 12],
    [1, 1],
    [2, 7],
    [3, 7],
    [4, 4],
  ])('stores the right number of planes for Isym %i', (isym, count) => {
    expect(ldtStoredPlaneIndices(isym, 12)).toHaveLength(count);
  });

  it('reads the header and converts cd/klm to absolute candela', () => {
    const ldt = readLdt(syntheticLdt({ isym: 0, stored: C_ANGLES, conversionFactor: 1.5 }));
    expect(ldt.company).toBe('ACME Lighting');
    expect(ldt.luminaireName).toBe('Test Luminaire');
    expect(ldt.luminaireNumber).toBe('LUM-42');
    expect(ldt.lampSets).toEqual([{ count: 1, type: 'LED', flux: TOTAL_LUMENS, color: '4000K', cri: '80', watts: 25.5 }]);
    expect([ldt.length, ldt.width, ldt.height, ldt.luminousLength, ldt.luminousWidth]).toEqual([1200, 300, 100, 1100, 250]);
    expect(ldt.cAngles).toEqual(C_ANGLES);
    expect(ldt.gAngles).toEqual(GAMMA_ANGLES);
    expect(ldtCandela(ldt)[2][3]).toBeCloseTo(candela(C_ANGLES[2], GAMMA_ANGLES[3], 1.5), 3);
  });

  it('reads rotational symmetry as a single plane', () => {
    const { data } = parsePhotometricText(syntheticLdt({ isym: 1, stored: [0] }), 'rot.ldt');
    expect(data.symmetry).toBe('rotational');
    expect(data.cAngles).toEqual([0]);
    expect(data.intensity).toHaveLength(1);
  });

  it.each([
    [2, C_ANGLES.slice(0, 7), 'c0-c180'],
    [4, C_ANGLES.slice(0, 4), 'quadrant'],
  ] as const)('exposes the stored range for Isym %i', (isym, stored, symmetry) => {
    const { data } = parsePhotometricText(syntheticLdt({ isym, stored }), 'half.ldt');
    expect(data.symmetry).toBe(symmetry);
    expect(data.cAngles).toEqual(stored);
    expect(data.intensity[stored.length - 1][2]).toBeCloseTo(candela(stored[stored.length - 1], GAMMA_ANGLES[2]), 3);
  });

  it('stores C270 through C0 to C90 for Isym 3 and mirrors it about the C90-C270 plane', () => {
    const symmetricAboutC90 = (c: number, g: number) => 100 + 40 * Math.sin((c * Math.PI) / 180) + g / 10;
    const stored = [270, 300, 330, 0, 30, 60, 90];
    const { data, sample } = parsePhotometricText(syntheticLdt({ isym: 3, stored, intensity: symmetricAboutC90 }), 'c90.ldt');
    expect(data.cAngles).toEqual([-90, -60, -30, 0, 30, 60, 90]);
    for (const c of C_ANGLES) {
      expect(sample(c, 60)).toBeCloseTo((symmetricAboutC90(c, 60) * TOTAL_LUMENS) / 1000, 2);
    }
  });

  it('reads absolute photometry (negative lamp count) without a lamp flux', () => {
    const { data } = parsePhotometricText(syntheticLdt({ isym: 0, stored: C_ANGLES, lampCount: -1 }), 'abs.ldt');
    expect(data.lampFlux).toBeUndefined();
    expect(data.intensity[0][0]).toBeCloseTo(candela(0, 0), 3);
  });

  it('treats blank dimension lines as zero', () => {
    const text = syntheticLdt({
      isym: 0,
      stored: C_ANGLES,
      lines: (lines) => {
        lines[13] = '';
        lines[16] = '';
      },
    });
    const ldt = readLdt(text);
    expect([ldt.length, ldt.width, ldt.height]).toEqual([1200, 0, 100]);
    expect(ldtCandela(ldt)[2][3]).toBeCloseTo(candela(C_ANGLES[2], GAMMA_ANGLES[3]), 3);
  });

  it('accepts decimal commas and several values per line', () => {
    const text = syntheticLdt({
      isym: 0,
      stored: C_ANGLES,
      lines: (lines) => {
        lines[31] = '25,5';
        const tail = lines.splice(32);
        lines.push(tail.join(' '));
      },
    }).replace(/\n/g, '\r\n');
    const ldt = readLdt(text);
    expect(ldt.lampSets[0].watts).toBe(25.5);
    expect(ldt.intensity).toHaveLength(12);
    expect(ldtCandela(ldt)[11][6]).toBeCloseTo(candela(330, 180), 3);
  });

  it('rejects incomplete intensity tables and unknown symmetry', () => {
    const text = syntheticLdt({ isym: 0, stored: C_ANGLES });
    expect(() => readLdt(text.split('\n').slice(0, -10).join('\n'))).toThrow(/incomplete/);
    expect(() => readLdt(syntheticLdt({ isym: 7, stored: C_ANGLES }))).toThrow(/symmetry/);
    expect(() => readLdt('too\nshort')).toThrow(/too short/);
  });
});

describe('writeLdt', () => {
  it('writes one value per line with CRLF and round-trips', () => {
    const ldt = readLdt(syntheticLdt({ isym: 2, stored: C_ANGLES.slice(0, 7) }));
    const text = writeLdt(ldt);
    expect(text.split('\r\n')[0]).toBe('ACME Lighting');
    expect(readLdt(text)).toEqual(ldt);
  });
});

describe.each(sampleNames('ldt'))('sample %s', (name) => {
  const text = readSample(name);

  it('round-trips through writeLdt without changes', () => {
    const ldt = readLdt(text);
    expect(readLdt(writeLdt(ldt))).toEqual(ldt);
  });

  it('loads in the viewer', () => {
    const { data, stats } = parsePhotometricText(text, name);
    expect(data.format).toBe('ldt');
    expect(stats.flux).toBeGreaterThan(0);
  });
});
