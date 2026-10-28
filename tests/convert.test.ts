import { describe, expect, it } from 'vitest';
import { convertPhotometricText, iesKeyword, parsePhotometricText, readIes, readLdt, type LoadedPhotometry } from '../src/photometry';
import { C_ANGLES, readSample, sampleNames, syntheticLdt } from './helpers';

/** Same light: identical intensity everywhere the viewer samples, same declared flux and power. */
function expectSameLight(a: LoadedPhotometry, b: LoadedPhotometry) {
  const peak = a.stats.maxIntensity;
  for (let g = 0; g <= 180; g += 2.5) {
    for (let c = 0; c < 360; c += 7.5) {
      expect(Math.abs(b.sample(c, g) - a.sample(c, g))).toBeLessThan(peak * 1e-5 + 1e-3);
    }
  }
  expect(b.stats.flux).toBeCloseTo(a.stats.flux, 0);
  if (a.data.lampFlux === undefined) expect(b.data.lampFlux).toBeUndefined();
  else expect(b.data.lampFlux).toBeCloseTo(a.data.lampFlux, 3);
  expect(b.data.inputWatts).toEqual(a.data.inputWatts);
  expect(b.data.symmetry).toBe(a.data.symmetry);
  // LDT marks a round opening with width 0, so a 0 × 0 opening cannot stay "not round".
  if (a.data.luminousWidth > 0) expect(b.data.round).toBe(a.data.round);
  expect(b.data.luminousLength).toBeCloseTo(a.data.luminousLength, 4);
  expect(b.data.luminousWidth).toBeCloseTo(a.data.luminousWidth, 4);
  expect(b.data.meta.manufacturer).toBe(a.data.meta.manufacturer);
  expect(b.data.meta.luminaire).toBe(a.data.meta.luminaire);
  expect(b.data.meta.catalog).toBe(a.data.meta.catalog);
}

describe.each([...sampleNames('ies'), ...sampleNames('ldt')])('sample %s', (name) => {
  const text = readSample(name);
  const original = parsePhotometricText(text, name);
  const converted = convertPhotometricText(text, name);
  const back = convertPhotometricText(converted.text, converted.fileName);

  it('converts to the other format with the same light', () => {
    expect(converted.format).not.toBe(original.data.format);
    expect(converted.fileName).toBe(name.replace(/\.(ies|ldt)$/, `.${converted.format}`));
    expectSameLight(original, parsePhotometricText(converted.text, converted.fileName));
  });

  it('converts back with the same light', () => {
    expect(back.format).toBe(original.data.format);
    expectSameLight(original, parsePhotometricText(back.text, back.fileName));
  });
});

describe('IES to LDT', () => {
  const ies = readSample('linear-batwing-pendant.ies');

  it('maps the header keywords to LDT fields', () => {
    const ldt = readLdt(convertPhotometricText(ies, 'pendant.ies').text);
    expect(ldt.company).toBe('Taman sample library');
    expect(ldt.reportNumber).toBe('Synthetic sample');
    expect(ldt.luminaireNumber).toBe('TS-LIN-BW');
    expect(ldt.dateUser).toBe('2026-09-23 / Taman');
    expect(ldt.fileName).toBe('pendant.ldt');
    expect(ldt.lampSets[0]).toMatchObject({ count: 1, type: 'LED 4000K', flux: 2500, watts: 20 });
    expect([ldt.length, ldt.width, ldt.height]).toEqual([1200, 70, 50]);
  });

  it('keeps the LDT symmetry that matches the IES planes', () => {
    const isym = (name: string) => readLdt(convertPhotometricText(readSample(name), name).text).symmetry;
    expect(isym('narrow-spot-downlight.ies')).toBe(1);
    expect(isym('linear-batwing-pendant.ies')).toBe(4);
    expect(isym('taman-street-luminaire.ies')).toBe(0);
  });

  it('stores absolute photometry with lamp count -1 and the computed flux', () => {
    const result = convertPhotometricText(readSample('well-known-street-luminaire.ies'), 'known.ies');
    const ldt = readLdt(result.text);
    expect(ldt.lampSets[0].count).toBe(-1);
    expect(ldt.lampSets[0].flux).toBeGreaterThan(0);
    expect(result.warnings.map((w) => w.code)).toContain('absolutePhotometry');
  });

  it('warns about keywords, TILT data and factors without an LDT field', () => {
    const text = ies
      .replace('[LAMP] LED 4000K', '[LAMP] LED 4000K\n[DISTRIBUTION] Batwing\n[MORE] wide\n[BALLAST] Driver X')
      .replace('TILT=NONE', 'TILT=INCLUDE\n1\n2\n0 90\n1 0.9')
      .replace(/\n1 1 20\r?\n/, '\n0.9 1 20\n');
    const { warnings, text: out } = convertPhotometricText(text, 'x.ies');
    const byCode = Object.fromEntries(warnings.map((w) => [w.code, w.message]));
    expect(byCode.keywordsDropped).toContain('[DISTRIBUTION], [BALLAST]');
    expect(byCode.tiltDropped).toBeDefined();
    expect(byCode.ballastFactorApplied).toContain('0.9');
    // The ballast factor is folded into the intensities rather than lost.
    expect(parsePhotometricText(out, 'x.ldt').stats.flux).toBeCloseTo(parsePhotometricText(text, 'x.ies').stats.flux, 0);
  });

  it('refuses Type A/B photometry', () => {
    expect(() => convertPhotometricText(ies.replace(/\n1 2500 1 73 7 1 2/, '\n1 2500 1 73 7 2 2'), 'b.ies')).toThrow(/Type C/);
  });

  it('refuses converting to the same format', () => {
    expect(() => convertPhotometricText(ies, 'x.ies', 'ies')).toThrow(/already IES/);
  });
});

