import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests import workspace packages through their public entry point
 * (`@ctxalloc/<package>`) rather than an internal file path, so a broken public
 * export surface fails the suite. The aliases resolve those specifiers to package
 * sources, which keeps `pnpm test` runnable without a prior build.
 */
const packageEntry = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@ctxalloc/ports': packageEntry('ports'),
      '@ctxalloc/testing': packageEntry('testing'),
    },
  },
});
