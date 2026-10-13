#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'prettier';
const DISPLAY_NAME = 'Prettier';
const OLDER_REFERENCE = 'references/version-differences.md';
const OLDER_RISK =
  'options, CLI flags and formatting output in the other references may differ or not exist';
const RELEASE_NOTES =
  'https://github.com/prettier/prettier/blob/main/CHANGELOG.md';
const docsUrlFor = (version) =>
  `https://github.com/prettier/prettier/tree/${version}/docs`;

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/check-version.mjs [projectDir]

Compares the ${PACKAGE} version installed in projectDir (default: the current
directory) with the docs version this skill was written against, read from
metadata.docs-version in SKILL.md.

Prints one sentence for the agent, then one JSON line with: skill, package,
status (match | newer | older | declared | missing), docsVersion,
installedVersion, installedFrom, declaredRange, declaredIn, source,
staleInstall, action, reference, projectDir.

When ${PACKAGE} is not installed, the lower bound of the range declared in
package.json (dependencies or devDependencies) is compared instead.

Exit codes:
  0  a status was determined, including missing
  1  invalid arguments (projectDir does not exist or is not a directory)
  2  unexpected error (SKILL.md metadata unreadable, invalid package.json)`;

class UsageError extends Error {}

function readFrontmatter(skillFile) {
  const lines = readFileSync(skillFile, 'utf8').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error(`${skillFile} does not start with YAML frontmatter`);
  }
  const fields = {};
  let inMetadata = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return fields;
    if (/^\S/.test(line)) inMetadata = /^metadata:\s*$/.test(line);
    const match = line.match(/^(\s*)([\w-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (indent === '' && key === 'name') fields.name = value;
    if (indent !== '' && inMetadata) fields[`metadata.${key}`] = value;
  }
  throw new Error(`${skillFile} has an unterminated frontmatter block`);
}

function stripNpmAlias(range) {
  const trimmed = String(range).trim();
  if (!trimmed.startsWith('npm:')) return trimmed;
  const atIndex = trimmed.lastIndexOf('@');
  return atIndex > 4 ? trimmed.slice(atIndex + 1).trim() : '';
}

function parseVersion(text) {
  const cleaned = stripNpmAlias(text);
  const match = cleaned.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part ?? 0));
}

function compareVersions({ left, right }) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function isOutsideDeclaredRange({ installedParts, rawRange, lowerParts }) {
  if (compareVersions({ left: installedParts, right: lowerParts }) < 0) {
    return true;
  }
  const cleaned = stripNpmAlias(rawRange);
  if (/^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][\w.-]+)?$/.test(cleaned)) {
    if (lowerParts[0] > 0) return installedParts[0] !== lowerParts[0];
    if (lowerParts[1] > 0) {
      return installedParts[0] !== 0 || installedParts[1] !== lowerParts[1];
    }
    return (
      installedParts[0] !== 0 ||
      installedParts[1] !== 0 ||
      installedParts[2] !== lowerParts[2]
    );
  }
  if (/^~(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][\w.-]+)?$/.test(cleaned)) {
    return (
      installedParts[0] !== lowerParts[0] || installedParts[1] !== lowerParts[1]
    );
  }
  if (/^=?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.test(cleaned)) {
    return compareVersions({ left: installedParts, right: lowerParts }) !== 0;
  }
  return false;
}

const formatVersion = (parts) => parts.join('.');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`, { cause: error });
  }
}

function isWorkspaceRootDir(dir) {
  if (
    existsSync(join(dir, 'pnpm-workspace.yaml')) ||
    existsSync(join(dir, '.git'))
  ) {
    return true;
  }
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return Boolean(pkg && typeof pkg === 'object' && 'workspaces' in pkg);
  } catch {
    return false;
  }
}

