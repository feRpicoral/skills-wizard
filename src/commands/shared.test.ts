import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { Context } from '../context.ts';
import { tempPaths } from '../test-support/fixtures.ts';
import { setVariablesCommand } from './shared.ts';

async function projectCommand(
  t: TestContext,
  dir: (home: string) => string,
): Promise<string> {
  const paths = await tempPaths(t);
  const ctx: Context = {
    paths,
    repoRoot: paths.home,
    cwd: paths.home,
    searchPath: [],
    interactive: false,
    print: () => {},
  };
  const project = dir(paths.home);
  return setVariablesCommand({
    ctx,
    location: {
      scope: 'project',
      manifestPath: join(project, '.agents', 'agents-config.json'),
      project: { dir: project, title: 'app' },
    },
    names: ['githubUsername'],
  });
}

test('setVariablesCommand leaves plain project paths unquoted', async (t) => {
  const command = await projectCommand(t, (home) => join(home, 'code', 'app'));

  assert.equal(
    command,
    'agents-config init --project ~/code/app --var githubUsername=<value>',
  );
});

test('setVariablesCommand quotes project paths for POSIX shells', async (t) => {
  const command = await projectCommand(t, (home) =>
    join(home, "my 'app' (copy)"),
  );

  assert.equal(
    command,
    "agents-config init --project ~/'my '\\''app'\\'' (copy)' --var githubUsername=<value>",
  );
});

test('setVariablesCommand quotes project paths outside the home directory', async (t) => {
  const command = await projectCommand(t, () => '/srv/my app;rm');

  assert.match(command, / --project '\/srv\/my app;rm' /);
});
