import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Architectural boundaries the first real retrieval provider must not blur
 * (DEC-041).
 *
 * Retrieval sits **before** the compiler and outside it. The kernel must stay
 * unable to see a retrieval library, a provider identity, or an index, so a
 * compilation remains a pure function of the candidates it is handed
 * (INV-DEP-002, INV-ADAPTER-001).
 *
 * The second direction matters just as much: the adapter must not be able to see
 * the kernel, or it could make a selection decision, which is exactly what the
 * seam exists to prevent (INV-ALLOC-002, INV-DEP-003).
 */

const rootUrl = new URL('../../', import.meta.url);

const RETRIEVAL_LIBRARY = 'minisearch';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readSource(relativePath)) as T;
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

function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INV-DEP-002: the retrieval library stays out of the kernel', () => {
  it.each(['packages/compiler/src', 'packages/domain/src'])(
    'is never imported by %s',
    (directory) => {
      for (const file of sourceFiles(directory)) {
        const code = codeOf(readSource(`${directory}/${file}`));
        expect(code, `${directory}/${file} names ${RETRIEVAL_LIBRARY}`).not.toContain(
          RETRIEVAL_LIBRARY,
        );
        expect(code, `${directory}/${file} names the adapters package`).not.toContain(
          '@ctxalloc/adapters',
        );
      }
    },
  );

  it.each(['packages/compiler', 'packages/domain', 'packages/ports', 'packages/application'])(
    'is not a declared dependency of %s',
    (packageDir) => {
      const manifest = readJson<{ dependencies?: Record<string, string> }>(
        `${packageDir}/package.json`,
      );
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(RETRIEVAL_LIBRARY);
    },
  );

  it('is not a declared dependency of the evaluation package', () => {
    const manifest = readJson<{ dependencies?: Record<string, string> }>(
      'packages/evaluation/package.json',
    );
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(RETRIEVAL_LIBRARY);
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@ctxalloc/adapters');
  });

  it('does not reach the ports, application, or evaluation sources', () => {
    for (const directory of [
      'packages/ports/src',
      'packages/application/src',
      'packages/evaluation/src',
    ]) {
      for (const file of sourceFiles(directory)) {
        const code = codeOf(readSource(`${directory}/${file}`));
        expect(code, `${directory}/${file} names ${RETRIEVAL_LIBRARY}`).not.toContain(
          RETRIEVAL_LIBRARY,
        );
      }
    }
  });

  it('leaves the CandidateProvider port unchanged in shape', () => {
    // Phase 18 implemented the port; it did not renegotiate it. A provider that
    // needed a wider contract would be a provider taking on responsibilities the
    // compiler owns.
    const port = readSource('packages/ports/src/candidate-provider.ts');
    expect(port).toContain('interface CandidateProviderRequest');
    expect(port).toContain('readonly scope: Scope;');
    expect(port).toContain('readonly query: string;');
    expect(port).toContain('readonly referenceTime: Timestamp;');
    expect(port).toContain('readonly sourceDocuments: readonly SourceDocument[];');
    expect(port).toContain('readonly blocks: readonly ContextBlock[];');
    expect(port).toContain(
      'getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]>;',
    );
    expect(port).not.toContain(RETRIEVAL_LIBRARY);
    expect(port).not.toContain('maxCandidates');
  });
});

