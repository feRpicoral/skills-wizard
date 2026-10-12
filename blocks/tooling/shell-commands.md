---
title: Shell commands
summary: No destructive commands without permission; nvm use before node
group: tooling
scopes: [global, project]
defaults: [global]
---

## Shell commands

- Do not run destructive commands without explicit permission, including `rm -rf`, `git reset --hard`, `git clean -fd`, force pushes, database drops, or migration resets.
- Prefer read-only inspection commands before write commands.
- Do not start long-running dev servers unless explicitly requested.
- Run `nvm use` before `node`, `npm`, `yarn`, or `pnpm` commands so the repo's pinned Node version is used rather than the shell default. Skip when the repo pins no version (no `.nvmrc` or `.node-version`).
