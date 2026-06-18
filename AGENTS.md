# Global Instructions

GitHub username: feRpicoral

## Precedence

If a user prompt conflicts with anything in this file, flag the conflict explicitly in one sentence, then follow the user's instruction.

## Communication style

- Be direct. Prioritize the correct answer over agreement. Criticize my reasoning when it's wrong. No false empathy, no filler reassurance. Dry and realistic tone.
- Lead with the answer or recommendation. Keep explanations concise unless deeper reasoning is requested.
- Don't over-explain basic concepts.
- When uncertain, state the uncertainty and the most reasonable next step.

## No AI tells

- Output should not read as machine-generated, in prose or code.
- Avoid the common tells: overuse of em dashes, "not just X but Y" phrasing, needless bullet lists where prose fits, hedging boilerplate, and formulaic intros or summaries.
- Avoid unicode arrows, emoji, decorative symbols, and overexplained comments unless the target file or design explicitly requires them.
- No filler or decorative phrasing. Say the thing once.

## Task execution

- Prefer minimal, targeted changes over broad rewrites.
- Do not refactor unrelated code while fixing a bug or implementing a feature.
- If a task is ambiguous, make the smallest reasonable assumption and state it before acting.
- If the requested change would require a risky migration, destructive command, or major architecture change, ask first.
- Before starting non-trivial work, reread the relevant sections of this file and call out any instruction conflict before acting.
- Before declaring a task complete, run the narrowest relevant validation available: tests, typecheck, lint, or build.
- For trivial follow-up changes, do not run the full local validation stack unless the change actually needs it.
- If validation cannot be run, explain exactly why and what should be run manually.
- Do not claim compliance with a rule unless it was actually checked. For example, do not say comments were audited unless remaining comments in touched files were reviewed.
- In plan mode, if a plan yields more than one implementation PR, decide the PR stacking explicitly. Prefer individual PRs against the default branch unless stacking is required by dependent changes or to minimize merge conflicts.

## Working notes

- Use `DECISIONS.md` only for long-running, multi-step, high-risk, or architecture-affecting tasks. Do not create it for read-only analysis, small fixes, or mechanical cleanup.
- This file exists only in the worktree for reference. Never commit it and never add it to `.gitignore`.
- Do not create `AGENTS.md` or similar agent-instruction files unless explicitly asked.
- Nothing that ships in the repo (code, comments, tests, docs, commit messages, PR titles or descriptions) may refer to, mention, or imply the existence of `DECISIONS.md` or similar agent-internal files, implementation plan phases, or other agent-only artifacts.

## Code conduct

- Read before writing. Study existing patterns in the file/module before adding new code.
- Match existing patterns, naming, formatter, and linter config. Don't introduce a parallel style.
- Avoid cosmetic diffs unless the task is explicitly about formatting.
- Preserve public APIs unless the task requires changing them.
- No dead code. Don't leave unused exports, commented-out blocks, or unreachable branches.
- No unexplained magic values. Extract named constants for repeated literals, protocol values, timeouts, limits, status codes with business meaning, or values whose purpose is not obvious. Do not extract obvious one-off values just to satisfy this rule.
- Use typed, specific errors when callers branch on the error or when the domain distinction matters. Generic `Error` is acceptable for unrecoverable/invariant failures and boundary-level messages.
- Don't swallow errors silently. Preserve original error context when wrapping.
- Update nearby documentation when behavior changes.

## Comments

Default to no comment.

A comment is allowed only when it explains something the code cannot reasonably express:
- why a surprising decision exists
- a business invariant
- an edge case from an external API/runtime/library
- a security, concurrency, data-loss, or recovery constraint
- a source/citation for behavior that is not inferable from the code

Do not add or keep comments that:
- restate the next line, branch, function name, type, or test assertion
- narrate steps in order, e.g. "1. fetch", "2. validate", "3. save"
- describe common framework behavior
- explain obvious constants, defaults, or parameters
- say something only useful because names are weak; rename instead
- justify dead or future code; delete it until needed
- add JSDoc to non-public functions/types unless it documents a real contract

For tests, prefer descriptive test names and assertions over comments. Keep a test comment only when it explains a regression, historical bug, invariant, or setup that would otherwise look wrong.

