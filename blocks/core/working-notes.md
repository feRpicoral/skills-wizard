---
title: Working notes
summary: When to keep local working notes and how to handle them
group: core
scopes: [global]
defaults: [global]
---

## Working notes

- Use `DECISIONS.md` only for long-running, multi-step, high-risk, or architecture-affecting tasks. Do not create it for read-only analysis, small fixes, or mechanical cleanup.
- This file exists only in the worktree for reference. Never commit it and never add it to `.gitignore`.
- Do not create `AGENTS.md` or similar agent-instruction files unless explicitly asked.
- Nothing that ships in the repo (code, comments, tests, docs, commit messages, PR titles or descriptions) may refer to, mention, or imply the existence of `DECISIONS.md` or similar agent-internal files, implementation plan phases, or other agent-only artifacts.
