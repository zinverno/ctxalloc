import type { Scope } from '@ctxalloc/domain';
import type { SourceRegistration } from '@ctxalloc/ports';

/**
 * Shared fixtures for the local source-to-compilation slice (DEC-039).
 *
 * The compilation policy is a real five-slice policy the compiler validates
 * itself; nothing here reimplements a compiler rule. Scoring normalizes authored
 * priority over `[0, 1000]` with weight `1`, and the filtering threshold is zero,
 * so an ordinary corpus block is eligible without any authored attribute.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network.
 */

export const SCOPE: Scope = { tenantId: 'local', workspaceId: 'default' };
export const OTHER_SCOPE: Scope = { tenantId: 'local', workspaceId: 'other' };

/** The explicit instant every local compilation measures recency against. */
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

export function compilationPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'local-slice',
    policyVersion: '1.0.0',
    scoring: {
      schemaVersion: 1,
      policyId: 'scoring',
      policyVersion: '1.0.0',
      authoredPriority: { weight: 1, min: 0, max: 1000 },
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

export function serviceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    compiler: {
      schemaVersion: 1,
      compilerId: 'ctxalloc-local',
      compilerVersion: '1.0.0',
      maxCorrectionSelections: 64,
    },
    markdownChunking: { targetTokens: 40, maxTokens: 80 },
    textChunking: { targetTokens: 40, maxTokens: 80 },
    ...overrides,
  };
}

export function localRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'request-1',
    scope: { ...SCOPE },
    query: 'What is the token budget?',
    referenceTime: REFERENCE_TIME,
    budget: { totalTokens: 4000, reservedOutputTokens: 500 },
    policy: compilationPolicy(),
    ...overrides,
  };
}

export function registration(overrides: Partial<SourceRegistration> = {}): SourceRegistration {
  return {
    schemaVersion: 1,
    scope: SCOPE,
    sourceType: 'markdown',
    identity: { namespace: 'vault:notes', key: 'a.md' },
    locator: 'a.md',
    metadata: {},
    ...overrides,
  } as SourceRegistration;
}

/** Every ordering of `items`, enumerated rather than shuffled (INV-DET-002). */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const permutation of permutations(rest)) result.push([item, ...permutation]);
  });
  return result;
}

export const MARKDOWN_SOURCE = '# Budgets\n\nThe available input budget is four thousand tokens.\n';
export const TEXT_SOURCE = 'A plain note about traces.\n\nA second paragraph about scope.\n';

export const CONVERSATION_SOURCE = JSON.stringify(
  {
    schemaVersion: 1,
    messages: [
      { id: 'm1', content: 'What is the token budget?' },
      { id: 'm2', content: 'Four thousand tokens minus the reserve.' },
    ],
  },
  null,
  2,
);
