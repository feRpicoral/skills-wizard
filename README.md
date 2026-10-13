# agents-config

The source of truth for my coding-agent instructions and skills. A CLI composes `AGENTS.md` from reusable blocks, installs first-party and curated third-party skills, and links them into the tools you pick, either system-wide or per project.

Supported tools: Claude Code, Codex, Gemini CLI, Antigravity (IDE and `agy`) and Copilot.

## Quick start

```bash
git clone git@github.com:feRpicoral/agents-config.git
cd agents-config
nvm use && corepack enable && yarn install
yarn agents-config
```

With no command, the CLI opens an interactive menu. The system-wide flow can link an `agents-config` command into `~/.local/bin`, so it runs from any directory once `~/.local/bin` is on your `PATH`.

Without a terminal, commands print the plan and only write when you pass `--yes`.

## Commands

| Command                                   | What it does                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `agents-config init --global`             | Install instructions and skills for the selected tools                                         |
| `agents-config init --project <dir>`      | Write a project `AGENTS.md`, project skills, `CLAUDE.md` and Gemini CLI settings               |
| `agents-config sync [--project <dir>]`    | Re-render everything recorded in the manifest                                                  |
| `agents-config update`                    | Fetch upstream skill updates, show changed files and risk flags, and refresh recorded installs |
| `agents-config adopt [skill...]`          | Back up and take over existing unmanaged skills                                                |
| `agents-config doctor [--project <dir>]`  | Report drift, conflicts, skill name clashes and tool-specific problems                         |
| `agents-config skill validate [path...]`  | Validate skill directories against the Agent Skills spec (`--catalog` checks `catalog.yaml`)   |
| `agents-config skill new <name>`          | Scaffold a first-party skill in `skills/<name>` (`--template`, `--with-evals`)                 |
| `agents-config skill eval <name>`         | Benchmark a skill (`with_skill` vs `without_skill` baseline and optional `--compare <ref>`)    |
| `agents-config skill triggers <name>`     | Measure trigger precision, recall and false positive rate on `evals/trigger_queries.json`      |
| `agents-config skill report <name> [dir]` | Regenerate `report.md` from an existing evaluation iteration directory                         |

Common flags: `--tools`, `--blocks`, `--skills`, `--skill-mode copy|link`, `--preset <id>`, `--style lean|self-contained`, `--var name=value`, `--yes`, `--dry-run` and `--local` (keep project files out of git). `agents-config --help` lists all of them.

## Stack presets and project onboarding

`agents-config init --project <dir>` inspects the project directory (`package.json`, `nx.json`, `pyproject.toml`, `.nvmrc`, `prisma/schema.prisma`, `supabase/config.toml`, `components.json` and workspace packages under `apps/*`, `packages/*`, `libs/*`) to auto-detect a stack preset and generate a project-specific seed preamble (`# <name>`, description, `## Commands`, `## Workspaces`) above `<!-- BEGIN:agents-config -->`:

| Preset ID        | Stack blocks (`stack/*`)                                                                    | Preselected skills                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `nextjs-app`     | `typescript`, `node-yarn`, `lint-format`, `nextjs`, `tailwind-shadcn`, `tanstack-query`     | `vercel-react-best-practices`, `shadcn`, `frontend-design`, `eslint-configuration`, `prettier-configuration` |
| `nestjs-api`     | `typescript`, `node-yarn`, `lint-format`, `nestjs`, `prisma`                                | `nestjs-module`, `eslint-configuration`, `prettier-configuration`                                            |
| `nx-monorepo`    | `typescript`, `node-yarn`, `lint-format`, `nx` (+ detected workspace app/lib stack blocks)  | `eslint-configuration`, `prettier-configuration` (+ detected workspace skills)                               |
| `expo-app`       | `typescript`, `node-yarn`, `lint-format`, `expo-react-native`, `tanstack-query`             | `vercel-react-native-skills`, `eslint-configuration`, `prettier-configuration`                               |
| `vite-spa`       | `typescript`, `node-yarn`, `lint-format`, `react-vite`, `tailwind-shadcn`, `tanstack-query` | `vercel-react-best-practices`, `shadcn`, `frontend-design`, `eslint-configuration`, `prettier-configuration` |
| `python-service` | `python-uv`                                                                                 | (none by default)                                                                                            |
| `node-tool`      | `typescript`, `node-yarn`, `lint-format`                                                    | `eslint-configuration`, `prettier-configuration`                                                             |

