---
title: Commits
summary: Conventional Commits, header line only
group: git
scopes: [global, project]
defaults: [global, project]
---

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
