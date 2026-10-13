Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/migrate-to-10.0.0.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/migrate-to-9.0.0.md, https://github.com/eslint/eslint/blob/v10.12.0/CHANGELOG.md (MIT), condensed.

# Version differences

Read this when the version check reports `older`, when planning an upgrade, or when a feature from the other references is missing. The other references describe ESLint 10.12.0.

## When configuration features arrived

Versions come from the changelog at v10.12.0.

| Feature                                                                                   | Since                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Flat config (`eslint.config.js`) as the default, `--inspect-config`                       | 9.0.0                                    |
| `--flag` feature flags                                                                    | 9.6.0                                    |
| TypeScript config files through jiti                                                      | 9.9.0 behind a flag, unflagged in 9.18.0 |
| Config lookup from each linted file                                                       | 9.12.0 behind a flag, default in 10.0.0  |
| `linterOptions.reportUnusedInlineConfigs`, `--report-unused-inline-configs`               | 9.19.0                                   |
| `--ext` in flat config                                                                    | 9.21.0                                   |
| `defineConfig()`, `globalIgnores()` from `eslint/config`, and `extends` in config objects | 9.22.0                                   |
| Circular fix detection warning                                                            | 9.23.0                                   |
| Bulk suppressions (`--suppress-all`, `--suppress-rule`, `--prune-suppressions`)           | 9.24.0                                   |
| Native Node.js TypeScript config loading (`unstable_native_nodejs_ts_config`)             | 9.24.0                                   |
| `--mcp`                                                                                   | 9.26.0                                   |
| `ESLINT_FLAGS` environment variable                                                       | 9.27.0                                   |
| `--pass-on-unpruned-suppressions`                                                         | 9.28.0                                   |
| `basePath` in config objects                                                              | 9.30.0                                   |
| `--concurrency` (multithreaded linting)                                                   | 9.34.0                                   |
| `preserve-caught-error` rule                                                              | 9.35.0                                   |
| Suppressions in the Node.js API (`applySuppressions`)                                     | 10.1.0                                   |
| `includeIgnoreFile()` from `eslint/config`                                                | 10.4.0                                   |

## Working with an older install

- 9.22.0 to 9.39.x: the references apply except for rows above marked later than the installed version, plus these 9.x behaviors: the config is looked up from the working directory unless the per-file lookup flag is set, and eslintrc can still be loaded with `ESLINT_USE_FLAT_CONFIG=false`. Import `.gitignore` patterns with `includeIgnoreFile(path, 'name')` from `@eslint/compat`.
- 9.0.0 to 9.21.x: no `defineConfig`, `globalIgnores` or `extends`. Export a plain array, spread shared configs into it, and use an object whose only key is `ignores` for global ignores.
- 8.x: flat config is used only when `eslint.config.js` exists at the project root or `ESLINT_USE_FLAT_CONFIG=true` is set; eslintrc is the default. Recommend upgrading (ESLint 8 cannot use `eslint/config`).
- The house repos are on ESLint 9 (see house-style.md), so expect `older` there.

## ESLint 10.0.0 (from 9.x)

Codemod: `npx codemod @eslint/v9-to-v10` (sub-codemods `@eslint/v9-to-v10-config`, `-custom-rules`, `-ruletester`, `-linter-api`). It is a starting point; review the diff and check the items below.

For users:

