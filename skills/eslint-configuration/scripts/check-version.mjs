#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class UsageError extends Error {}

function usageFor(pkg = '<package>') {
  return `Usage: node scripts/check-version.mjs [projectDir]\n\nCompares the ${pkg} version installed in projectDir (default: the current directory) with metadata.docs-version in SKILL.md.\nPrints one sentence for the agent, then one JSON summary line.\nWhen ${pkg} is not installed, the lower bound of the range declared in package.json is compared instead.\n\nExit codes: 0 (status determined), 1 (invalid arguments), 2 (unexpected error)`;
}

function unquoteYamlValue(raw) {
  const t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return t.replace(/\s+#.*$/, '').trim();
}

function readFrontmatter(skillFile) {
  const lines = readFileSync(skillFile, 'utf8').split(/\r?\n/);
  if (lines[0]?.trim() !== '---')
    throw new Error(`${skillFile} does not start with YAML frontmatter`);
  const fields = {};
  let inMeta = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return fields;
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (/^\S/.test(line)) inMeta = /^metadata:\s*(?:#.*)?$/.test(line);
    const match = line.match(/^(\s*)([\w-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    const val = unquoteYamlValue(rawValue);
    if (indent === '' && key === 'name') fields.name = val;
    if (indent !== '' && inMeta) fields[`metadata.${key}`] = val;
  }
  throw new Error(`${skillFile} has an unterminated frontmatter block`);
}

function loadSkillConfig() {
  const fm = readFrontmatter(join(skillDir, 'SKILL.md'));
  const pkg = fm['metadata.package'];
  const displayName = fm['metadata.display-name'];
  const docsVersion = fm['metadata.docs-version'];
  const olderReference =
    fm['metadata.older-reference'] ?? 'references/version-differences.md';
  const olderRisk = fm['metadata.older-risk'];
  const releaseNotes = fm['metadata.release-notes'];
  const tpl = fm['metadata.docs-url-template'];
  if (
    [pkg, displayName, docsVersion, olderRisk, releaseNotes, tpl].some(
      (v) => !v,
    )
  ) {
    throw new Error(
      'SKILL.md metadata is missing required check-version fields',
    );
  }
  const docsUrlFor = (v) => tpl.replaceAll('{version}', v);
  return {
    skill: fm.name ?? null,
    pkg,
    displayName,
    docsVersion,
    olderReference,
    olderRisk,
    releaseNotes,
    docsUrlFor,
  };
}

function stripNpmAlias(range) {
  const t = String(range).trim();
  if (!t.startsWith('npm:')) return t;
  const at = t.lastIndexOf('@');
  return at > 4 ? t.slice(at + 1).trim() : '';
}

const UNCOMPARABLE_RE =
  /^(?:|\*|latest|next|(?:git\+|git:|https?:|github:|bitbucket:|gitlab:|file:|link:|workspace:|catalog:|patch:).*|.*\/.*)$/i;
const PARTIAL_RE =
  /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i;
const isWild = (tok) =>
  tok === undefined || tok === '*' || tok.toLowerCase() === 'x';

function parsePartialVersion(raw) {
  const m = String(raw).trim().match(PARTIAL_RE);
  if (!m || isWild(m[1])) return null;
  const major = Number(m[1]);
  if (isWild(m[2]))
    return { major, minor: 0, patch: 0, pre: null, precision: 1 };
  const minor = Number(m[2]);
  if (isWild(m[3])) return { major, minor, patch: 0, pre: null, precision: 2 };
  return { major, minor, patch: Number(m[3]), pre: m[4] ?? null, precision: 3 };
}

function parseSingleVersion(text) {
  const cleaned = stripNpmAlias(text);
  if (UNCOMPARABLE_RE.test(cleaned)) return null;
  const v = parsePartialVersion(cleaned);
  return v ? [v.major, v.minor, v.patch, v.pre] : null;
}

function comparePrerelease(leftPre, rightPre) {
  if (!leftPre && !rightPre) return 0;
  if (leftPre && !rightPre) return -1;
  if (!leftPre && rightPre) return 1;
  const lp = String(leftPre).split('.');
  const rp = String(rightPre).split('.');
  for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
    const a = lp[i];
    const b = rp[i];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNum = /^\d+$/.test(a) ? Number(a) : null;
    const bNum = /^\d+$/.test(b) ? Number(b) : null;
    if (aNum !== null && bNum !== null) return aNum > bNum ? 1 : -1;
    if (aNum !== null || bNum !== null) return aNum !== null ? -1 : 1;
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

function partialCeiling(v) {
  if (v.precision === 1) return [v.major + 1, 0, 0, '0'];
  return v.precision === 2 ? [v.major, v.minor + 1, 0, '0'] : null;
}

function parseComparatorToken(token) {
  const m = token.match(/^(>=|<=|>|<|\^|~|=)?(.*)$/);
  const ver = m ? parsePartialVersion(m[2]) : null;
  if (!ver) return null;
  const op = m[1] ?? '';
  const base = [ver.major, ver.minor, ver.patch, ver.pre];
  const cmp = (a, b) => compareVersions({ left: a, right: b });
  const ceil = partialCeiling(ver);
  if (op === '^') {
    const upper =
      ver.major > 0 || ver.precision === 1
        ? [ver.major + 1, 0, 0, '0']
        : ver.minor > 0 || ver.precision === 2
          ? [0, ver.minor + 1, 0, '0']
          : [0, 0, ver.patch + 1, '0'];
    return { lower: base, test: (v) => cmp(v, base) >= 0 && cmp(v, upper) < 0 };
  }
  if (op === '~') {
    const upper = ceil ?? [ver.major, ver.minor + 1, 0, '0'];
    return { lower: base, test: (v) => cmp(v, base) >= 0 && cmp(v, upper) < 0 };
  }
  if (op === '<') {
    const upper = ver.precision < 3 ? [ver.major, ver.minor, 0, '0'] : base;
    return { lower: null, test: (v) => cmp(v, upper) < 0 };
  }
  if (op === '<=') {
    return {
      lower: null,
      test: ceil ? (v) => cmp(v, ceil) < 0 : (v) => cmp(v, base) <= 0,
    };
  }
  if (op === '>=') return { lower: base, test: (v) => cmp(v, base) >= 0 };
  if (op === '>') {
    const next = ceil ? [ceil[0], ceil[1], 0, null] : null;
    return next
      ? { lower: next, test: (v) => cmp(v, next) >= 0 }
      : { lower: base, test: (v) => cmp(v, base) > 0 };
  }
  return {
    lower: base,
    test: ceil
      ? (v) => cmp(v, base) >= 0 && cmp(v, ceil) < 0
      : (v) => cmp(v, base) === 0,
  };
}

function parseRangeBranch(branch) {
  const cleaned = stripNpmAlias(branch);
  if (UNCOMPARABLE_RE.test(cleaned)) return null;
  const tokens = cleaned
    .replace(/(\S+)\s+-\s+(\S+)/g, '>=$1 <=$2')
    .replace(/([<>~^=])\s+/g, '$1')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const comps = tokens.map(parseComparatorToken);
  if (comps.some((c) => c === null)) return null;
  let lower = null;
  for (const c of comps) {
    if (
      c.lower &&
      (!lower || compareVersions({ left: c.lower, right: lower }) > 0)
    )
      lower = c.lower;
  }
  return { lower, matches: (v) => comps.every((c) => c.test(v)) };
}

function parseVersion(text) {
  const branches = String(text)
    .split('||')
    .map((p) => p.trim())
    .filter(Boolean);
  if (branches.length === 0) return null;
  let lowest = null;
  for (const raw of branches) {
    const b = parseRangeBranch(raw);
    if (!b?.lower) return null;
    if (!lowest || compareVersions({ left: b.lower, right: lowest }) < 0)
      lowest = b.lower;
  }
  return lowest;
}

function isOutsideDeclaredRange({ installedParts, rawRange }) {
  const branches = String(rawRange)
    .split('||')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(parseRangeBranch);
  if (branches.length === 0 || branches.some((b) => b === null)) return false;
  return branches.every((b) => !b.matches(installedParts));
}

const formatVersion = (p) =>
  p[3] ? `${p[0]}.${p[1]}.${p[2]}-${p[3]}` : `${p[0]}.${p[1]}.${p[2]}`;

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
  )
    return true;
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
  let pkgBoundary = null;
  for (;;) {
    if (declaresWorkspaces(dir)) return dir;
    if (pkgBoundary === null && existsSync(join(dir, 'package.json')))
      pkgBoundary = dir;
    if (existsSync(join(dir, '.git'))) return pkgBoundary ?? dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return pkgBoundary ?? startDir;
}

function findInstalled(projectDir, pkg) {
  const ceiling = findWorkspaceCeiling(projectDir);
  for (let dir = projectDir; ;) {
    const candidate = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) {
      const version = String(readJson(candidate).version ?? '').trim();
      const parts = parseSingleVersion(version);
      if (!parts) throw new Error(`${candidate} has no usable "version" field`);
      return { version, parts, manifestPath: candidate, installedFrom: dir };
    }
    const parent = dirname(dir);
    if (dir === ceiling || parent === dir) return null;
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
  if (status === 'match')
    return `the same version as ${docs}. Use the references as written.`;
  if (status === 'newer') {
    return `newer than ${docs}. Tell the user this skill is out of date and recommend updating it from the docs at ${version} (${config.docsUrlFor(version)}); read the release notes and any migration guide for versions after ${config.docsVersion} (${config.releaseNotes}) before relying on the references, and keep helping with the task.`;
  }
  if (status === 'older')
    return `older than ${docs}. Read ${config.olderReference} first: ${config.olderRisk} in ${version}.`;
  throw new Error(`unknown status ${status}`);
}

const ACTIONS = {
  match: 'use-references',
  newer: 'tell-user-skill-outdated',
  older: 'read-version-differences',
  declared: 'install-and-recheck',
  missing: 'treat-as-new-setup',
};

const makeState = (status, source = null, extra = {}) => ({
  status,
  source,
  staleInstall: false,
  staleRelation: null,
  lowerBound: null,
  ...extra,
});

function resolveVersionState({ installed, declared, docsParts }) {
  const declaredParts = declared ? parseVersion(declared.range) : null;
  if (installed) {
    const installedParts = installed.parts;
    const order = compareVersions({ left: installedParts, right: docsParts });
    const status = order === 0 ? 'match' : order > 0 ? 'newer' : 'older';
    const staleInstall = Boolean(
      declared &&
      isOutsideDeclaredRange({ installedParts, rawRange: declared.range }),
    );
    const staleRelation = staleInstall
      ? declaredParts &&
        compareVersions({ left: installedParts, right: declaredParts }) < 0
        ? 'below'
        : 'outside'
      : null;
    return makeState(status, 'node_modules', { staleInstall, staleRelation });
  }
  if (declaredParts) {
    const order = compareVersions({ left: declaredParts, right: docsParts });
    const status = order === 0 ? 'match' : order > 0 ? 'newer' : 'older';
    return makeState(status, 'package.json', {
      lowerBound: formatVersion(declaredParts),
    });
  }
  return declared
    ? makeState('declared', 'package.json')
    : makeState('missing');
}

function formatAgentMessage(ctx) {
  const { config, projectDir, installed, declared, state } = ctx;
  const declaredText = declared
    ? `declared in package.json (${declared.field}: "${declared.range}")`
    : '';
  let msg;
  if (installed) {
    msg = `${config.pkg} ${installed.version} is installed, ${statusSentence({ config, status: state.status, version: installed.version })}`;
    if (state.staleInstall) {
      msg += ` The installed version is ${state.staleRelation} the range ${declaredText}, so node_modules is stale: reinstall from the lockfile before trusting local results or comparing them with CI.`;
    }
  } else if (state.lowerBound) {
    msg = `${config.pkg} is ${declaredText} but not installed in ${projectDir}. Its lower bound ${state.lowerBound} is ${statusSentence({ config, status: state.status, version: state.lowerBound })} Install dependencies and re-run this check for the exact version.`;
  } else if (declared) {
    msg = `${config.pkg} is ${declaredText} but not installed, and the range has no comparable version. Install dependencies and re-run this check.`;
  } else {
    msg = `${config.pkg} is neither installed nor declared in ${projectDir}. Treat this as a new setup; the references describe ${config.displayName} ${config.docsVersion}.`;
  }
  if (!installed && existsSync(join(projectDir, '.pnp.cjs'))) {
    msg +=
      ' This project uses Yarn Plug\'n\'Play; run the check with "yarn node" so the installed version can be resolved.';
  }
  return msg;
}

function check(projectDir, config) {
  const docsParts = parseSingleVersion(config.docsVersion);
  if (!docsParts)
    throw new Error('metadata.docs-version is missing or invalid in SKILL.md');
  const installed = findInstalled(projectDir, config.pkg);
  const declared = findDeclared(projectDir, config.pkg);
  const state = resolveVersionState({ installed, declared, docsParts });
  return {
    message: formatAgentMessage({
      config,
      projectDir,
      installed,
      declared,
      state,
    }),
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
      options: { help: { type: 'boolean', short: 'h' } },
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
  process.stdout.write(`${message}\n${JSON.stringify(result)}\n`);
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
