import type {
  PreparedRuntimeProjection,
  PreparedRuntimeUnprojection,
  RuntimeProjectionInput,
  RuntimeProjector,
  RuntimeUnprojectionInput,
} from '../../domain/runtime/runtime-projector.js';
import { ClaudeCodeProjectPluginProjector } from './claude-code-project-plugin-projector.js';
import { AgyProjectPluginProjector } from './agy-project-plugin-projector.js';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';

export class CompositeRuntimeProjector implements RuntimeProjector {
  constructor(
    private readonly claudeProjector: RuntimeProjector = new ClaudeCodeProjectPluginProjector(),
    private readonly agyProjector: RuntimeProjector = new AgyProjectPluginProjector(),
  ) {}

  private getProjector(runtime: string): RuntimeProjector {
    if (runtime === 'claude-code') return this.claudeProjector;
    if (runtime === 'agy' || runtime === 'antigravity') return this.agyProjector;
    throw new KkError(`Unsupported runtime for projection: ${runtime}`, {
      code: 'unsupported_environment',
      exitCode: EXIT_CODES.invalidInput,
      remediation: 'Choose a supported runtime: claude-code or agy.',
    });
  }

  async assertSupported(
    input: Pick<RuntimeProjectionInput, 'runtime' | 'scope' | 'projectDirectory'>,
  ): Promise<void> {
    return this.getProjector(input.runtime).assertSupported(input);
  }

  async prepare(input: RuntimeProjectionInput): Promise<PreparedRuntimeProjection> {
    return this.getProjector(input.runtime).prepare(input);
  }

  async prepareUninstall(
    input: RuntimeUnprojectionInput,
  ): Promise<PreparedRuntimeUnprojection> {
    return this.getProjector(input.runtime).prepareUninstall(input);
  }
}
