---
name: eslint-configuration
description: "Configures, migrates, upgrades and debugs ESLint in JavaScript and TypeScript repositories. Use when writing eslint.config.js/mjs/ts flat config with defineConfig, adding rules, plugins, parsers, globals or ignores, converting .eslintrc or .eslintignore, upgrading ESLint 8 or 9 to 10, wiring lint into lint-staged, Husky and CI, or answering indirect requests such as 'set up linting for this repo', 'lint errors after upgrading', 'eslint is ignoring my files', 'this rule does not apply', unsorted imports, unused-variable noise, Nx or monorepo lint config, or typescript-eslint questions. Don't use for Prettier options, .prettierignore, or editor format-on-save conflicts alone (use prettier-configuration)."
compatibility: Requires Node.js. scripts/check-version.mjs reads the project's package.json and node_modules.
metadata:
  docs-version: '10.12.0'
  docs-source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src
  package: eslint
  display-name: ESLint
  older-reference: references/version-differences.md
  older-risk: features documented in the other references may not exist
  release-notes: https://github.com/eslint/eslint/releases
  docs-url-template: https://github.com/eslint/eslint/tree/v{version}/docs/src
---

# ESLint configuration

Configure ESLint with flat config. Two kinds of knowledge live here and stay separate:

- What ESLint supports, condensed from the ESLint 10.12.0 docs: the `references/` files except `default-setup.md` and `default-setup-nx.md`.
- The opinionated default this skill uses for new setups: `references/default-setup.md` and `references/default-setup-nx.md`. They are a preference, not an ESLint requirement.

When you explain a change, say which parts ESLint requires and which come from the default setup.

## Start here

1. Run the version check from the project root, or pass the project path:

   ```bash
   node <skill-dir>/scripts/check-version.mjs [projectDir]
   ```

   It prints one sentence and one JSON line. Act on `status`:
   - `match`: use the references as written.
   - `newer`: tell the user the installed ESLint is newer than the 10.12.0 docs this skill was built from. Recommend updating the skill from the docs at the installed version, and read that version's release notes (and migration guide if the major changed) before relying on version-specific details. Keep helping with the task.
   - `older`: read [references/version-differences.md](references/version-differences.md) before anything else. Features in the other references, such as `defineConfig`, `basePath` or bulk suppressions, may not exist in the installed version.
   - `declared`: ESLint is declared in `package.json` with an uncomparable range (`catalog:`, `workspace:*`, `latest`) and not installed. Install dependencies first and re-run the check; do not treat it as a new setup.
   - `missing`: ESLint is neither installed nor declared. Treat it as a new setup.
   - `staleInstall: true` or "declared but not installed": say so. Lint results are not trustworthy until dependencies are installed from the lockfile.