describe('LDT to IES', () => {
  it('maps the LDT fields to keywords', () => {
    const { text, warnings } = convertPhotometricText(syntheticLdt({ isym: 0, stored: C_ANGLES }), 'lamp.ldt');
    const ies = readIes(text);
    expect(ies.version).toBe('IESNA:LM-63-2002');
    expect(iesKeyword(ies, 'TEST')).toBe('REPORT-1');
    expect(iesKeyword(ies, 'ISSUEDATE')).toBe('2026-01-01');
    expect(iesKeyword(ies, 'TESTLAB')).toBe('tester');
    expect(iesKeyword(ies, 'MANUFAC')).toBe('ACME Lighting');
    expect(iesKeyword(ies, '_COLOR')).toBe('4000K');
    expect(iesKeyword(ies, '_CRI')).toBe('80');
    expect([ies.lampCount, ies.lumensPerLamp, ies.inputWatts]).toEqual([1, 2000, 25.5]);
    expect([ies.length, ies.width]).toEqual([1.1, 0.25]);
    // A full distribution gets a closing 360° plane.
    expect(ies.horizontalAngles.at(-1)).toBe(360);
    expect(warnings.map((w) => w.code)).toEqual(['luminaireDimensions']);
  });

  it('maps lamp color and CRI back into the LDT lamp set', () => {
    const ldt = syntheticLdt({ isym: 1, stored: [0] });
    const back = readLdt(convertPhotometricText(convertPhotometricText(ldt, 'a.ldt').text, 'a.ies').text);
    expect(back.lampSets[0]).toMatchObject({ color: '4000K', cri: '80', type: 'LED' });
  });

  it('writes the C90-C270 half the IES way and keeps the distribution', () => {
    const name = 'asymmetric-wall-washer.ldt';
    const iesText = convertPhotometricText(readSample(name), name).text;
    const ies = readIes(iesText);
    expect(ies.horizontalAngles[0]).toBe(90);
    expect(ies.horizontalAngles.at(-1)).toBe(270);
    expect(readLdt(convertPhotometricText(iesText, 'w.ies').text).symmetry).toBe(3);
  });

  it('warns about LDT fields without an IES field', () => {
    const text = syntheticLdt({
      isym: 0,
      stored: C_ANGLES,
      lines: (lines) => {
        lines[24] = '15'; // measurement tilt
        lines[17] = '40'; // luminous height C0 differs from the others
        lines[32] = '0.5'; // first direct ratio
      },
    });
    const codes = convertPhotometricText(text, 'x.ldt').warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['tiltDropped', 'directRatiosDropped', 'luminousHeights', 'luminaireDimensions']));
  });
});

