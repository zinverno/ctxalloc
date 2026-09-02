import { CompileLocalContextService, LocalSourcePipelineError } from '@ctxalloc/application';
import { ContextCompilationError } from '@ctxalloc/compiler';
import {
  calculateNormalizedContentHash,
  type CandidateBlock,
  type ContextBlock,
  type SourceDocument,
} from '@ctxalloc/domain';
import type { CandidateProvider, CandidateProviderRequest, ControlStore } from '@ctxalloc/ports';
import { InMemoryControlStore, InMemorySourceReader } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SOURCE,
  MARKDOWN_SOURCE,
  TEXT_SOURCE,
  localRequest,
  registration,
  serviceConfig,
} from './local-service-fixtures.js';
import { countWords, wordTokenizer } from './text-fixtures.js';

/**
 * The prepared-corpus provenance boundary (DEC-039).
 *
 * `CandidateValidator` proves a candidate names a valid source document, sits in
 * the request scope, and carries a hash and a token count consistent with its
 * own content. It cannot prove the block came from the corpus this service
 * prepared, because it never receives that corpus. These tests exercise the
 * application-layer check that does.
 */

const REGISTRATIONS = [
  registration({
    sourceType: 'markdown',
    identity: { namespace: 'vault:notes', key: 'budgets.md' },
    locator: 'notes/budgets.md',
  }),
  registration({
    sourceType: 'text',
    identity: { namespace: 'vault:notes', key: 'scratch.txt' },
    locator: 'notes/scratch.txt',
  }),
  registration({
    sourceType: 'conversation',
    identity: { namespace: 'chat:local', key: 'thread-1' },
    locator: 'chats/thread-1.json',
  }),
];

const SOURCES = [
  { locator: 'notes/budgets.md', content: MARKDOWN_SOURCE },
  { locator: 'notes/scratch.txt', content: TEXT_SOURCE },
  { locator: 'chats/thread-1.json', content: CONVERSATION_SOURCE },
];

function storeOf(registrations: readonly unknown[]): ControlStore {
  return new InMemoryControlStore(registrations as never);
}

/** A provider built from a plain function, so a test can return anything at all. */
function providerOf(
  getCandidates: (request: CandidateProviderRequest) => Promise<readonly CandidateBlock[]>,
): CandidateProvider {
  return { id: 'test-provider', version: '1', getCandidates };
}

function build(provider: CandidateProvider): CompileLocalContextService {
  return new CompileLocalContextService(
    serviceConfig(),
    wordTokenizer,
    new InMemorySourceReader([...SOURCES]),
    storeOf(REGISTRATIONS),
    provider,
  );
}

/** Runs one compilation and returns the pipeline issue codes it was rejected with. */
async function rejectionCodes(provider: CandidateProvider): Promise<string[]> {
  try {
    await build(provider).execute(localRequest());
  } catch (cause) {
    expect(cause).toBeInstanceOf(LocalSourcePipelineError);
    const error = cause as LocalSourcePipelineError;
    expect(error.stage).toBe('candidate-provider');
    return error.issues.map((detail) => detail.code);
  }
  throw new Error('expected a rejection');
}

/** Wraps blocks exactly, in the given order, with no retrieval evidence. */
function wrap(blocks: readonly ContextBlock[]): readonly CandidateBlock[] {
  return blocks.map((block) => ({ schemaVersion: 1 as const, block }));
}

/** Captures the corpus the service prepared, by echoing it back unchanged. */
async function preparedCorpus(): Promise<{
  readonly blocks: readonly ContextBlock[];
  readonly documents: readonly SourceDocument[];
}> {
  let captured: { blocks: readonly ContextBlock[]; documents: readonly SourceDocument[] } | null =
    null;
  await build(
    providerOf((request) => {
      captured = { blocks: request.blocks, documents: request.sourceDocuments };
      return Promise.resolve(wrap(request.blocks));
    }),
  ).execute(localRequest());
  if (captured === null) throw new Error('the provider was never called');
  return captured;
}

