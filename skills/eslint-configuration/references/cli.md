Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/command-line-interface.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/suppressions.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/mcp.md (MIT), condensed.

# CLI for setup, CI and debugging

Run the project's local ESLint: `npx eslint [options] [file|dir|glob]*`, or the repo's equivalent (`yarn eslint`, `pnpm exec eslint`, the `lint` script, an Nx target). With no file arguments ESLint lints `.`. Quote globs (`"lib/**"`) so ESLint expands them instead of the shell. Options that take several values accept repetition or a comma list, except `--ignore-pattern` (repeat it).

## Configuration and debugging

| Flag                                                             | Use                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `-c`, `--config <file>`                                          | Use this config instead of looking up `eslint.config.*`; patterns then resolve relative to the working directory       |
| `--no-config-lookup`                                             | Use no config file (combine with `--rule`, `--ext`)                                                                    |
| `--print-config <file>`                                          | Print the computed config for one file as JSON, without linting. `files`, `ignores` and `name` are not shown           |
| `--inspect-config`                                               | Run `npx @eslint/config-inspector@latest`, an interactive browser UI showing which objects match a file. Does not lint |
| `--debug`                                                        | Debug output; search it for `eslint.config` to see which file loaded                                                   |
| `--env-info`                                                     | Node.js, npm and ESLint versions, for bug reports                                                                      |
| `--flag <name>`                                                  | Enable a feature flag (repeatable). Flags can also come from the `ESLINT_FLAGS` environment variable                   |
| `--ext <ext>`                                                    | Extra extensions to lint, mainly with `--no-config-lookup`; normally add `files` patterns in the config instead        |
| `--global`, `--parser`, `--parser-options`, `--plugin`, `--rule` | One-off overrides; `--rule` merges with config rules unless `--no-config-lookup` is set                                |

## Fixing

- `--fix` writes fixes to the files and reports what remains. It fails with piped stdin and does nothing for processors that do not opt in to autofix.
- `--fix-dry-run` computes fixes without writing; the default formatter does not print them, so use `--format json`. Works with `--stdin`.
- `--fix-type <problem|suggestion|layout|directive>` limits the fixes applied, for example when another tool formats the code.
- Review every `--fix` diff before committing it.

## Ignoring

- `--no-ignore`: disable `ignores` and `--ignore-pattern`.
- `--ignore-pattern <pattern>`: extra ignore, relative to the working directory; quote it.
- `--no-warn-ignored`: silence "File ignored" warnings for explicitly passed files. Pair it with `--max-warnings 0` in lint-staged.
- `--no-error-on-unmatched-pattern`: do not fail when a quoted glob matches nothing.
- `--pass-on-no-patterns`: exit 0 when no patterns are passed instead of linting `.`.

## Warnings, output and CI

- `--quiet`: report errors only; rules set to `"warn"` do not run. With `--max-warnings`, warn rules run but are not reported.
- `--max-warnings <n>`: exit 1 when there are more than `n` warnings. `-1` disables the limit.
- `-f`, `--format <name>`: `stylish` (default), `json`, an npm formatter (`eslint-formatter-<name>`), or a local file.
- `-o`, `--output-file <path>`: write the report to a file (written even when empty).
- `--color` / `--no-color`: force colors on or off. In ESLint 10 these flags beat `NO_COLOR`, `NODE_DISABLE_COLORS` and `FORCE_COLOR`.
- `--exit-on-fatal-error`: exit 2 on parsing errors instead of reporting them as problems.
- `--stats`: add timing statistics to the results (for custom or `json` formatters).

## Inline configuration

- `--no-inline-config`: ignore all configuration comments.
- `--report-unused-disable-directives`: report unused `eslint-disable` and `eslint-enable` comments as errors.
- `--report-unused-disable-directives-severity <off|warn|error>`: same with a chosen severity; only one of the two flags at a time. Default comes from `linterOptions.reportUnusedDisableDirectives` (`"warn"`).
- `--report-unused-inline-configs <off|warn|error>`: report `/* eslint rule: ... */` comments that change nothing. Default from `linterOptions.reportUnusedInlineConfigs` (`"off"`).

## Caching

- `--cache`: lint only changed files, storing state in `.eslintcache`. Running without `--cache` deletes the cache file. Autofixed files are not cached.
- The cache key is the file (contents or metadata) and the configuration. Dependencies between files are not tracked, so type-aware rules (typescript-eslint) and import-resolution rules (`eslint-plugin-import`, `eslint-plugin-import-x`) can report stale results. Run without `--cache` when accuracy matters.
- `--cache-location <path>`: file or directory (end directories with `/`). Replaces the deprecated `--cache-file`.
- `--cache-strategy <metadata|content>`: default `metadata`; `content` suits CI and fresh clones, where git does not preserve modification times.

## Concurrency

`--concurrency <n|auto|off>` sets the number of linting threads. Default `off` (main thread only); `auto` picks a value.

## Bulk suppressions

Use these to enable a rule as `"error"` without fixing every existing violation first. Only `"error"` rules are suppressed.

```bash
npx eslint --fix --suppress-all                          # suppress every remaining error
npx eslint --fix --suppress-rule no-unused-expressions   # one rule (repeatable)
npx eslint --prune-suppressions                          # drop entries that no longer occur
```

- Suppressions go to `eslint-suppressions.json` in the working directory. Commit it so everyone shares it.
- `--suppressions-location <path>` moves the file, and must then be passed on every run.
- When suppressed violations get fixed, ESLint exits with code 2 and prints "There are suppressions left that do not occur anymore. Consider re-running the command with `--prune-suppressions`." Run `--prune-suppressions`, or pass `--pass-on-unpruned-suppressions` to ignore unused entries.
- Run with `--fix` first so fixable violations are fixed rather than suppressed.
- The Node.js API applies existing suppressions with `new ESLint({ applySuppressions: true, suppressionsLocation })`; creating and pruning are CLI-only. `lintText()` needs `filePath` for suppressions to match.

## Other

- `--init` runs `npm init @eslint/config`, a wizard that writes `eslint.config.js` or `.mjs`. For this user, write the house-style config instead.
- `--mcp` starts the ESLint MCP server. Editors usually register it as `npx @eslint/mcp@latest`. With a TypeScript config, install `@eslint/mcp` and `jiti` locally and use `npx @eslint/mcp`, or set `ESLINT_FLAGS=unstable_native_nodejs_ts_config` and `NODE_OPTIONS=--experimental-transform-types` in the server's environment. Yarn Plug'n'Play is not supported; use `nodeLinker: node-modules`.
- `-h`, `--help` and `-v`, `--version` do not lint.

## Exit codes

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| `0`  | No errors, and warnings at or below `--max-warnings` when set                                                     |
| `1`  | At least one error, or more warnings than `--max-warnings` allows                                                 |
| `2`  | Configuration problem or internal error (also unused suppressions, and fatal errors with `--exit-on-fatal-error`) |
