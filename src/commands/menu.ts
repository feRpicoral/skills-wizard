import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { unwrap } from '../prompts/selection.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { runSync } from './sync.ts';

type MenuChoice = 'global' | 'project' | 'sync' | 'doctor';

export async function runMenu(ctx: Context): Promise<number> {
  clack.intro('agents-config');
  const choice = unwrap(
    await clack.select<MenuChoice>({
      message: 'What do you want to do?',
      options: [
        { value: 'global', label: 'Set up system-wide instructions' },
        { value: 'project', label: 'Set up a project' },
        { value: 'sync', label: 'Sync the system-wide install' },
        { value: 'doctor', label: 'Check the system-wide install' },
      ],
    }),
  );

  switch (choice) {
    case 'global':
    case 'project':
      return runInit(ctx, {
        scope: choice,
        variables: {},
        yes: false,
        dryRun: false,
      });
    case 'sync':
      return runSync(ctx, { scope: 'global', yes: false, dryRun: false });
    case 'doctor':
      return runDoctor(ctx, { scope: 'global' });
  }
}
