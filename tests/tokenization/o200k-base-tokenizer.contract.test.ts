import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { describeTokenizerContract } from '../contracts/tokenizer.contract.js';

/**
 * The real adapter passes the same reusable Tokenizer contract as the fake
 * (INV-ADAPTER-005). The contract asserts capability-level properties only, so
 * exact counts are covered by the golden fixture suite instead.
 */
describeTokenizerContract({
  name: 'O200kBaseTokenizer',
  createTokenizer: () => new O200kBaseTokenizer(),
});
