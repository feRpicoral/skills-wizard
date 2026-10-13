import { ApplyError, SetupError } from '../errors.ts';
import { runSetup } from '../skills/setup.ts';
import {
  removeTree,
  replaceWithCopy,
  replaceWithLink,
} from '../skills/tree.ts';
import { serializeManifest, writeManifest } from '../state/manifest.ts';
import {
  readTextIfExists,
  removePath,
  replaceSymlink,
  writeTextAtomic,
} from './fs.ts';
import {
  type Plan,
  type PlannedAction,
  resolveManifestEntries,
} from './plan.ts';

interface SetupFailure {
  path: string;
  message: string;
}

interface ApplyOutcome {
  applied: PlannedAction[];
  skipped: PlannedAction[];
  setupFailures: SetupFailure[];
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
    case 'copy-tree':
      return replaceWithCopy({
        source: action.change.source,
        destination: action.path,
        ...(action.change.backup ? { backup: action.change.backup } : {}),
      });
    case 'link-tree':
      return replaceWithLink({
        target: action.change.target,
        destination: action.path,
        ...(action.change.backup ? { backup: action.change.backup } : {}),
      });
    case 'delete-tree':
      return removeTree(action.path);
  }
}

async function setUp(
  action: PlannedAction,
  failures: SetupFailure[],
): Promise<void> {
  if (action.change.type !== 'copy-tree' || !action.change.setup) return;
  try {
    await runSetup({ dir: action.path, command: action.change.setup });
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    failures.push({ path: action.path, message: error.message });
  }
}

async function recordManifest(plan: Plan, applied: Set<PlannedAction>) {
  const effective = resolveManifestEntries({
    manifest: plan.manifest,
    actions: plan.actions,
    isApplied: (action) => applied.has(action),
  });
  if (effective.entries.length === 0 && effective.manifest.tools.length === 0) {
    await removePath(plan.manifestPath);
    return;
  }

  const manifest = { ...effective.manifest, entries: effective.entries };
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

async function executeAll(
  plan: Plan,
  outcome: ApplyOutcome,
): Promise<ApplyError | undefined> {
  for (const action of plan.actions) {
    if (action.status === 'conflict') {
      outcome.skipped.push(action);
      continue;
    }
    try {
      await execute(action);
    } catch (error) {
      return new ApplyError(
        `Could not update ${action.path}: ${message(error)}`,
        { cause: error },
      );
    }
    outcome.applied.push(action);
    await setUp(action, outcome.setupFailures);
  }
  return undefined;
}

export async function applyPlan(plan: Plan): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { applied: [], skipped: [], setupFailures: [] };
  const { applied } = outcome;

  const failure = await executeAll(plan, outcome);

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

  return outcome;
}
