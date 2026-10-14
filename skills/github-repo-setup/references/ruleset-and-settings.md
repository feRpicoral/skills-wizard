# GitHub Repository Ruleset and Settings Reference

## Canonical Ruleset Payload (`.github/ruleset-main.json`)

Use this exact JSON structure when creating or updating the default-branch ruleset via `gh api`:

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge"]
      }
    }
  ]
}
```

### Key Field Rules

- `name`: `"main"` (or the repository's default branch name).
- `target`: `"branch"`.
- `enforcement`: `"active"` (never `"disabled"` or `"evaluate"` unless the user asks to test a ruleset in evaluate mode).
- `bypass_actors`: `[]` by default. Only add an entry (`actor_id`, `actor_type`, `bypass_mode`) when the user explicitly requests a bypass.
- `conditions.ref_name.include`: `["~DEFAULT_BRANCH"]` targets the repository's configured default branch automatically.
- `rules`:
  - `deletion`: blocks deleting the default branch.
  - `non_fast_forward`: blocks force-pushes to the default branch.
  - `pull_request`: blocks direct pushes and requires changes to arrive via pull request. `required_approving_review_count` is `0` so solo repositories still enforce PR flow and CI checks without requiring a second reviewer account, and `allowed_merge_methods` is `["merge"]` so ruleset-level merge restrictions match the repository-level merge policy.

### Status-Check Extension (`required_status_checks`)

When the repository has required CI checks (or when updating an existing ruleset that already defines status checks), include a `required_status_checks` rule in `rules`:

```json
{
  "type": "required_status_checks",
  "parameters": {
    "strict_required_status_checks_policy": false,
    "do_not_enforce_on_create": false,
    "required_status_checks": [
      {
        "context": "check"
      }
    ]
  }
}
```

## Creating a New Repository (`gh repo create`)

When the remote repository does not exist yet, confirm visibility (`--private` vs `--public`) with the user first, then create it from the local repository before applying merge settings and the ruleset:

```bash
gh repo create "<owner>/<repo>" --private --source=. --remote=origin
```

If ruleset creation on a private repository returns HTTP 403 (`Upgrade to GitHub Pro or make this repository public to enable this feature`), stop and report that repository rulesets on private repositories require GitHub Pro/Team/Enterprise — never change the repository's visibility to public automatically.

## Idempotent Setup Script (`scripts/setup-github-repo.sh`)

When a task asks for a repeatable setup script, use `gh` for read-only inspection first (with `--paginate` and `?includes_parents=false` so inherited organization rulesets are not mistaken for repository rulesets), inspect any existing repository ruleset before overwriting it, then apply repository settings and create or update the ruleset:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?Usage: setup-github-repo.sh <owner/repo>}"
RULESET_FILE="${2:-.github/ruleset-main.json}"

gh repo view "$REPO" --json name,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge

gh repo edit "$REPO" \
  --enable-merge-commit=true \
  --enable-squash-merge=false \
  --enable-rebase-merge=false \
  --delete-branch-on-merge=true

EXISTING_ID="$(gh api --paginate "repos/$REPO/rulesets?includes_parents=false" --jq '.[] | select(.name == "main" and .target == "branch") | .id' | head -n 1 || true)"

if [ -n "$EXISTING_ID" ]; then
  gh api "repos/$REPO/rulesets/$EXISTING_ID" >/dev/null
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "repos/$REPO/rulesets/$EXISTING_ID" \
    --input "$RULESET_FILE"
else
  gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    "repos/$REPO/rulesets" \
    --input "$RULESET_FILE"
fi

gh repo view "$REPO" --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge
gh api --paginate "repos/$REPO/rulesets?includes_parents=false" --jq '.[] | select(.name == "main") | {id, name, enforcement, target}'
```

## Verification Checklist

1. `mergeCommitAllowed` is `true`.
2. `squashMergeAllowed` is `false`.
3. `rebaseMergeAllowed` is `false`.
4. `deleteBranchOnMerge` is `true`.
5. Active branch ruleset `main` targets `~DEFAULT_BRANCH` with `bypass_actors: []`, `deletion`, `non_fast_forward`, and `pull_request` (`required_approving_review_count: 0`).
