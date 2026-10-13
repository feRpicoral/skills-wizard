---
title: Node.js and Yarn
summary: Node version pinning with .nvmrc, Corepack, Yarn 4 and immutable CI installs
group: stack
scopes: [project]
defaults: []
---

## Node.js and Yarn

- Pin the Node.js version in `.nvmrc` (Node 24 LTS by default) and run `nvm use` before executing Node or package manager commands when `.nvmrc` is present.
- Enable Corepack (`corepack enable`) and use Yarn 4 pinned via `packageManager` in `package.json`, with `nodeLinker: node-modules` and `npmMinimalAgeGate: 4320` in `.yarnrc.yml` unless the repository specifies otherwise.
- In CI workflows, read the Node version from `.nvmrc` (`node-version-file: '.nvmrc'`) and install dependencies with `yarn install --immutable`.
- Never mix package managers (`npm`, `pnpm`, `yarn`) or commit foreign lockfiles (`package-lock.json`, `pnpm-lock.yaml`) in a Yarn repository. Run scripts via `yarn <script>` and add dependencies with `yarn add` or `yarn add -D`.
