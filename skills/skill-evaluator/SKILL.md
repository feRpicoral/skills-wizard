---
name: skill-evaluator
description: Evaluates, benchmarks, grades, and optimizes Agent Skills using evals/evals.json, evals/trigger_queries.json, and the agents-config skill eval, triggers, and report commands. Use when the user asks to benchmark a skill with vs without baseline, compare a skill against an older git ref, write or tighten scripted and blind-grader assertions in evals.json, measure trigger precision and recall on train/validation splits, or audit benchmark.json and report.md for non-discriminating assertions or baseline contamination. Don't use for scaffolding a brand-new skill from scratch (use skill-author).
compatibility: Requires git and agents-config on PATH
---

# Skill Evaluator

Measure whether an Agent Skill improves task outcomes over the no-skill baseline and triggers reliably on realistic user prompts without false positives.

## Workflow

1. **Audit or author the evaluation suite (`evals/evals.json`)**
   - Ensure `evals/evals.json` declares `"skill_name": "<name>"` matching the skill directory and includes at least 3 realistic cases:
     - **Casual phrasing**: natural user request with realistic project context.
     - **Precise specification**: detailed technical constraints and target file names.
     - **Edge case / migration**: legacy, conflicting, or broken fixture files under `evals/files/<case-id>/`.
   - Prefer **deterministic scripted assertions** wherever an outcome can be checked programmatically:
     - `{"type": "file_exists", "path": "<relPath>"}`
     - `{"type": "file_absent", "path": "<relPath>"}`
     - `{"type": "regex", "path": "<relPath>", "pattern": "<regex>", "flags": "m"}`
     - `{"type": "json_valid", "path": "<relPath>"}`
     - `{"type": "command", "run": "<shell command>", "expect": 0}`
   - Reserve natural-language string assertions for semantic qualities graded by the blind LLM grader (which runs after scripted assertions and requires non-empty supporting `evidence` for every pass).

2. **Run with-skill vs baseline benchmarks (`skill eval`)**
   - Execute the benchmark suite from the repository root:
     ```bash
     yarn agents-config skill eval <name> --runs 3 --parallel 2
     ```
   - Key options:
     - `--runner <agy|claude|codex|gemini|fake>`: choose the agent CLI runner (auto-detected on `PATH` in order `agy` -> `claude` -> `codex` -> `gemini`).
     - `--baseline` / `--no-baseline` / `--baseline none|<git-ref>`: include or skip the `without_skill` baseline (enabled by default; excludes the skill at the workspace/CLI level without touching `~/.agents/skills`), or compare directly against `<git-ref>`.
     - `--compare <git-ref>`: also run `old_skill` extracted from `<git-ref>:skills/<name>` to verify an edit did not regress existing cases.
     - `--case <id>` or `--cases <id1,id2>`: run a single eval case or a comma-separated subset of cases during fast iteration.
     - `--keep-workdirs`: preserve `<runDir>/workdir` when debugging a failing assertion.

3. **Analyze `benchmark.json` and `report.md` (`skill report`)**
   - Inspect `~/.agents/agents-config/evals/<name>/iteration-<N>/report.md` (or regenerate it with `yarn agents-config skill report <name> [iteration-dir]` or `yarn agents-config skill report <run-dir>`):
     - **Baseline status**: verify `metadata.baseline_status` is `"clean"`. If it is `"possibly contaminated"` (when a runner lacks workspace-level skill exclusion and the skill is installed globally), interpret small deltas with caution.
     - **Pass-rate, duration, and token deltas**: check `run_summary.delta` (`with_skill` minus `without_skill`).
     - **Non-discriminating and flaky assertions**: review `non_discriminating_assertions` and `assertion_analysis` (`pass_only_with_skill`, `pass_in_both`, `fail_in_both`, `flaky`): any assertion that passes 100% in both `with_skill` and `without_skill` does not measure skill value and should be tightened or replaced.
     - **Regressing assertions**: any assertion with classification `"regressing"` (`with_skill` pass rate below baseline) indicates an instruction in `SKILL.md` is counterproductive.

4. **Measure and optimize trigger precision & recall (`skill triggers`)**
   - Ensure `evals/trigger_queries.json` has at least 10 positive (`should_trigger: true`) and 10 near-miss negative (`should_trigger: false`) multi-sentence prompts.
   - Evaluate on the deterministic 60% **train** split while iterating on the `SKILL.md` `description`:
     ```bash
     yarn agents-config skill triggers <name> --split train --runs 3
     ```
   - Inspect false negatives (under-triggering) and false positives (over-triggering) in `triggers.md`, refine the `Use when...` and `Don't use for...` clauses in `SKILL.md`, and re-run on `--split train`.
   - Once train recall and specificity meet target thresholds, verify generalization on the held-out 40% **validation** split:
     ```bash
     yarn agents-config skill triggers <name> --split validation --runs 3
     ```
   - Never tune `description` phrasing directly to validation queries; if validation recall or precision drops significantly below train, generalize the trigger concepts rather than adding query-specific keywords.

## References

- Read [references/grading-and-metrics.md](references/grading-and-metrics.md) for the complete `evals.json`, `benchmark.json`, and `triggers.json` schemas, scripted assertion behavior, blind grader rules, and diagnostic playbooks.
