---
title: GitHub repository setup
summary: Settings to apply when creating a GitHub repository
group: git
scopes: [global, project]
defaults: [global]
---

## GitHub repository setup

- When creating a new GitHub repo, configure these before pushing the first commit:
  - Enable auto-delete of head branches on merge (`gh repo edit <repo> --delete-branch-on-merge`).
  - Allow only merge commits for PRs; disable squash and rebase merging (`gh repo edit <repo> --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false`).
  - Protect the default branch with a ruleset that requires PRs for changes and blocks direct pushes. If the exact ruleset spec is unclear, surface the choice instead of guessing.
