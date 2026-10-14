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

function extractTomlTableBody(
  uncommented: string,
  header: string,
): string | null {
  const escaped = RegExp.escape(header);
  const pattern = new RegExp(
    `^\\s*\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    'm',
  );
  const match = uncommented.match(pattern);
  return match?.[1] ?? null;
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

export function parsePyprojectToml(source: string): ParsedPyproject {
  const uncommented = stripTomlComments(source);
  const projectBody = extractTomlTableBody(uncommented, 'project');
  const poetryBody = extractTomlTableBody(uncommented, 'tool.poetry');
  const metadataBody = projectBody ?? poetryBody;
  const name = metadataBody
    ? extractTomlStringValue(metadataBody, 'name')
    : undefined;
  const description = metadataBody
    ? extractTomlStringValue(metadataBody, 'description')
    : undefined;

  const searchable = stripMetadataAssignments(uncommented);
  const hasUvSection = /^\s*\[\[?tool\.uv(?:\]|\.)/m.test(uncommented);
  const hasPoetrySection = /^\s*\[\[?tool\.poetry(?:\]|\.)/m.test(uncommented);
  const hasRuff =
    /^\s*\[\[?tool\.ruff(?:\]|\.)/m.test(uncommented) ||
    /\bruff\b/i.test(searchable);
  const hasMypy =
    /^\s*\[\[?tool\.mypy(?:\]|\.)/m.test(uncommented) ||
    /\bmypy\b/i.test(searchable);
  const hasPyright =
    /^\s*\[\[?tool\.pyright(?:\]|\.)/m.test(uncommented) ||
    /\bpyright\b/i.test(searchable);
  const hasPytest =
    /^\s*\[\[?tool\.pytest(?:\]|\.)/m.test(uncommented) ||
    /\bpytest\b/i.test(searchable);

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
}

export async function detectPackageManager({
  projectDir,
  root,
  pkg,
  pyproject,
  hasUvLock,
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
      ...(root !== undefined ? { root } : {}),
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
  if (pyproject?.hasPoetrySection || (await hasFile('poetry.lock'))) {
    return 'poetry';
  }

  if (pkg !== null) return 'yarn';
  return undefined;
}
