import { basename, dirname, join, relative, sep } from 'node:path';

import { FrontmatterError } from '../errors.ts';
import { isRecord, parseFrontmatter } from '../frontmatter.ts';
import { fsErrorReason, isInside, readTextIfExists } from '../install/fs.ts';
import { escapingLinks } from './tree.ts';

export const SKILL_FILE = 'SKILL.md';

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
const BODY_LINE_LIMIT = 500;

const SPEC_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

const CODE_SPAN = /```[\s\S]*?```|`[^`\n]+`/g;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const NOT_A_FILE_LINK = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;
const SAYS_WHEN = /\b(?:when|whenever|use (?:\w+ ){0,2}(?:for|to|on|if|in))\b/i;

export interface SkillReport {
  dir: string;
  name?: string;
  errors: string[];
  warnings: string[];
}

interface ValidateOptions {
  strict: boolean;
  expectedName?: string;
}

function nameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length === 0 || name.length > NAME_MAX) {
    problems.push(`name must be 1-${NAME_MAX} characters`);
  }
  if (/[^a-z0-9-]/.test(name)) {
    problems.push(
      'name may only contain lowercase letters, digits and hyphens',
    );
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    problems.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    problems.push('name must not contain consecutive hyphens');
  }
  return problems;
}

export function isSkillName(value: string): boolean {
  return nameProblems(value).length === 0;
}

function optionalString(
  data: Record<string, unknown>,
  field: string,
  max?: number,
): string[] {
  const value = data[field];
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.trim() === '') {
    return [`${field} must be a non-empty string`];
  }
  if (max !== undefined && value.length > max) {
    return [`${field} must be at most ${max} characters`];
  }
  return [];
}

function metadataProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['metadata must be a mapping'];
  return Object.entries(value)
    .filter(([, entry]) => typeof entry !== 'string')
    .map(([key]) => `metadata.${key} must be a string`);
}

function specProblems(data: Record<string, unknown>): string[] {
  const { description } = data;
  return [
    ...(typeof description === 'string' && description.length > DESCRIPTION_MAX
      ? [`description must be at most ${DESCRIPTION_MAX} characters`]
      : []),
    ...optionalString(data, 'license'),
    ...optionalString(data, 'compatibility', COMPATIBILITY_MAX),
    ...optionalString(data, 'allowed-tools'),
    ...metadataProblems(data.metadata),
  ];
}

async function readIfReadable(file: string): Promise<string | null> {
  try {
    return await readTextIfExists(file);
  } catch (error) {
    if (fsErrorReason(error) === undefined) throw error;
    return null;
  }
}

function decodedPath(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

interface LinkedMarkdownParams {
  markdown: string;
  file: string;
  dir: string;
}

function linkedMarkdown({
  markdown,
  file,
  dir,
}: LinkedMarkdownParams): string[] {
  const prose = markdown.replace(CODE_SPAN, '');
  return [...prose.matchAll(MARKDOWN_LINK)].flatMap((match) => {
    const target = match[1]?.split('#')[0];
    if (!target || NOT_A_FILE_LINK.test(target) || !target.endsWith('.md')) {
      return [];
    }
    const resolved = join(dirname(file), decodedPath(target));
    return isInside({ dir, path: resolved }) ? [resolved] : [];
  });
}

interface NestedReferencesParams {
  dir: string;
  body: string;
  escapingPaths: ReadonlySet<string>;
}

async function nestedReferences({
  dir,
  body,
  escapingPaths,
}: NestedReferencesParams): Promise<string[]> {
  const skillFile = join(dir, SKILL_FILE);
  const warnings: string[] = [];
  for (const reference of new Set(
    linkedMarkdown({ markdown: body, file: skillFile, dir }),
  )) {
    const relReference = relative(dir, reference).split(sep).join('/');
    if (escapingPaths.has(relReference)) continue;
    const content = await readIfReadable(reference);
    if (content === null) continue;
    const [deeper] = linkedMarkdown({
      markdown: content,
      file: reference,
      dir,
    }).filter((target) => target !== skillFile && target !== reference);
    if (deeper !== undefined) {
      warnings.push(
        `${relative(dir, reference)} links to ${relative(dir, deeper)}; keep references one level deep from ${SKILL_FILE}`,
      );
    }
  }
  return warnings;
}

function practiceWarnings(description: unknown, body: string): string[] {
  const warnings: string[] = [];
  const lines = body.replace(/\n$/, '').split('\n').length;
  if (lines >= BODY_LINE_LIMIT) {
    warnings.push(
      `${SKILL_FILE} body has ${lines} lines; keep it under ${BODY_LINE_LIMIT} and move detail into references`,
    );
  }
  if (typeof description === 'string' && !SAYS_WHEN.test(description)) {
    warnings.push(
      'description should say when to use the skill, for example "Use when ..."',
    );
  }
  return warnings;
}

async function readSkillFile(
  dir: string,
  report: SkillReport,
): Promise<string | null> {
  try {
    const source = await readTextIfExists(join(dir, SKILL_FILE));
    if (source === null) report.errors.push(`${SKILL_FILE} is missing`);
    return source;
  } catch (error) {
    const reason = fsErrorReason(error);
    if (reason === undefined) throw error;
    report.errors.push(`${SKILL_FILE} cannot be read: ${reason}`);
    return null;
  }
}

async function linkProblems(dir: string): Promise<string[]> {
  try {
    return (await escapingLinks(dir)).map(
      ({ path, target }) =>
        `${path} does not resolve inside the skill folder (${target}); links must be relative and stay inside it`,
    );
  } catch (error) {
    const reason = fsErrorReason(error);
    if (reason === undefined) throw error;
    return [`the skill folder cannot be read: ${reason}`];
  }
}

interface IdentityProblemsParams extends ValidateOptions {
  name: string;
  dir: string;
}

function identityProblems({
  name,
  dir,
  strict,
  expectedName,
}: IdentityProblemsParams): string[] {
  const problems = nameProblems(name);
  const folder = basename(dir);
  if (strict && name !== folder) {
    problems.push(`name "${name}" must match the folder "${folder}"`);
  }
  if (expectedName !== undefined && name !== expectedName) {
    problems.push(`declares name "${name}" instead of "${expectedName}"`);
  }
  return problems;
}

export async function validateSkill(
  dir: string,
  { strict, expectedName }: ValidateOptions,
): Promise<SkillReport> {
  const report: SkillReport = { dir, errors: [], warnings: [] };
  const escaping = await escapingLinks(dir).catch(() => []);
  const escapingPaths = new Set(escaping.map((item) => item.path));
  if (escapingPaths.has(SKILL_FILE)) {
    report.errors.push(
      ...escaping.map(
        ({ path, target }) =>
          `${path} does not resolve inside the skill folder (${target}); links must be relative and stay inside it`,
      ),
    );
    return report;
  }
  const source = await readSkillFile(dir, report);
  if (source === null) return report;
  report.errors.push(...(await linkProblems(dir)));

  let document;
  try {
    document = parseFrontmatter({ source, file: SKILL_FILE });
  } catch (error) {
    if (!(error instanceof FrontmatterError)) throw error;
    report.errors.push(error.message);
    return report;
  }
  const { data, body } = document;
  if (!isRecord(data)) {
    report.errors.push('frontmatter must be a mapping');
    return report;
  }

  const { name, description } = data;
  if (typeof name === 'string') {
    report.name = name;
    report.errors.push(
      ...identityProblems({
        name,
        dir,
        strict,
        expectedName,
      }),
    );
  } else {
    report.errors.push('name is required');
  }
  if (typeof description !== 'string' || description.trim() === '') {
    report.errors.push('description is required');
  }

  const problems = specProblems(data);
  if (strict) {
    const unknown = Object.keys(data)
      .filter((field) => !SPEC_FIELDS.has(field))
      .map((field) => `unknown field "${field}"`);
    report.errors.push(...problems, ...unknown);
  } else {
    report.warnings.push(...problems);
  }
  report.warnings.push(
    ...practiceWarnings(description, body),
    ...(await nestedReferences({ dir, body, escapingPaths })),
  );
  return report;
}
