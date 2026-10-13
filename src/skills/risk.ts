import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter } from '../frontmatter.ts';
import { readTextIfExists } from '../install/fs.ts';
import {
  changedFiles,
  diffSkillTrees,
  type DiffSkillTreesParams,
  type SkillDiff,
} from './diff.ts';
import { SKILL_FILE } from './validate.ts';

export type RiskKind =
  | 'pipe-to-shell'
  | 'download-to-shell'
  | 'npx-yes'
  | 'unpinned-latest'
  | 'rm-rf'
  | 'base64-shell'
  | 'executable'
  | 'symlink'
  | 'hooks'
  | 'allowed-tools';

export interface RiskFlag {
  file: string;
  kind: RiskKind;
  detail: string;
}

const HOOK_PATH = /(?:^|\/)hooks(?:\.json$|\/)/;
const HOOK_EVENTS =
  /\b(?:PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|SessionEnd)\b/;

const TEXT_PATTERNS: readonly {
  kind: RiskKind;
  patterns: readonly RegExp[];
  detail: string;
}[] = [
  {
    kind: 'pipe-to-shell',
    patterns: [
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|a|k)?sh\b/i,
    ],
    detail: 'pipes a download into a shell',
  },
  {
    kind: 'download-to-shell',
    patterns: [
      /(?:\b(?:(?:ba|z|da|a|k)?sh|source)|(?:^|[\s;&|(])\.)\s+(?:-\S+\s+)*<\(\s*(?:sudo\s+)?(?:curl|wget)\b/im,
      /\b(?:ba|z|da|a|k)?sh\s+(?:-\S+\s+)*-[A-Za-z]*c[A-Za-z]*\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/i,
      /\beval\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/i,
    ],
    detail: 'runs a downloaded script in a shell',
  },
  {
    kind: 'npx-yes',
    patterns: [/\bnpx\s+(?:[^\n]*?\s)?(?:-y|--yes)\b/],
    detail: 'runs npx with --yes',
  },
  {
    kind: 'unpinned-latest',
    patterns: [/[A-Za-z0-9._-]+@latest\b/],
    detail: 'uses an unpinned @latest package',
  },
  {
    kind: 'rm-rf',
    patterns: [
      /\brm(?=(?:\s+-[-A-Za-z]+)*\s+(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)\b)(?=(?:\s+-[-A-Za-z]+)*\s+(?:-[A-Za-z]*f[A-Za-z]*|--force)\b)/,
    ],
    detail: 'runs rm -rf',
  },
  {
    kind: 'base64-shell',
    patterns: [
      /\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|a|k)?sh|eval|python\d?|node|perl|ruby)\b/i,
    ],
    detail: 'pipes decoded base64 into a shell',
  },
];

function toolList(value: unknown): string | undefined {
  const tools =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
  const joined = tools
    .map((tool) => tool.trim())
    .filter(Boolean)
    .join(' ');
  return joined || undefined;
}

function allowedTools(markdown: string | null): string | undefined {
  if (!markdown) return undefined;
  try {
    const { data } = parseFrontmatter({ source: markdown, file: SKILL_FILE });
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return undefined;
    }
    return toolList((data as Record<string, unknown>)['allowed-tools']);
  } catch {
    return undefined;
  }
}

async function readUtf8IfText(path: string): Promise<string | null> {
  const buffer = await readFile(path);
  return buffer.includes(0) ? null : buffer.toString('utf8');
}

async function allowedToolsRisk({
  previousDir,
  nextDir,
}: DiffSkillTreesParams): Promise<RiskFlag[]> {
  const [beforeText, afterText] = await Promise.all([
    previousDir
      ? readTextIfExists(join(previousDir, SKILL_FILE))
      : Promise.resolve(null),
    readTextIfExists(join(nextDir, SKILL_FILE)),
  ]);
  const before = allowedTools(beforeText);
  const after = allowedTools(afterText);
  if (after === undefined || after === before) return [];
  const detail =
    before === undefined
      ? `grants allowed-tools "${after}"`
      : `changes allowed-tools from "${before}" to "${after}"`;
  return [{ file: SKILL_FILE, kind: 'allowed-tools', detail }];
}

export interface ScanSkillRisksParams extends DiffSkillTreesParams {
  precomputed?: SkillDiff;
}

export async function scanSkillRisks({
  previousDir,
  nextDir,
  precomputed,
}: ScanSkillRisksParams): Promise<RiskFlag[]> {
  const diff = precomputed ?? (await diffSkillTrees({ previousDir, nextDir }));
  const flags: RiskFlag[] = [];

  for (const path of changedFiles(diff)) {
    const afterFile = diff.after.get(path);
    const beforeFile = diff.before.get(path);
    if (!afterFile) continue;

    if (afterFile.executable && !beforeFile?.executable) {
      flags.push({
        file: path,
        kind: 'executable',
        detail: 'new executable file',
      });
    }
    const isHookFile = HOOK_PATH.test(path);
    if (isHookFile) {
      flags.push({
        file: path,
        kind: 'hooks',
        detail: 'adds or modifies hook configuration',
      });
    }
    if (afterFile.link) {
      const target = await readlink(join(nextDir, ...path.split('/')));
      flags.push({
        file: path,
        kind: 'symlink',
        detail: beforeFile?.link
          ? `changes a link to point at ${target}`
          : `adds a link to ${target}`,
      });
      continue;
    }

    const text = await readUtf8IfText(join(nextDir, ...path.split('/')));
    if (text === null) continue;
    if (!isHookFile && HOOK_EVENTS.test(text)) {
      flags.push({
        file: path,
        kind: 'hooks',
        detail: 'references lifecycle hooks',
      });
    }
    for (const rule of TEXT_PATTERNS) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        flags.push({ file: path, kind: rule.kind, detail: rule.detail });
      }
    }
  }

  if (diff.added.includes(SKILL_FILE) || diff.modified.includes(SKILL_FILE)) {
    flags.push(...(await allowedToolsRisk({ previousDir, nextDir })));
  }
  return flags;
}
