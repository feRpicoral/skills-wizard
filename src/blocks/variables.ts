import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LOOKUP_TIMEOUT_MS = 5_000;

export interface VariableLookupEnv {
  home?: string;
  searchPath?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

interface VariableDefinition {
  message: string;
  lookup?: (lookupEnv?: VariableLookupEnv) => Promise<string | undefined>;
}

export async function commandOutput(
  command: string,
  args: string[],
  lookupEnv?: VariableLookupEnv,
): Promise<string | undefined> {
  try {
    const env =
      lookupEnv?.home !== undefined ||
      lookupEnv?.searchPath !== undefined ||
      lookupEnv?.env !== undefined
        ? {
            ...process.env,
            ...(lookupEnv.home !== undefined ? { HOME: lookupEnv.home } : {}),
            ...(lookupEnv.searchPath !== undefined
              ? { PATH: lookupEnv.searchPath.join(delimiter) }
              : {}),
            ...lookupEnv.env,
          }
        : undefined;
    const { stdout } = await run(command, args, {
      timeout: LOOKUP_TIMEOUT_MS,
      ...(env ? { env } : {}),
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const VARIABLES: Readonly<Record<string, VariableDefinition>> = {
  githubUsername: {
    message: 'GitHub username',
    lookup: async (lookupEnv) =>
      (await commandOutput(
        'gh',
        ['api', 'user', '--jq', '.login'],
        lookupEnv,
      )) ??
      (await commandOutput(
        'git',
        ['config', '--get', 'github.user'],
        lookupEnv,
      )),
  },
};

export function variableMessage(name: string): string {
  return VARIABLES[name]?.message ?? `Value for ${name}`;
}

export async function lookupVariables(
  names: readonly string[],
  known: Readonly<Record<string, string>>,
  lookupEnv?: VariableLookupEnv,
): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...known };
  const entries = await Promise.all(
    names.map(async (name) => {
      if (values[name]?.trim()) return null;
      const found = await VARIABLES[name]?.lookup?.(lookupEnv);
      return found ? ([name, found] as const) : null;
    }),
  );
  for (const entry of entries) {
    if (entry) values[entry[0]] = entry[1];
  }
  return values;
}
