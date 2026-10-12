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

async function execute(action: PlannedAction): Promise<void> {
  switch (action.change.type) {
    case 'none':
      return;
    case 'write':
      return writeTextAtomic(
        action.writePath ?? action.path,
        action.change.content,
      );
    case 'delete':
      return removePath(action.path);
    case 'symlink':
      return replaceSymlink(action.change.target, action.path);
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
    await writeManifest(plan.manifestPath, manifest, plan.projectDir);
  }
}

export async function applyPlan(plan: Plan): Promise<ApplyOutcome> {
  const applied: PlannedAction[] = [];
  const skipped: PlannedAction[] = [];

  try {
    for (const action of plan.actions) {
      if (action.status === 'conflict') {
        skipped.push(action);
        continue;
      }
      try {
        await execute(action);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ApplyError(`Could not update ${action.path}: ${reason}`, {
          cause: error,
        });
      }
      applied.push(action);
    }
  } finally {
    await recordManifest(plan, new Set(applied));
  }

  return { applied, skipped };
}