Before finishing a change, audit every comment you added or touched. For each one, ask:
"Would a senior reviewer lose important context or safety information if this comment were deleted?"
If no, delete it.

For cleanup tasks, run a final search for the thing being cleaned up and inspect the remaining matches. Summarize why remaining instances were kept.

## Documentation

- In Markdown files, use Mermaid for diagrams. Do not use ASCII art diagrams.
- If documentation starts getting complex, prefer a `docs/` folder over a crowded README.
- When changing documented code or flows, update the nearby documentation in the same change.

## Testing

- Tests for non-trivial logic and public API surfaces. Skip tests for trivial wrappers and type-only code.
- Add or update tests when behavior changes. Prefer focused tests near the changed code.
- Do not snapshot large outputs unless the project already uses that pattern.
- Never delete or weaken tests to make a change pass.
- Structure tests as arrange/act/assert. Separate the three phases with a single empty line. Do not label them with comments (no `// arrange`, `// act`, `// assert`).

## Dependencies

- Do not add dependencies for small utilities that can be implemented clearly in-project.
- Prefer existing project dependencies before adding new ones.
- If adding a dependency, explain why it is necessary and whether it affects runtime, build time, or bundle size.
- Use the package manager already used by the project. Do not change lockfiles unless dependency changes are required.
- For new projects or when no package manager is established, prefer `yarn` over `npm`.

## Environment variables

- Access and validate environment variables through a dedicated service that fails fast at boot. Avoid scattered direct `process.env` reads.
- When adding an environment variable, update `.env.example` and every boot path that would fail without it, including CI, test setup, e2e setup and deploy configuration.

## Shell commands

- Do not run destructive commands without explicit permission, including `rm -rf`, `git reset --hard`, `git clean -fd`, force pushes, database drops, or migration resets.
- Prefer read-only inspection commands before write commands.
- Do not start long-running dev servers unless explicitly requested.

## External CLIs

- For GitHub operations (PRs, issues, releases, gists, repo management, checks), use the `gh` CLI rather than raw API calls or browser-based steps.
- For AWS operations, use the `aws` CLI. Respect the project's configured profile and region; do not pass `--profile` or `--region` overrides unless explicitly asked.
- Read-only first. Use `describe`, `list`, `get`, or `gh ... view` subcommands to confirm targets before any write operation.
- Cloud- or repo-destructive actions (terminating instances, deleting buckets or objects, dropping databases, removing IAM roles/policies, force-pushing, deleting branches or releases) require explicit permission even mid-session, regardless of prior approvals.
- Prefer `--dry-run` flags where the command supports them.

## GitHub repository setup

- When creating a new GitHub repo, configure these before pushing the first commit:
  - Enable auto-delete of head branches on merge (`gh repo edit <repo> --delete-branch-on-merge`).
  - Allow only merge commits for PRs; disable squash and rebase merging (`gh repo edit <repo> --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false`).
  - Protect the default branch with a ruleset that requires PRs for changes and blocks direct pushes. If the exact ruleset spec is unclear, surface the choice instead of guessing.

## Branching and pull requests

- Unless explicitly told to commit directly on a branch, create a branch, open a draft PR with the `gh` CLI, and do the work on that branch.
- If the user asks to open, update, fix, or resolve conflicts on a PR, that authorizes normal pushes to that PR branch needed to complete that request after validation.
- Do not push unrelated changes. Force-pushes, pushes to `main`/protected/shared branches, tags, releases, or remote changes require explicit permission.
- Open the draft PR early once there is a coherent first commit. Do not create an empty PR unless explicitly asked.
- Merge PRs with a merge commit (`gh pr merge --merge`). Do not squash or rebase.

## Pull request reviews

- Always review thoroughly. Prioritize code quality, readability, maintainability, bugs, AI tells, code and render performance, and whether the change follows the repo's agent instructions.

## Pull request descriptions

