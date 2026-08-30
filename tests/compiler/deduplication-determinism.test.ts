import { readFileSync } from 'node:fs';
import { CandidateDeduplicator, type DeduplicatedCandidateSet } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  countingTokenizer,
  permutations,
  sourceDocument,
  validate,
} from './deduplication-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);
const deduplicator = new CandidateDeduplicator();

const SHARED = 'the deployment window\ncloses at noon';
/** The same canonical content, written with CRLF line endings. */
const SHARED_CRLF = 'the deployment window\r\ncloses at noon';
const OTHER = 'the rollback plan is documented';

const DOCUMENTS = [sourceDocument({ id: 'doc-2' }), sourceDocument({ id: 'doc-1' })];

/**
 * One fixture exercising every grouping and selection path at once: repeated
 * wrappers of a single ID, distinct IDs sharing exact content, differing
 * retrieval evidence, required and optional blocks, and two source documents.
 */
const CANDIDATES = [
  candidate(
    { id: 'block-a', sourceDocumentId: 'doc-1', content: SHARED },
    { providerId: 'fts', providerVersion: '1', rank: 3 },
  ),
  candidate(
    { id: 'block-a', sourceDocumentId: 'doc-1', content: SHARED },
    { providerId: 'vec', providerVersion: '2', rank: 0 },
  ),
  candidate({
    id: 'block-z',
    sourceDocumentId: 'doc-2',
    content: SHARED,
    attributes: { required: true },
  }),
  candidate({
    id: 'block-m',
    sourceDocumentId: 'doc-2',
    content: SHARED_CRLF,
    attributes: { required: true },
  }),
  candidate({ id: 'block-b', sourceDocumentId: 'doc-1', content: OTHER }),
  candidate({
    id: 'block-c',
    sourceDocumentId: 'doc-2',
    content: OTHER,
    attributes: { required: false },
  }),
] as const;

function deduplicate(candidates: readonly Record<string, unknown>[]): DeduplicatedCandidateSet {
  return deduplicator.deduplicate(
    validate({ sourceDocuments: DOCUMENTS, candidates: [...candidates] }),
  );
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INV-ALLOC-005: the result is stable under every candidate input order', () => {
  const orders = permutations([...CANDIDATES]);
  const expected = deduplicate(CANDIDATES);

  it('enumerates every permutation of the fixture', () => {
    expect(orders).toHaveLength(720);
    expect(new Set(orders.map((order) => JSON.stringify(order))).size).toBe(720);
  });

  it('produces a deep-equal deduplicated set for every permutation', () => {
    for (const order of orders) {
      expect(deduplicate(order)).toEqual(expected);
    }
  });

  it('selects the same canonical blocks, reasons, and match reasons every time', () => {
    for (const order of orders) {
      const actual = deduplicate(order);
      expect(actual.candidates.map((group) => group.canonicalBlock.id)).toEqual(
        expected.candidates.map((group) => group.canonicalBlock.id),
      );
      expect(actual.candidates.map((group) => group.canonicalSelectionReason)).toEqual(
        expected.candidates.map((group) => group.canonicalSelectionReason),
      );
      expect(
        actual.candidates.map((group) => group.members.map((member) => member.matchReason)),
      ).toEqual(
        expected.candidates.map((group) => group.members.map((member) => member.matchReason)),
      );
      expect(
        actual.candidates.map((group) => group.members.map((member) => member.candidate.block.id)),
      ).toEqual(
        expected.candidates.map((group) =>
          group.members.map((member) => member.candidate.block.id),
        ),
      );
    }
  });

  it('INV-DET-002: returns the same source registry order for a reversed registry', () => {
    const forward = deduplicator.deduplicate(
      validate({ sourceDocuments: DOCUMENTS, candidates: [...CANDIDATES] }),
    );
    const reversed = deduplicator.deduplicate(
      validate({ sourceDocuments: [...DOCUMENTS].reverse(), candidates: [...CANDIDATES] }),
    );

    expect(reversed.sourceDocuments).toEqual(forward.sourceDocuments);
    expect(reversed.sourceDocuments.map((document) => document.id)).toEqual(['doc-1', 'doc-2']);
  });

  it('INV-DET-002: ignores JavaScript property insertion order in metadata and retrieval', () => {
    const straight = deduplicate([
      candidate(
        { id: 'block-a', sourceDocumentId: 'doc-1', content: SHARED, metadata: { a: 1, b: 2 } },
        { providerId: 'p', providerVersion: '1', rank: 1, metadata: { x: 1, y: 2 } },
      ),
      candidate({ id: 'block-b', sourceDocumentId: 'doc-1', content: SHARED }),
    ]);
    const shuffledKeys = deduplicate([
      candidate({ id: 'block-b', sourceDocumentId: 'doc-1', content: SHARED }),
      candidate(
        { id: 'block-a', sourceDocumentId: 'doc-1', content: SHARED, metadata: { b: 2, a: 1 } },
        { metadata: { y: 2, x: 1 }, rank: 1, providerVersion: '1', providerId: 'p' },
      ),
    ]);

    expect(shuffledKeys.candidates.map((group) => group.canonicalBlock.id)).toEqual(
      straight.candidates.map((group) => group.canonicalBlock.id),
    );
    expect(
      shuffledKeys.candidates.map((group) =>
        group.members.map((member) => member.candidate.block.id),
      ),
    ).toEqual(
      straight.candidates.map((group) => group.members.map((member) => member.candidate.block.id)),
    );
    expect(shuffledKeys.candidates[0]?.members[0]?.candidate.retrieval?.metadata).toEqual({
      x: 1,
      y: 2,
    });
  });

  it('INV-DET-001: repeating the same call returns a deep-equal result', () => {
    expect(deduplicate(CANDIDATES)).toEqual(deduplicate(CANDIDATES));
  });
});

