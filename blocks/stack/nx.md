---
title: Nx Monorepo
summary: Yarn workspaces with apps/ and libs/, package.json targets, nx affected and tag boundaries
group: stack
scopes: [project]
defaults: []
---

## Nx Monorepo

- Structure the monorepo with Yarn workspaces under `apps/*` and `libs/*` (or `packages/*`), defining targets via `package.json` scripts and workspaces rather than adding unnecessary `project.json` files.
- Enforce module boundaries with tags (`@nx/enforce-module-boundaries`) and import across workspace packages only through their public entry points (`@scope/<pkg>`), never via relative paths across workspace roots.
- Run tasks locally with `yarn nx` (`yarn nx run <project>:<target>` or `yarn nx run-many -t lint,test,build`) and use `yarn nx affected -t lint,test,build` in CI so task pipelines and caching are respected.
