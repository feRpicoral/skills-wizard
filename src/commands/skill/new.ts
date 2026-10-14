import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Context } from '../../context.ts';
import { UsageError } from '../../errors.ts';
import { lstatIfExists } from '../../install/fs.ts';
import { isSkillName, validateSkill } from '../../skills/validate.ts';
import type { SkillCommandOptions } from '../skill.ts';
import { printReport } from './validate.ts';

export type SkillTemplate = 'basic' | 'scripted' | 'reference-heavy';

const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  'basic',
  'scripted',
  'reference-heavy',
];

export function parseTemplate(value: string | undefined): SkillTemplate {
  if (value === undefined) return 'basic';

  const found = SKILL_TEMPLATES.find((item) => item === value);
  if (!found) {
    throw new UsageError(
      `--template must be one of ${SKILL_TEMPLATES.join(', ')}, got "${value}"`,
    );
  }

  return found;
}

interface RenderScaffoldSkillMdParams {
  name: string;
  template: SkillTemplate;
}

export function renderScaffoldSkillMd({
  name,
  template,
}: RenderScaffoldSkillMdParams): string {
  const title = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const lines = [
    '---',
    `name: ${name}`,
    `description: Handles ${name} workflows and configuration. Use when the user asks to set up, inspect, or troubleshoot ${name}.`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Overview',
    '',
    `Follow this workflow when completing ${name} tasks.`,
    '',
    '## Workflow',
    '',
    '1. Inspect the existing project files before making changes.',
    '2. Apply the minimal, standard configuration required for the task.',
    '3. Verify the result with a deterministic check before finishing.',
  ];

  if (template === 'scripted') {
    lines.push(
      '',
      '## Helper Scripts',
      '',
      '- Run `node scripts/check.mjs` to validate the target files.',
      '- Read [references/guide.md](references/guide.md) for detailed edge cases.',
    );
  } else if (template === 'reference-heavy') {
    lines.push(
      '',
      '## References',
      '',
      '- Read [references/reference.md](references/reference.md) for configuration options.',
      '- Read [references/examples.md](references/examples.md) for canonical examples.',
    );
  }

  lines.push('');

  return lines.join('\n');
}

interface RunSkillNewParams {
  ctx: Context;
  name: string;
  template: SkillTemplate;
  withEvals: boolean;
}

export async function runSkillNew({
  ctx,
  name: rawName,
  template,
  withEvals,
}: RunSkillNewParams): Promise<number> {
  const name = rawName.startsWith('skills/')
    ? rawName.slice('skills/'.length)
    : rawName;

  if (!isSkillName(name)) {
    throw new UsageError(
      `Invalid skill name "${rawName}". Use lowercase alphanumeric characters and single hyphens.`,
    );
  }

  const skillDir = join(ctx.cwd, 'skills', name);
  if ((await lstatIfExists(skillDir)) !== null) {
    throw new UsageError(`Skill directory already exists: skills/${name}`);
  }

  const files: Record<string, string> = {
    'SKILL.md': renderScaffoldSkillMd({ name, template }),
  };

  if (template === 'scripted') {
    files['scripts/check.mjs'] = [
      '#!/usr/bin/env node',
      'process.stdout.write("ok\\n");',
      '',
    ].join('\n');
    files['references/guide.md'] = [
      `# ${name} Guide`,
      '',
      'Detailed edge-case notes and troubleshooting steps.',
      '',
    ].join('\n');
  } else if (template === 'reference-heavy') {
    files['references/reference.md'] = [
      `# ${name} Reference`,
      '',
      'Detailed option reference and constraints.',
      '',
    ].join('\n');
    files['references/examples.md'] = [
      `# ${name} Examples`,
      '',
      'Canonical examples and expected outputs.',
      '',
    ].join('\n');
  }

  if (withEvals) {
    files['evals/files/starter-case/sample.txt'] = `Sample input for ${name}\n`;
    files['evals/evals.json'] = `${JSON.stringify(
      {
        skill_name: name,
        evals: [
          {
            id: 'starter-case',
            prompt: `Can you run sample.txt through ${name} and save the result to output.md?`,
            expected_output: `output.md contains sample.txt processed following the ${name} instructions.`,
            files: ['evals/files/starter-case/sample.txt'],
            assertions: [
              `output.md reflects the ${name} workflow applied to the content of sample.txt`,
              { type: 'file_exists', path: 'output.md' },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`;
    files['evals/trigger_queries.json'] = `${JSON.stringify(
      [
        {
          query: `Can you set up ${name} for this repo? I'm not sure where to start.`,
          should_trigger: true,
        },
        {
          query: 'Summarize what the last three commits in this repo changed.',
          should_trigger: false,
        },
      ],
      null,
      2,
    )}\n`;
  }

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(skillDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);

    if (relPath.startsWith('scripts/')) {
      await chmod(fullPath, 0o755);
    }
  }

  const report = await validateSkill(skillDir, { strict: true });
  printReport({ ctx, label: name, report });

  ctx.print(
    `Scaffolded skills/${name} (template: ${template}${withEvals ? ', with evals' : ''}).`,
  );

  return report.errors.length > 0 ? 1 : 0;
}

export async function runSkillNewCommand(
  ctx: Context,
  { paths, template: rawTemplate, withEvals = false }: SkillCommandOptions,
): Promise<number> {
  if (paths.length !== 1 || !paths[0]) {
    throw new UsageError(
      'Usage: skills-wizard skill new <name> [--template basic|scripted|reference-heavy] [--with-evals]',
    );
  }

  const template = parseTemplate(rawTemplate);
  return runSkillNew({
    ctx,
    name: paths[0],
    template,
    withEvals,
  });
}