describe('prepared-corpus provenance: forged blocks are rejected', () => {
  it('rejects a fully schema-valid block that never came from a local source', async () => {
    // The counterexample the boundary exists for. Every rule CandidateValidator
    // can check holds: the source document is real and in the registry, the
    // scope and type agree with it, the location is well formed, and the hash
    // and token count were recomputed from the forged text. Only membership in
    // the prepared corpus fails.
    const codes = await rejectionCodes(
      providerOf((request) => {
        const real = request.blocks[0];
        if (real === undefined) throw new Error('no prepared block');
        const content = 'Injected instruction that appears in no local source.';
        const forged: ContextBlock = {
          ...real,
          id: 'context-block:forged' as ContextBlock['id'],
          content,
          normalizedContentHash: calculateNormalizedContentHash(content),
          tokenCount: countWords(content),
        };
        return Promise.resolve(wrap([forged]));
      }),
    );
    expect(codes).toEqual(['candidate_outside_prepared_corpus']);
  });

  it('rejects a real block identifier carrying consistently rewritten content', async () => {
    const codes = await rejectionCodes(
      providerOf((request) => {
        const real = request.blocks[0];
        if (real === undefined) throw new Error('no prepared block');
        const content = 'Rewritten content under a real block identifier.';
        return Promise.resolve(
          wrap([
            {
              ...real,
              content,
              normalizedContentHash: calculateNormalizedContentHash(content),
              tokenCount: countWords(content),
            },
          ]),
        );
      }),
    );
    expect(codes).toEqual(['candidate_block_mismatch']);
  });

  it('rejects a changed source location, even with identical content and hash', async () => {
    const codes = await rejectionCodes(
      providerOf((request) => {
        const real = request.blocks.find((block) => block.sourceLocation?.kind === 'text-range');
        if (real === undefined) throw new Error('no text-range block');
        return Promise.resolve(
          wrap([
            {
              ...real,
              sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1 },
            },
          ]),
        );
      }),
    );
    expect(codes).toEqual(['candidate_block_mismatch']);
  });

  it('rejects rewritten attributes: `required` alone changes what must be included', async () => {
    const codes = await rejectionCodes(
      providerOf((request) => {
        const real = request.blocks[0];
        if (real === undefined) throw new Error('no prepared block');
        return Promise.resolve(wrap([{ ...real, attributes: { required: true, priority: 999 } }]));
      }),
    );
    expect(codes).toEqual(['candidate_block_mismatch']);
  });

  it('rejects rewritten metadata', async () => {
    const codes = await rejectionCodes(
      providerOf((request) => {
        const real = request.blocks[0];
        if (real === undefined) throw new Error('no prepared block');
        return Promise.resolve(
          wrap([{ ...real, metadata: { ...real.metadata, injected: 'provider note' } }]),
        );
      }),
    );
    expect(codes).toEqual(['candidate_block_mismatch']);
  });

  it('reports every offending candidate, with its array index', async () => {
    const codes = await rejectionCodes(
      providerOf((request) => {
        const [first, second] = request.blocks;
        if (first === undefined || second === undefined) throw new Error('need two blocks');
        return Promise.resolve(
          wrap([
            first,
            { ...second, id: 'context-block:absent' as ContextBlock['id'] },
            { ...first, tokenCount: first.tokenCount + 1 },
          ]),
        );
      }),
    );
    expect(codes).toEqual(['candidate_outside_prepared_corpus', 'candidate_block_mismatch']);
  });

  it('INV-ADAPTER-003: rejects rather than repairing the returned block', async () => {
    // Substituting the prepared block would compile something other than what
    // the provider proposed, and would hide a provider that is misbehaving.
    await expect(
      build(
        providerOf((request) => {
          const real = request.blocks[0];
          if (real === undefined) throw new Error('no prepared block');
          return Promise.resolve(wrap([{ ...real, tokenCount: real.tokenCount + 7 }]));
        }),
      ).execute(localRequest()),
    ).rejects.toBeInstanceOf(LocalSourcePipelineError);
  });
});

