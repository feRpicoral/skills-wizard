import type { SkillSourceRecord } from '../state/manifest.ts';

export const SKILL_MODES = ['copy', 'link'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export const DEFAULT_SKILL_MODE: SkillMode = 'copy';

export interface SkillSource {
  dir: string;
  record: SkillSourceRecord;
  linkable: boolean;
  setup?: string;
}
