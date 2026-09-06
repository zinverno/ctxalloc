import type { CompilationTracePersistenceService } from './compilation-trace-persistence-service.js';
import type {
  CompileLocalContextService,
  LocalCompilationResult,
} from './compile-local-context-service.js';

/** Compile completely, then persist the settled trace before publishing success (DEC-043). */
export class CompileAndPersistLocalContextService {
  constructor(
    private readonly compiler: CompileLocalContextService,
    private readonly persistence: CompilationTracePersistenceService,
  ) {}

  async execute(input: unknown): Promise<LocalCompilationResult> {
    const result = await this.compiler.execute(input);
    await this.persistence.store(result.compilation.trace);
    return result;
  }
}
