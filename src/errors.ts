export class AgentsConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends AgentsConfigError {}

export class CancelledError extends AgentsConfigError {}

export class EnvironmentError extends AgentsConfigError {}

export class BlockLibraryError extends AgentsConfigError {}

export class CompositionError extends AgentsConfigError {}

export class FrontmatterError extends AgentsConfigError {}

export class ManagedRegionError extends AgentsConfigError {}

export class JsonMergeError extends AgentsConfigError {}

export class ManifestError extends AgentsConfigError {}

export class ApplyError extends AgentsConfigError {}
