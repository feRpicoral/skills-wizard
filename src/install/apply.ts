import { ApplyError } from '../errors.ts';
import { serializeManifest, writeManifest } from '../state/manifest.ts';
import {
  readTextIfExists,
  removePath,
  replaceSymlink,
  writeTextAtomic,
} from './fs.ts';
import type { Plan, PlannedAction } from './plan.ts';

interface ApplyOutcome {
  applied: PlannedAction[];
  skipped: PlannedAction[];
}

interface ExecutionResult extends ApplyOutcome {
  failure?: ApplyError;
}

async function execute(action: PlannedAction): Promise<void> {
  switch (action.change.type) {
    case 'none':
      return;
    case 'write':
      return writeTextAtomic({
        path: action.writePath ?? action.path,
        content: action.change.content,
      });
    case 'delete':
      return removePath(action.path);
    case 'symlink':
      return replaceSymlink({
        target: action.change.target,
        path: action.path,
      });
  }
}

async function recordManifest(plan: Plan, applied: Set<PlannedAction>) {
  const entries = plan.actions.flatMap((action) => {
    const entry = applied.has(action) ? action.entry : action.previous;
    return entry ? [entry] : [];
  });
  if (entries.length === 0 && plan.manifest.tools.length === 0) {
    await removePath(plan.manifestPath);
    return;
  }

  const manifest = { ...plan.manifest, entries };
  const existing = await readTextIfExists(plan.manifestPath);
  if (existing !== serializeManifest(manifest, plan.projectDir)) {
    await writeManifest({
      file: plan.manifestPath,
      manifest,
      ...(plan.projectDir ? { projectDir: plan.projectDir } : {}),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeAll(plan: Plan): Promise<ExecutionResult> {
  const applied: PlannedAction[] = [];
  const skipped: PlannedAction[] = [];
  for (const action of plan.actions) {
    if (action.status === 'conflict') {
      skipped.push(action);
      continue;
    }
    try {
      await execute(action);
    } catch (error) {
      return {
        applied,
        skipped,
        failure: new ApplyError(
          `Could not update ${action.path}: ${message(error)}`,
          { cause: error },
        ),
      };
    }
    applied.push(action);
  }
  return { applied, skipped };
}

/**
 * Executes a computed {@link Plan} against the filesystem and persists the
 * resulting manifest state.
 *
 * Actions with `status === 'conflict'` are skipped and retain their `previous`
 * manifest entry. If a filesystem write fails mid-plan, `applyPlan` still
 * attempts to record the manifest for all actions applied so far before
 * rethrowing {@link ApplyError}; if recording the manifest itself fails, the
 * thrown {@link ApplyError} lists any modified paths that could not be recorded.
 */
export async function applyPlan(plan: Plan): Promise<ApplyOutcome> {
  const { applied, skipped, failure } = await executeAll(plan);

  try {
    await recordManifest(plan, new Set(applied));
  } catch (error) {
    const unrecorded = applied
      .filter((action) => action.change.type !== 'none')
      .map((action) => action.path);
    const details = [
      ...(failure === undefined ? [] : [message(failure)]),
      ...(unrecorded.length > 0
        ? [`changed but not recorded: ${unrecorded.join(', ')}`]
        : []),
    ];
    throw new ApplyError(
      [
        `Could not record the manifest at ${plan.manifestPath}: ${message(error)}`,
        ...details,
      ].join('; '),
      { cause: error },
    );
  }
  if (failure !== undefined) throw failure;

  return { applied, skipped };
}
