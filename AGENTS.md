# skills-wizard

A CLI and the content it installs: `AGENTS.md` instructions, skills, and curated MCP server configurations for Claude Code, Codex, Gemini CLI, Antigravity (IDE and `agy`) and Copilot.

## Commands

- Setup: `nvm use && corepack enable && yarn install`
- Run the CLI from source: `yarn skills-wizard [command]`. Node 24 strips the TypeScript types at runtime, so development has no build step.
- Validate and add skills: `yarn skills-wizard skill validate [path...]`, `yarn skills-wizard skill validate --catalog`, `yarn skills-wizard add [query|url]`
- Scaffold and evaluate skills: `yarn skills-wizard skill new <name> [--with-evals]`, `yarn skills-wizard skill eval <name> [--compare <ref>|<skill-a>,<skill-b>]`, `yarn skills-wizard skill triggers <name>`, `yarn skills-wizard skill report <name> [iteration-dir]`
- Manage and search MCP servers: `yarn skills-wizard mcp [list]`, `yarn skills-wizard mcp add <name...>`, `yarn skills-wizard mcp remove <name...>`, `yarn skills-wizard mcp search <query> [--official] [--limit <n>] [--add]`
- Regenerate the README screenshot after changing the banner or main menu: `yarn readme:screenshot`
- Build the npm package output (`dist/`, also run by `prepack`): `yarn build`. Node does not strip types under `node_modules`, so the published `bin` points at compiled JavaScript.
- Checks before pushing: `yarn lint && yarn typecheck && yarn test`

## Layout

- `blocks/`: instruction fragments. `blocks/index.yaml` sets the composed order and the group labels.
- `presets/`: stack preset definitions (`presets/<id>.yaml`) mapping project archetypes to `stack/*` blocks and skills.
- `skills/`: first-party skills (`skills/<name>/SKILL.md`), validated strictly against the Agent Skills spec.
- `catalog.yaml`: curated third-party skills by upstream repository and path.
- `mcp/servers.yaml`: curated MCP server catalog (`stdio`, `http`, `sse`) with scope defaults, project auto-detection keys, secret references, and tool allow/deny filters.
- `src/blocks/`: loading, validating and composing blocks.
- `src/project/`: stack preset loading (`presets.ts`), project stack/workspace auto-detection (`detect.ts`) and initial `AGENTS.md` seed preamble generation (`seed.ts`).
- `src/skills/`: catalog loading, third-party skill discovery (`discover.ts`), sparse git source cache, skill tree copying/hashing, spec validation, collision detection, diffs and risk scanning.
- `src/mcp/`: MCP server catalog loading (`model.ts`), per-tool config rendering (`render.ts`), lossless JSON and TOML config merging (`install.ts`), and MCP registry search (`search.ts`).
- `src/evals/`: skill evaluation schemas (`evals.json`, `trigger_queries.json`), isolated workspace preparation, runner adapters (`agy`, `claude`, `codex`, `gemini`, `fake`), scripted and blind-grader assertion evaluation, benchmark aggregation and Markdown reports.
- `src/install/`: planning and applying file and skill changes (managed regions, import lines, JSON merges, MCP JSON/TOML merges, symlinks, skill trees).
- `src/tools/registry.ts`: where each supported tool reads its instructions and skills.
- `src/state/`: manifests and the recorded projects registry (`projects.json`).
- `src/commands/` and `src/prompts/`: CLI commands (`init`, `sync`, `update`, `add`, `adopt`, `doctor`, `skill`, `mcp`), the interactive menu loop (`menu.ts`), interactive prompts and the launch banner (`banner.ts`).
- `scripts/`: repository maintenance scripts (`readme-screenshot.ts` renders `docs/assets/cli.svg`).
- `docs/`: architecture and per-tool reference.

## Conventions

- Relative imports use the `.ts` extension and type-only imports use `import type`. No enums, namespaces or parameter properties (`erasableSyntaxOnly`), because Node runs the source directly.
- Only `src/env.ts` reads environment variables. Everything else receives a `Paths` object.
- Never modify or delete a path that is not recorded in a manifest.
- Block bodies start with an H2 heading, except `core/identity`. Block text becomes installed instructions, so edit it deliberately. Prettier ignores `blocks/` to keep that text exact.
- Every skill in `catalog.yaml` from the same repository must share one `ref`, and its upstream `SKILL.md` frontmatter `name` must match the catalog `name`.
- Add first-party skills under `skills/<name>/` (`yarn skills-wizard skill new <name> --with-evals`), validate with `yarn skills-wizard skill validate skills/<name>`, and evaluate with `yarn skills-wizard skill eval <name>` and `yarn skills-wizard skill triggers <name>`.
- First-party skill instructions call `skills-wizard skill ...`; `yarn skills-wizard` applies only inside this repository.
- Code, docs, tests and commits reference only public tools and paths.
- Tests use `tempPaths`, `tempDir` and local bare git repositories (`createUpstream`) and never touch the network or the real home directory.
