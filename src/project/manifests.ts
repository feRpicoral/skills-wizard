import { parse as parseYaml } from 'yaml';

import { hasProjectFile } from './boundary-fs.ts';
import type { DetectedPackageManager, PythonToolSignals } from './detect.ts';

export interface ParsedPackageJson {
  name?: string;
  description?: string;
  packageManager?: string;
  scripts: Record<string, string>;
  dependencies: string[];
  workspaces: string[];
}

export interface ParsedPyproject {
  name?: string;
  description?: string;
  hasUvSection: boolean;
  hasPoetrySection: boolean;
  tools: PythonToolSignals;
}

function stringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  }

  return out;
}

function dependencyNames(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw);
}

/**
 * Extracts workspace glob patterns from a `package.json#workspaces` or
 * `pnpm-workspace.yaml` value (supporting both string arrays and
 * `{ packages: string[] }` objects).
 */
export function parseWorkspacesField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string');
  }

  if (raw && typeof raw === 'object' && 'packages' in raw) {
    const packages = (raw as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter(
        (item): item is string => typeof item === 'string',
      );
    }
  }

  return [];
}

/**
 * Parses a `package.json` source string into its normalized name, description,
 * `packageManager`, scripts, combined `dependencies`/`devDependencies` names,
 * and `workspaces` patterns. Returns `null` when `source` is not a JSON object.
 */
export function parsePackageJson(source: string): ParsedPackageJson | null {
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const name =
      typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim()
        : undefined;
    const description =
      typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : undefined;
    const packageManager =
      typeof parsed.packageManager === 'string' && parsed.packageManager.trim()
        ? parsed.packageManager.trim()
        : undefined;
    const scripts = stringMap(parsed.scripts);
    const dependencies = [
      ...new Set([
        ...dependencyNames(parsed.dependencies),
        ...dependencyNames(parsed.devDependencies),
      ]),
    ].sort();
    const workspaces = parseWorkspacesField(parsed.workspaces);

    return {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(packageManager !== undefined ? { packageManager } : {}),
      scripts,
      dependencies,
      workspaces,
    };
  } catch {
    return null;
  }
}

