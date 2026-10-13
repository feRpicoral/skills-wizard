Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/plugins.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/parser.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/language-options.md (MIT), condensed.

# Plugins, processors, languages, parsers and language options

## Plugins

Plugins are objects that can provide rules, configs, processors and languages. Register them under `plugins`; the key is the namespace used in rule names.

```js
import example from 'eslint-plugin-example';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.js'],
    plugins: { example },
    rules: { 'example/rule1': 'warn' },
  },
]);
```

- Convention: the namespace is the package name without `eslint-plugin-` (`eslint-plugin-jsdoc` becomes `jsdoc`). Flat config lets you pick any namespace (`jsd: jsdoc` makes rules `jsd/...`), but keep the conventional name: shared configs expect it, and the eslint-config-prettier README warns that it only turns off rules under the official plugin names.
- With `files`, the plugin is only available to matching files, so a rule from it must be configured in an object that matches the same files.
- Local plugin from a file: `import local from './my-local-plugin.js'` and `plugins: { local }`.
- Virtual plugin for a single rule file (the replacement for `--rulesdir`):

```js
import myRule from './rules/my-rule.js';

export default defineConfig([
  {
    plugins: { local: { rules: { 'my-rule': myRule } } },
    rules: { 'local/my-rule': 'warn' },
  },
]);
```

## Processors

Processors extract JavaScript from other files or transform code before linting.

```js
import markdown from '@eslint/markdown';

export default defineConfig([
  {
    files: ['**/*.md'],
    plugins: { markdown },
    processor: 'markdown/markdown',
  },
  {
    files: ['**/*.md/*.js'],
    rules: { strict: 'off' },
  },
]);
```

- Named code blocks (`0.js`, `1.js`) count as child files of the original, matched with patterns like `**/*.md/*.js`.
- ESLint lints named blocks only when they are JavaScript or match a `files` entry; add an object for other block types such as `**/*.jsx`.
- Global ignores also apply to named blocks, for example `{ ignores: ['**/test.md/*.jsx'] }`.
- Flat config never assigns processors automatically; set `processor` explicitly.

## Languages

Plugins can add languages other than JavaScript. Set `language` to `"namespace/language"`:

```js
import json from '@eslint/json';

export default defineConfig([
  {
    files: ['**/*.json'],
    plugins: { json },
    language: 'json/jsonc',
  },
]);
```

When `language` is set, `languageOptions` belong to that language; check the plugin's docs. The default language is `js/js`.

## JavaScript language options

| Option        | Default    | Values                                                                                                                                                                          |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecmaVersion` | `"latest"` | `3`, `5`, any year from `2015` on, or `"latest"`. Sets syntax and the built-in globals. The docs recommend the default                                                          |
| `sourceType`  | `"module"` | `"module"` (ESM, strict, invalid with `3` or `5`), `"commonjs"` (top-level function scope, `require()`), `"script"` (shared global scope). `.cjs` files default to `"commonjs"` |

`languageOptions.parserOptions` for the default parser (espree), all `false` by default:

- `allowReserved`: reserved words as identifiers (`ecmaVersion: 3` only).
- `ecmaFeatures.globalReturn`: top-level `return` with `sourceType: "script"`. Always allowed for `"commonjs"`, never for `"module"`.
- `ecmaFeatures.impliedStrict`: global strict mode (`ecmaVersion` 5 or later).
- `ecmaFeatures.jsx`: JSX syntax. JSX support is not React support; for React use `eslint-plugin-react` or `@eslint-react/eslint-plugin`.

Keep `ecmaVersion` and `sourceType` in `languageOptions`, not in `parserOptions`. If both are set, the `parserOptions` values win for the parser.

## Globals

ESLint assumes no environment globals beyond the ECMAScript built-ins for the configured `ecmaVersion`. Rules like `no-undef` need the rest declared.

```js
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.jest,
        var1: 'writable',
        var2: 'readonly',
        Promise: 'off',
      },
    },
  },
]);
```

- Values: `"writable"`, `"readonly"`, `"off"` (removes a global). `true`, `"writeable"`, `false` and `"readable"` still work but are deprecated.
- Environment sets come from the `globals` npm package (`globals.browser`, `globals.node`, `globals.jest`, `globals.mocha`, ...). ESLint does not install it.
- In a file: `/* global var1, var2:writable */`.

## Custom parsers

`languageOptions.parser` takes a parser object (with `parse()` or `parseForESLint()`), imported as a module:

```js
import babelParser from '@babel/eslint-parser';

export default defineConfig([
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: ['@babel/preset-env'],
        },
      },
    },
  },
]);
```

- `parserOptions` are parser-specific; read the parser's docs.
- ESLint passes `languageOptions.ecmaVersion` and `sourceType` to every parser; set `parserOptions.ecmaVersion` or `parserOptions.sourceType` only to give the parser different values.
- Parsers the docs list as compatible: Esprima, `@babel/eslint-parser`, `@typescript-eslint/parser`. ESLint does not fix bugs that only affect third-party parsers.

## TypeScript

The ESLint docs do not document TypeScript setup beyond listing `@typescript-eslint/parser` as compatible. Use typescript-eslint (https://typescript-eslint.io) and follow its documentation for its configs and options. Two things come from the ESLint side:

- `.ts`, `.mts` and `.cts` files are only linted when a `files` pattern matches them (shared configs usually add these patterns).
- The house configs spread `tseslint.configs.recommended` from the `typescript-eslint` package or get typescript-eslint through `eslint-config-next/typescript` or `@nx/eslint-plugin`; see house-style.md.

## Common problems

- `TypeError: context.getScope is not a function` (or `getAncestors`, `markVariableAsUsed`, `getDeclaredVariables`): the plugin predates the ESLint 9 rule API. Upgrade the plugin, or patch it with the compatibility utilities from `@eslint/compat`, and report it upstream.
- A shareable config still in eslintrc format: wrap it with `FlatCompat` (see migration-from-eslintrc.md).
