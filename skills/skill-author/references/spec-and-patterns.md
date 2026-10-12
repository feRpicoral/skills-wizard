# Agent Skills Specification and Authoring Patterns

## Table of Contents

1. [Frontmatter Specification](#1-frontmatter-specification)
2. [Description Formula and Examples](#2-description-formula-and-examples)
3. [Progressive Disclosure Patterns](#3-progressive-disclosure-patterns)
4. [Bundled Script Conventions](#4-bundled-script-conventions)
5. [Pre-Flight Authoring Checklist](#5-pre-flight-authoring-checklist)

## 1. Frontmatter Specification

Strict validation (`yarn agents-config skill validate skills/<name>`) enforces the Agent Skills specification:

| Field           | Required | Constraints                                                                                                                      |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | 1–64 chars; lowercase `a-z`, `0-9`, and single `-`; cannot start/end with `-` or contain `--`; must match parent directory name. |
| `description`   | Yes      | 1–1024 chars; non-empty string; must state what the skill does and when to use it (`Use when...`).                               |
| `license`       | No       | Non-empty string (for example `MIT` or `Apache-2.0`).                                                                            |
| `compatibility` | No       | 1–500 chars describing runtime, OS, or binary requirements.                                                                      |
| `metadata`      | No       | Map of string keys to string values only (nested objects or numbers fail strict validation).                                     |
| `allowed-tools` | No       | Space-delimited string of pre-approved tool names.                                                                               |

Any unknown frontmatter key is rejected by strict validation for first-party skills.

## 2. Description Formula and Examples

The skill `description` is always loaded in the agent's system prompt metadata list. Use this three-part structure:

```text
<Action verbs + domain capabilities and outputs>. Use when <specific user intents, file names, error messages, and indirect triggers>. Don't use for <near-miss tasks that belong to another skill or built-in tool>.
```

### Weak vs Strong Descriptions

- **Too vague (under-triggers and over-triggers):**
  `Helps with JSON schemas and validation files.`
- **Strong (clear scope, triggers, and exclusions):**
  `Authors and validates JSON Schema Draft 2020-12 definitions, migrates Draft-07 schemas, and runs structural lint checks. Use when the user asks to create or fix a .schema.json file, enforce additionalProperties: false, or debug schema validation failures. Don't use for runtime TypeScript validation with Zod or database DDL migrations.`

## 3. Progressive Disclosure Patterns

Keep `SKILL.md` focused on the core workflow (<300 lines) and organize supporting files by role:

- **Pattern A — High-level workflow with variant references:**
  Put the universal 4–6 step workflow in `SKILL.md`, and place framework- or provider-specific configurations in `references/<variant>.md`. In `SKILL.md`, tell the agent which reference file to read based on the files detected in the workspace.
- **Pattern B — Deterministic helper scripts + concise instructions:**
  Put repeatable verification or transformation logic in `scripts/<action>.mjs` and instruct the agent to run `node <skill-dir>/scripts/<action>.mjs <target>` instead of re-deriving complex shell pipelines.
- **One-hop rule:**
  Every file in `references/` must be linked directly from `SKILL.md` using a relative markdown link (`references/<topic>.md`) and must not link to any other markdown file in `references/`.
- **Long reference files (>100 lines):**
  Include a `## Table of Contents` immediately after the H1 heading so an agent can jump to the relevant section with a partial file read.

## 4. Bundled Script Conventions

When adding scripts under `skills/<name>/scripts/`:

- Use Node.js (`#!/usr/bin/env node` with `.mjs`) or POSIX/Bash (`#!/usr/bin/env bash`) without external network calls.
- Never block on interactive stdin prompts; fail fast with usage instructions when required flags are missing.
- Support `--help` and exit `0` when printing help.
- Keep `evals/` out of runtime dependencies: `copySkillTree` strips `evals/` when installing skills to `~/.agents/skills/<name>`.

## 5. Pre-Flight Authoring Checklist

- [ ] `skills/<name>/SKILL.md` exists and `name` matches `<name>`.
- [ ] `description` uses third-person voice, includes `Use when...` and `Don't use for...`, and is <=1024 characters.
- [ ] `SKILL.md` body is under 300 lines and uses imperative steps with concrete examples.
- [ ] No `README.md`, `CHANGELOG.md`, or nested reference chains exist inside `skills/<name>/`.
- [ ] `evals/evals.json` has >=3 cases with fixture files under `evals/files/<case-id>/` and mixed scripted + string assertions.
- [ ] `evals/trigger_queries.json` has 10 positive and 10 near-miss negative queries.
- [ ] `yarn agents-config skill validate skills/<name>` exits `0` with 0 errors and 0 warnings.