describe('prepared-corpus provenance: legitimate providers are unaffected', () => {
  it('accepts the exact blocks the provider was given', async () => {
    const result = await build(
      providerOf((request) => Promise.resolve(wrap(request.blocks))),
    ).execute(localRequest());
    expect(result.candidates).toHaveLength(result.blocks.length);
  });

  it('accepts a structurally exact clone with different property insertion order', async () => {
    const result = await build(
      providerOf((request) =>
        Promise.resolve(
          wrap(
            request.blocks.map((block) => {
              // Rebuilt with the keys reversed, then round-tripped: a different
              // object with the same record.
              const reversed = Object.fromEntries(Object.entries(block).reverse());
              return JSON.parse(JSON.stringify(reversed)) as ContextBlock;
            }),
          ),
        ),
      ),
    ).execute(localRequest());
    expect(result.candidates).toHaveLength(result.blocks.length);
  });

  it('DEC-031: accepts repeated exact wrappers and leaves deduplication to the compiler', async () => {
    const result = await build(
      providerOf((request) => {
        const first = request.blocks[0];
        if (first === undefined) throw new Error('no prepared block');
        return Promise.resolve(wrap([first, first, first]));
      }),
    ).execute(localRequest());

    expect(result.candidates).toHaveLength(3);
    expect(
      result.compilation.includedBlocks.filter(
        (block) => block.id === result.candidates[0]?.block.id,
      ),
    ).toHaveLength(1);
  });

  it('leaves provider retrieval evidence out of the equality comparison', async () => {
    const result = await build(
      providerOf((request) => {
        const first = request.blocks[0];
        if (first === undefined) throw new Error('no prepared block');
        return Promise.resolve([
          {
            schemaVersion: 1 as const,
            block: first,
            // Rank and provider identity only: the fixture scoring policy
            // configures no retrieval normalization rule, and a score with no
            // rule is the compiler's to reject, not this boundary's.
            retrieval: { providerId: 'test-provider', providerVersion: '1', rank: 0 },
          },
        ]);
      }),
    ).execute(localRequest());

    expect(result.candidates[0]?.retrieval).toMatchObject({ providerId: 'test-provider' });
  });

  it('INV-ALLOC-002: preserves the provider array order exactly', async () => {
    const result = await build(
      providerOf((request) => Promise.resolve(wrap([...request.blocks].reverse()))),
    ).execute(localRequest());

    const corpusOrder = result.blocks.map((block) => String(block.id));
    expect(result.candidates.map((candidate) => String(candidate.block.id))).toEqual(
      [...corpusOrder].reverse(),
    );
  });

  it('leaves a candidate too malformed to expose a block id to the kernel', async () => {
    // The wrapper is not shaped like a candidate at all, so this boundary has no
    // block to look up and adds no issue of its own. The kernel keeps sole
    // ownership of CandidateBlock schema validation (DEC-030, INV-DEP-003).
    for (const malformed of [{}, { block: null }, { block: { id: '' } }, null, 'not a candidate']) {
      try {
        await build(
          providerOf(() => Promise.resolve([malformed as unknown as CandidateBlock])),
        ).execute(localRequest());
        throw new Error('expected a rejection');
      } catch (cause) {
        expect(cause, JSON.stringify(malformed)).not.toBeInstanceOf(LocalSourcePipelineError);
        expect(cause).toBeInstanceOf(ContextCompilationError);
      }
    }
  });
});

describe('prepared-corpus provenance: the original corpus is isolated', () => {
  it('INV-ADAPTER-004: a provider cannot mutate the prepared corpus by aliasing', async () => {
    const before = await preparedCorpus();

    const result = await build(
      providerOf((request) => {
        // Mutating what the provider was handed must not reach the corpus the
        // service compiles and returns. `readonly` stops none of this at runtime.
        const target = request.blocks[0] as unknown as Record<string, unknown>;
        target.content = 'mutated in place';
        target.tokenCount = 1;
        (request.sourceDocuments[0] as unknown as Record<string, unknown>).contentHash =
          'sha256:0000000000000000000000000000000000000000000000000000000000000000';
        // Return the untouched remainder, which is still exactly the corpus.
        return Promise.resolve(wrap(request.blocks.slice(1)));
      }),
    ).execute(localRequest());

    expect(result.blocks.map((block) => block.content)).toEqual(
      before.blocks.map((block) => block.content),
    );
    expect(result.blocks[0]?.content).not.toBe('mutated in place');
    expect(result.sourceDocuments.map((document) => document.contentHash)).toEqual(
      before.documents.map((document) => document.contentHash),
    );
  });

  it('rejects the mutated block when the provider returns it', async () => {
    const codes = await rejectionCodes(
      providerOf((request) => {
        const target = request.blocks[0] as unknown as Record<string, unknown>;
        const content = 'mutated in place';
        target.content = content;
        target.normalizedContentHash = calculateNormalizedContentHash(content);
        target.tokenCount = countWords(content);
        return Promise.resolve(wrap(request.blocks));
      }),
    );
    expect(codes).toEqual(['candidate_block_mismatch']);
  });

  it('hands the provider a copy, not the corpus objects themselves', async () => {
    const captured = await preparedCorpus();
    const result = await build(
      providerOf((request) => Promise.resolve(wrap(request.blocks))),
    ).execute(localRequest());

    // Equal by value on every run, and never the same object as the one the
    // result publishes.
    expect(JSON.parse(JSON.stringify(captured.blocks))).toEqual(
      JSON.parse(JSON.stringify(result.blocks)),
    );
    for (const block of result.blocks) {
      expect(captured.blocks).not.toContain(block);
    }
  });
});

