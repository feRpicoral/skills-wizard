#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-acme/payments}"

curl -sS -X PATCH \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO" \
  -d '{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":true,"delete_branch_on_merge":false}'

curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/rulesets" \
  -d @.github/ruleset-main.json
