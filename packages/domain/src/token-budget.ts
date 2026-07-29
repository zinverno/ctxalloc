import { z } from 'zod';

/**
 * Token budget of one compilation request (ARCHITECTURE 7, METRICS 8.3).
 *
 * The budget states what the caller has already committed elsewhere. The model
 * context window is not the compiler input budget: the expected output, the
 * system prompt, tool schemas, and protocol overhead are subtracted first, and
 * what remains is what the compiler may spend on context.
 *
 * Only explicitly configured reserves are subtracted. No reserve is defaulted,
 * guessed, or injected during parsing (INV-BUDGET-001): an omitted reserve means
 * the caller reserved nothing for it, which is a decision the caller must make
 * rather than one the compiler invents.
 *
 * This value carries no schema version. It is a nested part of a future
 * compilation request rather than an independently persisted record, so its
 * version travels with the record that contains it (INV-STORE-004).
 */

/**
 * One token amount: a finite non-negative safe integer (INV-BUDGET-005).
 *
 * Numeric strings, fractions, `NaN`, `Infinity`, and values above
 * `Number.MAX_SAFE_INTEGER` are rejected rather than coerced, because a budget
 * value that cannot be compared or subtracted exactly is not a budget.
 */
const tokenAmount = z.number().int().min(0);

/** Reserve fields in the fixed order used for validation and arithmetic. */
const RESERVE_FIELDS = [
  'reservedOutputTokens',
  'reservedSystemTokens',
  'reservedToolTokens',
  'reservedProtocolTokens',
] as const;

const TokenBudgetShapeSchema = z.strictObject({
  totalTokens: tokenAmount,
  reservedOutputTokens: tokenAmount,
  reservedSystemTokens: tokenAmount.optional(),
  reservedToolTokens: tokenAmount.optional(),
  reservedProtocolTokens: tokenAmount.optional(),
});

type TokenBudgetShape = z.infer<typeof TokenBudgetShapeSchema>;

/**
 * Rejects a budget whose configured reserves exceed the total.
 *
 * The reserves are subtracted one at a time instead of summed and compared,
 * because summing several values near `Number.MAX_SAFE_INTEGER` can lose
 * precision and silently accept an impossible budget. Each subtraction stays
 * inside the safe range, so the check is exact for every accepted amount.
 *
 * Reserves equal to the total are valid: the request is then simply left with
 * zero available input tokens.
 */
function reservesFitTotal(budget: TokenBudgetShape): boolean {
  let remaining = budget.totalTokens;
  for (const field of RESERVE_FIELDS) {
    const reserve = budget[field] ?? 0;
    if (reserve > remaining) return false;
    remaining -= reserve;
  }
  return true;
}

export const TokenBudgetSchema = TokenBudgetShapeSchema.refine(reservesFitTotal, {
  message: 'configured reserved tokens must not exceed totalTokens',
});

export type TokenBudget = Readonly<z.infer<typeof TokenBudgetSchema>>;

/**
 * Reserve amounts in fixed order, treating an omitted reserve as zero.
 *
 * The zero substitution exists for arithmetic only. It is never written back:
 * the parsed budget keeps an omitted field absent, so a later trace or persisted
 * request cannot claim the caller configured a reserve it never supplied.
 */
function reserveAmounts(budget: TokenBudget): number[] {
  return RESERVE_FIELDS.map((field) => budget[field] ?? 0);
}

/**
 * Total tokens the budget reserves outside the compiler input (METRICS 8.3).
 *
 * The caller must supply a budget that passed {@link TokenBudgetSchema}. For such
 * a budget every partial sum is bounded by `totalTokens`, so the addition is
 * exact.
 */
export function configuredReservedTokens(budget: TokenBudget): number {
  return reserveAmounts(budget).reduce((total, reserve) => total + reserve, 0);
}

/**
 * Tokens available for compiled context (METRICS 8.3, INV-BUDGET-001).
 *
 * This is the ceiling a later allocator must respect; the value is exact and
 * never an estimate. Computing it requires no tokenizer, clock, randomness, or
 * environment state, and it does not modify the supplied budget.
 */
export function availableInputTokens(budget: TokenBudget): number {
  return reserveAmounts(budget).reduce(
    (remaining, reserve) => remaining - reserve,
    budget.totalTokens,
  );
}