Additive detections automatically include `stack/prisma`, `stack/supabase-prisma` (`supabase-prisma`), `stack/llm-apps` (`ai-sdk`, `claude-api`) and `playwright-cli` when those packages or config files are present. Use `--style lean` (default) to include only `stack/*` blocks in project `AGENTS.md` alongside the global `AGENTS.md`, or `--style self-contained` to include core, engineering, git, tooling and stack blocks in a standalone file.

## How it works

```mermaid
flowchart LR
    blocks["blocks/*.md"] --> compose["Compose selected blocks"]
    skills["skills/* and catalog.yaml"] --> cache["Sparse source cache"]
    compose --> plan["Plan: create, update, remove, conflict"]
    cache --> plan
    manifest["Manifest of owned paths"] --> plan
    plan --> review["Review"]
    review --> apply["Apply and record"]
    apply --> manifest
```

- The CLI only rewrites text between `<!-- BEGIN:agents-config -->` and `<!-- END:agents-config -->`. Everything outside the markers stays as it is, including regions that other tools write.
- System-wide skills are copied once into `~/.agents/skills/<name>` (or linked from `skills/<name>` in `link` mode for first-party skills) and symlinked into each selected tool's skill directory when needed. Project skills are copied into `.agents/skills/<name>` and linked relatively from `.claude/skills/<name>` for Claude Code.
- The manifest (`~/.agents/agents-config/manifest.json`, or `.agents/agents-config.json` in a project) lists every path the CLI owns, along with skill provenance and content hashes. Locally edited skill copies are flagged as conflicts rather than overwritten, and unmanaged skill folders can be taken over with `agents-config adopt` after a backup.
- `agents-config update` checks upstream repositories, summarizes changed files and risky patterns (such as `curl | sh`, `npx --yes`, `@latest`, new executables or hook changes), and refreshes the system-wide install and every recorded project.

[docs/architecture.md](docs/architecture.md) covers the details, and [docs/tools.md](docs/tools.md) lists where each tool reads its files.

## Adding or editing a block

1. Create `blocks/<group>/<id>.md` with frontmatter: `title`, `summary`, `group`, `scopes`, `defaults` and, if needed, `variables` and `requires` (blocks it depends on, listed earlier in the order).
2. Add its id to `blocks/index.yaml` where it should appear in the composed file.
3. Run `yarn test`.
4. Run `agents-config init` and select the new block. `sync` only re-renders the blocks an install already recorded, so it picks up edits to existing blocks but never adds new ones.

## Adding and evaluating a skill

- **First-party skill:** scaffold `skills/<name>` with `yarn agents-config skill new <name> --with-evals` (or use the `skill-author` skill), author `SKILL.md` with spec-compliant frontmatter (`name` matching `<name>` and `description` stating when to use the skill), and run `yarn agents-config skill validate skills/<name>`.
- **Benchmarking and triggers:** define test cases in `skills/<name>/evals/evals.json` and trigger queries in `skills/<name>/evals/trigger_queries.json`, then run `yarn agents-config skill eval <name>` and `yarn agents-config skill triggers <name>` (or use the `skill-evaluator` skill). Reports and `benchmark.json` artifacts are written to `~/.agents/agents-config/evals/<name>/`.
- **Third-party skill:** add an entry to `catalog.yaml` (`name`, `repo`, `path`, `category`, `scopes`, optional `ref`, `defaults`, `setup`, `note`) and run `yarn agents-config skill validate --catalog`.
