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
    // Building the real tokenizer's rank table takes about a second per instance,
    // and the contract suite deliberately constructs independent instances. The
    // raised limit keeps those tests from failing on machine speed alone.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@ctxalloc/ports': packageEntry('ports'),
      '@ctxalloc/testing': packageEntry('testing'),
      '@ctxalloc/tokenization': packageEntry('tokenization'),
    },
  },
});