describe('INV-DET-003: the deduplicator has no hidden inputs', () => {
  const SOURCES = [
    'packages/compiler/src/candidate-deduplicator.ts',
    'packages/compiler/src/canonical-json.ts',
  ] as const;

  it.each(SOURCES)('%s reads no clock, no randomness, and no environment', (relativePath) => {
    const source = stripComments(readSource(relativePath));
    for (const forbidden of [
      'Date.now',
      'new Date',
      'Math.random',
      'randomUUID',
      'crypto',
      'process.env',
      'hostname',
      'fetch(',
      'localeCompare',
      'readFile',
      'require(',
    ]) {
      expect(source, `${relativePath} uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(SOURCES)('%s imports no infrastructure module', (relativePath) => {
    const specifiers = [...readSource(relativePath).matchAll(/from '(?<specifier>[^']+)'/g)].map(
      (match) => match.groups?.specifier ?? '',
    );
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:'), `${relativePath} imports ${specifier}`).toBe(false);
      expect(
        specifier.startsWith('./') || specifier === '@ctxalloc/domain',
        `${relativePath} imports ${specifier}`,
      ).toBe(true);
    }
  });

  it('needs no injected dependency', () => {
    expect(CandidateDeduplicator.length).toBe(0);
    expect(() => new CandidateDeduplicator()).not.toThrow();
  });

  it('INV-DEP-002: calls no tokenizer', () => {
    const calls: string[] = [];
    const validated = validate(
      { sourceDocuments: DOCUMENTS, candidates: [...CANDIDATES] },
      countingTokenizer(calls),
    );
    const afterValidation = calls.length;
    expect(afterValidation).toBeGreaterThan(0);

    deduplicator.deduplicate(validated);
    expect(calls).toHaveLength(afterValidation);
  });
});

describe('INV-DEDUP-005: grouping compares normalized content, never the hash alone', () => {
  it('uses the validated hash only to choose a bucket', () => {
    const source = stripComments(readSource('packages/compiler/src/candidate-deduplicator.ts'));

    // The group key is the canonical normalized content itself.
    expect(source).toContain('normalizeContextBlockContentForHash(block.content)');
    expect(source).toContain('bucket.get(normalizedContent)');
    expect(source).toContain('bucket.set(normalizedContent, group)');

    // Every use of the validated hash is an outer-bucket lookup, so a
    // hypothetical hash collision could never merge two different texts.
    const hashLines = source.split('\n').filter((line) => line.includes('normalizedContentHash'));
    expect(hashLines.length).toBeGreaterThan(0);
    for (const line of hashLines) {
      expect(line, `hash used outside a bucket lookup: ${line.trim()}`).toContain('buckets.');
    }
  });
});
