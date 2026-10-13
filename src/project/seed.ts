import type { ProjectDetection, WorkspacePackageInfo } from './detect.ts';

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

function buildCommandsLines(detection: ProjectDetection): string[] {
  const lines: string[] = [];
  const scripts = orderedScriptEntries(detection.scripts);
  const hasNodeSignals =
    scripts.length > 0 || detection.nvmrc !== undefined || detection.hasNx;

  if (hasNodeSignals) {
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
  } else if (detection.hasPyproject && detection.packageManager === 'poetry') {
    lines.push('- Install dependencies: `poetry install`');
    if (detection.pythonTools?.hasRuff) {
      lines.push(
        '- Lint and format: `poetry run ruff check && poetry run ruff format --check`',
      );
    }
    if (detection.pythonTools?.hasPyright && !detection.pythonTools.hasMypy) {
      lines.push('- Typecheck: `poetry run pyright`');
    } else if (detection.pythonTools?.hasMypy) {
      lines.push('- Typecheck: `poetry run mypy --strict`');
    }
    if (detection.pythonTools?.hasPytest) {
      lines.push('- Run tests: `poetry run pytest`');
    }
  } else if (
    detection.hasPyproject &&
    (detection.packageManager === 'uv' ||
      detection.packageManager === undefined)
  ) {
    const tools = detection.pythonTools;
    const anyToolConfigured =
      tools !== undefined &&
      (tools.hasRuff || tools.hasMypy || tools.hasPyright || tools.hasPytest);
    lines.push('- Install dependencies: `uv sync`');
    if (!anyToolConfigured || tools.hasRuff) {
      lines.push(
        '- Lint and format: `uv run ruff check && uv run ruff format --check`',
      );
    }
    if (tools?.hasPyright && !tools.hasMypy) {
      lines.push('- Typecheck: `uv run pyright`');
    } else if (!anyToolConfigured || tools?.hasMypy) {
      lines.push('- Typecheck: `uv run mypy --strict`');
    }
    if (!anyToolConfigured || tools.hasPytest) {
      lines.push('- Run tests: `uv run pytest`');
    }
  }

  return lines;
}

function formatWorkspaceBullet(ws: WorkspacePackageInfo): string {
  const header =
    ws.name !== ws.relativePath
      ? `${formatCodeSpan(ws.relativePath)} (${formatCodeSpan(ws.name)})`
      : formatCodeSpan(ws.relativePath);
  return ws.description ? `- ${header}: ${ws.description}` : `- ${header}`;
}

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
