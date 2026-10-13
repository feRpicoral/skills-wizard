---
title: Branching and pull requests
summary: Branch, PR and push rules
group: git
scopes: [global, project]
defaults: [global, project]
requires: [git/pr-reviews]
---

## Branching and pull requests

- Unless explicitly told to commit directly on a branch, create a branch, do the work on that branch, run the pre-PR subagent review loop (see "Pull request reviews"), and open the PR with the `gh` CLI once the reviewing subagent marks it good to go.
- If the user asks to open, update, fix, or resolve conflicts on a PR, that authorizes normal pushes to that PR branch needed to complete that request after validation.
- Do not push unrelated changes. Force-pushes, pushes to `main`/protected/shared branches, tags, releases, or remote changes require explicit permission.
- Do not create an empty PR unless explicitly asked. If the repository runs CI on ready-for-review PRs, open the PR as ready for review after the subagent review passes; otherwise open it as a draft.
- Merge PRs with a merge commit (`gh pr merge --merge`). Do not squash or rebase.
