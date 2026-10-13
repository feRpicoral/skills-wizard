---
title: Nx Monorepo
summary: Module boundary enforcement, workspace package entry points and Nx task targets
group: stack
scopes: [project]
defaults: []
---

## Nx Monorepo

- Enforce workspace module boundaries (`@nx/enforce-module-boundaries`) and import across workspace projects only through their public package entry points (`@scope/<pkg>`), never via relative paths that cross `apps/*`, `packages/*`, or `libs/*` roots.
- Run tasks through Nx (`yarn nx run <project>:<target>`, `yarn nx run-many -t lint,test,build`, or `yarn nx affected -t lint,test,build`) so `dependsOn` pipelines and task caching are respected.
- Place shared schemas, API contracts, and utilities in workspace libraries (`packages/*` or `libs/*`) rather than importing code from one application into another.
