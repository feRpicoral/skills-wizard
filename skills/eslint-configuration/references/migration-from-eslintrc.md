Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/migration-guide.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/migrate-to-9.0.0.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/migrate-to-10.0.0.md (MIT), condensed.

# Migrating from eslintrc to flat config

ESLint 10 cannot load `.eslintrc*`, `.eslintignore` or an `eslintConfig` key in `package.json`. ESLint 9 loads them only with `ESLINT_USE_FLAT_CONFIG=false`. ESLint 8 uses flat config only when `eslint.config.js` exists.

## Steps

1. Run the version check. If ESLint 8 is installed, plan the upgrade: `defineConfig` and `globalIgnores` need 9.22.0 or later, and ESLint 10 needs Node.js `^20.19.0`, `^22.13.0` or `>=24`.
2. Inventory what the old setup does: `extends`, `plugins`, `parser`, `parserOptions`, `env`, `globals`, `rules`, `overrides`, `ignorePatterns`, `.eslintignore`, `settings`, linter options, and the npm scripts' ESLint flags. Optionally capture `npx eslint --print-config <file>` output for one file per override before changing anything.
3. Generate a draft if useful:
   - `npx @eslint/migrate-config .eslintrc.json` (also `.eslintrc` and `.eslintrc.yml`). For `.eslintrc.js` it only emits the evaluated data, without functions or conditionals.
   - `npx codemod @eslint/v8-to-v9-config` also rewrites `eslintConfig` in package.json, `.eslintignore`, `/* exported */` and some `/* eslint */` comments.
   - Neither output is guaranteed to work unchanged. Check it against the mapping below.
4. Write `eslint.config.mjs` (house convention) with the same behavior: same rules, same globals per file group, same ignores. Do not add plugins or style rules during the migration unless the user asks.
5. Remove `/* eslint-env */` comments (errors in ESLint 10). Declare the globals in the config, or use `/* global describe, it -- Mocha globals */`.
6. Delete `.eslintrc*`, `.eslintignore` and `eslintConfig`. Update scripts: drop `--ignore-path`, `--env`, `--no-eslintrc` (now `--no-config-lookup`), `--rulesdir` and `--resolve-plugins-relative-to`.
7. Add `@eslint/js` and `globals` to devDependencies when the config uses them (ESLint does not install them).
8. Verify: `npx eslint .` and `--print-config` for a file in each former override; compare with the old results.

## Mapping

| eslintrc                                                          | Flat config                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `root: true`                                                      | Remove; every flat config acts as root                                                                                 |
| `extends: "eslint:recommended"` / `"eslint:all"`                  | `js.configs.recommended` / `js.configs.all` from `@eslint/js`, or `extends: ['js/recommended']` with `plugins: { js }` |
| `extends: ["eslint-config-x", "./custom.js"]`                     | Import the modules and add them to the array or to `extends`                                                           |
| `plugins: ["jsdoc"]`                                              | `import jsdoc from 'eslint-plugin-jsdoc'` and `plugins: { jsdoc }`                                                     |
| `parser: "@babel/eslint-parser"`                                  | `languageOptions.parser` set to the imported parser object                                                             |
| `parserOptions.ecmaVersion`, `parserOptions.sourceType`           | `languageOptions.ecmaVersion`, `languageOptions.sourceType`                                                            |
| Other `parserOptions`                                             | `languageOptions.parserOptions`                                                                                        |
| `env: { browser: true, node: true }`                              | `languageOptions.globals: { ...globals.browser, ...globals.node }`                                                     |
| `globals: { myGlobal: "readonly" }`                               | `languageOptions.globals`                                                                                              |
| `overrides: [{ files: [...], ... }]`                              | Later objects with `files` (always an array, never a single string)                                                    |
| `ignorePatterns`, `.eslintignore`                                 | `globalIgnores([...])`; `temp.js` becomes `**/temp.js`                                                                 |
| `noInlineConfig`, `reportUnusedDisableDirectives: true`           | `linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'warn' }`                                       |
| Extension-named processors (`"plugin/.md"`) applied automatically | An explicit object: `{ files: ['**/*.md'], processor: plugin.processors['.md'] }`                                      |
| `--rulesdir`                                                      | A virtual plugin in the config (plugins-parsers-languages.md)                                                          |
| `settings`                                                        | `settings` (unchanged)                                                                                                 |

Unchanged: rule configuration syntax, processor syntax, and most CLI flags.

## Behavior differences to account for

- An object without `files` applies to `**/*.js`, `**/*.mjs` and `**/*.cjs` plus any extension another object adds. Every flat config object behaves like an `overrides` entry.
- Patterns resolve relative to the config file. `.eslintignore` used gitignore semantics, where `temp.js` matched at any depth.
- Dotfiles are linted by default; add `'**/.*'` to global ignores if the old setup relied on skipping them.
- `sourceType: 'commonjs'` is available.
- `--ignore-path .gitignore` becomes `includeIgnoreFile()` from `eslint/config` (10.4.0 and later) or from `@eslint/compat` on older versions (ignoring-files.md).

## Worked example

Before (`.eslintrc.json` plus `.eslintignore` containing `temp.js`):

```json
{
  "root": true,
  "env": { "browser": true, "es2022": true },
  "extends": ["eslint:recommended"],
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "rules": { "eqeqeq": "error" },
  "overrides": [
    {
      "files": ["test/**/*.js"],
      "env": { "mocha": true },
      "rules": { "no-unused-expressions": "off" }
    }
  ],
  "ignorePatterns": ["dist/"]
}
```

After:

```js
// eslint.config.mjs
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/', '**/temp.js']),
  {
    files: ['**/*.js'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { eqeqeq: 'error' },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.mocha } },
    rules: { 'no-unused-expressions': 'off' },
  },
]);
```

`env.es2022` needs no translation: ECMAScript globals follow `ecmaVersion`.

## Shareable configs not yet converted

```js
// eslint.config.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';
import { defineConfig } from 'eslint/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

export default defineConfig([...compat.extends('eslint-config-my-config')]);
```

Install `@eslint/eslintrc`, and keep it current when `@eslint/js` is on version 10. If a plugin throws `TypeError: context.getScope is not a function`, it predates the ESLint 9 rule API: upgrade it or patch it with `@eslint/compat`.

## Editor

The VS Code ESLint extension supports flat config by default from 3.0.10. Older versions need `"eslint.experimental.useFlatConfig": true` in `.vscode/settings.json`.
