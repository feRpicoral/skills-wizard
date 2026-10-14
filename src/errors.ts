export class AgentsConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends AgentsConfigError {}

export class MissingVariablesError extends UsageError {}

export class CancelledError extends AgentsConfigError {}

export class EnvironmentError extends AgentsConfigError {}

export class BlockLibraryError extends AgentsConfigError {}

export class CompositionError extends AgentsConfigError {}

export class FrontmatterError extends AgentsConfigError {}

export class ManagedRegionError extends AgentsConfigError {}

export class JsonMergeError extends AgentsConfigError {}

export class ManifestError extends AgentsConfigError {}

export class RegistryError extends AgentsConfigError {}

export class ApplyError extends AgentsConfigError {}

export class UnsafeWriteError extends AgentsConfigError {}

export class CatalogError extends AgentsConfigError {}

export class SourceError extends AgentsConfigError {}

export class SetupError extends AgentsConfigError {
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

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    'errno' in error &&
    typeof error.errno === 'number'
  );
}
