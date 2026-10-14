Source: the user's repositories quotahit, desvia, relay, cite and sonar (.prettierrc, .prettierignore, package.json, .husky, commitlint and CI files read 2026-10-12). Not part of the Prettier docs: these are the user's preferences, not Prettier requirements.

# House style (Prettier, lint-staged, Husky)

Use this for new setups. In an existing repo, match what is there.

## What all five repos share

- Prettier 3 with a project config file and a `.prettierignore`.
- ESLint runs Prettier through `eslint-plugin-prettier/recommended` (see the eslint-configuration skill).
- `arrowParens` stays at its default `"always"` (relay and cite spell it out, the others omit it).
- Husky 9, lint-staged and commitlint with `@commitlint/config-conventional`; the hooks run `yarn lint-staged` and `yarn commitlint --edit "$1"`.
- Yarn 4 (`packageManager` field) with `nodeLinker: node-modules`.

## Where the repos differ

| Topic                  | What the repos do                                                                                                                                                                         | Default for a new setup                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Quotes                 | `singleQuote: true` (desvia, quotahit); double quotes (sonar, relay, cite)                                                                                                                | Single quotes                                                                                                 |
| `printWidth`           | Default 80 (desvia, quotahit); 100 (sonar, relay, cite)                                                                                                                                   | Default                                                                                                       |
| Defaults spelled out   | Only non-defaults (desvia, quotahit); `semi`, `singleQuote: false`, `trailingComma: "all"`, `tabWidth`, `useTabs`, `arrowParens` listed at default values (relay, cite; sonar lists some) | Only non-defaults                                                                                             |
| Config file            | `.prettierrc` (desvia, quotahit); `.prettierrc.json` (sonar, relay, cite)                                                                                                                 | `.prettierrc`                                                                                                 |
| Tailwind class sorting | `prettier-plugin-tailwindcss` (sonar, relay, cite); quotahit uses Tailwind 4 without it                                                                                                   | Add the plugin whenever Tailwind is present (user preference for new setups)                                  |
| lint-staged JS glob    | `*.{ts,tsx,js,jsx,cjs,mjs}` (desvia, quotahit); same without `cjs` (sonar, relay, cite)                                                                                                   | Include `cjs`                                                                                                 |
| Husky install script   | `"postinstall": "husky"` (desvia, quotahit); `"prepare": "husky"` (sonar, relay, cite)                                                                                                    | `postinstall` with Yarn, because Yarn 2+ does not run `prepare` (Husky docs); `prepare` with npm, pnpm or bun |
| `format:check` script  | Present (sonar, relay, cite); only `format` (quotahit)                                                                                                                                    | Add both                                                                                                      |
| commitlint rules       | 100-character header, body line length off (quotahit, desvia, cite); header-only commits (relay); defaults (sonar)                                                                        | quotahit and desvia                                                                                           |

If the target repo already made one of these choices, keep it. Otherwise use the default column and tell the user that it follows the newest repos (desvia, quotahit).

## .prettierrc

New setup (desvia, quotahit):

```json
{
  "singleQuote": true
}
```

New setup with Tailwind CSS:

```json
{
  "singleQuote": true,
  "plugins": ["prettier-plugin-tailwindcss"],
  "tailwindStylesheet": "./src/app/globals.css"
}
```

- The plugin entry matches sonar, relay and cite (`"plugins": ["prettier-plugin-tailwindcss"]`). Keep it last if other plugins are added.
- `tailwindStylesheet` is not in the house repos. The plugin README says Tailwind CSS v4 projects must point it at the CSS entry file (relative to the Prettier config), so add it with the repo's real path and tell the user it is new. Tailwind v3 projects use `tailwindConfig` only when `tailwind.config.js` is not next to the Prettier config.

For reference, relay and cite (Tailwind, older style):

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

## .prettierignore

Next.js (quotahit):

```text
.next
node_modules
.yarn
coverage
generated
```

Nx monorepo (desvia):

```text
# Add files here to ignore them from prettier formatting
/dist
/coverage
/.nx/cache
/.nx/workspace-data
.nx/self-healing
**/generated
```

Additions seen in the other repos: `out`, `build`, `dist`, `.vercel`, `playwright-report`, `test-results`, `prisma/migrations` (relay), `public` (sonar, cite), and lockfiles (`yarn.lock`, `*.lock`, `package-lock.json`, `pnpm-lock.yaml`). Prettier already skips `node_modules` and anything in `.gitignore` when run from the root, so those entries are harmless but optional.

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

- `lint`, `lint:fix`, `format` and `postinstall` come from quotahit (which chains `husky && prisma generate ...` in `postinstall`); `format:check` from sonar, relay and cite.
- CI in quotahit and relay runs `yarn install --immutable` and then `yarn lint`; JS and TS formatting is enforced there through `prettier/prettier`. JSON, Markdown, CSS and YAML are only formatted by the pre-commit hook. For a new setup, also run `yarn format:check` in CI, which the Prettier docs recommend.

## lint-staged

```json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx,cjs,mjs}": ["eslint --fix", "prettier --write"],
    "*.{json,md,css,yml,yaml}": ["prettier --write"]
  }
}
```

The block is identical in all five repos except that sonar, relay and cite omit `cjs`. ESLint runs before Prettier, as the Prettier docs require.

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
// commitlint.config.mjs (quotahit; desvia is the same with body-max-line-length: [0])
const commitlintConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0, 'always', 100],
  },
};

export default commitlintConfig;
```

relay is stricter (lower-case subject, no trailing period, 72-character header, empty body and footer). sonar uses the conventional config unchanged. cite uses the quotahit rules in a CommonJS `commitlint.config.js`.

## Dev dependencies and versions in use

| Package                                              | Range in the repos                       |
| ---------------------------------------------------- | ---------------------------------------- |
| `prettier`                                           | `^3.8.1` (desvia) to `^3.8.4` (quotahit) |
| `prettier-plugin-tailwindcss`                        | `^0.6.9` (relay), `^0.8.0` (cite, sonar) |
| `eslint-plugin-prettier`                             | `^5.2.1` to `^5.5.6`                     |
| `eslint-config-prettier`                             | `^9.1.0` (relay), `^10.x` elsewhere      |
| `husky`                                              | `^9.1.7`                                 |
| `lint-staged`                                        | `^17.0.4` to `^17.0.7`                   |
| `@commitlint/cli`, `@commitlint/config-conventional` | `^21.0.1` to `^21.0.2`                   |

The repos use caret ranges with a committed `yarn.lock` and `yarn install --immutable` in CI, which keeps versions consistent as long as everyone installs from the lockfile. The Prettier docs recommend an exact version instead; in a house repo keep the caret and the lockfile, and mention the docs' advice when version drift is the problem.
