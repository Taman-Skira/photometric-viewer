import { defineConfig } from 'vite';

/** Bundles the command line converter into a single Node script (`npm run build:cli`). */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'cli/index.ts',
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'photometric-viewer.js',
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
