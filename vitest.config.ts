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

/**
 * `apps/cli` is an application, not a reusable package, so nothing in
 * `packages/` may import it. The alias exists for the CLI's own tests, which
 * drive `runCli` in-process rather than spawning the built executable — the
 * suite runs before `pnpm build`, so a test that required `dist` could not run
 * at all (DEC-042).
 */
const cliEntry = fileURLToPath(new URL('./apps/cli/src/index.ts', import.meta.url));

/**
 * The retrieval library is a dependency of `@ctxalloc/adapters`, not of the
 * workspace root, so Node resolution from `tests/` cannot find it. The alias lets
 * an adapter test build a control index and observe the exact scores the library
 * produces, and — because the alias resolves to the *same* module instance the
 * adapter loads — lets one test replace `search` to exercise the malformed-result
 * branches the real library cannot produce.
 *
 * It grants tests no architectural licence: `pnpm check:boundaries` and the
 * retrieval boundary suite still forbid every package source outside
 * `@ctxalloc/adapters` from naming it.
 */
const retrievalLibraryEntry = fileURLToPath(
  new URL('./packages/adapters/node_modules/minisearch/dist/es/index.js', import.meta.url),
);

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
      '@ctxalloc/adapters': packageEntry('adapters'),
      '@ctxalloc/cli': cliEntry,
      '@ctxalloc/application': packageEntry('application'),
      '@ctxalloc/compiler': packageEntry('compiler'),
      '@ctxalloc/domain': packageEntry('domain'),
      '@ctxalloc/evaluation': packageEntry('evaluation'),
      '@ctxalloc/ports': packageEntry('ports'),
      '@ctxalloc/testing': packageEntry('testing'),
      '@ctxalloc/tokenization': packageEntry('tokenization'),
      minisearch: retrievalLibraryEntry,
    },
  },
});
