import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Single-file UMD bundle exposing window.Wayfarer = { ...core, ui, payments, utils }.
export default defineConfig({
  build: {
    target: 'es2020',
    sourcemap: true,
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/umd.js'),
      name: 'Wayfarer',
      formats: ['umd'],
      fileName: () => 'wayfarer.umd.js',
    },
    rollupOptions: { external: ['msw', 'msw/node', 'msw/browser'] },
  },
});
