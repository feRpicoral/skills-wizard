import type { Context } from '../context.ts';
import { displayPath } from '../install/describe.ts';
import { scanInstalledSkills } from '../skills/collisions.ts';
import { resolveSkillSources, type SkillSource } from '../skills/install.ts';
import { loadSkillLibrary, unknownSkillNames } from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import type { Finding } from './doctor-checks.ts';
import { sourceCache } from './shared.ts';

export async function skillFindings(
  ctx: Context,
  manifest: Manifest | null,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const scan = await scanInstalledSkills(ctx.paths, manifest);
  for (const collision of scan.collisions) {
    const locations = collision.paths
      .map((path) => displayPath({ path, home }))
      .join(', ');
    findings.push({
      level: 'warn',
      message: `Skill "${collision.name}" is declared in multiple locations: ${locations}`,
    });
  }
  for (const path of scan.skipped) {
    findings.push({
      level: 'warn',
      message: `Skipped unreadable or incomplete skill folder: ${displayPath({ path, home })}`,
    });
  }
  if (scan.unmanaged.length > 0) {
    const list = scan.unmanaged
      .map(
        (skill) => `${skill.name} (${displayPath({ path: skill.path, home })})`,
      )
      .join(', ');
    findings.push({
      level: 'note',
      message: `Unmanaged skills: ${list}`,
    });
  }
  return findings;
}

export async function resolveDoctorSkills(
  ctx: Context,
  manifest: Manifest,
): Promise<{
  skills: string[];
  sources: Map<string, SkillSource>;
  findings: Finding[];
}> {
  const findings: Finding[] = [];
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const unknownSkills = unknownSkillNames(skillLibrary, manifest.skills);
  if (unknownSkills.length > 0) {
    findings.push({
      level: 'warn',
      message: `Skills no longer in catalog.yaml or skills/: ${unknownSkills.join(', ')}; agents-config sync will remove them`,
    });
  }
  const skills = manifest.skills.filter(
    (name) => !unknownSkills.includes(name),
  );
  const resolution = await resolveSkillSources({
    library: skillLibrary,
    names: skills,
    cache: sourceCache(ctx),
    fetch: false,
  });
  for (const [name, problem] of resolution.problems) {
    findings.push({
      level: 'note',
      message: `Skipped checking the ${name} skill: ${problem}`,
    });
  }
  return { skills, sources: resolution.sources, findings };
}
