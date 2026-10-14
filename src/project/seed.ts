import type {
  ProjectDetection,
  PythonToolSignals,
  WorkspacePackageInfo,
} from './detect.ts';

const LIFECYCLE_SCRIPTS: ReadonlySet<string> = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
]);

const SCRIPT_ORDER: readonly string[] = [
  'dev',
  'start',
  'build',
  'typecheck',
  'lint',
  'lint:fix',
  'format',
  'format:check',
  'test',
  'test:unit',
  'test:e2e',
  'db:generate',
  'db:migrate',
  'db:push',
  'db:seed',
];

function orderedScriptEntries(
  scripts: Readonly<Record<string, string>>,
): [string, string][] {
  const entries = Object.entries(scripts).filter(
    ([name]) => !LIFECYCLE_SCRIPTS.has(name),
  );
  const rank = new Map(SCRIPT_ORDER.map((name, index) => [name, index]));

  return entries.sort(([left], [right]) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);

    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }

    if (leftRank !== undefined) return -1;

    if (rightRank !== undefined) return 1;

    return left.localeCompare(right);
  });
}

function runPrefix(pm: ProjectDetection['packageManager']): string {
  if (pm === 'npm') return 'npm run';

  if (pm === 'pnpm') return 'pnpm';

  if (pm === 'bun') return 'bun run';

  return 'yarn';
}

function execPrefix(pm: ProjectDetection['packageManager']): string {
  if (pm === 'npm') return 'npx';

  if (pm === 'pnpm') return 'pnpm exec';

  if (pm === 'bun') return 'bunx';

  return 'yarn';
}

/**
 * Wraps `raw` in a Markdown inline code span, collapsing line breaks and
 * choosing a backtick fence (with padding spaces when needed) that cannot
 * collide with backticks inside `raw`.
 */
export function formatCodeSpan(raw: string): string {
  const collapsed = raw.replace(/\s*\r?\n\s*/g, ' ').trim();
  const runs = collapsed.match(/`+/g);

  if (!runs) return `\`${collapsed}\``;

  const maxRun = Math.max(...runs.map((run) => run.length));
  const fence = '`'.repeat(maxRun + 1);
  const needsPadding = collapsed.startsWith('`') || collapsed.endsWith('`');

  return needsPadding
    ? `${fence} ${collapsed} ${fence}`
    : `${fence}${collapsed}${fence}`;
}

function buildNodeCommands(detection: ProjectDetection): string[] {
  const lines: string[] = [];
  const scripts = orderedScriptEntries(detection.scripts);
  const hasNodeSignals =
    scripts.length > 0 || detection.nvmrc !== undefined || detection.hasNx;

  if (!hasNodeSignals) return lines;

  const pm =
    detection.packageManager &&
    detection.packageManager !== 'uv' &&
    detection.packageManager !== 'poetry'
      ? detection.packageManager
      : 'yarn';

  if (detection.nvmrc !== undefined) {
    const setupCmd =
      pm === 'yarn'
        ? 'nvm use && corepack enable && yarn install'
        : `nvm use && ${pm} install`;
    lines.push(`- Setup: ${formatCodeSpan(setupCmd)}`);
  } else if (scripts.length > 0 || detection.hasNx) {
    lines.push(`- Install: ${formatCodeSpan(`${pm} install`)}`);
  }

  const prefix = runPrefix(pm);

  for (const [name, command] of scripts) {
    lines.push(
      `- ${formatCodeSpan(`${prefix} ${name}`)}: ${formatCodeSpan(command)}`,
    );
  }

  if (detection.hasNx && scripts.length === 0) {
    const exec = execPrefix(pm);
    lines.push(
      `- Run workspace targets: ${formatCodeSpan(`${exec} nx run-many -t lint,test,build`)}`,
    );
    lines.push(
      `- Run affected targets: ${formatCodeSpan(`${exec} nx affected -t lint,test,build`)}`,
    );
  }

  return lines;
}

function buildPythonToolLines(
  runnerPrefix: string,
  tools: PythonToolSignals | undefined,
  includeDefaultsWhenUnconfigured: boolean,
): string[] {
  const lines: string[] = [];
  const anyToolConfigured =
    tools !== undefined &&
    (tools.hasRuff || tools.hasMypy || tools.hasPyright || tools.hasPytest);
  const fallback = includeDefaultsWhenUnconfigured && !anyToolConfigured;

  if (fallback || tools?.hasRuff) {
    lines.push(
      `- Lint and format: \`${runnerPrefix} ruff check && ${runnerPrefix} ruff format --check\``,
    );
  }

  if (tools?.hasPyright && !tools.hasMypy) {
    lines.push(`- Typecheck: \`${runnerPrefix} pyright\``);
  } else if (fallback || tools?.hasMypy) {
    lines.push(`- Typecheck: \`${runnerPrefix} mypy --strict\``);
  }

  if (fallback || tools?.hasPytest) {
    lines.push(`- Run tests: \`${runnerPrefix} pytest\``);
  }

  return lines;
}

function buildPythonCommands(detection: ProjectDetection): string[] {
  if (!detection.hasPyproject) return [];

  if (
    detection.packageManager === 'poetry' ||
    detection.pythonPackageManager === 'poetry'
  ) {
    return [
      '- Install dependencies: `poetry install`',
      ...buildPythonToolLines('poetry run', detection.pythonTools, false),
    ];
  }

  return [
    '- Install dependencies: `uv sync`',
    ...buildPythonToolLines('uv run', detection.pythonTools, true),
  ];
}

function buildCommandsLines(detection: ProjectDetection): string[] {
  return [...buildNodeCommands(detection), ...buildPythonCommands(detection)];
}

function formatWorkspaceBullet(ws: WorkspacePackageInfo): string {
  const header =
    ws.name !== ws.relativePath
      ? `${formatCodeSpan(ws.relativePath)} (${formatCodeSpan(ws.name)})`
      : formatCodeSpan(ws.relativePath);
  return ws.description ? `- ${header}: ${ws.description}` : `- ${header}`;
}

/**
 * Builds the initial Markdown preamble (`# <name>`, description, `## Commands`,
 * and `## Workspaces`) seeded above the managed region when `AGENTS.md` is
 * first created or empty.
 */
export function buildProjectSeed(detection: ProjectDetection): string {
  const sections: string[] = [`# ${detection.name}`];

  if (detection.description) {
    sections.push(detection.description);
  }

  const commandLines = buildCommandsLines(detection);

  if (commandLines.length > 0) {
    sections.push(['## Commands', '', ...commandLines].join('\n'));
  }

  if (detection.workspaces.length > 0) {
    const workspaceLines = detection.workspaces.map(formatWorkspaceBullet);
    sections.push(['## Workspaces', '', ...workspaceLines].join('\n'));
  }

  return sections.join('\n\n');
}
