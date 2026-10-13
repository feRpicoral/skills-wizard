import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { unwrap } from '../prompts/selection.ts';
import { runAdd } from './add.ts';
import { runAdopt } from './adopt.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { runSync } from './sync.ts';
import { runUpdate } from './update.ts';

type MenuChoice =
  'global' | 'project' | 'add' | 'sync' | 'update' | 'adopt' | 'doctor';

export async function runMenu(ctx: Context): Promise<number> {
  clack.intro('agents-config');
  const choice = unwrap(
    await clack.select<MenuChoice>({
      message: 'What do you want to do?',
      options: [
        { value: 'global', label: 'Set up system-wide instructions' },
        { value: 'project', label: 'Set up a project' },
        { value: 'add', label: 'Search and add a third-party skill' },
        { value: 'sync', label: 'Sync the system-wide install' },
        { value: 'update', label: 'Update installed third-party skills' },
        { value: 'adopt', label: 'Adopt existing unmanaged skills' },
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
    case 'add':
      return runAdd(ctx, { yes: false, dryRun: false });
    case 'sync':
      return runSync(ctx, { scope: 'global', yes: false, dryRun: false });
    case 'update':
      return runUpdate(ctx, { yes: false, dryRun: false });
    case 'adopt':
      return runAdopt(ctx, { names: [], yes: false, dryRun: false });
    case 'doctor':
      return runDoctor(ctx, { scope: 'global' });
  }
}