describe('INV-DEP-001: the adapter stays below the kernel', () => {
  it('depends on ports, domain, and the one retrieval library', () => {
    const manifest = readJson<{ dependencies: Record<string, string> }>(
      'packages/adapters/package.json',
    );
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@ctxalloc/domain',
      '@ctxalloc/ports',
      RETRIEVAL_LIBRARY,
    ]);
  });

  it('is allowlisted for exactly domain and ports', () => {
    const allowlist = readJson<Record<string, string[]>>(
      'scripts/internal-dependency-allowlist.json',
    );
    expect(allowlist['@ctxalloc/adapters']).toEqual(['@ctxalloc/domain', '@ctxalloc/ports']);
  });

  it('names neither the compiler nor a compilation type', () => {
    const code = codeOf(readSource('packages/adapters/src/minisearch-candidate-provider.ts'));
    for (const forbidden of [
      '@ctxalloc/compiler',
      '@ctxalloc/application',
      '@ctxalloc/evaluation',
      'CompilationRequest',
      'CompilationPolicy',
      'ScoringPolicy',
      'TokenBudget',
      'ScoredCandidate',
      'BudgetAllocator',
    ]) {
      expect(code, `the adapter names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('keeps the corrected Phase 9 contract a documentation change only', () => {
    // Phase 18 corrected what `RetrievalNormalizationRule.min`/`max` assert. It
    // must not have changed how they are validated or applied: the schema still
    // requires a finite ordered pair, the linear map is unchanged, and the issue
    // code is the one that already existed (DEC-041).
    const scorer = readSource('packages/compiler/src/candidate-scorer.ts');
    expect(scorer).toContain('normalization window');
    expect(scorer).not.toContain("the inclusive bounds of the provider's documented range");
    expect(scorer).toContain("'retrieval_score_out_of_range'");
    expect(scorer).toContain('.refine((rule) => rule.min < rule.max');

    // The linear map itself, unchanged.
    expect(scorer).toContain(
      'return higherIsBetter ? (rawValue - min) / span : (max - rawValue) / span;',
    );
    // The out-of-window branch still records an issue and moves on. It must never
    // substitute a clamped value for the one the policy declined to interpret.
    expect(scorer).toContain('if (entry.rawValue < rule.min || entry.rawValue > rule.max)');
    expect(codeOf(scorer)).not.toContain('clamp');
  });

  it('reads no token budget and makes no allocation decision', () => {
    // `maxCandidates` bounds how many wrappers are proposed. It is not a budget,
    // and the provider must never inspect one to decide what to return.
    const code = codeOf(readSource('packages/adapters/src/minisearch-candidate-provider.ts'));
    for (const forbidden of [
      'tokenCount',
      'availableTokens',
      'totalTokens',
      'reservedOutputTokens',
      'required',
      'priority',
      'category',
    ]) {
      expect(code, `the adapter reads ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('retrieval remains request-local and unpersisted', () => {
  it('the retrieval library never reaches an application entry point', () => {
    // `apps/cli` composes the provider inside its `compile` command (DEC-042),
    // and that is the only place: neither entry point may name the library, and
    // `apps/api` composes nothing at all until the HTTP phase.
    for (const entry of ['apps/cli/src/index.ts', 'apps/api/src/index.ts']) {
      const source = readSource(entry);
      expect(source).not.toContain(RETRIEVAL_LIBRARY);
      expect(source).not.toContain('MiniSearchCandidateProvider');
    }
    expect(readSource('apps/api/src/index.ts').trim()).toBe('export {};');
  });

  it('ships no persistent retrieval index', () => {
    // `SQLiteControlStore` and `SQLiteTraceStore` arrived in Phase 19 and are
    // deliberately **not** on this list: they are the local control and audit
    // store (DEC-042). A persisted retrieval index is a different thing
    // entirely, and it remains future work — the index MiniSearch builds is an
    // in-memory value that becomes garbage when the call returns
    // (INV-STORE-002).
    for (const forbidden of [
      'PersistentRetrievalIndex',
      'RetrievalIndexStore',
      'IndexStore',
      'saveIndex',
      'loadIndex',
    ]) {
      for (const file of sourceFiles('packages/adapters/src')) {
        expect(
          codeOf(readSource(`packages/adapters/src/${file}`)),
          `packages/adapters/src/${file} declares ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }
    expect(existsSync(new URL('packages/retrieval', rootUrl))).toBe(false);
  });

  it('the retrieval adapter reaches no store, no file, and no watcher', () => {
    const code = codeOf(readSource('packages/adapters/src/minisearch-candidate-provider.ts'));
    for (const forbidden of [
      'watch(',
      'FSWatcher',
      'chokidar',
      'migrate',
      'reindex',
      'node:sqlite',
      'node:fs',
      'ControlStore',
      'TraceStore',
    ]) {
      expect(code, `the adapter declares ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the retrieval dataset is a versioned repository artefact', () => {
  it('lives under benchmarks/, not only inside a test file', () => {
    expect(existsSync(new URL('benchmarks/retrieval/v1/index.ts', rootUrl))).toBe(true);
    expect(existsSync(new URL('benchmarks/retrieval/v1/fixtures.ts', rootUrl))).toBe(true);
  });

  it('depends on no application, adapter, or retrieval-library module', () => {
    // The dataset describes a corpus and its expected outcomes. Importing the
    // provider would make the answer key depend on the thing it measures.
    for (const file of ['index.ts', 'fixtures.ts']) {
      const source = readSource(`benchmarks/retrieval/v1/${file}`);
      for (const forbidden of [
        '@ctxalloc/application',
        '@ctxalloc/adapters',
        RETRIEVAL_LIBRARY,
        'node:fs',
        'Math.random',
        'Date.now',
      ]) {
        expect(source, `benchmarks/retrieval/v1/${file} names ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });
});

describe('the retrieval spike is committed evidence', () => {
  it('records the decision in a document a reader can check', () => {
    const spike = readSource('docs/RETRIEVAL_SPIKE.md');
    expect(spike.trim().length).toBeGreaterThan(0);
    // The matrix the spike is required to carry.
    for (const heading of [
      'Exact block mapping',
      'Hidden state',
      'Offline lexical mode',
      'Deterministic behavior',
      'Score semantics',
      'CI feasibility',
      'Verdict',
    ]) {
      expect(spike, `the spike omits "${heading}"`).toContain(heading);
    }
    // Both inspected candidates are named, with the outcome for each.
    expect(spike).toContain('@tobilu/qmd');
    expect(spike).toContain('minisearch');
  });

  it('records the decision in DECISIONS.md as DEC-041', () => {
    const decisions = readSource('docs/DECISIONS.md');
    expect(decisions).toContain('## DEC-041');
    expect(decisions).toContain('minisearch');
  });
});
