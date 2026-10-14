---
title: Dependencies
summary: Prefer established, focused libraries over hand-rolled code; use the project package manager
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Dependencies

- Prefer established, focused libraries for solved problems (parsers, formats, protocols, validation, date handling, CLI primitives) instead of coding them from scratch. Pick the smallest library that fits without pulling in an overkill framework or AST pipeline.
- Prefer existing project dependencies when they already cover the need, and do not add packages for trivial one-liners the standard library handles directly.
- If adding a dependency, explain why it is necessary and whether it affects runtime, build time, or bundle size.
- Use the package manager already used by the project. Do not change lockfiles unless dependency changes are required.
- For new projects or when no package manager is established, prefer `yarn` over `npm`.