- Concise. Default to a short summary; let the diff carry the rest. Only expand into longer prose when the change is genuinely complex and a reviewer cannot pick it up cold without it.
- No test plan, todo, checklist, or checkbox sections. If verification context matters, state what was run in one line.
- No AI tells (see "No AI tells" above). Don't over-section; don't add decorative headers; don't write "summary of summary" closers; don't lean on em-dashes as the default joiner.

## Git behavior

- Commit along the way in small, focused commits as work progresses.
- Before pushing, inspect `git status`, inspect the staged or committed diff, and run the narrowest relevant validation.
- Push only committed, task-relevant changes to the task branch. Report the branch, commit SHA, PR URL, and validation result after pushing.
- Do not poll CI after a push unless the user explicitly asks for it.
- Before committing, inspect `git diff --staged` and `git status`.
- Commit only files relevant to the requested task.
- If unrelated modified files exist, leave them untouched and mention them.
- Comment cleanup is part of every edit: when working near existing comments, remove or tighten nearby comments that fail the comment policy. Do not leave a low-value comment unchanged just because the task was elsewhere.

## Commits

All commits MUST follow Conventional Commits 1.0.0.

Format:

    <type>[optional scope]: <description>

Rules:
- Header line only. NEVER write a body or footer.
- NEVER add a `Co-Authored-By:` trailer.
- NEVER add generated-by-agent attribution lines.
- Description: lowercase, imperative mood, no trailing period.
- Keep commits small and focused. Each commit should leave the codebase in a working state when possible.

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Examples:
- `feat(auth): add token refresh handling`
- `fix(api): handle missing merchant id`
- `refactor(db): extract order status constants`
- `test(billing): cover invoice total calculation`

Spec: https://www.conventionalcommits.org/en/v1.0.0/

## Security and secrets

- Never print, expose, or commit secrets, tokens, private keys, `.env` values, or credentials.
- If secrets appear in command output, stop and warn instead of repeating them.
- Do not weaken authentication, authorization, validation, rate limits, or encryption unless explicitly requested.

## Web research

- Use web search only when the question involves current state, specific recent versions, third-party services, or my confidence is low.
- For current-state questions, prefer results from the last 3 months.
- For stable technical topics, prefer canonical sources even if older: official docs, specs, RFCs, source code, changelogs, and maintainer discussions.
- Fetching a page to read its content (outside GitHub): try its Markdown variant first instead of judging whether the site supports one. Build the `.md` URL from the page URL by dropping any trailing slash, query, and fragment, then appending `.md` — e.g. `https://docs.mapbox.com/api/navigation/map-matching/` becomes `https://docs.mapbox.com/api/navigation/map-matching.md`. Pass that straight to WebFetch; do not fetch the HTML first to check. Fall back to the original URL only if the `.md` returns 404 or HTML. This applies to direct fetches and to links returned by WebSearch.
- Also try `llms.txt` (and `llms-full.txt`) at the docs site root for a machine-readable index. When a `.md` or `llms.txt` source exists, treat it as the source of truth over the rendered page.
- If search results are stale, conflicting, or irrelevant, say so directly.

## MCP and tool usage

- Tools are opt-in by task, not opt-out by rule. Don't fan out across every available MCP for routine questions.
- On failure: if a tool returns nothing useful after 2 attempts, proceed with available knowledge and flag the gap. Don't loop retries.
- For Reddit URLs specifically, use the Reddit MCP directly rather than generic fetch.
- If the built-in WebFetch fails on a domain, try the fetcher MCP (Playwright-based) once as a fallback, then give up.

## Supabase with Prisma

- Use the new API key style (publishable key + secret key), not the legacy `anon` key.
- Connection URLs: set `DATABASE_TRANSACTION_POOLING_URL` to the transaction pooler and `DATABASE_SESSION_POOLING_URL` to the session pooler, where applicable.
- When an implementation creates or implies a new Supabase project, suggest adding it to `feRpicoral/supabase-heartbeat` to prevent pausing.
- The database cannot be reset because of other Supabase-managed tables, and the first migration won't generate due to drift. Baseline it instead:

      mkdir -p prisma/migrations/0_init
      yarn prisma migrate diff \
        --from-empty \
        --to-schema prisma/schema.prisma \
        --script \
        > prisma/migrations/0_init/migration.sql
      yarn prisma migrate deploy
