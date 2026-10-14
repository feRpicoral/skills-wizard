export class SkillsWizardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends SkillsWizardError {}

export class MissingVariablesError extends UsageError {}

export class CancelledError extends SkillsWizardError {}

export class EnvironmentError extends SkillsWizardError {}

export class BlockLibraryError extends SkillsWizardError {}

export class CompositionError extends SkillsWizardError {}

export class FrontmatterError extends SkillsWizardError {}

export class ManagedRegionError extends SkillsWizardError {}

export class JsonMergeError extends SkillsWizardError {}

export class ManifestError extends SkillsWizardError {}

export class RegistryError extends SkillsWizardError {}

export class ApplyError extends SkillsWizardError {}

export class UnsafeWriteError extends SkillsWizardError {}

export class CatalogError extends SkillsWizardError {}

export class SourceError extends SkillsWizardError {}

export class SetupError extends SkillsWizardError {
  readonly signal?: NodeJS.Signals;

  constructor(
    message: string,
    options?: ErrorOptions & { signal?: NodeJS.Signals },
  ) {
    super(message, options);
    if (options?.signal !== undefined) {
      this.signal = options.signal;
    }
  }
}

export class EvalError extends SkillsWizardError {}

export class RunnerError extends SkillsWizardError {}

export class PresetError extends SkillsWizardError {}

export class McpError extends SkillsWizardError {}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    'errno' in error &&
    typeof error.errno === 'number'
  );
}
