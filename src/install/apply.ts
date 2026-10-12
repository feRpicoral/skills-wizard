import { writeManifest } from '../state/manifest.ts';
import { removePath, replaceSymlink, writeTextAtomic } from './fs.ts';
import type { Plan, PlannedAction } from './plan.ts';

export interface ApplyOutcome {
  applied: PlannedAction[];
  skipped: PlannedAction[];
}

async function execute(action: PlannedAction): Promise<void> {
  switch (action.change.type) {
    case 'none':
      return;
    case 'write':
      return writeTextAtomic(action.path, action.change.content);
    case 'delete':
      return removePath(action.path);
    case 'symlink':
      return replaceSymlink(action.change.target, action.path);
  }
}

export async function applyPlan(
  plan: Plan,
  manifestPath: string,
  baseDir?: string,
): Promise<ApplyOutcome> {
  const applied: PlannedAction[] = [];
  const skipped: PlannedAction[] = [];

  try {
    for (const action of plan.actions) {
      if (action.status === 'conflict') {
        skipped.push(action);
        continue;
      }
      await execute(action);
      applied.push(action);
    }
  } finally {
    const done = new Set(applied);
    const entries = plan.actions.flatMap((action) => {
      const entry = done.has(action) ? action.entry : action.previous;
      return entry ? [entry] : [];
    });
    await writeManifest(manifestPath, { ...plan.manifest, entries }, baseDir);
  }

  return { applied, skipped };
}
