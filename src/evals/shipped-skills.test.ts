import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import {
  parseBenchmarkSummary,
  parseTriggerBenchmarkSummary,
} from './aggregate.ts';
import { loadEvalSuite, loadTriggerQueries } from './cases.ts';

const SKILLS_DIR = join(import.meta.dirname, '..', '..', 'skills');

async function shippedSkillDirs(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_DIR, entry.name));
}

async function filesNamed(dir: string, name: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => join(entry.parentPath, entry.name));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('every shipped skill eval suite and trigger query file loads', async () => {
  const skillDirs = await shippedSkillDirs();
  assert.ok(skillDirs.length > 0);

  for (const skillDir of skillDirs) {
    const suite = await loadEvalSuite(skillDir);
    const queries = await loadTriggerQueries(skillDir);

    assert.ok(suite.evals.length >= 3, `${skillDir} has fewer than 3 cases`);
    assert.ok(
      queries.filter((query) => query.should_trigger).length >= 10,
      `${skillDir} has fewer than 10 positive trigger queries`,
    );
    assert.ok(
      queries.filter((query) => !query.should_trigger).length >= 10,
      `${skillDir} has fewer than 10 negative trigger queries`,
    );
  }
});

test('shipped benchmark and trigger fixtures match the artifact schemas', async () => {
  const filesDir = join(SKILLS_DIR, 'skill-evaluator', 'evals', 'files');
  const benchmarks = await filesNamed(filesDir, 'benchmark.json');
  const triggers = await filesNamed(filesDir, 'triggers.json');
  assert.ok(benchmarks.length > 0);
  assert.ok(triggers.length > 0);

  for (const path of benchmarks) {
    const summary = parseBenchmarkSummary({
      raw: await readJson(path),
      sourcePath: relative(SKILLS_DIR, path),
    });
    assert.equal(summary.metadata.skill_name, 'dockerfile-hardener');
  }
  const splits = [];
  for (const path of triggers) {
    const summary = parseTriggerBenchmarkSummary({
      raw: await readJson(path),
      sourcePath: relative(SKILLS_DIR, path),
    });
    splits.push(summary.metadata.split);
  }
  assert.deepEqual(splits.sort(), ['train', 'validation']);
});
