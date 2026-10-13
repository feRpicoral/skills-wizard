---
title: Node.js and Yarn
summary: Node version pinning with .nvmrc, Corepack and Yarn Berry
group: stack
scopes: [project]
defaults: []
---

## Node.js and Yarn

- Pin the Node.js version in `.nvmrc` (Node 24 LTS by default) and run `nvm use` before executing Node or package manager commands when `.nvmrc` is present.
- Enable Corepack (`corepack enable`) and use the Yarn version pinned in `package.json` (`packageManager`) with `nodeLinker: node-modules` in `.yarnrc.yml` unless the repository specifies otherwise.
- Never mix package managers (`npm`, `pnpm`, `yarn`) or commit foreign lockfiles (`package-lock.json`, `pnpm-lock.yaml`) in a Yarn repository.
- Run project scripts through `yarn <script>` and install packages with `yarn add` or `yarn add -D` rather than hand-editing version ranges in `package.json`.
