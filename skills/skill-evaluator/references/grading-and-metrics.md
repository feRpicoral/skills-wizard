# Grading Schemas, Metrics, and Diagnostic Playbook

## Table of Contents

1. [Eval Suite Schema (`evals/evals.json`)](#1-eval-suite-schema-evalsevalsjson)
2. [Scripted vs Blind-Grader Assertions](#2-scripted-vs-blind-grader-assertions)
3. [Trigger Query Schema and Stratified Split](#3-trigger-query-schema-and-stratified-split)
4. [Benchmark and Trigger Artifacts](#4-benchmark-and-trigger-artifacts)
5. [Diagnostic Playbook](#5-diagnostic-playbook)

## 1. Eval Suite Schema (`evals/evals.json`)

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": "case-identifier",
      "prompt": "Realistic user request",
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

- `files` entries must live under `evals/files/`. When copied into `<workdir>`, leading `evals/files/` and `<case-id>/` prefixes are stripped so `evals/files/case-identifier/package.json` lands at `<workdir>/package.json`.
- `expectations` is accepted as an alias for `assertions` (do not specify both on the same case).

## 2. Scripted vs Blind-Grader Assertions

| Assertion Type | Evaluation Mechanism                                                                                                        | Best Used For                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `file_exists`  | Checks `lstat(join(workdir, path))`                                                                                         | Verifying required config or output files were created                           |
| `file_absent`  | Confirms `lstat(join(workdir, path))` is null                                                                               | Verifying legacy or disallowed files (`README.md`, `.eslintrc.cjs`) were removed |
| `regex`        | Tests `new RegExp(pattern, flags)` against UTF-8 file content                                                               | Checking specific settings, imports, or frontmatter fields                       |
| `json_valid`   | Runs `JSON.parse` on the target file                                                                                        | Confirming generated JSON files have no syntax errors                            |
| `command`      | Runs shell command in `workdir` (30s timeout) and compares exit code to `expect` (default `0`)                              | Syntax checks (`node --check`), schema validation scripts, or CLI dry runs       |
| `string`       | Evaluated by the blind LLM grader against `<task_prompt>`, `<expected_output>`, `<agent_response>`, and `<workspace_files>` | Checking explanation quality, reasoning steps, or semantic structure             |

**Grading Order and Blind Grader Evidence Rule:** Deterministic scripted assertions run first before the workspace file summary is captured and sent to the blind LLM grader. The grader prompt never reveals whether a run is `with_skill`, `without_skill`, or `old_skill`. Any string assertion where the grader returns empty or whitespace-only `evidence` is automatically forced to `passed: false`.

## 3. Trigger Query Schema and Stratified Split

`evals/trigger_queries.json` is a JSON array of `{ "query": string, "should_trigger": boolean }` objects:

- **Stratified 60/40 split:** `splitTriggerQueries` hashes each query with SHA-256 and partitions positive (`should_trigger: true`) and negative (`should_trigger: false`) queries separately into 60% `train` and 40% `validation`.
- **Trigger detection per runner:**
  - `agy`: `step_update` event with `tool_name === "view_file"` reading `/<skill>/SKILL.md` or `tool_name === "run_command"` referencing `<skill>/SKILL.md`.
  - `claude`: assistant `tool_use` block invoking `Skill` (`input.skill === "<skill>"`), `Read` on `/<skill>/SKILL.md`, or `Bash` referencing `<skill>/SKILL.md`.
  - `codex`: `item.started` / `item.completed` `command_execution` referencing `<skill>/SKILL.md`.
  - `gemini`: `tool_use` event invoking `activate_skill` for `<skill>` or reading `<skill>/SKILL.md`.

## 4. Benchmark and Trigger Artifacts

Results are stored outside the repository under `~/.agents/agents-config/evals/<skill>/`:

- `iteration-<N>/benchmark.json`:
  - `metadata`: `skill_name`, `runner`, `timestamp`, `runs_per_configuration`, `baseline_status` (`"clean"`, `"possibly contaminated"`, or `"skipped"`), `warnings`.
  - `run_summary`: `with_skill`, `without_skill`, `old_skill`, `delta`, `old_skill_delta` (`pass_rate`, `time_seconds`, `tokens` with `mean`, `stddev`, `min`, `max`).
  - `cases`: per-case variant summaries, assertion classifications (`differentiating`, `non-discriminating`, `regressing`, `failing`, `flaky`), and per-run grading/timing records.
  - `non_discriminating_assertions`: list of `<case_id>: <assertion>` entries that passed 100% in both `with_skill` and baseline runs.
  - `assertion_analysis`: object grouping `<case_id>: <assertion>` entries into `pass_only_with_skill`, `pass_in_both`, `fail_in_both`, and `flaky`.
- `triggers-<N>/triggers.json`:
  - `metrics`: `recall`, `precision`, `specificity`, `false_positive_rate`, `accuracy`, `true_positives`, `false_positives`, `true_negatives`, `false_negatives`.

## 5. Diagnostic Playbook

- **High non-discriminating assertion count (`with_skill` 100%, `without_skill` 100%):**
  The assertions test baseline model knowledge (such as "creates a valid JSON file") rather than skill-specific conventions. Replace them with `regex` or `command` assertions that verify the specific patterns taught by the skill.
- **Negative pass-rate delta (`regressing` assertions) or large token/time blowup:**
  The skill instructions are either overly verbose or contradicting the task prompt. Trim `SKILL.md`, move rarely needed tables into `references/`, and re-run with `--compare HEAD~1`.
- **Train recall 100% but validation recall <70%:**
  The `SKILL.md` `description` was overfitted to exact words from the train queries. Rewrite the `Use when...` clause around broader task categories, file types, and error symptoms.
