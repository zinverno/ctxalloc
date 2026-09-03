import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Architectural boundaries the evaluation phase must not blur (DEC-040).
 *
 * Two directions matter. The compiler must stay model-free and clock-free, so a
 * compilation is still a pure function of its inputs (INV-DET-001, INV-DEP-002).
 * And the evaluation package must stay above the compiler without reaching into
 * the application layer, so a benchmark measures the kernel rather than the
 * pipeline that feeds it (INV-DEP-003).
 */

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

function readManifest(relativeDir: string): Manifest {
  return JSON.parse(
    readFileSync(new URL(`${relativeDir}/package.json`, rootUrl), 'utf8'),
  ) as Manifest;
}

function sourceFiles(relativeDir: string): string[] {
  const base = new URL(`${relativeDir}/`, rootUrl);
  const walk = (directory: URL, prefix: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const child = new URL(`${entry}`, new URL(`${directory.pathname}/`, directory));
      const path = `${prefix}${entry}`;
      return statSync(child).isDirectory()
        ? walk(new URL(`${entry}/`, directory), `${path}/`)
        : entry.endsWith('.ts')
          ? [path]
          : [];
    });
  return walk(base, '');
}

function readSource(relativeDir: string, file: string): string {
  return readFileSync(new URL(`${relativeDir}/${file}`, rootUrl), 'utf8');
}

function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INV-DEP-002: the compiler kernel stays model-free and clock-free', () => {
  it('imports no model provider and no clock port', () => {
    for (const file of sourceFiles('packages/compiler/src')) {
      const code = codeOf(readSource('packages/compiler/src', file));
      for (const forbidden of [
        'ModelProvider',
        'MonotonicClock',
        'AnthropicModelProvider',
        '@ctxalloc/evaluation',
        '@ctxalloc/adapters',
      ]) {
        expect(code, `packages/compiler/src/${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('reads no clock and makes no network call anywhere in the kernel', () => {
    for (const file of sourceFiles('packages/compiler/src')) {
      const code = codeOf(readSource('packages/compiler/src', file));
      for (const forbidden of [
        'Date.now',
        'new Date',
        'performance.now',
        'fetch(',
        'Math.random',
      ]) {
        expect(code, `packages/compiler/src/${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('carries no token-reduction or answer-quality field on its published result', () => {
    // Those are comparisons against a baseline the kernel has never seen
    // (METRICS 8.7, 11.5).
    const code = codeOf(readSource('packages/compiler/src', 'context-compiler.ts'));
    for (const forbidden of [
      'tokenReduction',
      'baselineInputTokens',
      'answerQualityScore',
      'qualityLoss',
    ]) {
      expect(code, `declares ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('INV-DEP-003: the evaluation package sits above the compiler only', () => {
  it('depends on domain, ports, and compiler, and not on the application layer', () => {
    const manifest = readManifest('packages/evaluation');
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/compiler': 'workspace:*',
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
      zod: expect.stringContaining('4') as unknown as string,
    });
  });

  it('is allowlisted for exactly those three internal packages', () => {
    const allowlist = JSON.parse(
      readFileSync(new URL('scripts/internal-dependency-allowlist.json', rootUrl), 'utf8'),
    ) as Record<string, string[]>;
    expect(allowlist['@ctxalloc/evaluation']).toEqual([
      '@ctxalloc/domain',
      '@ctxalloc/ports',
      '@ctxalloc/compiler',
    ]);
  });

  it('imports no application, adapter, or tokenizer-library module', () => {
    for (const file of sourceFiles('packages/evaluation/src')) {
      const source = readSource('packages/evaluation/src', file);
      for (const specifier of [...source.matchAll(/from '(?<name>[^']+)'/g)].map(
        (match) => match.groups?.name ?? '',
      )) {
        expect(
          specifier.startsWith('./') ||
            specifier === 'zod' ||
            specifier === 'node:crypto' ||
            ['@ctxalloc/domain', '@ctxalloc/ports', '@ctxalloc/compiler'].includes(specifier),
          `packages/evaluation/src/${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('reads no clock, no random value, no filesystem, and no network', () => {
    // Every duration comes from the injected `MonotonicClock`, and the run date
    // is explicit caller data (INV-DET-003, INV-DET-004).
    for (const file of sourceFiles('packages/evaluation/src')) {
      const code = codeOf(readSource('packages/evaluation/src', file));
      for (const forbidden of [
        'Date.now',
        'new Date',
        'performance.now',
        'Math.random',
        'fetch(',
        'node:fs',
        'process.env',
        'localeCompare',
      ]) {
        expect(code, `packages/evaluation/src/${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('implements no retrieval of its own', () => {
    // A baseline orders candidates by evidence a provider already supplied; it
    // never searches, scores, or embeds anything (INV-DEP-002).
    for (const file of sourceFiles('packages/evaluation/src')) {
      const code = codeOf(readSource('packages/evaluation/src', file));
      for (const forbidden of ['embedding', 'similarity(', 'bm25', 'tfIdf', 'CandidateScorer']) {
        expect(code, `packages/evaluation/src/${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('keeps its mechanics unexported', () => {
    const entry = readSource('packages/evaluation/src', 'index.ts');
    for (const internal of [
      'canonicalJson',
      'compareCodeUnits',
      'domainSeparatedHash',
      'summarize',
      'hashReport',
      'renderBaselineContext',
      'buildFullContextBaseline',
      'buildTruncationBaseline',
      'buildTopKBaseline',
    ]) {
      expect(entry, `exports ${internal}`).not.toContain(internal);
    }
  });
});

describe('INV-DEP-001: adapters stay below the kernel', () => {
  it('depends on ports alone', () => {
    expect(readManifest('packages/adapters').dependencies).toEqual({
      '@ctxalloc/ports': 'workspace:*',
    });
  });

  it('names neither the compiler nor the evaluation harness', () => {
    for (const file of sourceFiles('packages/adapters/src')) {
      const code = codeOf(readSource('packages/adapters/src', file));
      for (const forbidden of [
        '@ctxalloc/compiler',
        '@ctxalloc/evaluation',
        'CompilationRequest',
      ]) {
        expect(code, `packages/adapters/src/${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('reads no environment variable in the model adapter', () => {
    // A base URL or a key taken from the environment would let a benchmark be
    // pointed elsewhere without its report saying so (INV-DET-003).
    const code = codeOf(readSource('packages/adapters/src', 'anthropic-model-provider.ts'));
    for (const forbidden of ['process.env', 'ANTHROPIC_API_KEY', 'cwd()', 'readFile']) {
      expect(code, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the benchmark dataset is a versioned repository artefact', () => {
  it('lives under benchmarks/, not only inside a test file', () => {
    expect(existsSync(new URL('benchmarks/evaluation/v1/index.ts', rootUrl))).toBe(true);
    expect(existsSync(new URL('benchmarks/evaluation/v1/fixtures.ts', rootUrl))).toBe(true);
  });

  it('depends on no application or adapter module', () => {
    for (const file of ['index.ts', 'fixtures.ts']) {
      const source = readSource('benchmarks/evaluation/v1', file);
      for (const forbidden of ['@ctxalloc/application', '@ctxalloc/adapters', 'node:fs']) {
        expect(source, `benchmarks/evaluation/v1/${file} names ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });
});
