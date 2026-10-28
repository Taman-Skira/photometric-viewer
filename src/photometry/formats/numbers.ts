/** Shortest plain decimal for `value` with at most `maxDecimals` decimals (no exponent, no `-0`). */
export function formatNumber(value: number, maxDecimals = 4): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(maxDecimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

/** Space separated values, at most `perLine` per line, so writers stay well below line length limits. */
export function wrapValues(values: number[], perLine = 10, maxDecimals = 4): string[] {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perLine) {
    lines.push(values.slice(i, i + perLine).map((v) => formatNumber(v, maxDecimals)).join(' '));
  }
  return lines;
}

/** Common step of ascending `values` if they are equally spaced, otherwise 0. */
export function uniformStep(values: number[]): number {
  if (values.length < 2) return 0;
  const step = values[1] - values[0];
  for (let i = 2; i < values.length; i++) {
    if (Math.abs(values[i] - values[i - 1] - step) > 1e-6) return 0;
  }
  return step;
}
