import assert from 'node:assert/strict';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { scanInstalledSkills } from './collisions.ts';

test('scanInstalledSkills merges tool links to ~/.agents/skills and flags frontmatter name clashes across different folders', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.agents/skills/pretty-mermaid/SKILL.md': skillSource('pretty-mermaid'),
    '.gemini/config/skills/skill_creator/SKILL.md':
      skillSource('skill-creator'),
    '.gemini/config/plugins/dev/skills/skill-creator/SKILL.md':
      skillSource('skill-creator'),
  });
  await mkdir(join(paths.geminiHome, 'config', 'skills'), { recursive: true });
  await symlink(
    join(paths.skillsDir, 'pretty-mermaid'),
    join(paths.geminiHome, 'config', 'skills', 'pretty-mermaid'),
  );

  const scan = await scanInstalledSkills(paths, null);

  assert.deepEqual(
    scan.unmanaged.map((skill) => ({
      name: skill.name,
      locations: skill.locations,
    })),
    [
      {
        name: 'pretty-mermaid',
        locations: [
          join(paths.skillsDir, 'pretty-mermaid'),
          join(paths.geminiHome, 'config', 'skills', 'pretty-mermaid'),
        ],
      },
      {
        name: 'skill-creator',
        locations: [
          join(paths.geminiHome, 'config', 'skills', 'skill_creator'),
        ],
      },
    ],
  );
  assert.deepEqual(scan.collisions, [
    {
      name: 'skill-creator',
      paths: [
        join(paths.geminiHome, 'config', 'skills', 'skill_creator'),
        join(
          paths.geminiHome,
          'config',
          'plugins',
          'dev',
          'skills',
          'skill-creator',
        ),
      ],
    },
  ]);
});

test('scanInstalledSkills skips broken and unreadable unmanaged symlink targets without throwing', async (t) => {
  const paths = await tempPaths(t);
  const restricted = await tempDir(t);
  await writeFiles(restricted, {
    'secret/SKILL.md': skillSource('secret'),
  });
  await mkdir(join(paths.geminiHome, 'config', 'skills'), { recursive: true });
  await symlink(
    join(restricted, 'missing'),
    join(paths.geminiHome, 'config', 'skills', 'dangling'),
  );
  await symlink(
    join(restricted, 'secret'),
    join(paths.geminiHome, 'config', 'skills', 'unreadable'),
  );
  await chmod(join(restricted, 'secret'), 0o000);
  let scan;
  try {
    scan = await scanInstalledSkills(paths, null);
  } finally {
    await chmod(join(restricted, 'secret'), 0o755);
  }

  assert.equal(scan.skills.length, 0);
  assert.deepEqual(scan.skipped, [
    join(paths.geminiHome, 'config', 'skills', 'dangling'),
    join(paths.geminiHome, 'config', 'skills', 'unreadable'),
  ]);
});

test('scanInstalledSkills reads a tool skills folder that links to ~/.agents/skills once', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.agents/skills/notes/SKILL.md': skillSource('notes'),
  });
  await mkdir(paths.claudeHome, { recursive: true });
  await symlink(paths.skillsDir, join(paths.claudeHome, 'skills'));

  const scan = await scanInstalledSkills(paths, null);

  assert.deepEqual(
    {
      collisions: scan.collisions,
      unmanaged: scan.unmanaged.map((skill) => skill.locations),
    },
    { collisions: [], unmanaged: [[join(paths.skillsDir, 'notes')]] },
  );
});

test('scanInstalledSkills merges links that reach the same folder under another name', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.agents/skills/notes/SKILL.md': skillSource('notes'),
  });
  await mkdir(join(paths.claudeHome, 'skills'), { recursive: true });
  await symlink(
    join(paths.skillsDir, 'notes'),
    join(paths.claudeHome, 'skills', 'my-notes'),
  );

  const scan = await scanInstalledSkills(paths, null);

  assert.deepEqual(
    {
      collisions: scan.collisions,
      unmanaged: scan.unmanaged.map((skill) => skill.locations),
    },
    {
      collisions: [],
      unmanaged: [
        [
          join(paths.skillsDir, 'notes'),
          join(paths.claudeHome, 'skills', 'my-notes'),
        ],
      ],
    },
  );
});
