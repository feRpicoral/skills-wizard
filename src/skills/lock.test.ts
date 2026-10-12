import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tempPaths, writeFiles } from '../test-support/fixtures.ts';
import { readSkillLock } from './lock.ts';

test('readSkillLock lists locked skills with their GitHub upstream', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.agents/.skill-lock.json': JSON.stringify({
      version: 3,
      skills: {
        mermaid: {
          source: 'owner/mermaid',
          sourceType: 'github',
          skillPath: 'SKILL.md',
        },
        deploy: {
          source: 'owner/tools',
          sourceType: 'github',
          skillPath: 'skills/deploy/SKILL.md',
        },
        local: { source: '/somewhere', sourceType: 'local' },
      },
    }),
  });

  const lock = await readSkillLock(paths);

  assert.deepEqual(
    lock,
    new Map([
      ['mermaid', { repo: 'owner/mermaid', path: '.' }],
      ['deploy', { repo: 'owner/tools', path: 'skills/deploy' }],
      ['local', {}],
    ]),
  );
});

test('an unreadable skill lock counts as empty', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { '.agents/.skill-lock.json': '{ broken' });

  const lock = await readSkillLock(paths);

  assert.equal(lock.size, 0);
});
