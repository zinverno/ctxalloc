import {
  CompilationTracePersistenceService,
  CompileAndPersistLocalContextService,
  CompileLocalContextService,
} from '@ctxalloc/application';
import {
  MiniSearchCandidateProvider,
  NodeFileSourceReader,
  SQLiteControlStore,
  SQLiteTraceStore,
  SystemMonotonicClock,
} from '@ctxalloc/adapters';
import { EvaluationHarness } from '@ctxalloc/evaluation';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import type { ApiConfig } from './config.js';
import { ApiError } from './errors.js';

/** App-internal seam. HTTP and Node types never enter reusable services. */
export interface ApiRuntime {
  readonly compile: Pick<CompileAndPersistLocalContextService, 'execute'>;
  readonly traces: Pick<CompilationTracePersistenceService, 'get'>;
  readonly evaluation: Pick<EvaluationHarness, 'runSuite'>;
  close(): void;
}
export function createApiRuntime(config: ApiConfig): ApiRuntime {
  let control: SQLiteControlStore | undefined;
  let traces: SQLiteTraceStore | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      control?.close();
    } finally {
      traces?.close();
    }
  };
  try {
    const storeConfig = { schemaVersion: 1, databasePath: config.databasePath };
    control = new SQLiteControlStore(storeConfig);
    traces = new SQLiteTraceStore(storeConfig);
    const tokenizer = new O200kBaseTokenizer();
    const local = new CompileLocalContextService(
      config.localCompile,
      tokenizer,
      new NodeFileSourceReader({
        rootDirectory: config.sourceRoot,
        maxBytes: config.maxSourceBytes,
      }),
      control,
      new MiniSearchCandidateProvider(config.candidateProvider),
    );
    const persistence = new CompilationTracePersistenceService(traces);
    return {
      compile: new CompileAndPersistLocalContextService(local, persistence),
      traces: persistence,
      evaluation: new EvaluationHarness(
        config.localCompile.compiler,
        tokenizer,
        new SystemMonotonicClock(),
      ),
      close,
    };
  } catch {
    try {
      close();
    } catch {
      /* Startup always reports one fixed failure. */
    }
    throw new ApiError(500, 'internal_error', 'runtime');
  }
}
