# agents-config

A CLI and the content it installs: `AGENTS.md` instructions and skills for Claude Code, Codex, Gemini CLI, Antigravity (IDE and `agy`) and Copilot.

## Commands

- Setup: `nvm use && corepack enable && yarn install`
- Run the CLI from source: `yarn agents-config [command]`. Node 24 strips the TypeScript types at runtime, so there is no build step.
- Validate skills: `yarn agents-config skill validate [path...]` or `yarn agents-config skill validate --catalog`
- Scaffold and evaluate skills: `yarn agents-config skill new <name> [--with-evals]`, `yarn agents-config skill eval <name>`, `yarn agents-config skill triggers <name>`, `yarn agents-config skill report <name> [iteration-dir]`
- Checks before pushing: `yarn lint && yarn typecheck && yarn test`

## Layout

- `blocks/`: instruction fragments. `blocks/index.yaml` sets the composed order and the group labels.
- `presets/`: stack preset definitions (`presets/<id>.yaml`) mapping project archetypes to `stack/*` blocks and skills.
- `skills/`: first-party skills (`skills/<name>/SKILL.md`), validated strictly against the Agent Skills spec.
- `catalog.yaml`: curated third-party skills by upstream repository and path.
- `src/blocks/`: loading, validating and composing blocks.
- `src/project/`: stack preset loading (`presets.ts`), project stack/workspace auto-detection (`detect.ts`) and initial `AGENTS.md` seed preamble generation (`seed.ts`).
- `src/skills/`: catalog loading, sparse git source cache, skill tree copying/hashing, spec validation, collision detection, diffs and risk scanning.
- `src/evals/`: skill evaluation schemas (`evals.json`, `trigger_queries.json`), isolated workspace preparation, runner adapters (`agy`, `claude`, `codex`, `gemini`, `fake`), scripted and blind-grader assertion evaluation, benchmark aggregation and Markdown reports.
- `src/install/`: planning and applying file and skill changes (managed regions, import lines, JSON merges, symlinks, skill trees).
- `src/tools/registry.ts`: where each supported tool reads its instructions and skills.
- `src/state/`: manifests and the recorded projects registry (`projects.json`).
- `src/commands/` and `src/prompts/`: CLI commands (`init`, `sync`, `update`, `adopt`, `doctor`, `skill`) and interactive prompts.
- `docs/`: architecture and per-tool reference.

## Conventions

- Relative imports use the `.ts` extension and type-only imports use `import type`. No enums, namespaces or parameter properties (`erasableSyntaxOnly`), because Node runs the source directly.
- Only `src/env.ts` reads environment variables. Everything else receives a `Paths` object.
- Never modify or delete a path that is not recorded in a manifest.
- Block bodies start with an H2 heading, except `core/identity`. Block text becomes installed instructions, so edit it deliberately. Prettier ignores `blocks/` to keep that text exact.
- Every skill in `catalog.yaml` from the same repository must share one `ref`, and its upstream `SKILL.md` frontmatter `name` must match the catalog `name`.
- Add first-party skills under `skills/<name>/` (`yarn agents-config skill new <name> --with-evals`), validate with `yarn agents-config skill validate skills/<name>`, and evaluate with `yarn agents-config skill eval <name>` and `yarn agents-config skill triggers <name>`.
- First-party skill instructions call `agents-config skill ...`; `yarn agents-config` applies only inside this repository.
- Code, docs, tests and commits reference only public tools and paths.
- Tests use `tempPaths`, `tempDir` and local bare git repositories (`createUpstream`) and never touch the network or the real home directory.
