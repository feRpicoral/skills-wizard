export {
  type AssertInsideRepoParams,
  assertInsideRepository,
  inspectDiscoveredSkill,
  type InspectDiscoveredSkillParams,
  locateSkillsInRepo,
  type LocateSkillsInRepoParams,
  type RepoSkillLocation,
  type ResolvedDiscoveredSkill,
} from './discover/inspect.ts';
export {
  mergeCandidateMetadata,
  type ResolvedTargetOutcome,
  resolveEffectiveRef,
  type ResolveEffectiveRefParams,
  type ResolveTargetCandidateParams,
  resolveTargetSkill,
  searchCandidates,
  type SearchCandidatesParams,
} from './discover/resolve.ts';
export {
  AWESOME_INDEX_FILE,
  AWESOME_SKILLS_REPO,
  isOffensiveCandidate,
  searchAwesomeIndex,
  type SearchAwesomeIndexParams,
} from './discover/search-awesome.ts';
export {
  type DiscoveryCandidate,
  searchSkillsSh,
  type SearchSkillsShParams,
} from './discover/search-skills-sh.ts';
export {
  DISCOVER_SOURCES,
  type DiscoverSource,
  isDiscoverSource,
  type ParsedSkillTarget,
  parseSkillTarget,
  type ResolvedGithubPathTarget,
  resolveGithubPathTarget,
  type ResolveGithubPathTargetParams,
} from './discover/target.ts';
