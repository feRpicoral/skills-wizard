---
title: Git behavior
summary: Small commits, inspect diffs before pushing
group: git
scopes: [global, project]
defaults: [global, project]
requires: [engineering/comments]
---

## Git behavior

- Commit along the way in small, focused commits as work progresses.
- Before pushing, inspect `git status`, inspect the staged or committed diff, and run the narrowest relevant validation.
- Push only committed, task-relevant changes to the task branch. Report the branch, commit SHA, PR URL, and validation result after pushing.
- Do not poll CI after a push unless the user explicitly asks for it.
- Before committing, inspect `git diff --staged` and `git status`.
- Commit only files relevant to the requested task.
- If unrelated modified files exist, leave them untouched and mention them.
- Comment cleanup is part of every edit: when working near existing comments, remove or tighten nearby comments that fail the comment policy. Do not leave a low-value comment unchanged just because the task was elsewhere.
