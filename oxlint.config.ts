import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['eslint', 'typescript', 'react', 'oxc'],
  env: { browser: true },
  ignorePatterns: ['dist', 'dist-cli'],
  rules: {
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'error',
    'react/only-export-components': ['warn', { allowConstantExport: true }],
    // The WebGL context and the first sample are set up in effects on purpose.
    'react/set-state-in-effect': 'off',
  },
});
