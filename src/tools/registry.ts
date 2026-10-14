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

export type ToolMcpClient =
  'antigravity' | 'claude-code' | 'gemini-cli' | 'copilot';

export type GlobalToolMcpConfig =
  | {
      format: 'json';
      client: ToolMcpClient;
      file: (paths: Paths) => string;
      permissionsFile?: (paths: Paths) => string;
    }
  | {
      format: 'toml';
      file: (paths: Paths) => string;
    };

export type ProjectToolMcpConfig =
  | {
      format: 'json';
      client: ToolMcpClient;
      file: string;
      permissionsFile?: string;
    }
  | {
      format: 'toml';
      file: string;
    };

export interface ToolDefinition {
  id: ToolId;
  label: string;
  detect: { dirs: (paths: Paths) => string[]; bins: readonly string[] };
  global: {
    instructions: (paths: Paths) => string;
    skills?: (paths: Paths) => string;
    extraSkills?: (paths: Paths) => string[];
    settings?: (paths: Paths) => ArraySetting;
    mcp?: GlobalToolMcpConfig;
    shadowedBy?: (paths: Paths) => string;
    alsoLoads?: (paths: Paths) => string[];
    limits?: SizeLimits;
  };
  project: {
    importLine?: { file: string; line: string };
    settings?: ArraySetting;
    mcp?: ProjectToolMcpConfig;
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

const antigravityGlobalMcp: GlobalToolMcpConfig = {
  format: 'json',
  client: 'antigravity',
  file: (paths) => join(paths.geminiHome, 'config', 'mcp_config.json'),
};

const antigravityProjectMcp: ProjectToolMcpConfig = {
  format: 'json',
  client: 'antigravity',
  file: join('.agents', 'mcp_config.json'),
};

export const TOOLS: Readonly<Record<ToolId, ToolDefinition>> = {
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    detect: {
      dirs: (paths) => [
        join(paths.geminiHome, 'antigravity'),
        join(paths.applicationsDir, 'Antigravity.app'),
      ],
      bins: [],
    },
    global: {
      instructions: sharedGeminiInstructions,
      skills: (paths) => join(paths.geminiHome, 'config', 'skills'),
      mcp: antigravityGlobalMcp,
      alsoLoads: antigravityExtraFiles,
      limits: ANTIGRAVITY_RULE_LIMITS,
    },
    project: {
      mcp: antigravityProjectMcp,
    },
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
      mcp: antigravityGlobalMcp,
      alsoLoads: antigravityExtraFiles,
      limits: ANTIGRAVITY_RULE_LIMITS,
    },
    project: {
      mcp: antigravityProjectMcp,
    },
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
      mcp: {
        format: 'json',
        client: 'gemini-cli',
        file: (paths) => join(paths.geminiHome, 'settings.json'),
      },
    },
    project: {
      settings: {
        file: join('.gemini', 'settings.json'),
        key: 'context.fileName',
        values: GEMINI_CONTEXT_FILES,
      },
      mcp: {
        format: 'json',
        client: 'gemini-cli',
        file: join('.gemini', 'settings.json'),
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
      mcp: {
        format: 'json',
        client: 'claude-code',
        file: (paths) => join(paths.home, '.claude.json'),
        permissionsFile: (paths) => join(paths.claudeHome, 'settings.json'),
      },
      limits: { lines: 200 },
    },
    project: {
      importLine: { file: 'CLAUDE.md', line: '@AGENTS.md' },
      skills: join('.claude', 'skills'),
      mcp: {
        format: 'json',
        client: 'claude-code',
        file: '.mcp.json',
        permissionsFile: join('.claude', 'settings.json'),
      },
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    detect: { dirs: (paths) => [paths.codexHome], bins: ['codex'] },
    global: {
      instructions: (paths) => join(paths.codexHome, 'AGENTS.md'),
      mcp: {
        format: 'toml',
        file: (paths) => join(paths.codexHome, 'config.toml'),
      },
      shadowedBy: (paths) => join(paths.codexHome, 'AGENTS.override.md'),
    },
    project: {
      mcp: {
        format: 'toml',
        file: join('.codex', 'config.toml'),
      },
    },
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot',
    detect: { dirs: (paths) => [paths.copilotHome], bins: ['copilot'] },
    global: {
      instructions: (paths) =>
        join(paths.copilotHome, 'copilot-instructions.md'),
      extraSkills: (paths) => [join(paths.copilotHome, 'skills')],
      mcp: {
        format: 'json',
        client: 'copilot',
        file: (paths) => join(paths.copilotHome, 'mcp-config.json'),
      },
    },
    project: {
      mcp: {
        format: 'json',
        client: 'copilot',
        file: '.mcp.json',
      },
    },
  },
};

export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

export function orderedTools(ids: readonly ToolId[]): ToolDefinition[] {
  return TOOL_IDS.filter((id) => ids.includes(id)).map((id) => TOOLS[id]);
}
