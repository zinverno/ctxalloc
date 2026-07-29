import { FakeTokenizer, type FakeTokenizerEntry } from '@ctxalloc/testing';
import {
  TOKENIZER_CONTRACT_TEXTS,
  describeTokenizerContract,
} from '../contracts/tokenizer.contract.js';

/**
 * Standard contract configuration for the fake.
 *
 * The empty string is mapped to zero, as the contract requires. Every other count
 * is the position of the text in the contract list: an arbitrary but stable value
 * that is deliberately unrelated to character or word count, so no test can pass
 * by accidentally relying on a length heuristic.
 */
const CONTRACT_TOKENIZER_ENTRIES: readonly FakeTokenizerEntry[] = TOKENIZER_CONTRACT_TEXTS.map(
  (text, index) => ({ text, tokens: index }),
);

describeTokenizerContract({
  name: 'FakeTokenizer',
  createTokenizer: () => new FakeTokenizer(CONTRACT_TOKENIZER_ENTRIES),
});
