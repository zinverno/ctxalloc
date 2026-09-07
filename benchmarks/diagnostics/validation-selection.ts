import type { Tokenizer } from '@ctxalloc/ports';
import { buildEvaluationSuiteV1 } from '../evaluation/v1/index.js';
import {
  BENCHMARK_DATASET_ID,
  BENCHMARK_DATASET_VERSION,
  benchmarkCompilerConfig,
} from '../evaluation/v1/fixtures.js';
import { diagnoseCompilation } from './compilation-decisions.js';

/** Frozen validation inputs only; annotations never enter the diagnostic compiler call. */
export function diagnoseValidationSelection(tokenizer: Tokenizer) {
  return {
    schemaVersion: 1 as const,
    dataset: { id: BENCHMARK_DATASET_ID, version: BENCHMARK_DATASET_VERSION },
    datasetSplit: 'validation' as const,
    cases: buildEvaluationSuiteV1(tokenizer)
      .filter((entry) => entry.datasetSplit === 'validation')
      .map((entry) => ({
        caseId: entry.id,
        ...diagnoseCompilation(entry.compilationRequest, benchmarkCompilerConfig(), tokenizer),
      })),
  };
}
