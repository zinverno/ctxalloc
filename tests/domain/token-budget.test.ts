import { describe, expect, it } from 'vitest';
import {
  TokenBudgetSchema,
  availableInputTokens,
  configuredReservedTokens,
  safeParse,
} from '../../packages/domain/src/index.js';
import type { TokenBudget } from '../../packages/domain/src/index.js';

/** Parses a budget, failing the test with the validation issues when it is rejected. */
function parseBudget(input: unknown): TokenBudget {
  const result = safeParse(TokenBudgetSchema, input);
  if (!result.ok) {
    throw new Error(`expected a valid budget, received issues: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

function rejects(input: unknown): boolean {
  return !safeParse(TokenBudgetSchema, input).ok;
}

const MINIMAL = { totalTokens: 1000, reservedOutputTokens: 200 };

const COMPLETE = {
  totalTokens: 1000,
  reservedOutputTokens: 200,
  reservedSystemTokens: 100,
  reservedToolTokens: 50,
  reservedProtocolTokens: 25,
};

describe('TokenBudget accepts documented budgets', () => {
  it('accepts a minimal budget with only the required reserves', () => {
    expect(parseBudget(MINIMAL)).toEqual(MINIMAL);
  });

  it('accepts a budget with every optional reserve present', () => {
    expect(parseBudget(COMPLETE)).toEqual(COMPLETE);
  });

  it('INV-BUDGET-001: never injects a default for an omitted reserve', () => {
    const parsed = parseBudget(MINIMAL);
    expect(Object.keys(parsed).sort()).toEqual(['reservedOutputTokens', 'totalTokens']);
    for (const field of [
      'reservedSystemTokens',
      'reservedToolTokens',
      'reservedProtocolTokens',
    ] as const) {
      expect(field in parsed, `${field} must stay absent`).toBe(false);
      expect(parsed[field]).toBeUndefined();
    }
  });

  it('accepts a zero total with a zero output reserve', () => {
    const budget = parseBudget({ totalTokens: 0, reservedOutputTokens: 0 });
    expect(configuredReservedTokens(budget)).toBe(0);
    expect(availableInputTokens(budget)).toBe(0);
  });

  it('accepts reserves equal to the total, leaving zero available input tokens', () => {
    const budget = parseBudget({
      totalTokens: 300,
      reservedOutputTokens: 100,
      reservedSystemTokens: 100,
      reservedToolTokens: 60,
      reservedProtocolTokens: 40,
    });
    expect(configuredReservedTokens(budget)).toBe(300);
    expect(availableInputTokens(budget)).toBe(0);
  });

  it('accepts the largest safe total', () => {
    const budget = parseBudget({
      totalTokens: Number.MAX_SAFE_INTEGER,
      reservedOutputTokens: Number.MAX_SAFE_INTEGER - 1,
      reservedSystemTokens: 1,
    });
    expect(configuredReservedTokens(budget)).toBe(Number.MAX_SAFE_INTEGER);
    expect(availableInputTokens(budget)).toBe(0);
  });
});

describe('TokenBudget INV-BUDGET-005: rejects impossible amounts', () => {
  it.each([
    ['negative total', { totalTokens: -1, reservedOutputTokens: 0 }],
    ['negative output reserve', { totalTokens: 100, reservedOutputTokens: -1 }],
    ['negative optional reserve', { ...MINIMAL, reservedToolTokens: -5 }],
    ['fractional total', { totalTokens: 100.5, reservedOutputTokens: 0 }],
    ['fractional reserve', { totalTokens: 100, reservedOutputTokens: 0.5 }],
    ['NaN total', { totalTokens: Number.NaN, reservedOutputTokens: 0 }],
    ['NaN reserve', { totalTokens: 100, reservedOutputTokens: Number.NaN }],
    ['infinite total', { totalTokens: Number.POSITIVE_INFINITY, reservedOutputTokens: 0 }],
    ['negative infinite total', { totalTokens: Number.NEGATIVE_INFINITY, reservedOutputTokens: 0 }],
    ['infinite reserve', { totalTokens: 100, reservedOutputTokens: Number.POSITIVE_INFINITY }],
    [
      'total above MAX_SAFE_INTEGER',
      { totalTokens: Number.MAX_SAFE_INTEGER + 2, reservedOutputTokens: 0 },
    ],
    [
      'reserve above MAX_SAFE_INTEGER',
      { totalTokens: 100, reservedOutputTokens: Number.MAX_SAFE_INTEGER + 2 },
    ],
    ['numeric string total', { totalTokens: '1000', reservedOutputTokens: 0 }],
    ['numeric string reserve', { totalTokens: 1000, reservedOutputTokens: '200' }],
    ['numeric string optional reserve', { ...MINIMAL, reservedSystemTokens: '10' }],
    ['missing total', { reservedOutputTokens: 0 }],
    ['missing output reserve', { totalTokens: 1000 }],
    ['unknown field', { ...MINIMAL, reservedThinkingTokens: 10 }],
    ['unknown field with a plausible name', { ...MINIMAL, reservedTokens: 10 }],
    ['null', null],
    ['array', [1000, 200]],
    ['string', '1000'],
  ])('rejects %s', (_name, input) => {
    expect(rejects(input)).toBe(true);
  });
});

describe('TokenBudget INV-BUDGET-005: rejects reserves above the total', () => {
  it.each([
    ['output reserve exceeds total', { totalTokens: 100, reservedOutputTokens: 101 }],
    [
      'combined reserves exceed total',
      { totalTokens: 100, reservedOutputTokens: 60, reservedSystemTokens: 41 },
    ],
    [
      'combined reserves exceed total by one across four fields',
      {
        totalTokens: 100,
        reservedOutputTokens: 25,
        reservedSystemTokens: 25,
        reservedToolTokens: 25,
        reservedProtocolTokens: 26,
      },
    ],
    [
      'large reserves exceed a large total without losing precision',
      {
        totalTokens: Number.MAX_SAFE_INTEGER,
        reservedOutputTokens: Number.MAX_SAFE_INTEGER,
        reservedSystemTokens: 1,
      },
    ],
    ['any reserve exceeds a zero total', { totalTokens: 0, reservedOutputTokens: 1 }],
  ])('rejects a budget where %s', (_name, input) => {
    expect(rejects(input)).toBe(true);
  });

  it('accepts the boundary where combined reserves exactly equal the total', () => {
    expect(
      parseBudget({
        totalTokens: 100,
        reservedOutputTokens: 25,
        reservedSystemTokens: 25,
        reservedToolTokens: 25,
        reservedProtocolTokens: 25,
      }),
    ).toBeDefined();
  });
});

describe('TokenBudget INV-BUDGET-001: budget arithmetic', () => {
  it('sums exactly the configured reserves', () => {
    expect(configuredReservedTokens(parseBudget(COMPLETE))).toBe(375);
    expect(configuredReservedTokens(parseBudget(MINIMAL))).toBe(200);
  });

  it('subtracts exactly the configured reserves from the total', () => {
    expect(availableInputTokens(parseBudget(COMPLETE))).toBe(625);
    expect(availableInputTokens(parseBudget(MINIMAL))).toBe(800);
  });

  it('treats an omitted reserve as zero without ever subtracting a guessed value', () => {
    const withOnlySystem = parseBudget({ ...MINIMAL, reservedSystemTokens: 100 });
    expect(availableInputTokens(withOnlySystem)).toBe(700);
    expect(availableInputTokens(parseBudget(MINIMAL))).toBe(800);
  });

  it('reconciles the total, the reserves, and the available tokens', () => {
    for (const input of [MINIMAL, COMPLETE, { totalTokens: 8192, reservedOutputTokens: 1024 }]) {
      const budget = parseBudget(input);
      expect(configuredReservedTokens(budget) + availableInputTokens(budget)).toBe(
        budget.totalTokens,
      );
    }
  });

  it('returns exact safe integers', () => {
    const budget = parseBudget(COMPLETE);
    expect(Number.isSafeInteger(configuredReservedTokens(budget))).toBe(true);
    expect(Number.isSafeInteger(availableInputTokens(budget))).toBe(true);
  });

  it('does not mutate or extend the supplied budget', () => {
    const input = { ...MINIMAL };
    const budget = parseBudget(input);
    const before = JSON.stringify(budget);

    configuredReservedTokens(budget);
    availableInputTokens(budget);

    expect(JSON.stringify(budget)).toBe(before);
    expect(Object.keys(budget).sort()).toEqual(['reservedOutputTokens', 'totalTokens']);
    expect(input).toEqual(MINIMAL);
  });
});

describe('TokenBudget INV-DET-001: identical input produces identical output', () => {
  it('does not depend on property order', () => {
    const ordered = parseBudget(COMPLETE);
    const shuffled = parseBudget({
      reservedProtocolTokens: COMPLETE.reservedProtocolTokens,
      reservedToolTokens: COMPLETE.reservedToolTokens,
      totalTokens: COMPLETE.totalTokens,
      reservedSystemTokens: COMPLETE.reservedSystemTokens,
      reservedOutputTokens: COMPLETE.reservedOutputTokens,
    });

    expect(shuffled).toEqual(ordered);
    expect(configuredReservedTokens(shuffled)).toBe(configuredReservedTokens(ordered));
    expect(availableInputTokens(shuffled)).toBe(availableInputTokens(ordered));
  });

  it('produces identical results for repeated parses of identical input', () => {
    const first = parseBudget(COMPLETE);
    const second = parseBudget(COMPLETE);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(availableInputTokens(second)).toBe(availableInputTokens(first));
  });

  it('survives a JSON round trip', () => {
    for (const input of [MINIMAL, COMPLETE]) {
      const budget = parseBudget(input);
      const roundTripped = parseBudget(JSON.parse(JSON.stringify(budget)));
      expect(roundTripped).toEqual(budget);
      expect(availableInputTokens(roundTripped)).toBe(availableInputTokens(budget));
      expect(configuredReservedTokens(roundTripped)).toBe(configuredReservedTokens(budget));
    }
  });
});
