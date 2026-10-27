import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, USAGE } from '../cli/convert';
import { readIes, readLdt } from '../src/photometry';
import { SAMPLES_DIR } from './helpers';

let dir: string;
let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const cli = (...args: string[]) => run(args, io);
const sample = (name: string) => {
  copyFileSync(join(SAMPLES_DIR, name), join(dir, name));
  return join(dir, name);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pv-cli-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('convert', () => {
  it('converts IES to LDT', () => {
    const input = sample('linear-batwing-pendant.ies');
    const output = join(dir, 'pendant.ldt');
    expect(cli('convert', input, output)).toBe(0);
    expect(out).toEqual([`Wrote ${output}`]);
    const ldt = readLdt(readFileSync(output, 'utf8'));
    expect(ldt.luminaireNumber).toBe('TS-LIN-BW');
    expect(ldt.fileName).toBe('pendant.ldt');
  });

  it('converts LDT to IES and prints warnings to stderr', () => {
    const input = sample('asymmetric-wall-washer.ldt');
    const output = join(dir, 'washer.ies');
    expect(cli('convert', input, output)).toBe(0);
    expect(readIes(readFileSync(output, 'utf8')).horizontalAngles.at(-1)).toBe(270);
    expect(err.some((l) => l.startsWith('warning: IES has no field for the direct ratios'))).toBe(true);
  });

  it('derives the output name from the input when it is omitted', () => {
    const input = sample('wide-downlight.ldt');
    expect(cli('convert', input)).toBe(0);
    expect(existsSync(join(dir, 'wide-downlight.ies'))).toBe(true);
  });

  it('detects the input format from the content when the extension is unknown', () => {
    const input = join(dir, 'spot.txt');
    copyFileSync(join(SAMPLES_DIR, 'narrow-spot-downlight.ies'), input);
    expect(cli('convert', input, join(dir, 'spot.ldt'))).toBe(0);
  });

  it('does not overwrite an existing file without --force', () => {
    const input = sample('narrow-spot-downlight.ies');
    const output = join(dir, 'spot.ldt');
    writeFileSync(output, 'keep');
    expect(cli('convert', input, output)).toBe(1);
    expect(err[0]).toMatch(/already exists; use --force/);
    expect(readFileSync(output, 'utf8')).toBe('keep');
    expect(cli('convert', '--force', input, output)).toBe(0);
    expect(readLdt(readFileSync(output, 'utf8')).symmetry).toBe(1);
  });

  it('suppresses warnings with --quiet', () => {
    expect(cli('convert', '-q', sample('asymmetric-wall-washer.ldt'))).toBe(0);
    expect(err).toEqual([]);
  });

  it('rejects an output in the same format or without a known extension', () => {
    const input = sample('narrow-spot-downlight.ies');
    expect(cli('convert', input, join(dir, 'copy.ies'))).toBe(2);
    expect(err[0]).toMatch(/already IES/);
    expect(cli('convert', input, join(dir, 'spot.csv'))).toBe(2);
    expect(err[1]).toMatch(/\.ies or \.ldt/);
  });

  it('reports unreadable and invalid input files', () => {
    expect(cli('convert', join(dir, 'missing.ies'))).toBe(1);
    expect(err[0]).toMatch(/cannot read .*ENOENT/);
    const broken = join(dir, 'broken.ies');
    writeFileSync(broken, 'IESNA:LM-63-2002\n[TEST] x\n');
    expect(cli('convert', broken)).toBe(1);
    expect(err[1]).toMatch(/missing TILT/);
  });
});

describe('usage', () => {
  it('prints help and version', () => {
    expect(cli('--help')).toBe(0);
    expect(cli('--version')).toBe(0);
    expect(out).toEqual([USAGE, expect.stringMatching(/^\d+\.\d+\.\d+$/)]);
  });

  it('fails with usage for missing or unknown commands and options', () => {
    expect(cli()).toBe(2);
    expect(cli('render', 'a.ies')).toBe(2);
    expect(err[1]).toMatch(/unknown command "render"/);
    expect(cli('convert', 'a.ies', '--nope')).toBe(2);
    expect(cli('convert', 'a.ies', 'b.ldt', 'c.ldt')).toBe(2);
  });
});