function findWorkspaceCeiling(startDir) {
  let dir = startDir;
  let ceiling = startDir;
  for (;;) {
    if (isWorkspaceRootDir(dir)) {
      ceiling = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ceiling;
}

function findInstalled(projectDir) {
  const ceiling = findWorkspaceCeiling(projectDir);
  let dir = projectDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', PACKAGE, 'package.json');
    if (existsSync(candidate)) {
      const manifest = readJson(candidate);
      const version = String(manifest.version ?? '').trim();
      const parts = parseVersion(version);
      if (!parts) {
        throw new Error(`${candidate} has no usable "version" field`);
      }
      return { version, parts, manifestPath: candidate, installedFrom: dir };
    }
    if (dir === ceiling) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findDeclared(projectDir) {
  const manifestPath = join(projectDir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson(manifestPath);
  for (const field of ['dependencies', 'devDependencies']) {
    const range = manifest[field]?.[PACKAGE];
    if (typeof range === 'string') return { range, field };
  }
  return null;
}

function statusSentence({ status, version, docsVersion }) {
  const docs = `the ${DISPLAY_NAME} ${docsVersion} docs this skill was built from`;
  switch (status) {
    case 'match':
      return `the same version as ${docs}. Use the references as written.`;
    case 'newer':
      return (
        `newer than ${docs}. Tell the user this skill is out of date and ` +
        `recommend updating it from the docs at ${version} ` +
        `(${docsUrlFor(version)}); read the release notes and any migration ` +
        `guide for versions after ${docsVersion} (${RELEASE_NOTES}) before ` +
        `relying on the references, and keep helping with the task.`
      );
    case 'older':
      return (
        `older than ${docs}. Read ${OLDER_REFERENCE} first: ${OLDER_RISK} ` +
        `in ${version}.`
      );
    default:
      throw new Error(`unknown status ${status}`);
  }
}

const ACTIONS = {
  match: 'use-references',
  newer: 'tell-user-skill-outdated',
  older: 'read-version-differences',
  declared: 'install-and-recheck',
  missing: 'treat-as-new-setup',
};

function check(projectDir) {
  const frontmatter = readFrontmatter(join(skillDir, 'SKILL.md'));
  const docsVersion = frontmatter['metadata.docs-version'];
  const docsParts = docsVersion && parseVersion(docsVersion);
  if (!docsParts) {
    throw new Error('metadata.docs-version is missing from SKILL.md');
  }

  const installed = findInstalled(projectDir);
  const declared = findDeclared(projectDir);
  const declaredParts = declared && parseVersion(declared.range);
  const declaredText = declared
    ? `declared in package.json (${declared.field}: "${declared.range}")`
    : '';

  let status = 'missing';
  let source = null;
  let message;
  let staleInstall = false;

  if (installed) {
    source = 'node_modules';
    const installedParts = installed.parts;
    const order = compareVersions({ left: installedParts, right: docsParts });
    status = order === 0 ? 'match' : order > 0 ? 'newer' : 'older';
    message =
      `${PACKAGE} ${installed.version} is installed, ` +
      statusSentence({ status, version: installed.version, docsVersion });
    if (
      declared &&
      declaredParts &&
      isOutsideDeclaredRange({
        installedParts,
        rawRange: declared.range,
        lowerParts: declaredParts,
      })
    ) {
      staleInstall = true;
      const relation =
        compareVersions({ left: installedParts, right: declaredParts }) < 0
          ? 'below'
          : 'outside';
      message +=
        ` The installed version is ${relation} the range ${declaredText}, so ` +
        `node_modules is stale: reinstall from the lockfile before trusting ` +
        `local results or comparing them with CI.`;
    }
  } else if (declaredParts) {
    source = 'package.json';
    const lowerBound = formatVersion(declaredParts);
    const order = compareVersions({ left: declaredParts, right: docsParts });
    status = order === 0 ? 'match' : order > 0 ? 'newer' : 'older';
    message =
      `${PACKAGE} is ${declaredText} but not installed in ${projectDir}. ` +
      `Its lower bound ${lowerBound} is ` +
      statusSentence({ status, version: lowerBound, docsVersion }) +
      ` Install dependencies and re-run this check for the exact version.`;
  } else if (declared) {
    status = 'declared';
    source = 'package.json';
    message =
      `${PACKAGE} is ${declaredText} but not installed, and the range has no ` +
      `comparable version. Install dependencies and re-run this check.`;
  } else {
    message =
      `${PACKAGE} is neither installed nor declared in ${projectDir}. Treat ` +
      `this as a new setup; the references describe ${DISPLAY_NAME} ` +
      `${docsVersion}.`;
  }

  if (!installed && existsSync(join(projectDir, '.pnp.cjs'))) {
    message +=
      ' This project uses Yarn Plug\'n\'Play; run the check with "yarn node"' +
      ' so the installed version can be resolved.';
  }

  return {
    message,
    result: {
      skill: frontmatter.name ?? null,
      package: PACKAGE,
      status,
      docsVersion,
      installedVersion: installed?.version ?? null,
      installedFrom: installed?.installedFrom ?? null,
      declaredRange: declared?.range ?? null,
      declaredIn: declared?.field ?? null,
      source,
      staleInstall,
      action: ACTIONS[status],
      reference: status === 'older' ? join(skillDir, OLDER_REFERENCE) : null,
      projectDir,
    },
  };
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const unknown = argv.filter((arg) => arg.startsWith('-'));
  if (unknown.length > 0 || positional.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${argv.join(' ')}. Pass at most one projectDir.`,
    );
  }
  const projectDir = resolve(positional[0] ?? process.cwd());
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new UsageError(`projectDir is not a directory: ${projectDir}`);
  }
  const { message, result } = check(projectDir);
  process.stdout.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`check-version: ${error.message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`check-version: ${error.message}\n`);
    process.exitCode = 2;
  }
}
