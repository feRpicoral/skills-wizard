Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/configuration-files.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/combine-configs.md (MIT), condensed.

# Configuration files

## File names and precedence

ESLint reads the first of these it finds in a directory, in this order:

1. `eslint.config.js`
2. `eslint.config.mjs`
3. `eslint.config.cjs`
4. `eslint.config.ts`
5. `eslint.config.mts`
6. `eslint.config.cts`

JavaScript files win over TypeScript files. `-c` / `--config <file>` selects a file explicitly and turns the lookup off.

The file exports an array of configuration objects. If `package.json` declares `"type": "commonjs"`, `eslint.config.js` must be CommonJS:

```js
// eslint.config.js
const { defineConfig } = require('eslint/config');

module.exports = defineConfig([
  {
    rules: {
      semi: 'error',
    },
  },
]);
```

`eslint.config.mjs` is always ES modules, which is why the house configs use it.

## Lookup

ESLint 10 resolves the configuration per linted file: it starts in the file's directory and walks up to the first `eslint.config.*`. Subdirectories, such as monorepo packages, can have their own config. Passing `--config` disables the search. ESLint 9 looked up from the working directory unless the per-file lookup flag was set (see version-differences.md).

## defineConfig and globalIgnores

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist/']),
  {
    files: ['**/*.js'],
    rules: {
      semi: 'error',
      'prefer-const': 'error',
    },
  },
]);
```

- `defineConfig()` takes configuration objects and arrays and resolves `extends`.
- `globalIgnores(patterns, name?)` creates an ignores-only object (details in ignoring-files.md).
- Both come from `eslint/config`, available since ESLint 9.22.0.

## Configuration object keys

| Key               | Meaning                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Label used in error messages and the config inspector                                                                                                                                  |
| `basePath`        | Subdirectory the object applies to (relative or absolute), since 9.30.0                                                                                                                |
| `files`           | Glob patterns the object applies to. Without it, the object applies to every file matched by any other object                                                                          |
| `ignores`         | Globs excluded from this object. Alone (besides `name`), they are global ignores                                                                                                       |
| `extends`         | Strings (`"plugin/config"`), configuration objects or arrays to inherit from                                                                                                           |
| `language`        | `"plugin/language"`, for example `"markdown/commonmark"`. Default `"js/js"`                                                                                                            |
| `languageOptions` | JavaScript: `ecmaVersion` (default `"latest"`), `sourceType` (default `"module"` for `.js` and `.mjs`, `"commonjs"` for `.cjs`), `globals`, `parser` (default espree), `parserOptions` |
| `linterOptions`   | `noInlineConfig`, `reportUnusedDisableDirectives` (default `"warn"`), `reportUnusedInlineConfigs` (default `"off"`)                                                                    |
| `processor`       | An object with `preprocess()` and `postprocess()`, or `"plugin/processor"`                                                                                                             |
| `plugins`         | Map of namespace to plugin object. With `files`, the plugins are only available to matching files                                                                                      |
| `rules`           | Rule configurations. With `files` or `ignores`, they only apply to matching files                                                                                                      |
| `settings`        | Name-value pairs available to every rule as `context.settings`                                                                                                                         |

## files and ignores

- Patterns use minimatch syntax and resolve relative to the directory of `eslint.config.*`. With `--config <file>` they resolve relative to the working directory. With `basePath`, `files` and `ignores` resolve relative to that subdirectory.
- ESLint always lints `**/*.js`, `**/*.cjs` and `**/*.mjs` unless they are globally ignored.
- To lint other extensions, add them to `files`, for example `files: ['**/*.ts', '**/*.cts', '**/*.mts']`. A pattern that is `*`, or ends in `/*` or `/**`, does not add files to the lint set.
- An object without `files` applies to every linted file, including extensions added by other objects. When the repo lints non-JavaScript files, put JavaScript-only rules in an object with `files: ['**/*.js', '**/*.cjs', '**/*.mjs']`.
- Files without an extension: `**/!(*.*)`. A dotfile such as `.gitignore` counts as an extension only: `**/.gitignore` matches, `**/*.gitignore` does not.
- AND matching: `files: [['src/*', '**/*.js']]` matches files that are in `src` and end in `.js`.
- `ignores` next to `files` removes files from that object only, and negation works: `ignores: ['**/*.config.js', '!**/eslint.config.js']`.
- Non-global `ignores` match file names only. `'dir-to-exclude/'` ignores nothing; use `'dir-to-exclude/**'`.
- `ignores` with other keys but no `files` applies the object to every linted file except the ignored ones. Add `files` whenever you use `ignores`.
- Negated `ignores` without `files` do not make ESLint lint extra files.
- Use `--print-config <file>` or `--inspect-config` to see which objects match a file.

## basePath

```js
export default defineConfig([
  {
    basePath: 'tests',
    extends: [
      { rules: { 'no-undef': 'error' } },
      {
        files: ['**/*.spec.js'],
        languageOptions: {
          globals: { it: 'readonly', describe: 'readonly' },
        },
      },
      { ignores: ['fixtures/'] },
    ],
  },
]);
```

All three inner objects apply under `tests/`; the ignores-only one globally ignores `tests/fixtures/`.

## Cascading

When several objects match a file, they merge in array order and later objects win on conflicts. Nested objects such as `languageOptions.globals` merge. For rules, a later entry with only a severity keeps the earlier options: `semi: ['error', 'never']` followed by `semi: 'warn'` gives `['warn', 'never']`. Inline `/* eslint */` comments apply after all configuration files.

Use cascading for per-directory or per-pattern rules, severity changes for a subset, tests versus sources, and different language options per pattern.

## extends and shared configs

Use `extends` to reuse configurations from plugins, packages or `@eslint/js`.

- Plugin config by name: register the plugin in `plugins`, then `extends: ['example/recommended']`.
- Plugin config by object: `extends: [examplePlugin.configs.recommended]`.
- Shareable config package (object or array): `extends: [exampleConfig]`.
- Always add `files` next to `extends`; otherwise the extended config may apply to all files.

```js
// eslint.config.mjs
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.js'],
    plugins: { js },
    extends: ['js/recommended'],
    rules: {
      'no-unused-vars': 'warn',
    },
  },
]);
```

`@eslint/js` provides `js/recommended` (rules ESLint recommends for everyone) and `js/all` (every core rule; changes with each minor and major release, not recommended for production). Install `@eslint/js` separately.

Spreading an imported array into the top level (`...nextVitals`) also works; the house configs do this for framework configs.

## settings

```js
export default defineConfig([
  {
    settings: { sharedData: 'Hello' },
  },
]);
```

Rules read it through `context.settings.sharedData`. Plugins namespace their keys to avoid collisions.

## Naming objects

`name` is optional but recommended, especially in shared configs. Scope it with the plugin or config name and `/`, for example `example/recommended` or `example/strict/language-setup`. ESLint does not enforce unique names. `--print-config` output omits `files`, `ignores` and `name`.

## TypeScript configuration files

- Node.js: install `jiti` 2.2.0 or later as a dev dependency. ESLint does not install it.
- Deno and Bun: supported natively.
- Node.js 22.13.0 or later without jiti: `npx --node-options='--experimental-strip-types' eslint --flag unstable_native_nodejs_ts_config`.
- ESLint does not type-check the configuration file and does not apply `tsconfig.json` settings to it.
- A `.js`, `.mjs` or `.cjs` config in the same directory takes precedence; run `eslint --config eslint.config.ts` to force the TypeScript file.
- The type of each configuration object is `Linter.Config` (see `lib/types` in the ESLint repository).
