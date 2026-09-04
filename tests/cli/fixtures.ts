import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
} from '@ctxalloc/adapters';
import { runCli, type CliIo } from '@ctxalloc/cli';

/**
 * Shared fixtures for the CLI suite (DEC-042).
 *
 * Every fixture here builds a **real** workspace on disk: a temporary directory
 * holding real source files, a real JSON config, and a real SQLite database the
 * commands create for themselves. Nothing is stubbed, because the thing under
 * test is the composition — a CLI whose stores were doubles would prove only
 * that the doubles work.
 */

export const SCOPE = { tenantId: 'local', workspaceId: 'cli' };
export const OTHER_SCOPE = { tenantId: 'local', workspaceId: 'elsewhere' };
export const PROJECT_SCOPE = { tenantId: 'local', workspaceId: 'cli', projectId: 'alpha' };
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

export const HANDBOOK = `# Budget handbook

The compiler receives candidate context blocks and selects a minimal sufficient
subset under a strict token budget.

## Reticulator

The quantum reticulator calibrates the allocator before every compilation run.

## Rendering

The renderer serializes every selected block as exactly one JSON line.
`;

export const DISTRACTORS = `The gardener repotted the fern on a rainy afternoon.

Ferry timetables change without warning in October.

Sourdough needs a long cold proof in the refrigerator overnight.
`;

/** One temporary CLI workspace: a source root, a config file, and input files. */
export interface Workspace {
  readonly root: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly sourceRoot: string;
  /** Writes one JSON input file and returns its path. */
  readonly write: (name: string, value: unknown) => string;
  readonly dispose: () => void;
}

/** The five-slice compilation policy the CLI fixtures compile under. */
export function policy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'cli-local',
    policyVersion: '1.0.0',
    scoring: {
      schemaVersion: 1,
      policyId: 'scoring',
      policyVersion: '1.0.0',
      authoredPriority: { weight: 1, min: 0, max: 1000 },
      retrieval: {
        weight: 1,
        aggregation: 'max',
        rules: [
          {
            ruleId: 'minisearch-bm25plus',
            providerId: MINISEARCH_CANDIDATE_PROVIDER_ID,
            providerVersion: MINISEARCH_CANDIDATE_PROVIDER_VERSION,
            semantics: MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
            higherIsBetter: true,
            min: 0,
            max: 1000,
          },
        ],
      },
    },
    filtering: {
      schemaVersion: 1,
      policyId: 'filtering',
      policyVersion: '1.0.0',
      minimumTotalScore: 0,
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'allocation',
      policyVersion: '1.0.0',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'ordering',
      policyVersion: '1.0.0',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'rendering',
      policyVersion: '1.0.0',
      format: 'jsonl-blocks',
    },
  };
}

/** The CLI configuration, with deliberately **relative** paths. */
export function cliConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    // Relative on purpose: the resolution rule is that these are relative to the
    // config file's own directory, never to `process.cwd()`.
    databasePath: './ctxalloc.sqlite',
    sourceRoot: './vault',
    maxSourceBytes: 1_000_000,
    candidateProvider: { schemaVersion: 1, maxCandidates: 8 },
    localCompile: {
      schemaVersion: 1,
      compiler: {
        schemaVersion: 1,
        compilerId: 'ctxalloc-local',
        compilerVersion: '1.0.0',
        maxCorrectionSelections: 64,
      },
      markdownChunking: { targetTokens: 40, maxTokens: 80 },
      textChunking: { targetTokens: 40, maxTokens: 80 },
    },
    ...overrides,
  };
}

/** One local compilation request. */
export function compilationRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'cli-request-1',
    scope: { ...SCOPE },
    query: 'reticulator calibrates the allocator',
    referenceTime: REFERENCE_TIME,
    budget: { totalTokens: 4000, reservedOutputTokens: 500 },
    policy: policy(),
    ...overrides,
  };
}

/** One source registration. */
export function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    scope: { ...SCOPE },
    sourceType: 'markdown',
    identity: { namespace: 'vault:docs', key: 'handbook.md' },
    locator: 'handbook.md',
    title: 'Budget handbook',
    metadata: {},
    ...overrides,
  };
}

/** The logical key of one registration. */
export function registrationKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    scope: { ...SCOPE },
    sourceType: 'markdown',
    identity: { namespace: 'vault:docs', key: 'handbook.md' },
    ...overrides,
  };
}

/**
 * Creates one temporary workspace.
 *
 * The config file sits at the workspace root and its paths are relative, so a
 * command that resolved them against `process.cwd()` would look for a vault
 * inside the repository and fail visibly.
 */
export function createWorkspace(config: Record<string, unknown> = cliConfig()): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'ctxalloc-cli-'));
  const sourceRoot = join(root, 'vault');
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, 'handbook.md'), HANDBOOK, 'utf8');
  writeFileSync(join(sourceRoot, 'distractors.txt'), DISTRACTORS, 'utf8');

  const configPath = join(root, 'ctxalloc.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return {
    root,
    configPath,
    databasePath: join(root, 'ctxalloc.sqlite'),
    sourceRoot,
    write: (name, value) => {
      const path = join(root, name);
      writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
      return path;
    },
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** What one in-process CLI invocation produced. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI in-process, capturing both streams separately. */
export async function cli(...argv: readonly string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}

/** The parsed stdout of a run that must have succeeded. */
export function successOf(run: CliRun): unknown {
  if (run.exitCode !== 0) {
    throw new Error(`expected success, got exit ${String(run.exitCode)}: ${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

/** The parsed stderr envelope of a run that must have failed. */
export function failureOf(run: CliRun): {
  readonly schemaVersion: number;
  readonly code: string;
  readonly stage: string;
  readonly issues: readonly { code: string; pointer: string; message: string }[];
} {
  if (run.exitCode === 0) {
    throw new Error(`expected failure, got success: ${run.stdout}`);
  }
  return JSON.parse(run.stderr) as {
    schemaVersion: number;
    code: string;
    stage: string;
    issues: { code: string; pointer: string; message: string }[];
  };
}
