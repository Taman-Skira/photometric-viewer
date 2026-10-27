import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import {
  convertPhotometricText,
  decodePhotometricBytes,
  detectFormat,
  formatFromFileName,
  replaceExtension,
} from '../src/photometry';

export const USAGE = `Usage: photometric-viewer convert <input> [output] [options]

Converts an IES file to EULUMDAT (LDT) or an LDT file to IES. The formats
follow the file extensions (.ies, .ldt). Without an output, the input name is
used with the other extension.

Options:
  -f, --force    overwrite the output file if it exists
  -q, --quiet    do not print conversion warnings
  -h, --help     show this help
  -v, --version  show the version`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Runs the CLI and returns the exit code: 0 success, 1 conversion error, 2 usage error. */
export function run(argv: string[], io: Io = defaultIo): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        force: { type: 'boolean', short: 'f' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    io.err(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(version);
    return 0;
  }
  const [command, input, output, ...rest] = positionals;
  if (values.help || command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (command !== 'convert' || !input || rest.length) {
    io.err(command && command !== 'convert' ? `error: unknown command "${command}"\n\n${USAGE}` : USAGE);
    return 2;
  }

  let text: string;
  try {
    text = decodePhotometricBytes(readFileSync(input));
  } catch (e) {
    io.err(`error: cannot read ${input}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    return 1;
  }

  const source = detectFormat(text, input);
  const outputPath = output ?? join(dirname(input), replaceExtension(basename(input), source === 'ies' ? 'ldt' : 'ies'));
  const target = formatFromFileName(outputPath);
  if (!target) {
    io.err(`error: cannot tell the output format from "${outputPath}"; use a .ies or .ldt extension`);
    return 2;
  }
  if (target === source) {
    io.err(`error: ${input} is already ${source.toUpperCase()}; give an output file with the other extension`);
    return 2;
  }
  if (resolve(outputPath) === resolve(input)) {
    io.err('error: the output file is the input file');
    return 2;
  }

  try {
    const result = convertPhotometricText(text, input, target, basename(outputPath));
    writeFileSync(outputPath, result.text, { flag: values.force ? 'w' : 'wx' });
    if (!values.quiet) for (const w of result.warnings) io.err(`warning: ${w.message}`);
    io.out(`Wrote ${outputPath}`);
    return 0;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') io.err(`error: ${outputPath} already exists; use --force to overwrite it`);
    else io.err(`error: ${err.code ? `cannot write ${outputPath}: ${err.code}` : err.message}`);
    return 1;
  }
}
