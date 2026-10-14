Not part of the ESLint docs: this is the skill's opinionated default for new setups, not an ESLint requirement. Compatibility facts were checked against the npm registry and each package's GitHub repository on 2026-10-14.

# Default setup (ESLint)

Use this for new setups. In an existing repo, match what is there. This file has the shared core, the plain TypeScript/Node and Next.js variants, and the compatibility notes for the latest versions. Nx and Expo variants are in default-setup-nx.md.

## Shared core

- Flat config in `eslint.config.mjs`, with `defineConfig` and `globalIgnores` from `eslint/config` (except in Nx workspaces, which keep the plain array Nx generates).
- `eslint-plugin-prettier/recommended`, with `eslint-plugin-prettier`, `eslint-config-prettier` and `prettier` installed. It enables `prettier/prettier`, turns on eslint-config-prettier and turns off `arrow-body-style` and `prefer-arrow-callback` (eslint-plugin-prettier README).
- `eslint-plugin-simple-import-sort` with both `simple-import-sort/imports` and `simple-import-sort/exports` set to `"error"`.
- Unused code through `eslint-plugin-unused-imports`, ignoring names prefixed with `_` (`^_`).
- Type-only imports through `@typescript-eslint/consistent-type-imports` with `prefer: 'type-imports', fixStyle: 'inline-type-imports'`.
- Prettier (`.prettierrc` with `{ "singleQuote": true }` and `.prettierignore`), Husky, lint-staged and commitlint on every commit (see the prettier-configuration skill).
- Agent directories (`.claude/**`, `.agents/**`) globally ignored when they exist.

If the target repo already made a different choice, such as `@typescript-eslint/no-unused-vars` instead of eslint-plugin-unused-imports, keep it and say so.

## Order inside the config

1. Shared configs: framework (`eslint-config-next`, `@nx/eslint-plugin`), `@eslint/js`, typescript-eslint.
2. `eslint-plugin-prettier/recommended`. Its README asks for it to be last so eslint-config-prettier can turn off conflicting rules from earlier configs.
3. The rules object. It holds no formatting rules, so placing it after the Prettier config is safe.
4. Global ignores.

## Plain TypeScript / Node

```js
// eslint.config.mjs
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  globalIgnores(['dist/**', 'coverage/**']),
]);
```

Dev dependencies: `eslint`, `@eslint/js`, `typescript-eslint`, `typescript` (6.0.x, see the compatibility notes below), `globals`, `eslint-plugin-prettier`, `eslint-config-prettier`, `prettier`, `eslint-plugin-simple-import-sort`, `eslint-plugin-unused-imports`.

## Next.js app

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    '.yarn/**',
    '.claude/**',
    '.agents/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
```

- Add generated output to the ignores (for example `src/generated/**` for a generated Prisma client), plus `.vercel/**`, `playwright-report/**` and `test-results/**` when they exist.
- Next.js 16 removed `next lint`, and `next build` no longer lints. Run the ESLint CLI from the `lint` script; `npx @next/codemod@canary next-lint-to-eslint-cli .` converts an older setup.
- Repos that prefer the typescript-eslint rule replace the unused-imports block with:

```js
'@typescript-eslint/no-unused-vars': [
  'error',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
],
```

Dev dependencies: `eslint`, `eslint-config-next` (same version as `next`), `typescript-eslint`, `typescript` (6.0.x), `eslint-plugin-prettier`, `eslint-config-prettier`, `prettier`, `eslint-plugin-simple-import-sort`, `eslint-plugin-unused-imports`.

## Scripts, hooks and CI

- `"lint": "eslint ."`, `"lint:fix": "eslint . --fix"`, `"format": "prettier --write ."`, `"format:check": "prettier --check ."`, and `"postinstall": "husky"` on Yarn (`"prepare": "husky"` on npm, pnpm or bun).
- `.prettierrc`: `{ "singleQuote": true }`, plus `.prettierignore` (`dist`, `coverage`, `.yarn`, generated code).
- `lint-staged` in `package.json`:
  ```json
  {
    "lint-staged": {
      "*.{ts,tsx,js,jsx,cjs,mjs}": ["eslint --fix", "prettier --write"],
      "*.{json,md,css,yml,yaml}": ["prettier --write"]
    }
  }
  ```
- `.husky/pre-commit`: `yarn lint-staged` (or `npx lint-staged` / `pnpm exec lint-staged`). Dev dependencies for hooks: `husky`, `lint-staged`.
- CI: install from the lockfile (`yarn install --immutable`, `npm ci`, `pnpm install --frozen-lockfile`), then lint, typecheck, test and build.

## Compatibility with the latest versions

Install the latest stable release of each package (no alpha, beta, rc, canary or nightly tags) as long as it fits the `peerDependencies` and `engines` of the rest of the toolchain. When it does not, use the newest stable release that does. Check with `npm view <package> dist-tags peerDependencies engines` before installing, because these facts change with every release, and tell the user when you held a package back and why.

As of the date above, that means:

- **TypeScript 6.0.x, not 7.** `typescript@latest` is 7.x, but TypeScript 7.0 ships no JavaScript compiler API, and typescript-eslint 8.x declares `typescript >=4.8.4 <6.1.0`, so it fails at install (peer conflict) or at lint time with TypeScript 7. Install `"typescript": "~6.0.3"` in any repo that lints TypeScript, directly or through `eslint-config-next/typescript` or `@nx/eslint-plugin`. Support is tracked in [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940); move to TypeScript 7 once typescript-eslint's range accepts it.
- **ESLint 10**, unless a plugin the repo needs does not accept it yet. typescript-eslint 8, eslint-plugin-prettier 5, eslint-config-prettier 10, eslint-plugin-simple-import-sort, eslint-plugin-unused-imports 4, `@nx/eslint` 23 and eslint-plugin-react-hooks 7.1 accept ESLint 10. `eslint-plugin-import`, `eslint-plugin-react` and `eslint-plugin-jsx-a11y` still declare ESLint 9 or earlier. eslint-config-next supports ESLint 10 from 16.4.0 by patching the first two internally, but adding `eslint-plugin-import` as a direct dependency still causes an npm `ERESOLVE` peer conflict ([vercel/next.js#98417](https://github.com/vercel/next.js/issues/98417)); in that case use the latest ESLint 9. ESLint 10 needs Node.js `^20.19.0 || ^22.13.0 || >=24`, and `@eslint/js` follows the ESLint major (`@eslint/js` 9 with ESLint 9).
- **Prettier 3.** Prettier 4 is only published as alpha releases on the `next` tag.
- **eslint-config-prettier 10.1 or later.** eslint-plugin-prettier 5 accepts eslint-config-prettier `>=7 <10` or `>=10.1`, so not 10.0.x. eslint-config-prettier 10 exposes its flat config as `eslint-config-prettier/flat`.
- eslint-plugin-unused-imports lists `@typescript-eslint/eslint-plugin` as an optional peer; it is only needed for TypeScript, and typescript-eslint already provides it.
- **Node.js 24** (or 22.22.1 or later): lint-staged 17 needs Node.js 22.22.1 and commitlint 21 needs 22.12.0, which is higher than ESLint's floor. Pin it with `.nvmrc` or `engines`. On an older Node.js, use the newest lint-staged and commitlint majors whose `engines` accept it.
