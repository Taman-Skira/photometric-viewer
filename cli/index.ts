import { run } from './convert';

process.exitCode = run(process.argv.slice(2));
