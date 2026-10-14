import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { AgentsConfigError, isSystemError } from '../errors.ts';
import { applyPlan } from '../install/apply.ts';
import {
  conflicts,
  describePlan,
  hasChanges,
  planPath,
} from '../install/describe.ts';
import { lstatIfExists } from '../install/fs.ts';
import type { Plan, PlannedAction } from '../install/plan.ts';
import { confirmApply } from '../prompts/selection.ts';
import { forgetProject, recordProject } from '../state/projects.ts';
import { notify } from './output.ts';

export interface ConfirmOptions {
  yes: boolean;
  dryRun: boolean;
  beforeApply?: () => Promise<void>;
  hasExtraWork?: boolean;
  alwaysCountSummary?: boolean;
}

interface ConfirmPlansParams {
  ctx: Context;
  plans: readonly Plan[];
  prompting: boolean;
  options: ConfirmOptions;
}

type ConfirmDecision = { proceed: true } | { proceed: false; code: number };

async function trackProject(
  ctx: Context,
  prompting: boolean,
  plan: Plan,
): Promise<void> {
  if (plan.projectDir === undefined) return;

  try {
    if (await lstatIfExists(plan.manifestPath)) {
      await recordProject(ctx.paths, plan.projectDir);
    } else {
      await forgetProject(ctx.paths, plan.projectDir);
    }
  } catch (error) {
    if (!(error instanceof AgentsConfigError) && !isSystemError(error)) {
      throw error;
    }

    notify({
      ctx,
      prompting,
      message: `Could not update the list of recorded projects: ${error.message}`,
      level: 'warn',
    });
  }
}

export async function confirmPlans({
  ctx,
  plans,
  prompting,
  options: { yes, dryRun, hasExtraWork = false },
}: ConfirmPlansParams): Promise<ConfirmDecision> {
  const lines = plans.flatMap((plan) => describePlan(plan, ctx.paths.home));

  if (prompting) {
    clack.note(lines.join('\n') || 'Nothing to do', 'Plan');
  } else {
    lines.forEach((entry) => ctx.print(entry));
  }

  for (const plan of plans) {
    for (const warning of plan.warnings ?? []) {
      notify({ ctx, prompting, message: warning, level: 'warn' });
    }
  }

  if (dryRun) {
    notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
    return { proceed: false, code: 0 };
  }

  const hasAnyWork =
    hasExtraWork ||
    plans.some((plan) => hasChanges(plan) || conflicts(plan).length > 0);

  if (!hasAnyWork) {
    notify({ ctx, prompting, message: 'Everything is up to date.' });
    return { proceed: false, code: 0 };
  }

  if (!ctx.interactive && !yes) {
    ctx.print(
      'Re-run with --yes to apply these changes, or --dry-run to preview them.',
    );
    return { proceed: false, code: 1 };
  }

  if (prompting && !(await confirmApply())) {
    notify({ ctx, prompting: true, message: 'Nothing was written.' });
    return { proceed: false, code: 1 };
  }

  return { proceed: true };
}

export interface ConfirmPlanParams {
  ctx: Context;
  plan: Plan;
  prompting: boolean;
  options: ConfirmOptions;
}

export async function confirmPlan({
  ctx,
  plan,
  prompting,
  options,
}: ConfirmPlanParams): Promise<ConfirmDecision> {
  return confirmPlans({ ctx, plans: [plan], prompting, options });
}

interface ReportPlanWarningsParams {
  ctx: Context;
  plan: Plan;
  prompting: boolean;
  outcome: {
    applied: PlannedAction[];
    skipped: PlannedAction[];
    setupFailures?: { path: string; message: string }[];
  };
}

function appliedSummary(changed: number): string {
  return `Applied ${changed} change${changed === 1 ? '' : 's'}.`;
}

function reportPlanWarnings({
  ctx,
  plan,
  prompting,
  outcome,
}: ReportPlanWarningsParams): number {
  const home = ctx.paths.home;

  for (const action of outcome.skipped) {
    notify({
      ctx,
      prompting,
      message: `Skipped ${planPath({ plan, path: action.path, home })}: ${action.reason ?? 'conflict'}`,
      level: 'warn',
    });
  }

  for (const failure of outcome.setupFailures ?? []) {
    notify({
      ctx,
      prompting,
      message: `Setup in ${planPath({ plan, path: failure.path, home })} did not finish: ${failure.message}`,
      level: 'warn',
    });
  }

  return outcome.skipped.length + (outcome.setupFailures?.length ?? 0);
}

export interface ReportApplyOutcomeParams {
  ctx: Context;
  plan: Plan;
  prompting: boolean;
  outcome: {
    applied: PlannedAction[];
    skipped: PlannedAction[];
    setupFailures?: { path: string; message: string }[];
  };
}

export function reportApplyOutcome({
  ctx,
  plan,
  prompting,
  outcome,
}: ReportApplyOutcomeParams): { code: number; applied: boolean } {
  const failed = reportPlanWarnings({ ctx, plan, prompting, outcome });
  const changed = outcome.applied.filter(
    (action) => action.change.type !== 'none',
  ).length;
  const summary =
    changed === 0 && plan.manifestStatus !== 'unchanged'
      ? 'Updated the manifest.'
      : appliedSummary(changed);

  if (prompting) clack.outro(summary);
  else ctx.print(summary);

  return { code: failed > 0 ? 1 : 0, applied: true };
}

export async function confirmAndApplyPlans(
  ctx: Context,
  plans: readonly Plan[],
  options: ConfirmOptions,
): Promise<{ code: number; applied: boolean }> {
  const prompting = ctx.interactive && !options.yes;
  const decision = await confirmPlans({ ctx, plans, prompting, options });
  if (!decision.proceed) return { code: decision.code, applied: false };

  await options.beforeApply?.();

  let changed = 0;
  let failed = 0;

  for (const plan of plans) {
    const outcome = await applyPlan(plan);
    await trackProject(ctx, prompting, plan);
    changed += outcome.applied.filter(
      (action) => action.change.type !== 'none',
    ).length;
    failed += reportPlanWarnings({ ctx, plan, prompting, outcome });
  }

  const single = !options.alwaysCountSummary ? plans[0] : undefined;
  const summary =
    plans.length === 1 &&
    single &&
    changed === 0 &&
    single.manifestStatus !== 'unchanged'
      ? 'Updated the manifest.'
      : appliedSummary(changed);

  if (prompting) clack.outro(summary);
  else ctx.print(summary);

  return { code: failed > 0 ? 1 : 0, applied: true };
}

export async function confirmAndApply(
  ctx: Context,
  plan: Plan,
  options: ConfirmOptions,
): Promise<{ code: number; applied: boolean }> {
  return confirmAndApplyPlans(ctx, [plan], options);
}
