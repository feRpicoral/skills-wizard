import { snapshotTree, type TreeFile } from './tree.ts';

export interface SkillDiff {
  added: string[];
  modified: string[];
  removed: string[];
  before: Map<string, TreeFile>;
  after: Map<string, TreeFile>;
}

interface TreeFilePair {
  left: TreeFile;
  right: TreeFile;
}

function sameFile({ left, right }: TreeFilePair): boolean {
  return (
    left.link === right.link &&
    left.executable === right.executable &&
    left.digest === right.digest
  );
}

export interface DiffSkillTreesParams {
  previousDir: string | null;
  nextDir: string;
}

export async function diffSkillTrees({
  previousDir,
  nextDir,
}: DiffSkillTreesParams): Promise<SkillDiff> {
  const [before, after] = await Promise.all([
    previousDir
      ? snapshotTree(previousDir)
      : Promise.resolve(new Map<string, TreeFile>()),
    snapshotTree(nextDir),
  ]);

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, file] of after) {
    const prior = before.get(path);

    if (!prior) added.push(path);
    else if (!sameFile({ left: prior, right: file })) modified.push(path);
  }

  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    removed: removed.sort(),
    before,
    after,
  };
}

export function hasDiff(diff: SkillDiff): boolean {
  return (
    diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0
  );
}

export function changedFiles(diff: SkillDiff): string[] {
  return [...diff.added, ...diff.modified].sort();
}
