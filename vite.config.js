import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// ESM + CJS builds, one chunk per public entry point. UMD is built separately (vite.umd.config.js).
export default defineConfig({
  build: {
    target: 'es2020',
    sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.js'),
        ui: resolve(import.meta.dirname, 'src/ui/index.js'),
        payments: resolve(import.meta.dirname, 'src/payments/index.js'),
        'payments-stripe': resolve(import.meta.dirname, 'src/payments/adapters/stripe.js'),
        'payments-paypal': resolve(import.meta.dirname, 'src/payments/adapters/paypal.js'),
        'payments-razorpay': resolve(import.meta.dirname, 'src/payments/adapters/razorpay.js'),
        utils: resolve(import.meta.dirname, 'src/utils/index.js'),
        mock: resolve(import.meta.dirname, 'src/mock/server.js'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, name) => (format === 'es' ? `${name}.js` : `${name}.cjs`),
    },
    rollupOptions: {
      // msw is a dev/test dependency of the host; never bundle it.
      external: ['msw', 'msw/node', 'msw/browser'],
      output: { preserveModules: false },
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    coverage: { provider: 'v8', include: ['src/**/*.js'], exclude: ['src/mock/**', 'src/types.js'] },
    restoreMocks: true,
  },
});
