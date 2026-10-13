---
name: skill-author
description: Designs, scaffolds, writes, and refactors Agent Skills (SKILL.md, references/, scripts/, assets/, and starter evals/) in skills/<name>. Use when the user asks to create a new skill, turn a workflow into a reusable skill, scaffold skills/<name>, write or tighten SKILL.md instructions and frontmatter descriptions, or split an oversized skill into progressive-disclosure reference files. Don't use for running benchmarks, grading eval runs, measuring trigger precision/recall, or writing evals for an existing skill (use skill-evaluator), or for editing global AGENTS.md blocks.
compatibility: Uses the agents-config CLI when it is on PATH and falls back to manual checks without it
---

# Skill Author

Author spec-compliant, progressive-disclosure Agent Skills under `skills/<name>/` and validate them with `agents-config skill validate`.

## Running the CLI

- Run `agents-config skill <subcommand>` from the repository that holds `skills/<name>/`.
- Inside the agents-config repository itself, run `yarn agents-config skill <subcommand>` instead.
- If neither command is available, say so, create the files by hand following the steps below, and check the result against the checklist in [references/spec-and-patterns.md](references/spec-and-patterns.md). Tell the user the validation was manual.

## Workflow

1. **Capture intent and boundaries**
   - Decide whether the guidance belongs in an **Agent Skill** or an **`AGENTS.md` block**:
     - Use an **Agent Skill** (`skills/<name>/`) for domain-specific workflows, multi-step procedures, or bundled helper scripts that should load on demand only when relevant.
     - Use an **`AGENTS.md` block** (`blocks/`) for brief, cross-cutting rules that must apply to every turn in every task.
   - Identify the concrete tasks the skill should handle, the expected outputs, and the tools or commands involved. Fill gaps in a casual request with sensible defaults rather than stopping to ask.
   - Determine what the agent already knows versus the project-specific conventions, fragile flag sequences, or domain rules that belong in the skill.
   - Choose the smallest directory template that fits the task:
     - `basic`: `SKILL.md` only, for concise procedural guidance under 200 lines.
     - `scripted`: `SKILL.md` + `scripts/` + `references/`, when deterministic validation, parsing, or code generation can be offloaded to an executable script.
     - `reference-heavy`: `SKILL.md` + `references/`, when different task variants or ecosystems need detailed reference tables loaded on demand.

2. **Scaffold the skill directory**
   - Run the scaffolder from the repository root:
     ```bash
     agents-config skill new <name> --template <basic|scripted|reference-heavy> --with-evals
     ```
   - Naming rules (`name` frontmatter and folder name must match):
     - 1-64 characters, lowercase ASCII letters, digits, and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`).
     - Prefer specific, action-oriented or domain-scoped names (`eslint-configuration`, `pdf-form-filler`) over vague labels (`utils`, `helper`).

3. **Write frontmatter for reliable triggering**
   - Keep frontmatter strictly within the Agent Skills specification fields (`name`, `description`, and optional `license`, `compatibility`, `metadata`, `allowed-tools`).
   - Add `license` only when the user chooses one and the repository ships the matching license file; never pick a license on the user's behalf.
   - Write `description` in **third-person voice** (1-1024 characters) covering three parts:
     1. **What it does**: concrete capabilities, file formats, and outputs.
     2. **When to use it**: explicit `Use when...` clause naming user phrases, file names, error messages, and scenarios, including cases where the user does not name the tool directly.
     3. **When not to use it**: brief `Don't use for...` clause ruling out near-miss tasks handled by sibling skills or standard tooling.

4. **Structure the `SKILL.md` body for progressive disclosure**
   - Keep `SKILL.md` under **300 lines** (strict validator warns at 500 lines).
   - Start with a concise workflow overview, then cover the default path with copy-pasteable commands or minimal code examples.
   - Explain the **why** behind non-obvious constraints rather than stacking rigid `ALWAYS`/`NEVER` rules without context.
   - When a skill recommends libraries or dependencies for user code, prefer established, focused libraries (such as `zod` for schema validation or `which` for executable lookup) over fragile hand-rolled implementations, while avoiding bloated frameworks.
   - Move deep option tables, ecosystem variants, and edge-case catalogs into `references/<topic>.md` and link to them directly from `SKILL.md` with clear guidance on when to read each file.
   - Keep references **one hop deep** from `SKILL.md`: files inside `references/` must not link to further reference files.
   - Never create `README.md`, `CHANGELOG.md`, or `INSTALLATION_GUIDE.md` inside a skill directory.

5. **Design bundled scripts (`scripts/`) when needed**
   - Make scripts self-contained, non-interactive, and idempotent (never prompt on TTY; accept all inputs via CLI flags).
   - Prefer established, focused libraries already available in the project environment over hand-rolled parsers or validators when bundling scripts.
   - Support `--help` to document usage and flags, emit structured output (JSON or clear line-oriented diagnostics), and return non-zero exit codes with actionable stderr messages on failure.
   - Mark executable scripts `chmod 755` with a `#!/usr/bin/env node` or `#!/usr/bin/env bash` shebang.

6. **Author starter evaluation suites (`evals/`)**
   - Populate `evals/evals.json` with at least 3 realistic test cases spanning:
     - **Casual phrasing**: a short, underspecified request written the way a user actually types it ("can you make a skill out of what we just did?"), not a restatement of the skill's own rules.
     - **Precise specification**: detailed technical requirements and constraints.
     - **Edge case / migration**: broken, legacy, or conflicting input files under `evals/files/<case-id>/`.
   - Give every case at least one assertion, and use only the scripted types `file_exists`, `file_absent`, `regex`, `json_valid`, and `command`, plus natural-language strings for the blind grader.
   - Point scripted assertions at the conventions the skill teaches (a specific file layout, a required field, a command that must succeed) rather than at things any agent does anyway, such as a file the fixture already contains.
   - Populate `evals/trigger_queries.json` with 10 positive (`should_trigger: true`) and 10 near-miss negative (`should_trigger: false`) queries. Write each query as a plain user request: no labels such as `[negative]`, and negatives that share vocabulary with the skill but need a different tool.
   - Hand off to `skill-evaluator` to tighten assertions or run benchmarks.

7. **Validate before finishing**
   - Run strict spec validation:
     ```bash
     agents-config skill validate skills/<name>
     ```
   - Fix all reported errors and warnings before handing off to `skill-evaluator` for benchmarking.

## References

- Read [references/spec-and-patterns.md](references/spec-and-patterns.md) when checking exact Agent Skills frontmatter constraints, choosing a progressive-disclosure pattern, validating by hand without the CLI, or reviewing the `SKILL.md` and `evals/` checklists.
