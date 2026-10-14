#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usageFor(pkg = '<package>') {
  return `Usage: node scripts/check-version.mjs [projectDir]

Compares the ${pkg} version installed in projectDir (default: the current
directory) with the docs version this skill was written against, read from
metadata.docs-version in SKILL.md.

Prints one sentence for the agent, then one JSON line with: skill, package,
status (match | newer | older | declared | missing), docsVersion,
installedVersion, installedFrom, declaredRange, declaredIn, source,
staleInstall, action, reference, projectDir.

When ${pkg} is not installed, the lower bound of the range declared in
package.json (dependencies or devDependencies) is compared instead.

Exit codes:
  0  a status was determined, including missing
  1  invalid arguments (projectDir does not exist or is not a directory)
  2  unexpected error (SKILL.md metadata unreadable, invalid package.json)`;
}

class UsageError extends Error {}

function unquoteYamlValue(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function readFrontmatter(skillFile) {
  const lines = readFileSync(skillFile, 'utf8').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error(`${skillFile} does not start with YAML frontmatter`);
  }
  const fields = {};
  let inMetadata = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return fields;
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (/^\S/.test(line)) {
      inMetadata = /^metadata:\s*(?:#.*)?$/.test(line);
    }
    const match = line.match(/^(\s*)([\w-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    const value = unquoteYamlValue(rawValue);
    if (indent === '' && key === 'name') fields.name = value;
    if (indent !== '' && inMetadata) fields[`metadata.${key}`] = value;
  }
  throw new Error(`${skillFile} has an unterminated frontmatter block`);
}

function loadSkillConfig() {
  const frontmatter = readFrontmatter(join(skillDir, 'SKILL.md'));
  const pkg = frontmatter['metadata.package'];
  const displayName = frontmatter['metadata.display-name'];
  const docsVersion = frontmatter['metadata.docs-version'];
  const olderReference =
    frontmatter['metadata.older-reference'] ??
    'references/version-differences.md';
  const olderRisk = frontmatter['metadata.older-risk'];
  const releaseNotes = frontmatter['metadata.release-notes'];
  const docsUrlTemplate = frontmatter['metadata.docs-url-template'];

  if (
    !pkg ||
    !displayName ||
    !docsVersion ||
    !olderRisk ||
    !releaseNotes ||
    !docsUrlTemplate
  ) {
    throw new Error(
      'SKILL.md metadata is missing required check-version fields',
    );
  }
  return {
    skill: frontmatter.name ?? null,
    pkg,
    displayName,
    docsVersion,
    olderReference,
    olderRisk,
    releaseNotes,
    docsUrlFor: (version) => docsUrlTemplate.replaceAll('{version}', version),
  };
}

function stripNpmAlias(range) {
  const trimmed = String(range).trim();
  if (!trimmed.startsWith('npm:')) return trimmed;
  const atIndex = trimmed.lastIndexOf('@');
  return atIndex > 4 ? trimmed.slice(atIndex + 1).trim() : '';
}

const UNCOMPARABLE_PREFIXES = [
  'git+',
  'git:',
  'http:',
  'https:',
  'github:',
  'bitbucket:',
  'gitlab:',
  'file:',
  'link:',
  'workspace:',
  'catalog:',
  'patch:',
];

function isUncomparableSpecifier(cleaned) {
  const lower = cleaned.toLowerCase();
  if (!lower || lower === '*' || lower === 'latest' || lower === 'next') {
    return true;
  }
  if (UNCOMPARABLE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return cleaned.includes('/');
}

function parseSingleVersion(text) {
  const cleaned = stripNpmAlias(text);
  if (isUncomparableSpecifier(cleaned)) return null;
  const match = cleaned.match(
    /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/,
  );
  if (!match) return null;
  return [
    Number(match[1] ?? 0),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
    match[4] ?? null,
  ];
}

function comparePrerelease(leftPre, rightPre) {
  if (!leftPre && !rightPre) return 0;
  if (leftPre && !rightPre) return -1;
  if (!leftPre && rightPre) return 1;
  const leftParts = String(leftPre).split('.');
  const rightParts = String(rightPre).split('.');
  const len = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < len; i += 1) {
    const a = leftParts[i];
    const b = rightParts[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNum = /^\d+$/.test(a) ? Number(a) : null;
    const bNum = /^\d+$/.test(b) ? Number(b) : null;
    if (aNum !== null && bNum !== null) return aNum > bNum ? 1 : -1;
    if (aNum !== null) return -1;
    if (bNum !== null) return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function compareVersions({ left, right }) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return comparePrerelease(left[3], right[3]);
}

function parseVersion(text) {
  const branches = String(text)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
  if (branches.length === 0) return null;
  let lowest = null;
  for (const branch of branches) {
    const parsed = parseSingleVersion(branch);
    if (!parsed) return null;
    if (!lowest || compareVersions({ left: parsed, right: lowest }) < 0) {
      lowest = parsed;
    }
  }
  return lowest;
}

function isOutsideSingleBranch(installedParts, branch) {
  const cleaned = stripNpmAlias(branch);
  const lowerParts = parseSingleVersion(cleaned);
  if (!lowerParts) return false;
  if (compareVersions({ left: installedParts, right: lowerParts }) < 0) {
    return true;
  }
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
  const tildeMatch = cleaned.match(
    /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][\w.-]+)?$/,
  );
  if (tildeMatch) {
    if (tildeMatch[2] === undefined) {
      return installedParts[0] !== lowerParts[0];
    }
    return (
      installedParts[0] !== lowerParts[0] || installedParts[1] !== lowerParts[1]
    );
  }
  if (/^=?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.test(cleaned)) {
    return compareVersions({ left: installedParts, right: lowerParts }) !== 0;
  }
  return false;
}

function isOutsideDeclaredRange({ installedParts, rawRange }) {
  const branches = String(rawRange)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
  if (branches.length === 0) return false;
  return branches.every((branch) =>
    isOutsideSingleBranch(installedParts, branch),
  );
}

function formatVersion(parts) {
  const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
  return parts[3] ? `${base}-${parts[3]}` : base;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`, { cause: error });
  }
}

function declaresWorkspaces(dir) {
  if (
    existsSync(join(dir, 'pnpm-workspace.yaml')) ||
    existsSync(join(dir, 'nx.json'))
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
  let packageBoundary = null;
  for (;;) {
    if (declaresWorkspaces(dir)) {
      return dir;
    }
    if (packageBoundary === null && existsSync(join(dir, 'package.json'))) {
      packageBoundary = dir;
    }
    if (existsSync(join(dir, '.git'))) {
      return packageBoundary ?? dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageBoundary ?? startDir;
}

function findInstalled(projectDir, pkg) {
  const ceiling = findWorkspaceCeiling(projectDir);
  let dir = projectDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) {
      const manifest = readJson(candidate);
      const version = String(manifest.version ?? '').trim();
      const parts = parseSingleVersion(version);
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

function findDeclared(projectDir, pkg) {
  const manifestPath = join(projectDir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson(manifestPath);
  for (const field of ['dependencies', 'devDependencies']) {
    const range = manifest[field]?.[pkg];
    if (typeof range === 'string') return { range, field };
  }
  return null;
}

function statusSentence({ config, status, version }) {
  const docs = `the ${config.displayName} ${config.docsVersion} docs this skill was built from`;
  switch (status) {
    case 'match':
      return `the same version as ${docs}. Use the references as written.`;
    case 'newer':
      return (
        `newer than ${docs}. Tell the user this skill is out of date and ` +
        `recommend updating it from the docs at ${version} ` +
        `(${config.docsUrlFor(version)}); read the release notes and any migration ` +
        `guide for versions after ${config.docsVersion} (${config.releaseNotes}) before ` +
        `relying on the references, and keep helping with the task.`
      );
    case 'older':
      return (
        `older than ${docs}. Read ${config.olderReference} first: ${config.olderRisk} ` +
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

function resolveVersionState({ installed, declared, docsParts }) {
  const declaredParts = declared ? parseVersion(declared.range) : null;
  if (installed) {
    const installedParts = installed.parts;
    const order = compareVersions({ left: installedParts, right: docsParts });
    const status = order === 0 ? 'match' : order > 0 ? 'newer' : 'older';
    const staleInstall = Boolean(
      declared &&
      declaredParts &&
      isOutsideDeclaredRange({
        installedParts,
        rawRange: declared.range,
      }),
    );
    const staleRelation =
      staleInstall && declaredParts
        ? compareVersions({ left: installedParts, right: declaredParts }) < 0
          ? 'below'
          : 'outside'
        : null;
    return {
      status,
      source: 'node_modules',
      staleInstall,
      staleRelation,
      lowerBound: null,
    };
  }
  if (declaredParts) {
    const order = compareVersions({ left: declaredParts, right: docsParts });
    const status = order === 0 ? 'match' : order > 0 ? 'newer' : 'older';
    return {
      status,
      source: 'package.json',
      staleInstall: false,
      staleRelation: null,
      lowerBound: formatVersion(declaredParts),
    };
  }
  if (declared) {
    return {
      status: 'declared',
      source: 'package.json',
      staleInstall: false,
      staleRelation: null,
      lowerBound: null,
    };
  }
  return {
    status: 'missing',
    source: null,
    staleInstall: false,
    staleRelation: null,
    lowerBound: null,
  };
}

function formatAgentMessage({
  config,
  projectDir,
  installed,
  declared,
  state,
}) {
  const declaredText = declared
    ? `declared in package.json (${declared.field}: "${declared.range}")`
    : '';
  let message;

  if (installed) {
    message =
      `${config.pkg} ${installed.version} is installed, ` +
      statusSentence({
        config,
        status: state.status,
        version: installed.version,
      });
    if (state.staleInstall) {
      message +=
        ` The installed version is ${state.staleRelation} the range ${declaredText}, so ` +
        `node_modules is stale: reinstall from the lockfile before trusting ` +
        `local results or comparing them with CI.`;
    }
  } else if (state.lowerBound) {
    message =
      `${config.pkg} is ${declaredText} but not installed in ${projectDir}. ` +
      `Its lower bound ${state.lowerBound} is ` +
      statusSentence({
        config,
        status: state.status,
        version: state.lowerBound,
      }) +
      ` Install dependencies and re-run this check for the exact version.`;
  } else if (declared) {
    message =
      `${config.pkg} is ${declaredText} but not installed, and the range has no ` +
      `comparable version. Install dependencies and re-run this check.`;
  } else {
    message =
      `${config.pkg} is neither installed nor declared in ${projectDir}. Treat ` +
      `this as a new setup; the references describe ${config.displayName} ` +
      `${config.docsVersion}.`;
  }

  if (!installed && existsSync(join(projectDir, '.pnp.cjs'))) {
    message +=
      ' This project uses Yarn Plug\'n\'Play; run the check with "yarn node"' +
      ' so the installed version can be resolved.';
  }

  return message;
}

function check(projectDir, config) {
  const docsParts = parseSingleVersion(config.docsVersion);
  if (!docsParts) {
    throw new Error('metadata.docs-version is missing or invalid in SKILL.md');
  }

  const installed = findInstalled(projectDir, config.pkg);
  const declared = findDeclared(projectDir, config.pkg);
  const state = resolveVersionState({ installed, declared, docsParts });
  const message = formatAgentMessage({
    config,
    projectDir,
    installed,
    declared,
    state,
  });

  return {
    message,
    result: {
      skill: config.skill,
      package: config.pkg,
      status: state.status,
      docsVersion: config.docsVersion,
      installedVersion: installed?.version ?? null,
      installedFrom: installed?.installedFrom ?? null,
      declaredRange: declared?.range ?? null,
      declaredIn: declared?.field ?? null,
      source: state.source,
      staleInstall: state.staleInstall,
      action: ACTIONS[state.status],
      reference:
        state.status === 'older' ? join(skillDir, config.olderReference) : null,
      projectDir,
    },
  };
}

function main(argv, config) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(
      `unexpected arguments: ${argv.join(' ')}. Pass at most one projectDir.`,
      { cause: error },
    );
  }

  if (parsed.values.help) {
    process.stdout.write(`${usageFor(config.pkg)}\n`);
    return 0;
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${argv.join(' ')}. Pass at most one projectDir.`,
    );
  }
  const projectDir = resolve(parsed.positionals[0] ?? process.cwd());
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new UsageError(`projectDir is not a directory: ${projectDir}`);
  }
  const { message, result } = check(projectDir, config);
  process.stdout.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

let loadedConfig = null;
try {
  loadedConfig = loadSkillConfig();
  process.exitCode = main(process.argv.slice(2), loadedConfig);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(
      `check-version: ${error.message}\n\n${usageFor(loadedConfig?.pkg)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stderr.write(`check-version: ${error.message}\n`);
    process.exitCode = 2;
  }
}
