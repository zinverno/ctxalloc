/**
 * Application use cases for CtxAlloc.
 *
 * This layer coordinates use cases over the domain model (ARCHITECTURE section
 * 3.2). It owns no budget or selection logic, calls no model, and reaches no
 * external system.
 *
 * The only use case in this phase is deterministic source ingestion (DEC-028):
 * it turns explicit, already-read source content into a validated
 * `SourceDocument` plus the unchanged content. Reading sources, chunking, and
 * `ContextBlock` creation belong to later phases and do not exist yet.
 */

export {
  SourceIngestionValidationError,
  ingestSource,
  type IngestedSource,
  type SourceIdentity,
  type SourceIngestionInput,
} from './source-ingestion.js';
