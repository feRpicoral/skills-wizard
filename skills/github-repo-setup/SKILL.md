---
name: github-repo-setup
description: Configures GitHub repository merge settings, head-branch cleanup, and default-branch protection rulesets using the gh CLI or reproducible setup scripts and JSON payloads. Use when creating a new GitHub repository, hardening or auditing repository settings before the first push, disabling squash or rebase merges so only merge commits are allowed, enabling delete-branch-on-merge, or creating and fixing a main branch ruleset via gh api (pull_request with required_approving_review_count of 0, non_fast_forward, deletion, and empty bypass_actors). Don't use for opening or merging pull requests, writing GitHub Actions CI workflows, or managing local git branches.
license: MIT
compatibility: Requires gh (GitHub CLI) authenticated with repository administration permissions
---

# GitHub Repository Setup

Configure a GitHub repository with the house merge policy and default-branch protection ruleset before pushing feature work.

## Start here

1. **Confirm target repository and mode**:
   - Determine `<owner>/<repo>` (from the prompt, `git remote get-url origin`, or `gh repo view`).
   - If the task asks to generate or repair local configuration files (such as `.github/ruleset-main.json` or `scripts/setup-github-repo.sh`) or runs in an offline workspace without live GitHub access, write the exact `gh` commands and ruleset JSON payload to the requested files and do not call live `gh` write commands unless explicitly asked.
   - When operating against a live GitHub repository, verify `gh` is installed and authenticated (`gh auth status`). If `gh` is missing or unauthenticated, surface that to the user rather than falling back to `curl` or browser instructions.

2. **Inspect current state first (read-only)**:
   ```bash
   gh repo view <owner>/<repo> --json name,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge
   gh api repos/<owner>/<repo>/rulesets
   ```
   Check the current default branch name (typically `main`), which merge strategies are enabled, whether `deleteBranchOnMerge` is active, and whether a branch ruleset already exists for `~DEFAULT_BRANCH` or `refs/heads/main`.

## Workflow

### 1. Apply repository merge and branch cleanup settings

Configure the repository so pull requests use merge commits exclusively and merged head branches are deleted automatically:

```bash
gh repo edit <owner>/<repo> \
  --enable-merge-commit=true \
  --enable-squash-merge=false \
  --enable-rebase-merge=false \
  --delete-branch-on-merge=true
```

Why: stacked pull requests rely on merge commits so GitHub can retarget dependent branches cleanly when a base PR merges, and `--delete-branch-on-merge=true` triggers that automatic retargeting while keeping remote branches tidy.

### 2. Configure the `main` branch ruleset

Protect the default branch with a repository ruleset targeting `~DEFAULT_BRANCH` (with `name: "main"`, `target: "branch"`, `enforcement: "active"`):

- **`bypass_actors: []`**: no admin or role bypasses unless the user explicitly requests one.
- **`conditions.ref_name`**: `include: ["~DEFAULT_BRANCH"]`, `exclude: []`.
- **`rules`**:
  - `{"type": "deletion"}` to prevent deleting the default branch.
  - `{"type": "non_fast_forward"}` to block force pushes.
  - `{"type": "pull_request", "parameters": { ... }}` requiring pull requests for all changes with `required_approving_review_count: 0` (so solo maintainer PRs can merge after checks without a second human account), `dismiss_stale_reviews_on_push: false`, `require_code_owner_review: false`, `require_last_push_approval: false`, and `required_review_thread_resolution: false`.
  - When `allowed_merge_methods` is included in `pull_request.parameters` (supported by GitHub's ruleset schema), set it to `["merge"]` only.

Create the ruleset with `gh api` (or update an existing ruleset with `--method PUT repos/<owner>/<repo>/rulesets/<id>`):

```bash
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  repos/<owner>/<repo>/rulesets \
  --input .github/ruleset-main.json
```

See [references/ruleset-and-settings.md](references/ruleset-and-settings.md) for the complete JSON payload, idempotent create-or-update commands, and status-check extensions.

### 3. Verify the applied settings

Run read-only verification commands and report the resulting state:

```bash
gh repo view <owner>/<repo> --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge
gh api repos/<owner>/<repo>/rulesets --jq '.[] | {id, name, enforcement, target}'
```

When writing setup scripts or JSON payloads in a repository, also remove any legacy branch-protection scripts or workflows that enable squash/rebase merges or grant unrequested admin bypasses.

## References

- Read [references/ruleset-and-settings.md](references/ruleset-and-settings.md) for the exact `.github/ruleset-main.json` schema, `scripts/setup-github-repo.sh` template, and verification queries.

## Non-negotiables

- Read-only inspection (`gh repo view`, `gh api repos/<owner>/<repo>/rulesets`) comes before any live write command.
- Always set `--enable-merge-commit=true`, `--enable-squash-merge=false`, `--enable-rebase-merge=false`, and `--delete-branch-on-merge=true`.
- Always set `required_approving_review_count: 0`, include `deletion` and `non_fast_forward`, and keep `bypass_actors: []` unless the user explicitly asks for a different count or bypass actor.
- Never replace `gh` with raw `curl` calls against `api.github.com` or hardcode personal access tokens in scripts.
