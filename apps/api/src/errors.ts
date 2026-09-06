import { CompilationTracePersistenceError, LocalSourcePipelineError } from '@ctxalloc/application';
import { ContextCompilationError } from '@ctxalloc/compiler';
import {
  EvaluationCaseValidationError,
  EvaluationRunConfigValidationError,
  EvaluationHarnessError,
} from '@ctxalloc/evaluation';
import { API_CONTRACT_VERSION } from './index.js';

const MESSAGES = {
  invalid_request: 'The request is invalid.',
  invalid_config: 'The API configuration is invalid or unreadable.',
  not_found: 'The requested resource was not found.',
  method_not_allowed: 'The method is not allowed for this resource.',
  body_too_large: 'The request body exceeds the configured byte limit.',
  unsupported_media: 'The request requires UTF-8 application/json with identity encoding.',
  request_aborted: 'The request did not complete.',
  server_busy: 'The server has no available request slot.',
  not_ready: 'The server is not ready to accept work.',
  internal_error: 'The operation could not be completed.',
  trace_store_failed: 'The settled trace could not be stored or read.',
  model_execution_disabled: 'Model execution is unavailable in this server.',
  unsupported_expectation: 'The request expectation is unsupported.',
} as const;
export type ApiErrorCode = keyof typeof MESSAGES;
export type ApiStage =
  'input' | 'config' | 'runtime' | 'compilation' | 'trace-store' | 'evaluation';

/** Only fixed project-owned values reach an HTTP error. Dependency issues are not echoed. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly stage: ApiStage = 'input',
  ) {
    super(MESSAGES[code]);
    this.name = 'ApiError';
  }
  envelope() {
    return {
      schemaVersion: API_CONTRACT_VERSION,
      error: {
        code: this.code,
        stage: this.stage,
        issues: [{ code: this.code, path: '', message: MESSAGES[this.code] }],
      },
    };
  }
}

export function toApiError(cause: unknown): ApiError {
  try {
    if (cause instanceof ApiError) return cause;
    if (cause instanceof LocalSourcePipelineError && cause.stage === 'request-validation')
      return new ApiError(400, 'invalid_request');
    if (cause instanceof ContextCompilationError && cause.stage === 'request-validation')
      return new ApiError(400, 'invalid_request');
    if (cause instanceof CompilationTracePersistenceError)
      return new ApiError(500, 'trace_store_failed', 'trace-store');
    if (
      cause instanceof EvaluationCaseValidationError ||
      cause instanceof EvaluationRunConfigValidationError
    )
      return new ApiError(400, 'invalid_request', 'evaluation');
    if (cause instanceof EvaluationHarnessError && cause.issueCode === 'model_provider_required')
      return new ApiError(400, 'model_execution_disabled', 'evaluation');
  } catch {
    /* Even a thrown Proxy is an opaque operational failure. */
  }
  return new ApiError(500, 'internal_error', 'runtime');
}
