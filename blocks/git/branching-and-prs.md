---
title: Branching and pull requests
summary: Branch, draft PR and push rules
group: git
scopes: [global, project]
defaults: [global, project]
---

## Branching and pull requests

- Unless explicitly told to commit directly on a branch, create a branch, open a draft PR with the `gh` CLI, and do the work on that branch.
- If the user asks to open, update, fix, or resolve conflicts on a PR, that authorizes normal pushes to that PR branch needed to complete that request after validation.
- Do not push unrelated changes. Force-pushes, pushes to `main`/protected/shared branches, tags, releases, or remote changes require explicit permission.
- Open the draft PR early once there is a coherent first commit. Do not create an empty PR unless explicitly asked.
- Merge PRs with a merge commit (`gh pr merge --merge`). Do not squash or rebase.
