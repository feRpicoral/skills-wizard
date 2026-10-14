import { ApplyError, SetupError } from '../errors.ts';
import { runSetup } from '../skills/setup.ts';
import {
  removeTree,
  replaceWithCopy,
  replaceWithLink,
} from '../skills/tree-replace.ts';
import { serializeManifest, writeManifest } from '../state/manifest.ts';
import {
  readTextIfExists,
  removePath,
  replaceSymlink,
  writeTextAtomic,
} from './fs.ts';
import type { Plan, PlannedAction } from './plan.ts';

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
): Promise<NodeJS.Signals | undefined> {
  if (action.change.type !== 'copy-tree' || !action.change.setup) {
    return undefined;
  }
  try {
    await runSetup({
      dir: action.path,
      command: action.change.setup,
      deferSignal: true,
    });
    return undefined;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    failures.push({ path: action.path, message: error.message });
    return error.signal;
  }
}

interface RecordManifestParams {
  plan: Plan;
  applied: ReadonlySet<PlannedAction>;
}

async function recordManifest({ plan, applied }: RecordManifestParams) {
  const entries = plan.actions.flatMap((action) => {
    const entry = applied.has(action) ? action.entry : action.previous;
    return entry ? [entry] : [];
  });
  if (entries.length === 0 && plan.manifest.tools.length === 0) {
    await removePath(plan.manifestPath);
    return;
  }

  const installedSkills = new Set(
    entries.flatMap((entry) => (entry.kind === 'skill' ? [entry.name] : [])),
  );
  const skills = plan.manifest.skills.filter((name) =>
    installedSkills.has(name),
  );
  const manifest = { ...plan.manifest, skills, entries };
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

interface ExecuteAllResult {
  failure?: ApplyError;
  signal?: NodeJS.Signals;
  partial: boolean;
}

async function executeAll(
  plan: Plan,
  outcome: ApplyOutcome,
): Promise<ExecuteAllResult> {
  for (const action of plan.actions) {
    if (action.status === 'conflict') {
      outcome.skipped.push(action);
      continue;
    }
    try {
      await execute(action);
    } catch (error) {
      return {
        failure: new ApplyError(
          `Could not update ${action.path}: ${message(error)}`,
          { cause: error },
        ),
        partial: true,
      };
    }
    outcome.applied.push(action);
    const signal = await setUp(action, outcome.setupFailures);
    if (signal !== undefined) {
      return { signal, partial: true };
    }
  }
  return { partial: false };
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
  const outcome: ApplyOutcome = { applied: [], skipped: [], setupFailures: [] };
  const { applied } = outcome;

  const { failure, signal } = await executeAll(plan, outcome);

  try {
    await recordManifest({
      plan,
      applied: new Set(applied),
    });
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
  if (signal !== undefined) {
    process.kill(process.pid, signal);
  }
  if (failure !== undefined) throw failure;

  return outcome;
}
