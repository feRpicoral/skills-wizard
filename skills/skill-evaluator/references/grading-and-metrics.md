# Grading Schemas, Metrics, and Diagnostic Playbook

## Table of Contents

1. [Eval Suite Schema (`evals/evals.json`)](#1-eval-suite-schema-evalsevalsjson)
2. [Scripted vs Blind-Grader Assertions](#2-scripted-vs-blind-grader-assertions)
3. [Trigger Query Schema and Split](#3-trigger-query-schema-and-split)
4. [Benchmark and Trigger Artifacts](#4-benchmark-and-trigger-artifacts)
5. [Diagnostic Playbook](#5-diagnostic-playbook)

## 1. Eval Suite Schema (`evals/evals.json`)

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": "case-identifier",
      "prompt": "can you fix our lint setup?",
      "expected_output": "Description of a successful result",
      "files": ["evals/files/case-identifier/package.json"],
      "assertions": [
        "The response explains the root cause before applying the fix",
        { "type": "file_exists", "path": "eslint.config.mjs" },
        { "type": "file_absent", "path": ".eslintrc.cjs" },
        {
          "type": "regex",
          "path": "eslint.config.mjs",
          "pattern": "tseslint\\.config",
          "flags": "m"
        },
        { "type": "json_valid", "path": "package.json" },
        {
          "type": "command",
          "run": "node --check eslint.config.mjs",
          "expect": 0
        }
      ]
    }
  ]
}
```

- `id` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and be unique ignoring case.
- Every case needs at least one assertion.
- `files` entries must live under `evals/files/`. When copied into `<workdir>`, leading `evals/files/` and `<case-id>/` prefixes are stripped so `evals/files/case-identifier/package.json` lands at `<workdir>/package.json`.
- Name a fixture skill file `SKILL.fixture.md`: it is staged as `SKILL.md` in the workspace, and it is never mistaken for a real skill when the skill folder is linked into an agent's skills directory.
- `expectations` is accepted as an alias for `assertions` (do not specify both on the same case).

## 2. Scripted vs Blind-Grader Assertions

| Assertion Type | Evaluation Mechanism                                                                                                                                       | Best Used For                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `file_exists`  | Checks `lstat(join(workdir, path))`                                                                                                                        | Verifying required config or output files were created                           |
| `file_absent`  | Confirms `lstat(join(workdir, path))` is null                                                                                                              | Verifying legacy or disallowed files (`README.md`, `.eslintrc.cjs`) were removed |
| `regex`        | Tests `new RegExp(pattern, flags)` against UTF-8 file content                                                                                              | Checking specific settings, imports, or frontmatter fields                       |
| `json_valid`   | Runs `JSON.parse` on the target file                                                                                                                       | Confirming generated JSON files have no syntax errors                            |
| `command`      | Runs a shell command in `workdir` in its own process group (30 s timeout, only the CLI's environment) and compares the exit code to `expect` (default `0`) | Syntax checks (`node --check`), schema validation scripts, or CLI dry runs       |
| `string`       | Evaluated by the blind LLM grader against `<task_prompt>`, `<expected_output>`, `<agent_response>`, and `<workspace_files>`                                | Checking explanation quality, reasoning steps, or semantic structure             |

**Grading order:** scripted assertions run first, then the workspace file summary is captured and sent to the blind grader.

**Blind grader rules:**

- The grader runs in an empty directory with the most restrictive tool mode the runner offers, and its prompt never reveals whether a run is `with_skill`, `without_skill`, or `old_skill`.
- It returns `{ "results": [{ "assertion", "passed", "evidence", "quote" }] }`, quoting each assertion verbatim. A string assertion with empty `evidence` fails.
- `quote` is an optional verbatim excerpt. A passed result whose quote does not occur in the response or the workspace summary is downgraded to failed with `Unverified evidence`.
- Malformed grader output fails closed: the affected string assertions fail with a `malformed grader output` reason.
- A grader error fails only that run's string assertions, with `Grader error: ...`.

**Failed runs:** when the agent run errors or times out, every assertion of that run fails with `Agent run failed: <reason>` without calling the grader. The run's `timing.json` records `timed_out`, `exit_code`, `error`, and `usage_reported`.

## 3. Trigger Query Schema and Split

`evals/trigger_queries.json` is a JSON array of `{ "query": string, "should_trigger": boolean }` objects. Write queries as plain user requests; a label such as `[negative]` leaks the answer.

- **Per-query split:** a query goes to `train` when the first 8 hex digits of `SHA-256(query)` mod 100 are below 60, otherwise to `validation`. Positive and negative queries are counted separately, the split is about 60/40 rather than exact, and adding queries never moves existing ones. The CLI warns when a class has fewer than 2 queries in a split.
- **Trigger detection per runner:** a run counts as triggered when the agent invokes the skill tool for `<skill>` (Claude `Skill`, Gemini `activate_skill`) or reads `<skill>/SKILL.md` from the staged skill folder (`.agents/skills/<skill>/` or `.claude/skills/<skill>/`).

## 4. Benchmark and Trigger Artifacts

Results are stored outside the repository under `~/.agents/agents-config/evals/<skill>/`. Both artifacts carry `"schema_version": 1` at the top level.

- `iteration-<N>/benchmark.json`:
  - `metadata`: `skill_name`, `skill_path`, `runner`, `timestamp`, `runs_per_configuration`, `compare_ref`, `baseline_status` (`"clean"`, `"possibly contaminated"`, or `"skipped"`), `warnings`.
  - How the `without_skill` baseline hides the skill: Claude Code gets `skillOverrides` plus permission deny rules, and Gemini CLI gets `skills.disabled`, which it honors only in trusted folders. Codex and `agy` have no documented workspace-level exclusion, so their baseline is `possibly contaminated` whenever the skill is also installed system-wide.
  - `run_summary`: `with_skill`, `without_skill`, `old_skill`, plus `delta` (`with_skill` minus `without_skill`) and `old_skill_delta` (`with_skill` minus `old_skill`). Each variant has `runs`, `failed_runs`, `usage_reported_runs`, and `pass_rate`, `time_seconds`, `tokens` summaries (`mean`, `stddev`, `min`, `max`; means and sample standard deviations across case runs). `tokens` is `null` when no run of that variant reported usage.
  - Statistics are stored unrounded; rounding happens only when rendering.
  - Deltas are signed strings in raw units: `pass_rate` as a fraction (`"+0.33"`), `time_seconds` (`"+12.40"`), and `tokens` (`"+1500"`, or `"n/a"` when either side reported no usage). `report.md` and the CLI summary show the pass-rate delta in percentage points, for example `with_skill pass rate 80.0% (+33.3 pp vs baseline, -10.0 pp vs old_skill)`.
  - Runs whose runner reported no token usage (`usage_reported: false`) are left out of token statistics.
  - `cases`: per-case variant summaries, per-run grading and timing records, and assertions with a `classification` against `without_skill` and an `old_skill_classification` against `old_skill` (present only with `--compare`). Classes: `differentiating`, `non-discriminating`, `regressing`, `failing`, `flaky`, and `no-baseline` when there is no reference run.
  - `non_discriminating_assertions`: `<case_id>: <assertion>` entries that passed in every `with_skill` and baseline run.
  - `assertion_analysis`: `<case_id>: <assertion>` entries grouped into `pass_only_with_skill` (only when a reference exists), `pass_in_both`, `fail_in_both`, `flaky`, `regressing` (against `without_skill`), and `regressing_vs_old` (against `old_skill`).
- `triggers-<N>/triggers.json`: one file per `skill triggers` run, so a train run and a validation run land in separate `triggers-<N>` directories.
  - `metadata`: `skill_name`, `skill_path`, `runner`, `split` (`train`, `validation`, or `all`), `runs_per_query`, `threshold`, `timestamp`, `possibly_contaminated` (true when a personal Claude skill with the same name would be loaded instead of the staged one), and `warnings`.
  - `metrics`: `total_queries`, `positive_queries`, `negative_queries`, `errored_queries`, `true_positives`, `false_positives`, `true_negatives`, `false_negatives`, `recall`, `precision`, `specificity`, `false_positive_rate`, `accuracy`. A ratio with a zero denominator is `null` and renders as `n/a (0/0)`.
  - `queries`: per-query `trigger_count`, `runs`, `errored_runs`, `trigger_rate` (`null` when every run errored), and `passed`.

`--baseline <ref>` and `--compare <ref>` read the ref from the repository that contains the skill folder. The ref, the skill folder at that ref, and runner availability are checked before anything is written.

## 5. Diagnostic Playbook

- **High non-discriminating assertion count (`with_skill` 100%, `without_skill` 100%):**
  The assertions test baseline model knowledge (such as "creates a valid JSON file") rather than skill-specific conventions. Replace them with `regex` or `command` assertions that verify the specific patterns taught by the skill.
- **Negative pass-rate delta (`regressing` assertions) or large token/time blowup:**
  The skill instructions are either overly verbose or contradicting the task prompt. Trim `SKILL.md`, move rarely needed tables into `references/`, and re-run with `--compare HEAD~1`.
- **Train recall 100% but validation recall below 70%:**
  The `SKILL.md` `description` was overfitted to exact words from the train queries. Rewrite the `Use when...` clause around broader task categories, file types, and error symptoms.
- **Failed runs (`Agent run failed: ...`):**
  The runner timed out or errored, so the pass rate says nothing about the skill. Check the run's `stderr.log`, raise `--timeout`, or fix the runner setup, then re-run.
