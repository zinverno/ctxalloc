import { readFileSync } from 'node:fs';
import * as compiler from '@ctxalloc/compiler';
import {
  BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION,
  BudgetAllocationError,
  BudgetAllocator,
  CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION,
  CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
  COMPILATION_POLICY_SCHEMA_VERSION,
  COMPILATION_REQUEST_SCHEMA_VERSION,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateFilteringError,
  CandidateScorer,
  CandidateScoringError,
  CandidateValidationError,
  CandidateValidator,
  CompilationPolicyError,
  CompilationPolicyValidator,
  CompilationRequestError,
  CompilationRequestValidator,
  CONTEXT_ORDERING_POLICY_SCHEMA_VERSION,
  CONTEXT_RENDERER_ID,
  CONTEXT_RENDERER_VERSION,
  CONTEXT_RENDERING_POLICY_SCHEMA_VERSION,
  ContextOrderer,
  ContextOrderingError,
  ContextRenderer,
  ContextRenderingError,
  type AllocatedCandidateSet,
  type AllocationDecisionReason,
  type BudgetAllocationPolicy,
  type CandidateFilteringDecision,
  type CandidateFilteringDecisionReason,
  type CandidateFilteringPolicy,
  type CandidateScore,
  type CandidateScoringPolicy,
  type CandidateValidationInput,
  type CanonicalSelectionReason,
  type CategoryAllocationConstraint,
  type CompilationPolicy,
  type CompilationRequest,
  type ContextOrderingPolicy,
  type ContextRenderingPolicy,
  type DeduplicatedCandidate,
  type DeduplicatedCandidateMember,
  type DeduplicatedCandidateSet,
  type DuplicateMatchReason,
  type ExcludedCandidateDecision,
  type FilteredCandidateSet,
  type IncludedCandidateDecision,
  type OrderedCandidateSet,
  type RenderedContextAttempt,
  type RetrievalNormalizationRule,
  type ScoredCandidate,
  type ScoredCandidateSet,
  type ValidatedCandidateSet,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import type {
  CandidateBlock,
  ContextBlock,
  ContextBlockId,
  Scope,
  SourceDocument,
  Timestamp,
  TokenBudget,
} from '../../packages/domain/src/index.js';
import { compilationPolicy as compilationPolicyFixture } from './compilation-fixtures.js';
import { candidate, countWords, input, sourceDocument, wordTokenizer } from './fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('packages/compiler/package.json', rootUrl), 'utf8'),
) as Manifest;

const SOURCE_FILES = [
  'packages/compiler/src/index.ts',
  'packages/compiler/src/budget-allocator.ts',
  'packages/compiler/src/context-orderer.ts',
  'packages/compiler/src/context-renderer.ts',
  'packages/compiler/src/candidate-validator.ts',
  'packages/compiler/src/candidate-deduplicator.ts',
  'packages/compiler/src/candidate-scorer.ts',
  'packages/compiler/src/candidate-filter.ts',
  'packages/compiler/src/compilation-policy.ts',
  'packages/compiler/src/compilation-request.ts',
  'packages/compiler/src/canonical-json.ts',
  'packages/compiler/src/validation-issues.ts',
] as const;

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function importSpecifiers(relativePath: string): string[] {
  return [...readSource(relativePath).matchAll(/from '(?<specifier>[^']+)'/g)].map(
    (match) => match.groups?.specifier ?? '',
  );
}

