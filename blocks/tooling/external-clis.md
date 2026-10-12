---
title: External CLIs
summary: Use gh, aws, fly, and vercel, read-only first; surface missing CLIs
group: tooling
scopes: [global, project]
defaults: [global]
---

## External CLIs

- For GitHub operations (PRs, issues, releases, gists, repo management, checks), use the `gh` CLI rather than raw API calls or browser-based steps.
- For AWS operations, use the `aws` CLI. Respect the project's configured profile and region; do not pass `--profile` or `--region` overrides unless explicitly asked.
- For Fly.io operations (apps, deployments, machines, secrets, logs, volumes), use the `fly` (`flyctl`) CLI.
- For Vercel operations (projects, deployments, environment variables, domains, logs), use the `vercel` CLI.
- If a CLI needed for an operation is missing, surface that to the user instead of working around it with raw API calls, ad-hoc scripts, or browser-based steps.
- Read-only first. Use `describe`, `list`, `get`, `status`, or `gh ... view` subcommands to confirm targets before any write operation.
- Cloud- or repo-destructive actions (terminating instances or machines, deleting apps, buckets, objects, or deployments, dropping databases, removing IAM roles/policies, force-pushing, deleting branches or releases) require explicit permission even mid-session, regardless of prior approvals.
- Prefer `--dry-run` flags where the command supports them.
