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
        "required_review_thread_resolution": false
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
  - `pull_request`: blocks direct pushes and requires changes to arrive via pull request. `required_approving_review_count` is `0` so solo repositories still enforce PR flow and CI checks without requiring a second reviewer account.

## Idempotent Setup Script (`scripts/setup-github-repo.sh`)

When a task asks for a repeatable setup script, use `gh` for read-only inspection first, then apply repository settings and create or update the ruleset:

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

EXISTING_ID="$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "main") | .id' | head -n 1 || true)"

if [ -n "$EXISTING_ID" ]; then
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
gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "main") | {id, name, enforcement, target}'
```

## Verification Checklist

1. `mergeCommitAllowed` is `true`.
2. `squashMergeAllowed` is `false`.
3. `rebaseMergeAllowed` is `false`.
4. `deleteBranchOnMerge` is `true`.
5. Active branch ruleset `main` targets `~DEFAULT_BRANCH` with `bypass_actors: []`, `deletion`, `non_fast_forward`, and `pull_request` (`required_approving_review_count: 0`).
