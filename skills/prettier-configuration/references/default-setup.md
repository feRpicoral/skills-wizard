Not part of the Prettier docs: this is the skill's opinionated default for new setups, not a Prettier requirement. Compatibility facts were checked against the npm registry and each package's GitHub repository on 2026-10-14.

# Default setup (Prettier, lint-staged, Husky)

Use this for new setups. In an existing repo, match what is there.

## Defaults

| Topic                  | Default for a new setup                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Config file            | `.prettierrc` with only the options that differ from Prettier's defaults                                      |
| Quotes                 | `singleQuote: true`                                                                                           |
| `printWidth`           | Prettier's default (80)                                                                                       |
| ESLint integration     | `eslint-plugin-prettier/recommended` (see the eslint-configuration skill)                                     |
| Tailwind class sorting | `prettier-plugin-tailwindcss` whenever Tailwind CSS is present                                                |
| lint-staged JS glob    | `*.{ts,tsx,js,jsx,cjs,mjs}`                                                                                   |
| Husky install script   | `postinstall` with Yarn, because Yarn 2+ does not run `prepare` (Husky docs); `prepare` with npm, pnpm or bun |
| Scripts                | Both `format` and `format:check`                                                                              |
| Commit messages        | commitlint with `@commitlint/config-conventional`, 100-character header, body line length off                 |

If the target repo already made a different choice (double quotes, `printWidth: 100`, `.prettierrc.json`, defaults spelled out), keep it.

## .prettierrc

```json
{
  "singleQuote": true
}
```

With Tailwind CSS:

```json
{
  "singleQuote": true,
  "plugins": ["prettier-plugin-tailwindcss"],
  "tailwindStylesheet": "./src/app/globals.css"
}
```

- Keep `prettier-plugin-tailwindcss` last if other plugins are added.
- Tailwind CSS v4 projects must point `tailwindStylesheet` at the CSS entry file, relative to the Prettier config (plugin README); use the repo's real path. Tailwind v3 projects use `tailwindConfig` only when `tailwind.config.js` is not next to the Prettier config.

## .prettierignore

Next.js:

```text
.next
.yarn
coverage
generated
```

Nx monorepo:

```text
/dist
/coverage
/.nx/cache
/.nx/workspace-data
**/generated
```

Add other build or report output the repo produces (`out`, `build`, `.vercel`, `playwright-report`, `test-results`, `prisma/migrations`, `public`) and lockfiles. Prettier already skips `node_modules` and anything in `.gitignore` when run from the root, so those entries are optional.

## package.json scripts

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "postinstall": "husky"
  }
}
```

- Use `"prepare": "husky"` instead of `postinstall` with npm, pnpm or bun. A package published to npm with Yarn also needs `"prepack": "pinst --disable"` and `"postpack": "pinst --enable"` so installing it does not run Husky (Husky docs).
- Run `format:check` in CI, which the Prettier docs recommend; `prettier/prettier` in `eslint .` covers only the files ESLint lints.

## lint-staged

```json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx,cjs,mjs}": ["eslint --fix", "prettier --write"],
    "*.{json,md,css,yml,yaml}": ["prettier --write"]
  }
}
```

ESLint runs before Prettier, as the Prettier docs require.

## Husky hooks

`.husky/pre-commit`:

```sh
yarn lint-staged
```

`.husky/commit-msg`:

```sh
yarn commitlint --edit "$1"
```

With npm, pnpm or bun, use that package manager's runner in place of `yarn` (the Prettier docs show `npx lint-staged`, `pnpm exec lint-staged`, `bunx lint-staged`).

## commitlint

```js
// commitlint.config.mjs
const commitlintConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0, 'always', 100],
  },
};

export default commitlintConfig;
```

## Compatibility with the latest versions

Install the latest stable release of each package (no alpha, beta, rc, canary or nightly tags) as long as it fits the `peerDependencies` and `engines` of the rest of the toolchain. When it does not, use the newest stable release that does. Check with `npm view <package> dist-tags peerDependencies engines` before installing, because these facts change with every release, and tell the user when you held a package back and why. As of the date above:

- **Prettier:** Prettier 3 is current; Prettier 4 is only published as alpha releases on the `next` tag, so do not install `prettier@next`. The Prettier docs recommend an exact version (`--save-exact`) because even patch releases can change output; a caret range is fine when everyone installs from the committed lockfile. Mention the trade-off when version drift is the problem.
- **prettier-plugin-tailwindcss:** 0.8.x needs Prettier 3.7 or later (its changelog), although its `peerDependencies` still say `^3.0`, and Node.js 20.19 or later. Upgrade Prettier first when an older 3.x is installed.
- **eslint-plugin-prettier and eslint-config-prettier:** eslint-plugin-prettier 5 needs Prettier 3 and accepts eslint-config-prettier `>=7 <10` or `>=10.1`, so avoid eslint-config-prettier 10.0.x. Both accept ESLint 10.
- **Husky:** 9.x is current (no major release since). Husky 9 needs Node.js 18 or later.
- **lint-staged:** 17 needs Node.js 22.22.1 or later and Git 2.32.0 or later. On older Node.js, install the previous major whose `engines` accepts it and say so.
- **commitlint:** `@commitlint/cli` and `@commitlint/config-conventional` 21 need Node.js 22.12.0 or later; keep both packages on the same major.
- **Node.js floor:** with the latest lint-staged and commitlint, the toolchain needs Node.js 22.22.1 or later. Use Node.js 24 for new setups and pin it with `.nvmrc` or `engines`.