- Node.js `^20.19.0`, `^22.13.0` or `>=24`. Check the Node version your editor integration runs on. If Node cannot be upgraded, stay on ESLint 9.
- `eslint:recommended` adds `no-unassigned-vars`, `no-useless-assignment` and `preserve-caught-error`. Fix the reports or disable the rules deliberately.
- Config lookup starts at each linted file's directory. The `v10_config_lookup_from_file` flag is removed and using it is an error (remove it from `--flag`, `ESLINT_FLAGS` and API `flags`). Pass `--config path/to/eslint.config.js` to keep a single cwd-based config.
- eslintrc is gone: `ESLINT_USE_FLAT_CONFIG=false` no longer works, `FlatESLint` and `LegacyESLint` are removed, and `Linter` no longer accepts `configType: "eslintrc"`.
- JSX references are tracked: expect new `no-unused-vars` or `no-undef` reports in JSX files, and remove workaround rules such as `@eslint-react/jsx-uses-vars`.
- `/* eslint-env */` comments are reported as errors. Remove them and declare globals in the config.
- `jiti` below 2.2.0 is unsupported for TypeScript config files.
- minimatch 10: POSIX character classes such as `[[:upper:]]` work in globs; review patterns containing `[[:`.
- The `stylish` formatter uses Node's `styleText`: `NO_COLOR` and `NODE_DISABLE_COLORS` are honored, `FORCE_COLOR` still forces colors, and `--color` / `--no-color` beat environment variables.
- `radix`: the `"always"` and `"as-needed"` options are deprecated; the rule always requires a radix.
- `no-shadow-restricted-names` reports `globalThis` by default (`reportGlobalThis: false` restores the old behavior).
- `func-names` rejects extra array items; `no-invalid-regexp` `allowConstructorFlags` must not repeat flags.
- `@eslint/js` configs have a `name` property again; upgrade `@eslint/eslintrc` when using `FlatCompat` with `@eslint/js` 10.

For plugins and integrations (a plugin failing on these needs an update):

- Removed `context.getCwd()`, `getFilename()`, `getPhysicalFilename()`, `getSourceCode()`, `context.parserOptions`, `context.parserPath`. Replacements: `context.cwd`, `context.filename`, `context.physicalFilename`, `context.sourceCode`, `context.languageOptions`.
- Removed `SourceCode#getTokenOrCommentBefore()`, `getTokenOrCommentAfter()`, `isSpaceBetweenTokens()`, `getJSDocComment()`; `@eslint/compat` has patches.
- `Program` node ranges cover the whole file, fixer `text` arguments must be strings, `ScopeManager` implementations need `addGlobals()`, `LintMessage#nodeType` is removed, and `RuleTester` is stricter.

## ESLint 9.0.0 (from 8.x)

Codemods: `npx codemod @eslint/v8-to-v9-config` (configuration, including `eslintConfig` in package.json and `.eslintignore`) and `npx codemod @eslint/v8-to-v9-custom-rules` (run it on rule files only).

- Node.js `^18.18.0`, `^20.9.0` or `>=21`.
- Flat config is the default; eslintrc is deprecated (removed in 10).
- Formatters removed from core: `checkstyle`, `compact`, `jslint-xml`, `junit`, `tap`, `unix`, `visualstudio`. Install `eslint-formatter-<name>`.
- Rules `require-jsdoc` and `valid-jsdoc` removed; use `eslint-plugin-jsdoc`.
- `eslint:recommended` adds `no-constant-binary-expression`, `no-empty-static-block`, `no-new-native-nonconstructor`, `no-unused-private-class-members` and drops `no-extra-semi`, `no-inner-declarations`, `no-mixed-spaces-and-tabs`, `no-new-symbol`.
- `--quiet` no longer runs `"warn"` rules; `--output-file` always writes a file; running without patterns lints `.` (`--pass-on-no-patterns` restores exit 0).
- Severity-only `/* eslint */` comments keep config options; repeated comments for one rule are reported; `/* exported */` parsing is stricter.
- `"eslint:recommended"` and `"eslint:all"` strings are rejected in flat config; use `js.configs.recommended` from `@eslint/js`.
- `no-unused-vars` defaults `caughtErrors` to `"all"`, and `varsIgnorePattern` no longer covers catch parameters; add `caughtErrorsIgnorePattern` (quotahit's `^_` setup does).
- Stricter schemas or new defaults: `no-constructor-return`, `no-sequences`, `no-implicit-coercion`, `no-invalid-regexp` (case-sensitive flags), `no-restricted-imports` (repeated `name` entries all apply), `no-inner-declarations` (`blockScopedFunctions`), `no-useless-computed-key` (class members), `camelcase` (`allow` takes strings only).
- Plugin API: `context.getScope()` and similar moved to `sourceCode`, so outdated plugins throw `TypeError: context.getScope is not a function`. Function-style rules and rules with options but no `meta.schema` are rejected.
