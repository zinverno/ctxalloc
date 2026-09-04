import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The architectural boundaries local persistence and the CLI must not blur
 * (DEC-042).
 *
 * Three directions matter.
 *
 * **SQLite stays in the adapters.** No domain, compiler, application, or
 * evaluation source may name a database client, and no port may expose a driver
 * type (INV-DEP-001, INV-ADAPTER-001).
 *
 * **The compiler and the ports must not form a cycle.** `@ctxalloc/compiler`
 * already depends inward on `@ctxalloc/ports`, so a port that named a compiler
 * type would close the loop. That constraint is exactly why `TraceStore` speaks
 * in JSON envelopes (INV-DEP-003).
 *
 * **`apps/cli` is the outermost layer.** It may depend inward on everything;
 * nothing may depend on it (ARCHITECTURE section 2).
 */

const rootUrl = new URL('../../', import.meta.url);

const SQLITE_NAMES = ['node:sqlite', 'DatabaseSync', 'StatementSync', 'better-sqlite3', 'sqlite3'];

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

/** Declared code only: documentation legitimately names what a layer refuses. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const INNER_PACKAGES = [
  'packages/domain',
  'packages/compiler',
  'packages/application',
  'packages/evaluation',
  'packages/ports',
  'packages/testing',
  'packages/tokenization',
] as const;

describe('INV-DEP-001: SQLite lives only in the adapters', () => {
  it.each(INNER_PACKAGES)('%s names no database client in its sources', (packageDir) => {
    for (const file of sourceFiles(`${packageDir}/src`)) {
      const code = codeOf(readSource(`${packageDir}/src/${file}`));
      for (const name of SQLITE_NAMES) {
        expect(code, `${packageDir}/src/${file} names ${name}`).not.toContain(name);
      }
      expect(code, `${packageDir}/src/${file} names the adapters package`).not.toContain(
        '@ctxalloc/adapters',
      );
    }
  });

  it.each(INNER_PACKAGES)('%s declares no SQLite dependency', (packageDir) => {
    const manifest = readJson<Manifest>(`${packageDir}/package.json`);
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    for (const name of ['better-sqlite3', 'sqlite3', 'node-sqlite3-wasm', 'sql.js']) {
      expect(declared, `${manifest.name} depends on ${name}`).not.toContain(name);
    }
  });

  it('the only SQLite implementation is under packages/adapters', () => {
    const owners = new Set<string>();
    for (const group of ['packages', 'apps']) {
      for (const entry of readdirSync(new URL(`${group}/`, rootUrl))) {
        const directory = `${group}/${entry}/src`;
        let files: string[];
        try {
          files = sourceFiles(directory);
        } catch {
          continue;
        }
        for (const file of files) {
          if (codeOf(readSource(`${directory}/${file}`)).includes('node:sqlite')) {
            owners.add(`${group}/${entry}`);
          }
        }
      }
    }

    expect([...owners]).toEqual(['packages/adapters']);
  });
});

describe('INV-DEP-003: the compiler and the ports do not form a cycle', () => {
  it('no port names a compiler type', () => {
    for (const file of sourceFiles('packages/ports/src')) {
      const source = readSource(`packages/ports/src/${file}`);

      expect(source, `${file} imports the compiler`).not.toContain("from '@ctxalloc/compiler'");
      // Matched on whole identifiers: `StoredCompilationTraceRecord` is the
      // project-owned envelope this package owns, and it merely contains
      // `CompilationTrace` as a substring.
      for (const name of [
        'SettledCompilationTrace',
        'CompilationTrace',
        'UnsettledCompilationTrace',
        'CompilationResult',
        'CompilationPolicy',
        'CompilationRequest',
        'ContextCompiler',
      ]) {
        expect(codeOf(source), `${file} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it('the ports package declares only the domain as an internal dependency', () => {
    const manifest = readJson<Manifest>('packages/ports/package.json');

    expect(manifest.dependencies).toEqual({ '@ctxalloc/domain': 'workspace:*' });
  });

  it('the ports package still exports no runtime value', () => {
    for (const file of sourceFiles('packages/ports/src')) {
      const code = codeOf(readSource(`packages/ports/src/${file}`));

      // A port is a contract, not behaviour: every export is an interface or a
      // type alias, and none of them is a value.
      expect(code, `${file} exports a runtime value`).not.toMatch(
        /export\s+(const|function|class|let|var|enum|default)\b/,
      );
      for (const line of code
        .split('\n')
        .filter((entry) => entry.trimStart().startsWith('export'))) {
        expect(line, `${file}: ${line}`).toMatch(/export\s+(type|interface)\b/);
      }
    }
  });

  it('the trace store port speaks only in project-owned and JSON-safe types', () => {
    const code = codeOf(readSource('packages/ports/src/trace-store.ts'));

    expect(code).toContain('JsonObject');
    expect(code).toContain('Scope');
    for (const name of [...SQLITE_NAMES, 'Buffer', 'node:', 'Row', 'unknown']) {
      expect(code, `names ${name}`).not.toContain(name);
    }
  });

  it('the control-store writer port speaks only in project-owned types', () => {
    const code = codeOf(readSource('packages/ports/src/control-store-writer.ts'));

    expect(code).toContain('SourceRegistration');
    expect(code).toContain('Scope');
    for (const name of [...SQLITE_NAMES, 'Buffer', 'node:', 'close(', 'transaction']) {
      expect(code, `names ${name}`).not.toContain(name);
    }
  });

  it('the read-only control store gained no write method', () => {
    const code = codeOf(readSource('packages/ports/src/control-store.ts'));

    // Writing is a separate capability behind a separate interface, so a
    // consumer that only lists sources is not handed the ability to remove one.
    for (const method of ['registerSource', 'updateSource', 'removeSource', 'deleteSource']) {
      expect(code, `declares ${method}`).not.toContain(method);
    }
  });

  it('neither store port declares a connection lifecycle', () => {
    for (const file of ['control-store.ts', 'control-store-writer.ts', 'trace-store.ts']) {
      const code = codeOf(readSource(`packages/ports/src/${file}`));

      // A local CLI should not have to know a database exists; `close()` lives
      // on the concrete adapter that needs it (DEC-042).
      for (const method of ['close(', 'connect(', 'begin(', 'commit(', 'flush(']) {
        expect(code, `${file} declares ${method}`).not.toContain(method);
      }
    }
  });
});

describe('ARCHITECTURE 2: apps/cli is the outermost composition root', () => {
  it('no package imports the CLI', () => {
    for (const entry of readdirSync(new URL('packages/', rootUrl))) {
      for (const file of sourceFiles(`packages/${entry}/src`)) {
        expect(
          readSource(`packages/${entry}/src/${file}`),
          `packages/${entry}/src/${file} imports the CLI`,
        ).not.toContain('@ctxalloc/cli');
      }
    }
  });

  it('no package or other app declares the CLI as a dependency', () => {
    const allowlist = readJson<Record<string, string[]>>(
      'scripts/internal-dependency-allowlist.json',
    );

    for (const [name, allowed] of Object.entries(allowlist)) {
      if (name === '@ctxalloc/cli') continue;
      expect(allowed, `${name} may depend on the CLI`).not.toContain('@ctxalloc/cli');
    }
  });

  it('the CLI depends inward only, and is allowed to reach every inner layer', () => {
    const manifest = readJson<Manifest>('apps/cli/package.json');
    const internal = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith('@ctxalloc/'),
    );

    expect(internal.sort()).toEqual([
      '@ctxalloc/adapters',
      '@ctxalloc/application',
      '@ctxalloc/compiler',
      '@ctxalloc/domain',
      '@ctxalloc/evaluation',
      '@ctxalloc/ports',
      '@ctxalloc/tokenization',
    ]);
    expect(internal).not.toContain('@ctxalloc/testing');
  });

  it('the CLI names no database client of its own', () => {
    for (const file of sourceFiles('apps/cli/src')) {
      const code = codeOf(readSource(`apps/cli/src/${file}`));

      for (const name of SQLITE_NAMES) {
        expect(code, `apps/cli/src/${file} names ${name}`).not.toContain(name);
      }
    }
  });

  it('publishes an executable and a testable entry point', () => {
    const manifest = readJson<{ bin: Record<string, string>; main: string }>(
      'apps/cli/package.json',
    );

    expect(manifest.bin).toEqual({ ctxalloc: './dist/bin.js' });
    expect(manifest.main).toBe('./dist/index.js');
    // The entry point exports `runCli`, so tests need no subprocess.
    expect(readSource('apps/cli/src/index.ts')).toContain('runCli');
  });
});

describe('Phase 19 scope: what local persistence deliberately does not add', () => {
  it('adds no HTTP framework or server', () => {
    const manifests = ['apps/cli', 'apps/api', ...INNER_PACKAGES, 'packages/adapters'].map((dir) =>
      readJson<Manifest>(`${dir}/package.json`),
    );

    for (const manifest of manifests) {
      const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      for (const name of ['express', 'fastify', 'koa', 'hono', 'h3']) {
        expect(declared, `${manifest.name} depends on ${name}`).not.toContain(name);
      }
    }

    for (const group of ['packages', 'apps']) {
      for (const entry of readdirSync(new URL(`${group}/`, rootUrl))) {
        for (const file of sourceFiles(`${group}/${entry}/src`)) {
          const code = codeOf(readSource(`${group}/${entry}/src/${file}`));
          expect(code, `${group}/${entry}/src/${file} creates a server`).not.toContain(
            'createServer',
          );
          expect(code, `${group}/${entry}/src/${file} imports node:http`).not.toContain(
            'node:http',
          );
        }
      }
    }
  });

  it('adds no ORM or query builder', () => {
    const manifest = readJson<Manifest>('packages/adapters/package.json');
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    for (const name of [
      'prisma',
      '@prisma/client',
      'drizzle-orm',
      'typeorm',
      'sequelize',
      'knex',
      'kysely',
    ]) {
      expect(declared, `depends on ${name}`).not.toContain(name);
    }
    // The built-in driver needs no dependency at all: the manifest gained none.
    expect(declared.sort()).toEqual(['@ctxalloc/domain', '@ctxalloc/ports', 'minisearch']);
  });

  it('persists no retrieval index: MiniSearch stays request-local', () => {
    const provider = codeOf(readSource('packages/adapters/src/minisearch-candidate-provider.ts'));

    for (const name of [...SQLITE_NAMES, 'node:fs', 'writeFile', 'persist']) {
      expect(provider, `names ${name}`).not.toContain(name);
    }

    // And no migration creates a table for one.
    const migrations = readSource('packages/adapters/src/sqlite-migrations.ts');
    expect(migrations).not.toContain('index_term');
    expect(migrations).not.toContain('retrieval_index');
  });

  it('creates exactly three tables, and none of them holds content', () => {
    const migrations = readSource('packages/adapters/src/sqlite-migrations.ts');
    const created = [...migrations.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?\$\{?(\w+)/g)].map(
      (match) => match[1],
    );

    expect(created).toHaveLength(3);

    const code = codeOf(migrations);
    // No column may hold source content, a block, a candidate, or the compiled
    // context: the original files remain the content authority (INV-STORE-001).
    for (const column of [
      'content',
      'block',
      'candidate',
      'compiled_context',
      'source_text',
      'embedding',
      'vector',
    ]) {
      expect(code, `declares a ${column} column`).not.toContain(`${column} TEXT`);
      expect(code, `declares a ${column} column`).not.toContain(`${column} BLOB`);
    }
  });
});
