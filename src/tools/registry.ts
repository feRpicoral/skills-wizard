import { join } from 'node:path';

import type { Paths } from '../env.ts';

export const TOOL_IDS = [
  'antigravity',
  'antigravity-cli',
  'gemini-cli',
  'claude-code',
  'codex',
  'copilot',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

interface ArraySetting {
  file: string;
  key: string;
  values: readonly string[];
}

interface SizeLimits {
  lines?: number;
  bytes?: number;
}

export interface ToolDefinition {
  id: ToolId;
  label: string;
  detect: { dirs: (paths: Paths) => string[]; bins: readonly string[] };
  global: {
    instructions: (paths: Paths) => string;
    skills?: (paths: Paths) => string;
    extraSkills?: (paths: Paths) => string[];
    settings?: (paths: Paths) => ArraySetting;
    shadowedBy?: (paths: Paths) => string;
    alsoLoads?: (paths: Paths) => string[];
    limits?: SizeLimits;
  };
  project: {
    importLine?: { file: string; line: string };
    settings?: ArraySetting;
    skills?: string;
  };
}

const GEMINI_CONTEXT_FILES = ['AGENTS.md', 'GEMINI.md'] as const;

const ANTIGRAVITY_RULE_LIMITS: SizeLimits = { bytes: 24_000 };

const sharedGeminiInstructions = (paths: Paths) =>
  join(paths.geminiHome, 'AGENTS.md');

const geminiContextFile = (paths: Paths) => join(paths.geminiHome, 'GEMINI.md');

const antigravityExtraFiles = (paths: Paths) => [
  geminiContextFile(paths),
  join(paths.geminiHome, 'config', 'AGENTS.md'),
  join(paths.geminiHome, 'config', 'GEMINI.md'),
];

export const TOOLS: Readonly<Record<ToolId, ToolDefinition>> = {
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    detect: {
      dirs: (paths) => [
        join(paths.geminiHome, 'antigravity'),
        '/Applications/Antigravity.app',
      ],
      bins: [],
    },
    global: {
      instructions: sharedGeminiInstructions,
      skills: (paths) => join(paths.geminiHome, 'config', 'skills'),
      alsoLoads: antigravityExtraFiles,
      limits: ANTIGRAVITY_RULE_LIMITS,
    },
    project: {},
  },
  'antigravity-cli': {
    id: 'antigravity-cli',
    label: 'Antigravity CLI (agy)',
    detect: {
      dirs: (paths) => [join(paths.geminiHome, 'antigravity-cli')],
      bins: ['agy'],
    },
    global: {
      instructions: sharedGeminiInstructions,
      skills: (paths) => join(paths.geminiHome, 'antigravity-cli', 'skills'),
      alsoLoads: antigravityExtraFiles,
      limits: ANTIGRAVITY_RULE_LIMITS,
    },
    project: {},
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    detect: { dirs: () => [], bins: ['gemini'] },
    global: {
      instructions: sharedGeminiInstructions,
      extraSkills: (paths) => [join(paths.geminiHome, 'skills')],
      alsoLoads: (paths) => [geminiContextFile(paths)],
      settings: (paths) => ({
        file: join(paths.geminiHome, 'settings.json'),
        key: 'context.fileName',
        values: GEMINI_CONTEXT_FILES,
      }),
    },
    project: {
      settings: {
        file: join('.gemini', 'settings.json'),
        key: 'context.fileName',
        values: GEMINI_CONTEXT_FILES,
      },
    },
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    detect: { dirs: (paths) => [paths.claudeHome], bins: ['claude'] },
    global: {
      instructions: (paths) => join(paths.claudeHome, 'CLAUDE.md'),
      skills: (paths) => join(paths.claudeHome, 'skills'),
      limits: { lines: 200 },
    },
    project: {
      importLine: { file: 'CLAUDE.md', line: '@AGENTS.md' },
      skills: join('.claude', 'skills'),
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    detect: { dirs: (paths) => [paths.codexHome], bins: ['codex'] },
    global: {
      instructions: (paths) => join(paths.codexHome, 'AGENTS.md'),
      shadowedBy: (paths) => join(paths.codexHome, 'AGENTS.override.md'),
    },
    project: {},
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot',
    detect: { dirs: (paths) => [paths.copilotHome], bins: ['copilot'] },
    global: {
      instructions: (paths) =>
        join(paths.copilotHome, 'copilot-instructions.md'),
      extraSkills: (paths) => [join(paths.copilotHome, 'skills')],
    },
    project: {},
  },
};

export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

export function orderedTools(ids: readonly ToolId[]): ToolDefinition[] {
  return TOOL_IDS.filter((id) => ids.includes(id)).map((id) => TOOLS[id]);
}
