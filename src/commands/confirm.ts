import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { applyPlan } from '../install/apply.ts';
import {
  conflicts,
  describePlan,
  hasChanges,
  planPath,
} from '../install/describe.ts';
import type { Plan, PlannedAction } from '../install/plan.ts';
import { confirmApply } from '../prompts/selection.ts';
import { notify } from './output.ts';

export interface ConfirmOptions {
  yes: boolean;
  dryRun: boolean;
}

interface ConfirmPlanParams {
  ctx: Context;
  plan: Plan;
  prompting: boolean;
  options: ConfirmOptions;
}

type ConfirmDecision = { proceed: true } | { proceed: false; code: number };

export async function confirmPlan({
  ctx,
  plan,
  prompting,
  options: { yes, dryRun },
}: ConfirmPlanParams): Promise<ConfirmDecision> {
  const lines = describePlan(plan, ctx.paths.home);
  if (prompting) {
    clack.note(lines.join('\n') || 'Nothing to do', 'Plan');
  } else {
    lines.forEach((entry) => ctx.print(entry));
  }

  if (dryRun) {
    notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
    return { proceed: false, code: 0 };
  }
  const blocked = conflicts(plan);
  if (!hasChanges(plan) && blocked.length === 0) {
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

interface ReportApplyOutcomeParams {
  ctx: Context;
  plan: Plan;
  prompting: boolean;
  outcome: {
    applied: PlannedAction[];
    skipped: PlannedAction[];
  };
}

export function reportApplyOutcome({
  ctx,
  plan,
  prompting,
  outcome,
}: ReportApplyOutcomeParams): { code: number; applied: boolean } {
  const changed = outcome.applied.filter(
    (action) => action.change.type !== 'none',
  ).length;
  const summary =
    changed === 0 && plan.manifestStatus !== 'unchanged'
      ? 'Updated the manifest.'
      : `Applied ${changed} change${changed === 1 ? '' : 's'}.`;
  if (prompting) clack.outro(summary);
  else ctx.print(summary);

  for (const action of outcome.skipped) {
    notify({
      ctx,
      prompting,
      message: `Skipped ${planPath({ plan, path: action.path, home: ctx.paths.home })}: ${action.reason ?? 'conflict'}`,
      level: 'warn',
    });
  }
  return { code: outcome.skipped.length > 0 ? 1 : 0, applied: true };
}

export async function confirmAndApply(
  ctx: Context,
  plan: Plan,
  options: ConfirmOptions,
): Promise<{ code: number; applied: boolean }> {
  const prompting = ctx.interactive && !options.yes;
  const decision = await confirmPlan({ ctx, plan, prompting, options });
  if (!decision.proceed) return { code: decision.code, applied: false };

  const outcome = await applyPlan(plan);
  return reportApplyOutcome({ ctx, plan, prompting, outcome });
}
