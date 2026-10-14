import { styleText } from 'node:util';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { CatalogError, UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import {
  confirmApply,
  promptAddQuery,
  promptDiscoveredCandidate,
  promptRepoSkillLocation,
  promptScope,
} from '../prompts/selection.ts';
import { appendEntries } from '../skills/adopt-catalog.ts';
import {
  type CatalogEntry,
  catalogPath,
  extendCatalog,
} from '../skills/catalog.ts';
import {
  type DiscoverSource,
  type ResolvedDiscoveredSkill,
  resolveTargetSkill,
} from '../skills/discover.ts';
import type { SkillSource } from '../skills/install.ts';
import {
  extendSkillLibrary,
  loadSkillLibrary,
  type SkillLibrary,
} from '../skills/library.ts';
import { restoreSourceCheckout } from '../skills/sources.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  applyWithCatalogRollback,
  buildSyncPlanForLocation,
  loadLibrary,
  loadMcpServers,
  mergeRequestedTools,
  notify,
  readLocationManifest,
  resolveLocation,
  sourceCache,
} from './shared.ts';

export interface AddOptions {
  target?: string;
  source?: DiscoverSource;
  category?: string;
  ref?: string;
  includeOffensive?: boolean;
  install?: boolean;
  scope?: Scope;
  projectDir?: string;
  tools?: ToolId[];
  yes: boolean;
  dryRun: boolean;
}

const DEFAULT_ADD_CATEGORY = 'workflow';
const WARN_LABEL = styleText('yellow', 'warn ');
const RISK_LABEL = styleText(['red', 'bold'], 'risk ');

function printInspectedSkill(
  ctx: Context,
  skill: ResolvedDiscoveredSkill,
): void {
  const refSuffix = skill.ref ? ` @ ${skill.ref}` : '';
  ctx.print(`Skill: ${skill.name}`);
  ctx.print(
    `Source: ${skill.repo} (${skill.path}${refSuffix}, commit ${skill.commit.slice(0, 12)})`,
  );
  if (skill.license) {
    ctx.print(`License: ${skill.license}`);
  }
  ctx.print(`Description: ${skill.description}`);
  for (const warning of skill.report.warnings) {
    ctx.print(`${WARN_LABEL}  ${skill.name}: ${warning}`);
  }
  for (const risk of skill.risks) {
    ctx.print(`${RISK_LABEL}  ${skill.name} (${risk.file}): ${risk.detail}`);
  }
}

interface InstallAddedSkillParams {
  ctx: Context;
  prompting: boolean;
  skillLibrary: SkillLibrary;
  entry: CatalogEntry;
  inspected: ResolvedDiscoveredSkill;
  catalogFile: string;
  requestedScope?: Scope;
  projectDir?: string;
  requestedTools?: ToolId[];
  yes: boolean;
  dryRun: boolean;
}

interface InstallAddedSkillOutcome {
  code: number;
  catalogCommitted: boolean;
}