2. Inspect the existing setup before editing anything:
   - Config: `eslint.config.{js,mjs,cjs,ts,mts,cts}` at the root and in subdirectories (ESLint 10 looks up the config from each file's directory), plus legacy `.eslintrc*`, `.eslintignore` and an `eslintConfig` key in `package.json`.
   - `package.json`: `type`, `packageManager`, `engines`, ESLint-related dependencies and versions, `scripts`, `lint-staged`.
   - Hooks and CI: `.husky/`, lint-staged config files, `.github/workflows/`.
   - Editor: `.vscode/settings.json` and `extensions.json` (format on save, `source.fixAll.eslint`).
   - Prettier: `.prettierrc*`, `.prettierignore` (the prettier-configuration skill covers these).
   - Repo instructions: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`. Follow them, for example running lint through `nx` when the repo says so.

3. Pick the path:
   - Existing flat config: keep matching it (file name, `defineConfig` or plain array, plugins, quote style, unused-variable approach). Change only what the task needs.
   - No ESLint setup: use the default setup in [references/default-setup.md](references/default-setup.md), not the generic doc defaults.
   - Legacy eslintrc: follow [references/migration-from-eslintrc.md](references/migration-from-eslintrc.md). Keep the existing rules; do not add plugins from the default setup during a migration unless asked.

## Workflow

### New setup (default setup)

1. Pick the variant: plain TypeScript/Node or Next.js in [references/default-setup.md](references/default-setup.md), Nx monorepo or Expo/React Native in [references/default-setup-nx.md](references/default-setup-nx.md).
2. Write `eslint.config.mjs`. Use `defineConfig` and `globalIgnores` from `eslint/config`, except in Nx workspaces, which keep the plain array Nx generates.
3. Order the array: shared configs (framework, typescript-eslint), then `eslint-plugin-prettier/recommended`, then the rules object, then global ignores. Nothing after the Prettier config may enable formatting rules.
4. Rules: `simple-import-sort/imports` and `simple-import-sort/exports` as `"error"`, unused variables ignored when prefixed with `_` (`^_`), and type-only imports through `@typescript-eslint/consistent-type-imports`.
5. Where a repo already made a different choice (the typescript-eslint unused-variable rule instead of eslint-plugin-unused-imports, quote style, `printWidth`), keep it. Otherwise use the default and tell the user which choice you made.
6. Add Prettier (`.prettierrc` with `{ "singleQuote": true }` and `.prettierignore`), `lint`/`lint:fix`/`format`/`format:check` scripts, `lint-staged` (`"*.{ts,tsx,js,jsx,cjs,mjs}": ["eslint --fix", "prettier --write"]`, `"*.{json,md,css,yml,yaml}": ["prettier --write"]`), and Husky (`.husky/pre-commit` running `yarn lint-staged`, wired via `"postinstall": "husky"` on Yarn or `"prepare": "husky"` on npm/pnpm/bun) as listed in [references/default-setup.md](references/default-setup.md).
7. Install the latest stable release of each package that fits the `peerDependencies` of the rest, as described in [references/default-setup.md](references/default-setup.md#compatibility-with-the-latest-versions). Today that means TypeScript 6.0.x (typescript-eslint does not support TypeScript 7), and ESLint 9 instead of 10 only when a plugin does not accept ESLint 10 yet. Say which packages you held back and why.
8. Mention the eslint-plugin-prettier trade-off in one sentence (Prettier's docs list editor noise, speed and an extra layer of indirection) and keep the plugin.

### Change an existing setup

- Read the computed config first: `npx eslint --print-config <file>`. Find which object sets what before adding another.
- Put file-specific behavior in a new object with `files`, after the general objects. Later objects override earlier ones.
- Generated, vendored or build output: global ignores (`globalIgnores([...])`), never `eslint-disable` comments.
- A new rule with many existing violations: enable it as `"error"`, run `--fix`, review, then use bulk suppressions for the rest (see [references/cli.md](references/cli.md)) instead of downgrading it.

### Upgrade ESLint 9 to 10

Read the 10.0.0 section of version-differences.md. Check Node (`^20.19.0 || ^22.13.0 || >=24`), remove eslintrc leftovers and `/* eslint-env */` comments, expect new `eslint:recommended` errors, review nested configs (per-file lookup), and update `jiti` to 2.2.0 or later for TypeScript config files. `npx codemod @eslint/v9-to-v10` is a starting point; review its diff. Check every plugin's peer range before bumping.

### Debug

Read [references/troubleshooting.md](references/troubleshooting.md). The usual order: `--print-config <file>` for the computed config, `--debug` to see which config file loaded, `--inspect-config` for matching objects (it starts an interactive browser UI, so ask before using it in an agent session).

### Verify every change

Run the tools and report the exact commands and results:

```bash
npx eslint .                       # or the repo's lint script or nx target
npx eslint --print-config <file>   # computed config for a representative file
npx prettier --check .             # when Prettier is part of the setup
```

Use the repo's runner when that is the convention (`yarn lint`, `pnpm exec eslint`, `nx run-many -t lint`). If dependencies are missing, install them with the repo's package manager, or report that verification could not run and why.

## References

Read only what the task needs:

| File                                                                    | Read when                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [configuration-files.md](references/configuration-files.md)             | Writing or reading any config: file names, lookup, config objects, files, ignores, basePath, defineConfig, extends, cascade |
| [rules-and-inline-config.md](references/rules-and-inline-config.md)     | Rule severities and options, inline comments, disable directives, linterOptions                                             |
| [plugins-parsers-languages.md](references/plugins-parsers-languages.md) | Plugins, processors, languages, parsers, languageOptions, globals, TypeScript                                               |
| [ignoring-files.md](references/ignoring-files.md)                       | Global and non-global ignores, .gitignore import, unignoring, ignored-file warnings                                         |
| [cli.md](references/cli.md)                                             | Flags for fixing, CI, caching, debugging, concurrency, feature flags, bulk suppressions, exit codes                         |
| [version-differences.md](references/version-differences.md)             | The installed version is not 10.12.0, or you are upgrading                                                                  |
| [migration-from-eslintrc.md](references/migration-from-eslintrc.md)     | `.eslintrc*`, `.eslintignore`, `eslintConfig` in package.json, FlatCompat                                                   |
| [troubleshooting.md](references/troubleshooting.md)                     | Error messages, files not linted, rules not applied, circular fixes, editor fights                                          |
| [default-setup.md](references/default-setup.md)                         | New setups: shared core, plain TypeScript/Node and Next.js variants, compatibility with the latest versions                 |
| [default-setup-nx.md](references/default-setup-nx.md)                   | New Nx monorepo or Expo/React Native setups                                                                                 |

## Gotchas

- Flat config reads only `eslint.config.*`. `env`, top-level `globals`, `overrides`, `ignorePatterns`, `root`, `.eslintignore` and `eslintConfig` in package.json are unsupported, and ESLint 10 reports `/* eslint-env */` comments as errors.
- `extends` only works inside `defineConfig()` (ESLint 9.22.0 or later). A plain array with `extends` fails with "A config object is using the "extends" key, which is not supported in flat config system". Pair every `extends` with `files`.
- ESLint lints `**/*.js`, `**/*.cjs` and `**/*.mjs` by default. Other extensions need a `files` pattern such as `**/*.ts`, and objects without `files` then apply to those files too.
- Patterns are relative to the config file, or to the working directory when `--config` is used. In legacy eslintrc, slash-less patterns in `.eslintignore`/`ignorePatterns` and `overrides[].files` (`matchBase: true`) matched at any depth (`temp.js` or `*.config.js`); in flat config, prepend `**/` (`**/temp.js`, `**/*.config.js`) unless the old pattern started with `./`.
- `ignores` is global only when it is the only key besides `name`; prefer `globalIgnores()`. Non-global ignores match files only, so `dir/` does nothing there; use `dir/**`.
- `build/**` stops traversal, so nothing inside can be unignored; use `build/**/*` plus `!` patterns.
- ESLint 10 finds the config by walking up from each linted file, so a nested `eslint.config.*` wins for its subtree. ESLint 9 used the working directory unless a flag was set.
- `--quiet` does not run `"warn"` rules. `--cache` can report stale results for type-aware and import-resolution rules.
- Passing an ignored file explicitly, as lint-staged does, prints "File ignored because of a matching ignore pattern"; add `--no-warn-ignored` when the command also uses `--max-warnings 0`.
- `eslint.config.ts` needs `jiti` 2.2.0 or later on Node, or Node 22.13.0 or later with `--experimental-strip-types` and `--flag unstable_native_nodejs_ts_config`.
- typescript-eslint does not work with TypeScript 7 (no compiler API; peer range `<6.1.0`), and `npm i -D typescript` now installs 7.x. Install `typescript@~6.0` in repos that lint TypeScript.
- `includeIgnoreFile()` comes from `eslint/config` since 10.4.0; pass `{ gitignoreResolution: true }` for `.gitignore`. Older installs use the deprecated helper from `@eslint/compat`.

## Non-negotiables

- Run the version check first and act on its status.
- Inspect before editing. Match the existing setup and follow the repo's AGENTS.md.
- Never weaken rules (downgrading to `"warn"`, turning them off, raising `--max-warnings`), add ignores or add `eslint-disable` comments just to make errors go away. Fix the code, scope the rule with `files`, or ask the user.
- Never commit `--fix` output wholesale. Review the diff and keep unrelated changes out.
- Verify by running ESLint, and report the commands and results, or why they could not run.

## Keeping this skill current

- The documented version lives only in `metadata.docs-version` above; `scripts/check-version.mjs` reads it from there.
- To update, fetch each page at the new tag, for example `gh api 'repos/eslint/eslint/contents/docs/src/use/configure/configuration-files.md?ref=v<version>' --jq .content | base64 -d`, compare it with the matching reference, then update the facts, the `Source:` line, `docs-version` and `docs-source`.
- Add each new release's configuration-relevant changes to version-differences.md, from `docs/src/use/migrate-to-<major>.0.0.md` and `CHANGELOG.md` at the tag.
- Re-check the compatibility section of default-setup.md against each package's latest release and `peerDependencies` when updating the skill.
- Re-run the cases in `evals/evals.json` after editing.