describe('prepared-corpus provenance: inspection is total over untrusted output', () => {
  /**
   * The values inspected here have not been validated yet, so provenance must
   * neither throw on them nor claim a finding it did not make. Each case below
   * makes a naive `JSON.stringify` misbehave: a bigint throws a `TypeError`, a
   * cycle throws a `RangeError`, and a `Date` serializes as `{}` — which would
   * compare *equal* to a genuinely empty object.
   */
  const UNCANONICALIZABLE: readonly (readonly [string, () => unknown])[] = [
    ['bigint', (): unknown => 1n],
    ['symbol', (): unknown => Symbol('s')],
    ['function', (): unknown => (): void => undefined],
    ['NaN', (): unknown => Number.NaN],
    ['Infinity', (): unknown => Number.POSITIVE_INFINITY],
    ['-Infinity', (): unknown => Number.NEGATIVE_INFINITY],
    ['Date', (): unknown => new Date(0)],
    ['Map', (): unknown => new Map([['a', 1]])],
    ['Set', (): unknown => new Set([1])],
    ['class instance', (): unknown => new (class Holder {})()],
  ];

  it.each(UNCANONICALIZABLE)(
    'passes a real block id carrying %s metadata to the kernel, without throwing',
    async (_name, make) => {
      let raised: unknown = null;
      try {
        await build(
          providerOf((request) => {
            const real = request.blocks[0];
            if (real === undefined) throw new Error('no prepared block');
            return Promise.resolve(
              wrap([{ ...real, metadata: { ...real.metadata, malformed: make() as never } }]),
            );
          }),
        ).execute(localRequest());
      } catch (cause) {
        raised = cause;
      }

      // No raw runtime error, and no provenance verdict this check cannot support.
      expect(raised).not.toBeInstanceOf(TypeError);
      expect(raised).not.toBeInstanceOf(RangeError);
      expect(raised).not.toBeInstanceOf(LocalSourcePipelineError);
      // The kernel owns the malformed-candidate rejection.
      expect(raised).toBeInstanceOf(ContextCompilationError);
    },
  );

  /**
   * Cycles are deliberately not exercised end to end.
   *
   * The provenance boundary itself handles one — `tryCanonicalRecordJson`
   * returns a failure rather than the `RangeError` `JSON.stringify` would throw,
   * which `canonical-record.test.ts` proves directly. The compilation still
   * fails with a `RangeError`, but it comes from `CandidateValidator`: the
   * domain's recursive `JsonValueSchema` has no cycle guard, so zod recurses
   * until the stack is exhausted.
   *
   * That is a pre-existing kernel limitation, unchanged by this phase and out of
   * scope for it: fixing it means changing Phase 7 domain validation, which this
   * pull request must not touch.
   */

  it('still rejects an out-of-corpus block whose metadata is uncanonicalizable', async () => {
    // Membership is decided by identifier, so it is reachable even when the
    // block itself cannot be compared field by field.
    const codes = await rejectionCodes(
      providerOf((request) => {
        const real = request.blocks[0];
        if (real === undefined) throw new Error('no prepared block');
        return Promise.resolve(
          wrap([
            {
              ...real,
              id: 'context-block:absent' as ContextBlock['id'],
              metadata: { malformed: 1n as never },
            },
          ]),
        );
      }),
    );
    expect(codes).toEqual(['candidate_outside_prepared_corpus']);
  });
});

