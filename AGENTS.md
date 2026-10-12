# agents-config

A CLI and the content it installs: `AGENTS.md` instructions for Claude Code, Codex, Gemini CLI, Antigravity (IDE and `agy`) and Copilot.

## Commands

- Setup: `nvm use && corepack enable && yarn install`
- Run the CLI from source: `yarn agents-config [command]`. Node 24 strips the TypeScript types at runtime, so there is no build step.
- Checks before pushing: `yarn lint && yarn typecheck && yarn test`

## Layout

- `blocks/`: instruction fragments. `blocks/index.yaml` sets the composed order and the group labels.
- `src/blocks/`: loading, validating and composing blocks.
- `src/install/`: planning and applying file changes (managed regions, import lines, JSON merges, symlinks).
- `src/tools/registry.ts`: where each supported tool reads its files.
- `src/state/`: manifests that record every path the CLI owns.
- `src/commands/` and `src/prompts/`: CLI commands and interactive prompts.
- `docs/`: architecture and per-tool reference.

## Conventions

- Relative imports use the `.ts` extension and type-only imports use `import type`. No enums, namespaces or parameter properties (`erasableSyntaxOnly`), because Node runs the source directly.
- Only `src/env.ts` reads environment variables. Everything else receives a `Paths` object.
- Never modify or delete a path that is not recorded in a manifest.
- Block bodies start with an H2 heading, except `core/identity`. Block text becomes installed instructions, so edit it deliberately. Prettier ignores `blocks/` to keep that text exact.
- Code, docs, tests and commits reference only public tools and paths.
- Tests use `tempPaths` and `tempDir` and never touch the real home directory.
