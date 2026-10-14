import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { RunnerError } from '../../errors.ts';
import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import { stagedSkillDir } from '../workspace.ts';
import { createFakeRunner, fakeTriggerDecision } from './index.ts';

test('the fake runner supports preflight and sandboxSupported overrides', async () => {
  await createFakeRunner().preflight?.();
  await assert.rejects(
    createFakeRunner({
      onPreflight: () => {
        throw new RunnerError('fake runner unavailable');
      },
    }).preflight?.() ?? Promise.resolve(),
    /fake runner unavailable/,
  );
  assert.equal(
    createFakeRunner({ sandboxSupported: false }).sandboxSupported,
    false,
  );
});

test('the fake runner passes error and usageReported through', async (t) => {
  const root = await tempDir(t);
  const runner = createFakeRunner({
    onTask: () => ({ error: 'simulated failure', usageReported: false }),
  });
  const result = await runner.runTask({
    prompt: 'Hello',
    workdir: root,
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  assert.equal(result.error, 'simulated failure');
  assert.equal(result.usageReported, false);
});

test('the fake runner sees the skill only when it is staged in .agents/skills and not excluded', async (t) => {
  const root = await tempDir(t);
  const runner = createFakeRunner();
  const run = (workdir: string, excludeSkill?: boolean) =>
    runner.runTask({
      prompt: 'Hello',
      workdir,
      runDir: join(root, 'run'),
      skillName: 'demo-skill',
      timeoutSeconds: 10,
      excludeSkill,
    });
  const staged = join(root, 'staged');
  await writeFiles(staged, {
    '.agents/skills/demo-skill/SKILL.md': '---\nname: demo-skill\n---\n',
    // Nothing writes this file anymore, so it must not hide the skill.
    '.agents/skills.json': JSON.stringify({ exclude: ['demo-skill'] }),
  });
  const baseline = join(root, 'baseline');
  await writeFiles(baseline, { 'input.txt': 'hello\n' });

  assert.equal((await run(staged)).triggered, true);
  assert.equal((await run(staged, true)).triggered, false);
  assert.equal((await run(baseline)).triggered, false);
  assert.match((await run(baseline)).response, /without skill/);
});

test('the fake runner triggers by a stable prompt hash, ignoring labels, and only when the skill is staged', async (t) => {
  const prompts = Array.from({ length: 40 }, (_, i) => `Request number ${i}`);
  const decisions = prompts.map((prompt) =>
    fakeTriggerDecision({ prompt, skillName: 'demo-skill' }),
  );
  const triggeredCount = decisions.filter(Boolean).length;
  assert.ok(triggeredCount > 5 && triggeredCount < 35, `${triggeredCount}/40`);
  assert.deepEqual(
    prompts.map((prompt) =>
      fakeTriggerDecision({ prompt, skillName: 'demo-skill' }),
    ),
    decisions,
  );

  const root = await tempDir(t);
  const staged = join(root, 'staged');
  const bare = join(root, 'bare');
  await writeFiles(
    stagedSkillDir({
      workdir: staged,
      runner: 'fake',
      skillName: 'demo-skill',
    }),
    { 'SKILL.md': '---\nname: demo-skill\n---\n' },
  );
  await writeFiles(bare, { 'README.md': 'x' });
  const runner = createFakeRunner();
  const run = async (workdir: string, prompt: string, excludeSkill = false) =>
    (
      await runner.runTask({
        prompt,
        workdir,
        runDir: join(root, 'run'),
        skillName: 'demo-skill',
        timeoutSeconds: 10,
        excludeSkill,
      })
    ).triggered;

  const triggeringPrompt = prompts[decisions.indexOf(true)] ?? '';
  const quietPrompt = prompts[decisions.indexOf(false)] ?? '';
  assert.equal(await run(staged, triggeringPrompt), true);
  assert.equal(await run(staged, quietPrompt), false);
  assert.equal(await run(staged, triggeringPrompt, true), false);
  assert.equal(await run(bare, triggeringPrompt), false);
  // A "[negative]" label is not special any more.
  const labelled = `[negative] ${triggeringPrompt}`;
  assert.equal(
    await run(staged, labelled),
    fakeTriggerDecision({ prompt: labelled, skillName: 'demo-skill' }),
  );
});
