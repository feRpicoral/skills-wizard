---
title: External CLIs
summary: Use gh and aws, read-only first
group: tooling
scopes: [global, project]
defaults: [global]
---

## External CLIs

- For GitHub operations (PRs, issues, releases, gists, repo management, checks), use the `gh` CLI rather than raw API calls or browser-based steps.
- For AWS operations, use the `aws` CLI. Respect the project's configured profile and region; do not pass `--profile` or `--region` overrides unless explicitly asked.
- Read-only first. Use `describe`, `list`, `get`, or `gh ... view` subcommands to confirm targets before any write operation.
- Cloud- or repo-destructive actions (terminating instances, deleting buckets or objects, dropping databases, removing IAM roles/policies, force-pushing, deleting branches or releases) require explicit permission even mid-session, regardless of prior approvals.
- Prefer `--dry-run` flags where the command supports them.
