---
title: Task execution
summary: Minimal changes, stated assumptions, validation before done
group: core
scopes: [global, project]
defaults: [global, project]
---

## Task execution

- Prefer minimal, targeted changes over broad rewrites.
- Do not refactor unrelated code while fixing a bug or implementing a feature.
- If a task is ambiguous, make the smallest reasonable assumption and state it before acting.
- If the requested change would require a risky migration, destructive command, or major architecture change, ask first.
- Before starting non-trivial work, reread the relevant sections of this file and call out any instruction conflict before acting.
- Before declaring a task complete, run the narrowest relevant validation available: tests, typecheck, lint, or build.
- For trivial follow-up changes, do not run the full local validation stack unless the change actually needs it.
- If validation cannot be run, explain exactly why and what should be run manually.
- Do not claim compliance with a rule unless it was actually checked. For example, do not say comments were audited unless remaining comments in touched files were reviewed.
- In plan mode, if a plan yields more than one implementation PR, decide the PR stacking explicitly. Prefer individual PRs against the default branch unless stacking is required by dependent changes or to minimize merge conflicts.