function stripTomlComments(source: string): string {
  let result = '';
  let i = 0;
  let quote: '"""' | "'''" | '"' | "'" | null = null;

  while (i < source.length) {
    if (quote === null) {
      if (source.startsWith('"""', i)) {
        quote = '"""';
        result += '"""';
        i += 3;
        continue;
      }

      if (source.startsWith("'''", i)) {
        quote = "'''";
        result += "'''";
        i += 3;
        continue;
      }

      const ch = source[i]!;

      if (ch === '"' || ch === "'") {
        quote = ch;
        result += ch;
        i += 1;
        continue;
      }

      if (ch === '#') {
        while (i < source.length && source[i] !== '\n') {
          i += 1;
        }
        continue;
      }

      result += ch;
      i += 1;
      continue;
    }

    if (quote === '"""' || quote === "'''") {
      if (source.startsWith(quote, i)) {
        result += quote;
        i += 3;
        quote = null;
        continue;
      }

      if (quote === '"""' && source[i] === '\\' && i + 1 < source.length) {
        result += source.slice(i, i + 2);
        i += 2;
        continue;
      }

      result += source[i]!;
      i += 1;
      continue;
    }

    const ch = source[i]!;

    if (quote === '"' && ch === '\\' && i + 1 < source.length) {
      result += source.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === quote || ch === '\n') {
      quote = null;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function unescapeTomlBasicString(raw: string): string {
  return raw.replace(/\\(["\\ntr])/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

const TOML_STRING_OR_HEADER =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|^[^\S\r\n]*(\[\[?[A-Za-z0-9_.-]+\]\]?)[^\S\r\n]*$/gm;

function splitTomlTables(uncommented: string): {
  headers: string[];
  tables: Map<string, string>;
} {
  const headers: string[] = [];
  const tables = new Map<string, string>();
  let currentHeader: string | null = null;
  let currentStart = 0;

  for (const match of uncommented.matchAll(TOML_STRING_OR_HEADER)) {
    const rawHeader = match[1];
    if (rawHeader === undefined) continue;

    if (currentHeader !== null && !tables.has(currentHeader)) {
      tables.set(currentHeader, uncommented.slice(currentStart, match.index));
    }

    headers.push(rawHeader);
    currentHeader = rawHeader.startsWith('[[')
      ? rawHeader.slice(2, -2)
      : rawHeader.slice(1, -1);
    currentStart = match.index + match[0].length;
  }

  if (currentHeader !== null && !tables.has(currentHeader)) {
    tables.set(currentHeader, uncommented.slice(currentStart));
  }

  return { headers, tables };
}

function extractTomlStringValue(
  tableBody: string,
  key: string,
): string | undefined {
  const escapedKey = RegExp.escape(key);
  const multilineBasic = new RegExp(
    `^\\s*${escapedKey}\\s*=\\s*"""([\\s\\S]*?)"""`,
    'm',
  ).exec(tableBody);
  if (multilineBasic?.[1] !== undefined) {
    const value = unescapeTomlBasicString(multilineBasic[1]).trim();
    return value || undefined;
  }

  const multilineLiteral = new RegExp(
    `^\\s*${escapedKey}\\s*=\\s*'''([\\s\\S]*?)'''`,
    'm',
  ).exec(tableBody);
  if (multilineLiteral?.[1] !== undefined) {
    const value = multilineLiteral[1].trim();
    return value || undefined;
  }

  const singleBasic = new RegExp(
    `^\\s*${escapedKey}\\s*=\\s*"((?:[^"\\\\\\r\\n]|\\\\.)*)"`,
    'm',
  ).exec(tableBody);
  if (singleBasic?.[1] !== undefined) {
    const value = unescapeTomlBasicString(singleBasic[1]).trim();
    return value || undefined;
  }

  const singleLiteral = new RegExp(
    `^\\s*${escapedKey}\\s*=\\s*'([^'\\r\\n]*)'`,
    'm',
  ).exec(tableBody);
  if (singleLiteral?.[1] !== undefined) {
    const value = singleLiteral[1].trim();
    return value || undefined;
  }

  return undefined;
}

function stripMetadataAssignments(uncommented: string): string {
  return uncommented.replace(
    /^\s*(?:name|description|readme|license)\s*=\s*(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')/gm,
    '',
  );
}

function hasHeaderPrefix(
  headers: readonly string[],
  toolName: string,
): boolean {
  const pattern = new RegExp(
    `^\\[\\[?tool\\.${RegExp.escape(toolName)}(?:\\]|\\.)`,
  );

  return headers.some((header) => pattern.test(header));
}

/**
 * Parses a `pyproject.toml` source string into its project/Poetry metadata,
 * `[tool.uv]` / `[tool.poetry]` section flags, and configured Python tooling
 * (`ruff`, `mypy`, `pyright`, `pytest`), ignoring comments and multiline string
 * contents that resemble TOML headers.
 */
export function parsePyprojectToml(source: string): ParsedPyproject {
  const uncommented = stripTomlComments(source);
  const { headers, tables } = splitTomlTables(uncommented);
  const metadataBody = tables.get('project') ?? tables.get('tool.poetry');
  const name = metadataBody
    ? extractTomlStringValue(metadataBody, 'name')
    : undefined;
  const description = metadataBody
    ? extractTomlStringValue(metadataBody, 'description')
    : undefined;

  const searchable = stripMetadataAssignments(uncommented);
  const hasUvSection = hasHeaderPrefix(headers, 'uv');
  const hasPoetrySection = hasHeaderPrefix(headers, 'poetry');
  const hasRuff =
    hasHeaderPrefix(headers, 'ruff') || /\bruff\b/i.test(searchable);
  const hasMypy =
    hasHeaderPrefix(headers, 'mypy') || /\bmypy\b/i.test(searchable);
  const hasPyright =
    hasHeaderPrefix(headers, 'pyright') || /\bpyright\b/i.test(searchable);
  const hasPytest =
    hasHeaderPrefix(headers, 'pytest') || /\bpytest\b/i.test(searchable);

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    hasUvSection,
    hasPoetrySection,
    tools: {
      hasRuff,
      hasMypy,
      hasPyright,
      hasPytest,
    },
  };
}

/**
 * Parses a `pnpm-workspace.yaml` source string and returns its `packages` glob
 * patterns, or an empty array when the YAML is invalid or omits `packages`.
 */
export function parsePnpmWorkspaceYaml(source: string): string[] {
  try {
    const parsed = parseYaml(source) as unknown;

    return parseWorkspacesField(parsed);
  } catch {
    return [];
  }
}

export interface DetectPackageManagerParams {
  projectDir: string;
  root?: string;
  pkg: ParsedPackageJson | null;
  pyproject: ParsedPyproject | null;
  hasUvLock?: boolean;
  hasPoetryLock?: boolean;
}

/**
 * Detects the primary package manager for `projectDir` from `package.json#packageManager`,
 * JS lockfiles (`yarn.lock`, `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`),
 * `.yarnrc.yml`, Python `uv`/`poetry` sections and lockfiles, or defaults to
 * `'yarn'` when `package.json` is present.
 */
export async function detectPackageManager({
  projectDir,
  root,
  pkg,
  pyproject,
  hasUvLock,
  hasPoetryLock,
}: DetectPackageManagerParams): Promise<DetectedPackageManager | undefined> {
  const declared = pkg?.packageManager?.toLowerCase() ?? '';
  if (declared.startsWith('yarn@')) return 'yarn';
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('npm@')) return 'npm';
  if (declared.startsWith('bun@')) return 'bun';

  const hasFile = (relativePath: string) =>
    hasProjectFile({
      projectDir,
      relativePath,
      root,
    });

  if (await hasFile('yarn.lock')) {
    return 'yarn';
  }

  if (await hasFile('pnpm-lock.yaml')) {
    return 'pnpm';
  }

  if (
    (await hasFile('package-lock.json')) ||
    (await hasFile('npm-shrinkwrap.json'))
  ) {
    return 'npm';
  }

  if ((await hasFile('bun.lock')) || (await hasFile('bun.lockb'))) {
    return 'bun';
  }

  if (await hasFile('.yarnrc.yml')) {
    return 'yarn';
  }

  const uvLock = hasUvLock ?? (await hasFile('uv.lock'));

  if (pyproject?.hasUvSection || uvLock) {
    return 'uv';
  }

  const poetryLock = hasPoetryLock ?? (await hasFile('poetry.lock'));

  if (pyproject?.hasPoetrySection || poetryLock) {
    return 'poetry';
  }

  if (pkg !== null) return 'yarn';
  return undefined;
}
