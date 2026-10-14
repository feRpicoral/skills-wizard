import { isDeepStrictEqual } from 'node:util';

import { CancelledError } from '../errors.ts';
import { answeredPrompts } from './selection.ts';

/**
 * One step of a wizard. `run` receives the answer it gave last time, when every
 * answer before it is unchanged since then, so a revisited prompt can start
 * from the user's previous selection instead of the computed default.
 */
export interface WizardStep {
  run: (remembered: unknown) => Promise<unknown>;
}

/** Wraps a typed step function as a `WizardStep`. */
export function wizardStep<T>(
  run: (remembered: T | undefined) => Promise<T>,
): WizardStep {
  return { run: (remembered) => run(remembered as T | undefined) };
}

export interface RunWizardOptions {
  /** Counts answered prompts, to tell steps that asked something from steps that did not. */
  answered?: () => number;
}

/**
 * Runs `steps` in order. Cancelling a prompt (esc) goes back to the closest
 * earlier step that asked something, which runs again with its previous answer
 * remembered; cancelling a later prompt of a step that already asked something
 * runs that step again. Cancelling before anything was answered throws the
 * `CancelledError`.
 */
export async function runWizard(
  steps: readonly WizardStep[],
  { answered = answeredPrompts }: RunWizardOptions = {},
): Promise<void> {
  const answers: unknown[] = [];
  const upstream: unknown[][] = [];
  const prompted: boolean[] = [];
  let index = 0;

  while (index < steps.length) {
    const step = steps[index];
    if (!step) break;

    const before = answered();
    const current = answers.slice(0, index);
    const recorded = upstream[index];
    const remembered =
      recorded !== undefined && isDeepStrictEqual(recorded, current)
        ? answers[index]
        : undefined;

    try {
      answers[index] = await step.run(remembered);
      upstream[index] = current;
      prompted[index] = answered() > before;
      index += 1;
    } catch (error) {
      if (!(error instanceof CancelledError)) throw error;
      if (answered() > before) continue;

      let back = index - 1;
      while (back >= 0 && !prompted[back]) back -= 1;

      if (back < 0) throw error;

      index = back;
    }
  }
}
