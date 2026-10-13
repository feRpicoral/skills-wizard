---
name: skill-evaluator
description: Evaluates, benchmarks, grades, and optimizes Agent Skills using evals/evals.json, evals/trigger_queries.json, and the agents-config skill eval, triggers, and report commands. Use when the user asks to benchmark a skill with vs without baseline, compare a skill against an older git ref, write, extend, or tighten the evals and trigger queries of an existing skill, measure trigger precision and recall on train/validation splits, or audit benchmark.json and report.md for non-discriminating assertions or baseline contamination. Don't use for scaffolding a brand-new skill or restructuring SKILL.md (use skill-author), or for benchmarking application code.
compatibility: Uses the agents-config CLI and an agent CLI (agy, claude, codex, or gemini) on PATH; without them it can only author and audit eval files
---

# Skill Evaluator

Measure whether an Agent Skill improves task outcomes over the no-skill baseline and triggers reliably on realistic user prompts without false positives.

## Running the CLI

- Run `agents-config skill <subcommand>` from the repository that holds `skills/<name>/`.
- Inside the agents-config repository itself, run `yarn agents-config skill <subcommand>` instead.
- If neither command is available, say so: you can still write and audit `evals/evals.json`, `evals/trigger_queries.json`, and existing `benchmark.json` or `triggers.json` files, but do not claim pass rates or trigger metrics you did not measure.
- Eval runs launch real agent CLIs with your real home directory and credentials. They are not confined: `--sandbox` is passed only to runners that support it, and the CLI warns when a runner cannot honor it. Use `--runner fake` to dry-run a suite without calling any agent.

## Workflow

1. **Audit or author the evaluation suite (`evals/evals.json`)**
   - Ensure `evals/evals.json` declares `"skill_name": "<name>"` matching the skill directory and includes at least 3 realistic cases:
     - **Casual phrasing**: a short, underspecified request written the way a user actually types it, not a restatement of the skill's rules.
     - **Precise specification**: detailed technical constraints and target file names.
     - **Edge case / migration**: legacy, conflicting, or broken fixture files under `evals/files/<case-id>/`.
   - Case ids must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and be unique ignoring case, and every case needs at least one assertion.
   - Prefer **deterministic scripted assertions** wherever an outcome can be checked programmatically; these are the only scripted types:
     - `{"type": "file_exists", "path": "<relPath>"}`
     - `{"type": "file_absent", "path": "<relPath>"}`
     - `{"type": "regex", "path": "<relPath>", "pattern": "<regex>", "flags": "m"}`
     - `{"type": "json_valid", "path": "<relPath>"}`
     - `{"type": "command", "run": "<shell command>", "expect": 0}`
   - Aim them at the conventions the skill teaches. An assertion the baseline also passes (a file the fixture already contains, valid JSON) measures nothing.
   - Reserve natural-language string assertions for semantic qualities graded by the blind LLM grader.
   - Writing evals for a skill that does not exist yet is part of scaffolding it; hand that to `skill-author`.

2. **Run with-skill vs baseline benchmarks (`skill eval`)**
   - Run the suite:
     ```bash
     agents-config skill eval <name> --runs 3 --parallel 2
     ```
   - Key options:
     - `--runner <agy|claude|codex|gemini|fake>`: choose the agent CLI runner (auto-detected on `PATH` in order `agy` -> `claude` -> `codex` -> `gemini`).
     - `--baseline` / `--no-baseline` / `--baseline none`: include or skip the `without_skill` baseline (enabled by default; the skill is excluded at the workspace or CLI level without touching `~/.agents/skills`).
     - `--baseline <git-ref>`: replace the `without_skill` baseline with the skill as it was at `<git-ref>`. Cannot be combined with `--compare`.
     - `--compare <git-ref>`: also run `old_skill` extracted from `<git-ref>` to check that an edit did not regress existing cases. The ref is read from the repository that contains the skill folder and is checked before any run starts.
     - `--case <id>` or `--cases <id1,id2>`: run a single eval case or a comma-separated subset of cases during fast iteration.
     - `--keep-workdirs`: preserve `<runDir>/workdir` when debugging a failing assertion.

3. **Analyze `benchmark.json` and `report.md` (`skill report`)**
   - Read `~/.agents/agents-config/evals/<name>/iteration-<N>/report.md`, or regenerate it with `agents-config skill report <name>` (latest iteration), `agents-config skill report <name> iteration-<N>`, or `agents-config skill report <run-dir>`:
     - **Failed runs**: a run that errored or timed out fails all of its assertions with `Agent run failed: ...`; fix the runner problem before reading pass rates.
     - **Baseline status**: verify `metadata.baseline_status` is `"clean"`. If it is `"possibly contaminated"` (the runner cannot exclude a globally installed copy of the skill), treat small deltas with caution.
     - **Pass-rate, duration, and token deltas**: `run_summary.delta` is `with_skill` minus `without_skill` (`old_skill_delta` is against `old_skill`); the report shows the pass-rate delta in percentage points. Tokens read `n/a` when the runner reported no usage.
     - **Assertion classifications**: `non-discriminating` assertions pass in both variants and should be tightened or replaced; `regressing` assertions pass less often with the skill and point at a counterproductive instruction; `no-baseline` means there was nothing to compare against. `old_skill_classification` classifies each assertion against `old_skill` when `--compare` was used.

4. **Measure and optimize trigger precision & recall (`skill triggers`)**
   - Ensure `evals/trigger_queries.json` has at least 10 positive (`should_trigger: true`) and 10 near-miss negative (`should_trigger: false`) queries, written as plain user requests without labels.
   - Iterate on the `SKILL.md` `description` against the **train** split (about 60% of each class, chosen per query by hash so adding queries never moves existing ones):
     ```bash
     agents-config skill triggers <name> --split train --runs 3
     ```
   - Inspect false negatives (under-triggering) and false positives (over-triggering) in `triggers.md`, refine the `Use when...` and `Don't use for...` clauses in `SKILL.md`, and re-run on `--split train`.
   - Once train recall and specificity meet target thresholds, verify generalization on the held-out **validation** split:
     ```bash
     agents-config skill triggers <name> --split validation --runs 3
     ```
   - Never tune `description` phrasing directly to validation queries; if validation recall or precision drops well below train, generalize the trigger concepts rather than adding query-specific keywords.

## References

- Read [references/grading-and-metrics.md](references/grading-and-metrics.md) for the complete `evals.json`, `benchmark.json`, and `triggers.json` schemas, scripted assertion behavior, blind grader rules, and diagnostic playbooks.