async function installAddedSkill({
  ctx,
  prompting,
  skillLibrary,
  entry,
  inspected,
  catalogFile,
  requestedScope,
  projectDir,
  requestedTools,
  yes,
  dryRun,
}: InstallAddedSkillParams): Promise<InstallAddedSkillOutcome> {
  const scope = requestedScope ?? (prompting ? await promptScope() : 'global');
  const location = await resolveLocation({
    ctx,
    scope,
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  const previous = await readLocationManifest({ ctx, prompting, location });
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath({ path: location.manifestPath, home: ctx.paths.home })}; run agents-config init ${scope === 'project' ? '--project' : '--global'} first.`,
    );
  }
  const library = await loadLibrary(ctx);
  const mcpCatalog = await loadMcpServers(ctx);
  const tools = mergeRequestedTools(previous.tools, requestedTools);

  if (tools.length === 0) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  const extraSkillSources = new Map<string, SkillSource>([
    [
      entry.name,
      {
        dir: inspected.dir,
        record: {
          type: 'catalog',
          repo: entry.repo,
          path: entry.path,
          ...(entry.ref ? { ref: entry.ref } : {}),
          commit: inspected.commit,
        },
        linkable: false,
        ...(entry.setup ? { setup: entry.setup } : {}),
      },
    ],
  ]);

  const plan = await buildSyncPlanForLocation({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
    mcpCatalog,
    tools,
    extraSkills: [entry.name],
    extraSkillSources,
    warnLocked: true,
  });

  const outcome = await applyWithCatalogRollback({
    ctx,
    prompting,
    plan,
    file: catalogFile,
    entries: [entry],
    failureOutcome: `${entry.name} was not added`,
    manifestPath: location.manifestPath,
    yes,
    dryRun,
  });
  return {
    code: outcome.code,
    catalogCommitted: outcome.applied && outcome.keptEntries.length > 0,
  };
}

export async function runAdd(
  ctx: Context,
  {
    target: rawTarget,
    source = 'all',
    category: requestedCategory,
    ref: requestedRef,
    includeOffensive = false,
    install = false,
    scope: requestedScope,
    projectDir,
    tools: requestedTools,
    yes,
    dryRun,
  }: AddOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const targetInput =
    rawTarget && rawTarget.trim() !== ''
      ? rawTarget.trim()
      : prompting
        ? await promptAddQuery()
        : undefined;
  if (!targetInput) {
    throw new UsageError(
      'Pass a search query, owner/repo[@skill], or GitHub URL to add.',
    );
  }

  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const { inspected, checkoutSnapshot } = await resolveTargetSkill({
    cache: sourceCache(ctx),
    skillLibrary,
    rawTarget: targetInput,
    source,
    ...(requestedCategory ? { requestedCategory } : {}),
    ...(requestedRef ? { requestedRef } : {}),
    includeOffensive,
    prompting,
    ...(ctx.discovery?.skillsShUrl
      ? { skillsShUrl: ctx.discovery.skillsShUrl }
      : {}),
    ...(ctx.discovery?.fetch ? { fetchFn: ctx.discovery.fetch } : {}),
    onWarn: (message) => notify({ ctx, prompting, message, level: 'warn' }),
    chooseLocation: promptRepoSkillLocation,
    chooseCandidate: promptDiscoveredCandidate,
  });

  let catalogCommitted = false;
  try {
    const existingLocal = skillLibrary.skills.find(
      (skill) => skill.name === inspected.name && skill.origin.type === 'local',
    );
    if (existingLocal && existingLocal.origin.type === 'local') {
      throw new CatalogError(
        `${inspected.name} already exists as a first-party skill in ${existingLocal.origin.path}`,
      );
    }

    const entry: CatalogEntry = {
      name: inspected.name,
      repo: inspected.repo,
      path: inspected.path,
      ...(inspected.ref ? { ref: inspected.ref } : {}),
      category: inspected.category ?? DEFAULT_ADD_CATEGORY,
      scopes: ['global', 'project'],
      defaults: [],
    };
    const file = catalogPath(ctx.repoRoot);
    const updatedCatalog = extendCatalog({
      catalog: skillLibrary.catalog,
      entries: [entry],
      file,
    });
    const extendedLibrary = extendSkillLibrary(skillLibrary, updatedCatalog);

    printInspectedSkill(ctx, inspected);

    const shouldInstall =
      install || requestedScope !== undefined || requestedTools !== undefined;
    if (shouldInstall) {
      const outcome = await installAddedSkill({
        ctx,
        prompting,
        skillLibrary: extendedLibrary,
        entry,
        inspected,
        catalogFile: file,
        ...(requestedScope ? { requestedScope } : {}),
        ...(projectDir !== undefined ? { projectDir } : {}),
        ...(requestedTools ? { requestedTools } : {}),
        yes,
        dryRun,
      });
      catalogCommitted = outcome.catalogCommitted;
      return outcome.code;
    }

    ctx.print(`update  catalog.yaml (+${entry.name})`);
    if (dryRun) {
      notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
      return 0;
    }
    if (!ctx.interactive && !yes) {
      ctx.print(
        'Re-run with --yes to apply these changes, or --dry-run to preview them.',
      );
      return 1;
    }
    if (prompting && !(await confirmApply())) {
      notify({ ctx, prompting: true, message: 'Nothing was written.' });
      return 1;
    }

    await appendEntries(file, [entry], `${entry.name} was not added`);
    catalogCommitted = true;
    notify({
      ctx,
      prompting,
      message: `Added to catalog.yaml: ${entry.name}`,
    });
    return 0;
  } finally {
    if (!catalogCommitted) {
      await restoreSourceCheckout(sourceCache(ctx), checkoutSnapshot);
    }
  }
}