describe('@ctxalloc/compiler public API', () => {
  it('exports the implemented compiler stages, the request and policy contracts, and their errors only', () => {
    expect(Object.keys(compiler).sort()).toEqual([
      'BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION',
      'BudgetAllocationError',
      'BudgetAllocator',
      'CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION',
      'CANDIDATE_SCORING_POLICY_SCHEMA_VERSION',
      'COMPILATION_POLICY_SCHEMA_VERSION',
      'COMPILATION_REQUEST_SCHEMA_VERSION',
      'CONTEXT_ORDERING_POLICY_SCHEMA_VERSION',
      'CONTEXT_RENDERER_ID',
      'CONTEXT_RENDERER_VERSION',
      'CONTEXT_RENDERING_POLICY_SCHEMA_VERSION',
      'CandidateDeduplicator',
      'CandidateFilter',
      'CandidateFilteringError',
      'CandidateScorer',
      'CandidateScoringError',
      'CandidateValidationError',
      'CandidateValidator',
      'CompilationPolicyError',
      'CompilationPolicyValidator',
      'CompilationRequestError',
      'CompilationRequestValidator',
      'ContextOrderer',
      'ContextOrderingError',
      'ContextRenderer',
      'ContextRenderingError',
    ]);
  });

  it('exports the documented public types from its entry point', () => {
    const exported = [...readSource('packages/compiler/src/index.ts').matchAll(/type (\w+),/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual([
      'AllocatedCandidateSet',
      'AllocationDecisionReason',
      'AuthoredPriorityScoreComponent',
      'AuthoredPriorityScoreEvidence',
      'AuthoredPriorityScoringPolicy',
      'BudgetAllocationIssueCode',
      'BudgetAllocationPolicy',
      'CandidateFilteringDecision',
      'CandidateFilteringDecisionReason',
      'CandidateFilteringIssueCode',
      'CandidateFilteringPolicy',
      'CandidateScore',
      'CandidateScoringIssueCode',
      'CandidateScoringPolicy',
      'CandidateValidationInput',
      'CandidateValidationIssueCode',
      'CanonicalSelectionReason',
      'CategoryAllocationConstraint',
      'CategoryPriorityRule',
      'CategoryPriorityScoreComponent',
      'CategoryPriorityScoreEvidence',
      'CategoryPriorityScoringPolicy',
      'CompilationPolicy',
      'CompilationPolicyIssueCode',
      'CompilationRequest',
      'CompilationRequestIssueCode',
      'ContextOrderingIssueCode',
      'ContextOrderingPolicy',
      'ContextRenderingIssueCode',
      'ContextRenderingPolicy',
      'DeduplicatedCandidate',
      'DeduplicatedCandidateMember',
      'DeduplicatedCandidateSet',
      'DuplicateMatchReason',
      'ExcludedCandidateDecision',
      'FilteredCandidateDecision',
      'FilteredCandidateSet',
      'IncludedCandidateDecision',
      'OrderedCandidateSet',
      'PolicyEligibleCandidateDecision',
      'PolicyValueSource',
      'RecencyScoreComponent',
      'RecencyScoreEvidence',
      'RecencyScoringPolicy',
      'RecencyTimestampField',
      'RecencyValueSource',
      'RenderedContextAttempt',
      'RequiredEligibleCandidateDecision',
      'RetrievalNormalizationRule',
      'RetrievalScoreComponent',
      'RetrievalScoreEvidence',
      'RetrievalScoringPolicy',
      'ScoreAggregation',
      'ScoredCandidate',
      'ScoredCandidateSet',
      'SourcePriorityRule',
      'SourcePriorityScoreComponent',
      'SourcePriorityScoreEvidence',
      'SourcePriorityScoringPolicy',
      'ValidatedCandidateSet',
    ]);
  });

  it('accepts the documented public input shape and returns the documented result', () => {
    const tokenizer: Tokenizer = wordTokenizer;
    const validator = new CandidateValidator(tokenizer);

    const scope: Scope = { tenantId: 'local', workspaceId: 'default' };
    const validated: ValidatedCandidateSet = validator.validate(input());

    const documents: readonly SourceDocument[] = validated.sourceDocuments;
    const candidates: readonly CandidateBlock[] = validated.candidates;
    // The validated result is itself a valid input for a later call, which is
    // what makes the two structures composable.
    const roundTrip: CandidateValidationInput = {
      scope: validated.scope,
      sourceDocuments: documents,
      candidates,
    };

    expect(validator.validate(roundTrip)).toEqual(validated);
    expect(validated.scope).toEqual(scope);
    expect(CandidateValidationError.prototype).toBeInstanceOf(Error);
  });

  it('accepts a ValidatedCandidateSet and returns the documented deduplicated result', () => {
    const validated: ValidatedCandidateSet = new CandidateValidator(wordTokenizer).validate(
      input({ candidates: [candidate(), candidate()] }),
    );
    const deduplicated: DeduplicatedCandidateSet = new CandidateDeduplicator().deduplicate(
      validated,
    );

    const scope: Scope = deduplicated.scope;
    const documents: readonly SourceDocument[] = deduplicated.sourceDocuments;
    const groups: readonly DeduplicatedCandidate[] = deduplicated.candidates;
    const group = groups[0];
    if (group === undefined) throw new Error('expected one group');

    const canonical: ContextBlock = group.canonicalBlock;
    const reason: CanonicalSelectionReason = group.canonicalSelectionReason;
    const members: readonly DeduplicatedCandidateMember[] = group.members;
    const member = members[0];
    if (member === undefined) throw new Error('expected one member');
    const wrapper: CandidateBlock = member.candidate;
    const matchReason: DuplicateMatchReason = member.matchReason;

    expect(scope).toEqual(validated.scope);
    expect(documents).toHaveLength(1);
    expect(canonical.id).toBe(wrapper.block.id);
    expect(reason).toBe('single-block');
    expect(matchReason).toBe('same-block-id');
  });

  it('accepts a DeduplicatedCandidateSet with an explicit reference time and returns the documented scored result', () => {
    const validated = new CandidateValidator(wordTokenizer).validate(input());
    const deduplicated = new CandidateDeduplicator().deduplicate(validated);

    const normalizationRule: RetrievalNormalizationRule = {
      ruleId: 'cosine',
      providerId: 'sqlite-fts5',
      providerVersion: '1.2.3',
      semantics: 'cosine-similarity',
      higherIsBetter: true,
      min: 0,
      max: 1,
    };
    const scoringPolicy: CandidateScoringPolicy = {
      schemaVersion: CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
      policyId: 'baseline',
      policyVersion: '1.0.0',
      retrieval: { weight: 1, aggregation: 'max', rules: [normalizationRule] },
    };

    const scored: ScoredCandidateSet = new CandidateScorer(scoringPolicy).score(
      deduplicated,
      '2026-06-01T12:00:00.000Z',
    );

    const scope: Scope = scored.scope;
    const documents: readonly SourceDocument[] = scored.sourceDocuments;
    const referenceTime: Timestamp = scored.referenceTime;
    const entries: readonly ScoredCandidate[] = scored.candidates;
    const entry = entries[0];
    if (entry === undefined) throw new Error('expected one scored candidate');
    const group: DeduplicatedCandidate = entry.candidate;
    const candidateScore: CandidateScore = entry.score;

    expect(scope).toEqual(validated.scope);
    expect(documents).toHaveLength(1);
    expect(referenceTime).toBe('2026-06-01T12:00:00.000Z');
    expect(scored.policyId).toBe('baseline');
    expect(scored.policyVersion).toBe('1.0.0');
    expect(group.canonicalBlock.id).toBe('block-1');
    expect(candidateScore.total).toBe(0);
    expect(candidateScore.retrieval?.aggregation).toBe('max');
    expect(CandidateScoringError.prototype).toBeInstanceOf(Error);
  });

  it('accepts a ScoredCandidateSet with an unknown budget and returns the documented allocation', () => {
    const scored = new CandidateScorer({
      schemaVersion: CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
      policyId: 'baseline',
      policyVersion: '1.0.0',
    }).score(
      new CandidateDeduplicator().deduplicate(
        new CandidateValidator(wordTokenizer).validate(input()),
      ),
      '2026-06-01T12:00:00.000Z',
    );

    const constraint: CategoryAllocationConstraint = { category: 'facts', maxBlocks: 3 };
    const allocationPolicy: BudgetAllocationPolicy = {
      schemaVersion: BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION,
      policyId: 'allocation',
      policyVersion: '1.0.0',
      optionalSelection: 'score-desc-greedy',
      categoryConstraints: [constraint],
    };
    // The budget crosses a runtime boundary, so the parameter is `unknown`.
    const untypedBudget: unknown = { totalTokens: 100, reservedOutputTokens: 10 };

    const allocated: AllocatedCandidateSet = new BudgetAllocator(allocationPolicy).allocate(
      scored,
      untypedBudget,
    );

    const scope: Scope = allocated.scope;
    const documents: readonly SourceDocument[] = allocated.sourceDocuments;
    const referenceTime: Timestamp = allocated.referenceTime;
    const tokenBudget: TokenBudget = allocated.tokenBudget;
    const included: readonly IncludedCandidateDecision[] = allocated.included;
    const excluded: readonly ExcludedCandidateDecision[] = allocated.excluded;
    const evictionOrder: readonly ContextBlockId[] = allocated.optionalEvictionOrder;
    const decision = included[0];
    if (decision === undefined) throw new Error('expected one included decision');
    const entry: ScoredCandidate = decision.candidate;
    const reason: AllocationDecisionReason = decision.reason;

    expect(scope).toEqual(scored.scope);
    expect(documents).toHaveLength(1);
    expect(referenceTime).toBe('2026-06-01T12:00:00.000Z');
    expect(tokenBudget.totalTokens).toBe(100);
    expect(allocated.availableInputTokens).toBe(90);
    expect(allocated.scoringPolicyId).toBe('baseline');
    expect(allocated.allocationPolicyId).toBe('allocation');
    expect(allocated.allocationPolicyVersion).toBe('1.0.0');
    expect(reason).toBe('INCLUDED_SCORE_ORDER');
    expect(entry.candidate.canonicalBlock.id).toBe('block-1');
    expect(allocated.selectedBlockContentTokens).toBe(
      countWords(entry.candidate.canonicalBlock.content),
    );
    expect(allocated.unallocatedBlockContentTokens).toBe(
      allocated.availableInputTokens - allocated.selectedBlockContentTokens,
    );
    expect(excluded).toEqual([]);
    expect(evictionOrder).toEqual([entry.candidate.canonicalBlock.id]);
    expect(BudgetAllocationError.prototype).toBeInstanceOf(Error);
  });

  it('publishes a stable top-level allocation error code', () => {
    try {
      new BudgetAllocator({});
    } catch (error) {
      expect((error as BudgetAllocationError).code).toBe('BUDGET_ALLOCATION_FAILED');
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('accepts an AllocatedCandidateSet and returns the documented ordered result', () => {
    const scored = new CandidateScorer({
      schemaVersion: CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
      policyId: 'baseline',
      policyVersion: '1.0.0',
    }).score(
      new CandidateDeduplicator().deduplicate(
        new CandidateValidator(wordTokenizer).validate(input()),
      ),
      '2026-06-01T12:00:00.000Z',
    );
    const allocated: AllocatedCandidateSet = new BudgetAllocator({
      schemaVersion: BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION,
      policyId: 'allocation',
      policyVersion: '1.0.0',
      optionalSelection: 'score-desc-greedy',
    }).allocate(scored, { totalTokens: 100, reservedOutputTokens: 10 });

    const orderingPolicy: ContextOrderingPolicy = {
      schemaVersion: CONTEXT_ORDERING_POLICY_SCHEMA_VERSION,
      policyId: 'ordering',
      policyVersion: '1.0.0',
      strategy: 'source-document-then-location',
    };
    const ordered: OrderedCandidateSet = new ContextOrderer(orderingPolicy).order(allocated);

    const allocation: AllocatedCandidateSet = ordered.allocation;
    const sequence: readonly IncludedCandidateDecision[] = ordered.orderedIncluded;

    expect(allocation).toBe(allocated);
    expect(ordered.orderingPolicyId).toBe('ordering');
    expect(ordered.orderingPolicyVersion).toBe('1.0.0');
    expect(sequence).toHaveLength(1);
    expect(sequence[0]).toBe(allocated.included[0]);
    expect(sequence[0]?.candidate.candidate.canonicalBlock.id).toBe('block-1');
    // The ordering stage adds no schema version: it is an ephemeral result.
    expect(Object.keys(ordered)).not.toContain('schemaVersion');
    expect(ContextOrderingError.prototype).toBeInstanceOf(Error);
  });

  it('accepts an unknown ordering policy at the runtime boundary', () => {
    const untyped: unknown = {
      schemaVersion: 1,
      policyId: 'p',
      policyVersion: '1',
      strategy: 'source-document-then-location',
    };
    expect(() => new ContextOrderer(untyped)).not.toThrow();
  });

  it('accepts an OrderedCandidateSet and returns the documented render attempt', () => {
    const scored = new CandidateScorer({
      schemaVersion: CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
      policyId: 'baseline',
      policyVersion: '1.0.0',
    }).score(
      new CandidateDeduplicator().deduplicate(
        new CandidateValidator(wordTokenizer).validate(input()),
      ),
      '2026-06-01T12:00:00.000Z',
    );
    const allocated = new BudgetAllocator({
      schemaVersion: BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION,
      policyId: 'allocation',
      policyVersion: '1.0.0',
      optionalSelection: 'score-desc-greedy',
    }).allocate(scored, { totalTokens: 100, reservedOutputTokens: 10 });
    const ordered = new ContextOrderer({
      schemaVersion: CONTEXT_ORDERING_POLICY_SCHEMA_VERSION,
      policyId: 'ordering',
      policyVersion: '1.0.0',
      strategy: 'source-document-then-location',
    }).order(allocated);

    const renderingPolicy: ContextRenderingPolicy = {
      schemaVersion: CONTEXT_RENDERING_POLICY_SCHEMA_VERSION,
      policyId: 'rendering',
      policyVersion: '1.0.0',
      format: 'jsonl-blocks',
    };
    const attempt: RenderedContextAttempt = new ContextRenderer(
      renderingPolicy,
      wordTokenizer,
    ).render(ordered);

    const carried: OrderedCandidateSet = attempt.ordered;
    expect(carried).toBe(ordered);
    expect(attempt.renderingPolicyId).toBe('rendering');
    expect(attempt.renderingPolicyVersion).toBe('1.0.0');
    expect(attempt.rendererId).toBe(CONTEXT_RENDERER_ID);
    expect(attempt.rendererVersion).toBe(CONTEXT_RENDERER_VERSION);
    expect(attempt.tokenizerId).toBe(wordTokenizer.id);
    expect(attempt.tokenizerVersion).toBe(wordTokenizer.version);
    expect(attempt.renderedContext.split('\n')).toHaveLength(1);
    expect(attempt.renderedTokens).toBe(countWords(attempt.renderedContext));
    expect(attempt.fitsAvailableInputBudget).toBe(
      attempt.renderedTokens <= allocated.availableInputTokens,
    );
    // The block-content sum stays reachable, but is never subtracted here: this
    // stage cannot prove both counts came from one tokenizer identity.
    expect(attempt.ordered.allocation.selectedBlockContentTokens).toBe(
      allocated.selectedBlockContentTokens,
    );
    // The attempt is not a CompilationResult, and it publishes no token delta.
    for (const final of [
      'renderedTokenDelta',
      'renderingTokenDelta',
      'renderingOverheadTokens',
      'compiledTokens',
      'unusedTokens',
    ]) {
      expect(Object.keys(attempt), `exposes ${final}`).not.toContain(final);
    }
    expect(ContextRenderingError.prototype).toBeInstanceOf(Error);
  });

  it('accepts an unknown rendering policy at the runtime boundary', () => {
    const untyped: unknown = {
      schemaVersion: 1,
      policyId: 'p',
      policyVersion: '1',
      format: 'jsonl-blocks',
    };
    expect(() => new ContextRenderer(untyped, wordTokenizer)).not.toThrow();
  });

  it('publishes a stable top-level rendering error code', () => {
    try {
      new ContextRenderer({}, wordTokenizer);
    } catch (error) {
      expect((error as ContextRenderingError).code).toBe('CONTEXT_RENDERING_FAILED');
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('publishes a stable top-level ordering error code', () => {
    try {
      new ContextOrderer({});
    } catch (error) {
      expect((error as ContextOrderingError).code).toBe('CONTEXT_ORDERING_FAILED');
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('accepts unknown policy and reference time at the runtime boundary', () => {
    const untypedPolicy: unknown = { schemaVersion: 1, policyId: 'p', policyVersion: '1' };
    const scorer = new CandidateScorer(untypedPolicy);
    const batch = new CandidateDeduplicator().deduplicate(
      new CandidateValidator(wordTokenizer).validate(input()),
    );
    const untypedTime: unknown = '2026-06-01T12:00:00.000Z';

    expect(() => scorer.score(batch, untypedTime)).not.toThrow();
  });

  it('accepts unknown at the runtime boundary', () => {
    const validator = new CandidateValidator(wordTokenizer);
    const untyped: unknown = input();
    expect(() => validator.validate(untyped)).not.toThrow();
  });

  it('publishes a stable top-level error code', () => {
    const validator = new CandidateValidator(wordTokenizer);
    try {
      validator.validate({});
    } catch (error) {
      expect((error as CandidateValidationError).code).toBe('CANDIDATE_VALIDATION_FAILED');
      return;
    }
    throw new Error('expected the empty object to be rejected');
  });

  it('accepts a ScoredCandidateSet and returns the documented filtered result', () => {
    const scored = new CandidateScorer({
      schemaVersion: CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
      policyId: 'baseline',
      policyVersion: '1.0.0',
    }).score(
      new CandidateDeduplicator().deduplicate(
        new CandidateValidator(wordTokenizer).validate(input()),
      ),
      '2026-06-01T12:00:00.000Z',
    );

    const filteringPolicy: CandidateFilteringPolicy = {
      schemaVersion: CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION,
      policyId: 'filtering',
      policyVersion: '1.0.0',
    };
    const filtered: FilteredCandidateSet = new CandidateFilter(filteringPolicy).filter(scored);

    const carried: ScoredCandidateSet = filtered.scored;
    const eligible: ScoredCandidateSet = filtered.eligible;
    const decisions: readonly CandidateFilteringDecision[] = filtered.decisions;
    const decision = decisions[0];
    if (decision === undefined) throw new Error('expected one filtering decision');
    const reason: CandidateFilteringDecisionReason = decision.reason;

    expect(carried).toBe(scored);
    expect(filtered.filteringPolicyId).toBe('filtering');
    expect(filtered.filteringPolicyVersion).toBe('1.0.0');
    expect(eligible.candidates).toEqual(scored.candidates);
    expect(eligible.referenceTime).toBe(scored.referenceTime);
    expect(reason).toBe('ELIGIBLE_POLICY');
    // The filtered set adds no schema version: it is an ephemeral result.
    expect(Object.keys(filtered)).not.toContain('schemaVersion');
    expect(CandidateFilteringError.prototype).toBeInstanceOf(Error);
  });

  it('accepts an unknown filtering policy at the runtime boundary', () => {
    const untyped: unknown = { schemaVersion: 1, policyId: 'p', policyVersion: '1' };
    expect(() => new CandidateFilter(untyped)).not.toThrow();
  });

  it('publishes a stable top-level filtering error code', () => {
    try {
      new CandidateFilter({});
    } catch (error) {
      expect((error as CandidateFilteringError).code).toBe('CANDIDATE_FILTERING_FAILED');
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('accepts an unknown compilation policy and returns the documented five slices', () => {
    const untyped: unknown = compilationPolicyFixture();
    const policy: CompilationPolicy = new CompilationPolicyValidator().validate(untyped);

    const scoring: CandidateScoringPolicy = policy.scoring;
    const filtering: CandidateFilteringPolicy = policy.filtering;
    const allocation: BudgetAllocationPolicy = policy.allocation;
    const ordering: ContextOrderingPolicy = policy.ordering;
    const rendering: ContextRenderingPolicy = policy.rendering;

    expect(policy.schemaVersion).toBe(COMPILATION_POLICY_SCHEMA_VERSION);
    expect(scoring.policyId).toBe('scoring');
    expect(filtering.policyId).toBe('filtering');
    expect(allocation.optionalSelection).toBe('score-desc-greedy');
    expect(ordering.strategy).toBe('source-document-then-location');
    expect(rendering.format).toBe('jsonl-blocks');
    expect(CompilationPolicyError.prototype).toBeInstanceOf(Error);
  });

  it('accepts an unknown compilation request and returns the documented record', () => {
    const untyped: unknown = {
      id: 'req-1',
      schemaVersion: COMPILATION_REQUEST_SCHEMA_VERSION,
      scope: { tenantId: 'local', workspaceId: 'default' },
      query: '',
      referenceTime: '2026-06-01T12:00:00.000Z',
      candidates: [],
      sourceDocuments: [],
      budget: { totalTokens: 100, reservedOutputTokens: 10 },
      policy: compilationPolicyFixture(),
    };
    const parsed: CompilationRequest = new CompilationRequestValidator().validate(untyped);

    const scope: Scope = parsed.scope;
    const referenceTime: Timestamp = parsed.referenceTime;
    const budget: TokenBudget = parsed.budget;
    const candidates: readonly CandidateBlock[] = parsed.candidates;
    const documents: readonly SourceDocument[] = parsed.sourceDocuments;
    const policy: CompilationPolicy = parsed.policy;

    expect(parsed.id).toBe('req-1');
    expect(parsed.query).toBe('');
    expect(scope.tenantId).toBe('local');
    expect(referenceTime).toBe('2026-06-01T12:00:00.000Z');
    expect(budget.totalTokens).toBe(100);
    expect(candidates).toEqual([]);
    expect(documents).toEqual([]);
    expect(policy.policyId).toBe('composition');
    expect(CompilationRequestError.prototype).toBeInstanceOf(Error);
  });

  it('publishes stable top-level policy and request error codes', () => {
    try {
      new CompilationPolicyValidator().validate({});
    } catch (error) {
      expect((error as CompilationPolicyError).code).toBe('COMPILATION_POLICY_INVALID');
    }
    try {
      new CompilationRequestValidator().validate({});
    } catch (error) {
      expect((error as CompilationRequestError).code).toBe('COMPILATION_REQUEST_INVALID');
      return;
    }
    throw new Error('expected the empty request to be rejected');
  });

  it('exports no later compiler stage and no retrieval port', () => {
    for (const name of [
      'TraceBuilder',
      'ContextCompiler',
      'CandidateProvider',
      'FakeCandidateProvider',
      'CompilationRequestSchema',
      'CompilationPolicySchema',
      'CompilationResult',
      'CompilationTrace',
      'compile',
      'score',
      'allocate',
      'render',
      'filter',
      // The nested policy parsers the broad CompilationPolicy reuses are
      // package-internal: they exist so one rule has one owner, not as API.
      'parseCandidateScoringPolicy',
      'parseCandidateFilteringPolicy',
      'parseBudgetAllocationPolicy',
      'parseContextOrderingPolicy',
      'parseContextRenderingPolicy',
      'parseCompilationPolicy',
    ]) {
      expect(Object.keys(compiler), `exports ${name}`).not.toContain(name);
    }
  });

  it('exposes no ingestion, chunking, or tokenizer implementation', () => {
    for (const name of [
      'ingestSource',
      'MarkdownChunker',
      'FakeTokenizer',
      'O200kBaseTokenizer',
      'SourceReader',
    ]) {
      expect(Object.keys(compiler), `exports ${name}`).not.toContain(name);
    }
  });

  it('declares only the dependencies it imports', () => {
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
      zod: '^4.4.3',
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-DEP-002: declares no retrieval, model, storage, or application dependency', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of [
      '@ctxalloc/application',
      '@ctxalloc/tokenization',
      '@ctxalloc/testing',
      '@ctxalloc/evaluation',
      'js-tiktoken',
      'better-sqlite3',
      'obsidian',
    ]) {
      expect(declared).not.toContain(forbidden);
    }
    expect(declared).toContain('@ctxalloc/domain');
    expect(declared).toContain('@ctxalloc/ports');
  });

  it('imports only its declared dependencies', () => {
    const allowed = new Set(['@ctxalloc/domain', '@ctxalloc/ports', 'zod']);
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(file)) {
        expect(
          specifier.startsWith('./') || allowed.has(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('INV-DEP-001: imports no Node standard library module', () => {
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(file)) {
        expect(specifier.startsWith('node:'), `${file} imports ${specifier}`).toBe(false);
      }
    }
  });

  it('INV-ADAPTER-001: leaks no validation-library type through its public surface', () => {
    const entry = readSource('packages/compiler/src/index.ts');
    expect(entry).not.toContain('zod');
    expect(entry).not.toContain('node:');

    for (const file of [
      'packages/compiler/src/candidate-validator.ts',
      'packages/compiler/src/candidate-deduplicator.ts',
      'packages/compiler/src/candidate-scorer.ts',
      'packages/compiler/src/budget-allocator.ts',
      'packages/compiler/src/context-orderer.ts',
      'packages/compiler/src/context-renderer.ts',
      'packages/compiler/src/candidate-filter.ts',
      'packages/compiler/src/compilation-policy.ts',
      'packages/compiler/src/compilation-request.ts',
    ]) {
      const declaredExports = readSource(file)
        .split('\n')
        .filter((line) => line.startsWith('export '))
        .join('\n');
      for (const leaked of ['z.', 'Zod', 'Buffer', 'Hash', 'createHash', 'Map<', 'Set<']) {
        expect(declaredExports, `${file} exposes ${leaked}`).not.toContain(leaked);
      }
    }
    // The shared canonical serializer is internal: the entry point never
    // re-exports it (INV-ADAPTER-001).
    expect(entry).not.toContain('canonicalJson');
    expect(entry).not.toContain('canonical-json');
    // The shared issue-rendering helpers are internal too.
    expect(entry).not.toContain('pointerFor');
    expect(entry).not.toContain('validation-issues');
  });

  it('INV-ADAPTER-001: exposes no mutable collection in the public contract', () => {
    const validator = new CandidateValidator(wordTokenizer);
    const result = validator.validate(input({ candidates: [candidate()] }));
    expect(result.candidates).toBeInstanceOf(Array);
    expect(result.sourceDocuments).toBeInstanceOf(Array);
    expect(result.candidates).not.toBeInstanceOf(Map);
    expect(result.sourceDocuments).not.toBeInstanceOf(Set);
  });

  it('reuses the project-owned ValidationIssue shape', () => {
    const validator = new CandidateValidator(wordTokenizer);
    try {
      validator.validate(input({ sourceDocuments: [sourceDocument(), sourceDocument()] }));
    } catch (error) {
      for (const issue of (error as CandidateValidationError).issues) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
        expect(typeof issue.code).toBe('string');
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.pointer).toBe('string');
        expect(typeof issue.message).toBe('string');
      }
      return;
    }
    throw new Error('expected the duplicate source ID to be rejected');
  });

  it('renders indexed pointers the same way the domain does', () => {
    const validator = new CandidateValidator(wordTokenizer);
    const schemaPointer = pointerOfFirstIssue(
      validator,
      input({ candidates: [candidate({ tokenCount: 'x' })] }),
    );
    const crossRecordPointer = pointerOfFirstIssue(
      validator,
      input({ candidates: [candidate({ tokenCount: 99 })] }),
    );
    // The first comes from the domain schema, the second from a cross-record
    // rule. Both must address the same field the same way.
    expect(schemaPointer).toBe('candidates[0].block.tokenCount');
    expect(crossRecordPointer).toBe('candidates[0].block.tokenCount');
  });

  it('countWords stays a genuine tokenizer for these tests', () => {
    expect(countWords('a b  c')).toBe(3);
  });
});

function pointerOfFirstIssue(validator: CandidateValidator, batch: unknown): string {
  try {
    validator.validate(batch);
  } catch (error) {
    return (error as CandidateValidationError).issues[0]?.pointer ?? '';
  }
  throw new Error('expected the batch to be rejected');
}
