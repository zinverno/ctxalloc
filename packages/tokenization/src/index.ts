/**
 * Tokenizer adapters for CtxAlloc.
 *
 * This package is the only place a tokenizer library may be imported. It
 * implements the project-owned `Tokenizer` port so the kernel never sees a
 * library type (INV-ADAPTER-001), and it owns no budget: a tokenizer reports what
 * text costs, while deciding what fits belongs to the allocator (INV-DEP-003).
 */

export {
  O200K_BASE_ENCODING,
  O200K_BASE_TOKENIZER_ID,
  O200K_BASE_TOKENIZER_VERSION,
  O200kBaseTokenizer,
  TokenizerEncodingFailedError,
  TokenizerInvalidUnicodeError,
} from './o200k-base-tokenizer.js';
