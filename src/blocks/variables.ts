import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LOOKUP_TIMEOUT_MS = 5_000;

interface VariableDefinition {
  message: string;
  lookup?: () => Promise<string | undefined>;
}

async function commandOutput(
  command: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await run(command, args, { timeout: LOOKUP_TIMEOUT_MS });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const VARIABLES: Readonly<Record<string, VariableDefinition>> = {
  githubUsername: {
    message: 'GitHub username',
    lookup: async () =>
      (await commandOutput('gh', ['api', 'user', '--jq', '.login'])) ??
      (await commandOutput('git', ['config', '--get', 'github.user'])),
  },
};

export function variableMessage(name: string): string {
  return VARIABLES[name]?.message ?? `Value for ${name}`;
}

export async function lookupVariables(
  names: readonly string[],
  known: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...known };
  for (const name of names) {
    if (values[name]?.trim()) continue;
    const found = await VARIABLES[name]?.lookup?.();
    if (found) values[name] = found;
  }
  return values;
}