describe('prepared-corpus provenance: successful output is application-owned', () => {
  /** A provider that keeps every reference it returned, so a test can mutate them later. */
  function retainingProvider(): {
    readonly provider: CandidateProvider;
    readonly retained: () => {
      readonly array: CandidateBlock[];
      readonly wrappers: CandidateBlock[];
    };
  } {
    let array: CandidateBlock[] = [];
    return {
      provider: providerOf((request) => {
        array = request.blocks.map((block, index) => ({
          schemaVersion: 1 as const,
          block,
          ...(index === 0
            ? {
                retrieval: {
                  providerId: 'test-provider',
                  providerVersion: '1',
                  rank: 0,
                  metadata: { note: 'original' },
                },
              }
            : {}),
        }));
        return Promise.resolve(array);
      }),
      retained: () => ({ array, wrappers: array }),
    };
  }

  it('INV-ADAPTER-004: post-success provider mutation cannot change the returned result', async () => {
    const { provider, retained } = retainingProvider();
    const result = await build(provider).execute(localRequest());

    const before = {
      candidates: JSON.parse(JSON.stringify(result.candidates)) as unknown,
      includedBlocks: JSON.parse(JSON.stringify(result.compilation.includedBlocks)) as unknown,
      compiledContext: result.compilation.compiledContext,
      usage: JSON.parse(JSON.stringify(result.compilation.usage)) as unknown,
      trace: JSON.parse(JSON.stringify(result.compilation.trace)) as unknown,
      compilationId: result.compilation.compilationId,
      length: result.candidates.length,
    };

    // Everything a provider could still be holding, mutated after success.
    const { array, wrappers } = retained();
    const first = wrappers[0];
    if (first === undefined) throw new Error('no retained wrapper');
    const block = first.block as unknown as Record<string, unknown>;
    block.content = 'MUTATED AFTER SUCCESS';
    block.tokenCount = 9999;
    block.attributes = { required: true, priority: 999 };
    block.metadata = { injected: 'provider note' };
    (first.retrieval?.metadata as Record<string, unknown>).note = 'mutated';
    (first as unknown as Record<string, unknown>).retrieval = { providerId: 'injected' };
    array.push(first);
    array.reverse();

    expect(result.candidates).toHaveLength(before.length);
    expect(JSON.parse(JSON.stringify(result.candidates))).toEqual(before.candidates);
    expect(JSON.parse(JSON.stringify(result.compilation.includedBlocks))).toEqual(
      before.includedBlocks,
    );
    expect(result.compilation.compiledContext).toBe(before.compiledContext);
    expect(JSON.parse(JSON.stringify(result.compilation.usage))).toEqual(before.usage);
    expect(JSON.parse(JSON.stringify(result.compilation.trace))).toEqual(before.trace);
    expect(result.compilation.compilationId).toBe(before.compilationId);
  });

  it('returns candidates equal to the provider output but sharing no object with it', async () => {
    const { provider, retained } = retainingProvider();
    const result = await build(provider).execute(localRequest());
    const { wrappers } = retained();

    expect(JSON.parse(JSON.stringify(result.candidates))).toEqual(
      JSON.parse(JSON.stringify(wrappers)),
    );
    result.candidates.forEach((candidate, index) => {
      expect(candidate).not.toBe(wrappers[index]);
      expect(candidate.block).not.toBe(wrappers[index]?.block);
      if (candidate.retrieval?.metadata !== undefined) {
        expect(candidate.retrieval.metadata).not.toBe(wrappers[index]?.retrieval?.metadata);
      }
    });
    expect(result.candidates as unknown).not.toBe(wrappers as unknown);
  });

  it('preserves provider order, repeated wrappers, and retrieval evidence through the snapshot', async () => {
    const result = await build(
      providerOf((request) => {
        const [first, second] = request.blocks;
        if (first === undefined || second === undefined) throw new Error('need two blocks');
        return Promise.resolve([
          { schemaVersion: 1 as const, block: second },
          {
            schemaVersion: 1 as const,
            block: first,
            retrieval: {
              providerId: 'test-provider',
              providerVersion: '1',
              rank: 3,
              metadata: { shard: 'a', nested: { deep: [1, 2, 3] } },
            },
          },
          { schemaVersion: 1 as const, block: second },
        ]);
      }),
    ).execute(localRequest());

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.block.id).toBe(result.candidates[2]?.block.id);
    expect(result.candidates[1]?.retrieval).toEqual({
      providerId: 'test-provider',
      providerVersion: '1',
      rank: 3,
      metadata: { shard: 'a', nested: { deep: [1, 2, 3] } },
    });
    expect(result.candidates[0]?.retrieval).toBeUndefined();
  });
});
