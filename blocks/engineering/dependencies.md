---
title: Dependencies
summary: Prefer existing dependencies and the project package manager
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Dependencies

- Do not add dependencies for small utilities that can be implemented clearly in-project.
- Prefer existing project dependencies before adding new ones.
- If adding a dependency, explain why it is necessary and whether it affects runtime, build time, or bundle size.
- Use the package manager already used by the project. Do not change lockfiles unless dependency changes are required.
- For new projects or when no package manager is established, prefer `yarn` over `npm`.
