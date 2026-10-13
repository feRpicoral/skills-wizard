---
name: prettier-configuration
description: "Use when adding, configuring or debugging Prettier 3 in a repo: .prettierrc and overrides, options such as singleQuote, printWidth or trailingComma, .prettierignore and prettier-ignore comments, plugins like prettier-plugin-tailwindcss, the CLI (--check, --write, --cache), editor format on save, lint-staged and Husky pre-commit hooks, or CI format checks. Also use for indirect asks such as 'format on save fights the linter', 'make ESLint and Prettier stop fighting', 'stop Prettier from reformatting generated files or Markdown tables', 'prettier --check passes locally but fails in CI', formatting churn after an upgrade, or 'set up formatting for this repo', even when the user only says formatting. Applies the user's house style to new setups and matches existing ones. For lint rules and ESLint config structure, use eslint-configuration."
license: MIT
compatibility: Requires Node.js. scripts/check-version.mjs reads the project's package.json and node_modules.
metadata:
  docs-version: '3.9.10'
  docs-source: https://github.com/prettier/prettier/tree/3.9.10/docs
---

# Prettier configuration

Configure Prettier and its integrations. Two kinds of knowledge live here and stay separate:

- What Prettier supports, condensed from the Prettier 3.9.10 docs: the `references/` files except `house-style.md`.
- What this user prefers, verified against their repositories: `references/house-style.md`.

When you explain a change, say which parts Prettier requires and which are the user's preference.

## Start here

1. Run the version check from the project root, or pass the project path:

   ```bash
   node <skill-dir>/scripts/check-version.mjs [projectDir]
   ```

   It prints one sentence and one JSON line. Act on `status`:
   - `match`: use the references as written.
   - `newer`: tell the user the installed Prettier is newer than the 3.9.10 docs this skill was built from. Recommend updating the skill from the docs at the installed version, and read the changelog entries after 3.9.10 before relying on version-specific details. Keep helping with the task.
   - `older`: read [references/version-differences.md](references/version-differences.md) before anything else. Options and flags in the other references may not exist, and output differs between releases.
   - `missing`: Prettier is neither installed nor declared. Treat it as a new setup.
   - `staleInstall: true`: the installed version is below the declared range, a classic cause of "passes locally, fails in CI". Say so and reinstall from the lockfile before comparing output.

2. Inspect the existing setup before editing anything:
   - Config: the `"prettier"` key in `package.json`, `.prettierrc*`, `prettier.config.*`, `.editorconfig`, and nested configs in subdirectories (resolution starts at each formatted file).
   - Ignores: `.prettierignore`, `.gitignore` (Prettier honors it by default), generated or vendored directories.
   - `package.json`: `packageManager`, the `prettier` version and plugins, `scripts`, `lint-staged`.
   - ESLint integration: `eslint-config-prettier`, `eslint-plugin-prettier`, stylistic rules in `eslint.config.*`.
   - Hooks, CI and editor: `.husky/`, `.github/workflows/`, `.vscode/settings.json` and `extensions.json`.
   - Repo instructions: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`.

3. Pick the path:
   - Existing Prettier setup: keep matching it (file name, quote style, `printWidth`, plugins, how ESLint integrates). Change only what the task needs. A repo that already uses `eslint-plugin-prettier` keeps it.
   - No Prettier setup: use the house style in [references/house-style.md](references/house-style.md), not the generic doc defaults.

## Workflow

### New setup (house style)

1. Create `.prettierrc` with `{ "singleQuote": true }` and nothing else unless the repo needs it. Prettier's option philosophy says options are frozen and each one is a debate; do not restate defaults.
2. If the repo uses Tailwind CSS, add `prettier-plugin-tailwindcss` (last in `plugins`); for Tailwind v4 also set `tailwindStylesheet`, as described in house-style.md.
3. Create `.prettierignore` for build output, coverage, generated code and lockfiles that are not already in `.gitignore`.
4. Add scripts `format` and `format:check`, and devDependencies `prettier` (plus the plugin).
5. ESLint integration: add `eslint-plugin-prettier/recommended` (with `eslint-config-prettier`) after the shared configs, and remove stylistic ESLint rules. The eslint-configuration skill covers the config itself. Mention once that Prettier's docs list downsides of running Prettier inside ESLint (editor noise, speed, indirection), and keep it.
6. Hooks: lint-staged plus Husky 9 with the house block (ESLint first, then Prettier) and the `pre-commit` and `commit-msg` hooks. With Yarn, install Husky from `postinstall`; with npm, pnpm or bun, from `prepare`.
7. Where the user's repos disagree (quotes, `printWidth`), follow the target repo if it already decided; otherwise use the newest repos' choice (desvia, quotahit: single quotes, default `printWidth`) and say so.

### Stop Prettier from touching something

Read [references/ignoring.md](references/ignoring.md). Whole files or directories go in `.prettierignore`; parts of a file get a `prettier-ignore` comment in that language's syntax (in Markdown, directly above the table or block). Ignore as narrowly as the request allows: one table, not every Markdown file.

### Make ESLint and Prettier stop fighting

Read [references/linters.md](references/linters.md). Find the conflicting stylistic rules (`npx eslint-config-prettier <file>`), remove them, make sure the Prettier config sits after the shared configs, and make the editor use the project's local Prettier.

### Local and CI output differ

Read [references/precommit-and-ci.md](references/precommit-and-ci.md). Compare versions first (the version check flags stale installs), then config resolution, ignore files and the working directory. Fix the cause; never add the failing files to `.prettierignore`.

### Verify every change

Run the tools and report the exact commands and results:

```bash
npx prettier --check .              # whole repo, honoring .prettierignore and .gitignore
npx prettier --check path/to/file   # a specific file
npx eslint .                        # when ESLint integrates with Prettier
```

Use the repo's runner when that is the convention (`yarn format:check`, `pnpm exec prettier`). If dependencies are missing, install them with the repo's package manager, or report that verification could not run and why. Before `prettier --write .` on an existing repo, check `git status` so formatting changes stay separate from other edits.

## References

Read only what the task needs:

| File                                                        | Read when                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [options.md](references/options.md)                         | Choosing or explaining any option: CLI flag, config key, default, accepted values          |
| [configuration.md](references/configuration.md)             | Config file names and precedence, overrides, EditorConfig, shared configs                  |
| [ignoring.md](references/ignoring.md)                       | `.prettierignore`, default ignores, `.gitignore`, `prettier-ignore` comments per language  |
| [cli.md](references/cli.md)                                 | `--check`, `--write`, `--list-different`, caching, ignore paths, log levels, exit codes    |
| [linters.md](references/linters.md)                         | ESLint or Stylelint integration, eslint-config-prettier, eslint-plugin-prettier trade-offs |
| [plugins.md](references/plugins.md)                         | Loading plugins, official plugins, Tailwind plugin ordering                                |
| [precommit-and-ci.md](references/precommit-and-ci.md)       | lint-staged, Husky, other hook tools, CI checks, version drift between machines            |
| [version-differences.md](references/version-differences.md) | The installed version is not 3.9.10, or you are upgrading                                  |
| [house-style.md](references/house-style.md)                 | New setups, or the user asks for their usual setup                                         |

## Gotchas

- Never put `parser` at the top level of a config; it disables inference for every file. Use it only inside `overrides`.
- `printWidth` is a target, not a hard limit like ESLint's `max-len`. The docs recommend not going above 80.
- Since 3.0, `trailingComma` defaults to `"all"` and plugins are never auto-loaded: list them in `plugins`.
- Prettier honors `./.gitignore` and `./.prettierignore` from the directory it runs in. `--ignore-path` replaces both defaults rather than adding to them.
- Config is resolved from each formatted file's directory upward; there is no global config. `.editorconfig` (`indent_style`, `indent_size`, `max_line_length`, `end_of_line`) applies unless the Prettier config overrides it.
- Markdown range ignores need a blank line before both `<!-- prettier-ignore-start -->` and `<!-- prettier-ignore-end -->`.
- `--cache` keys on the Prettier version, options and Node version, not plugin versions; delete the cache after updating plugins.
- Even patch releases can change output. Running `npx prettier` without a local install downloads the latest version.
- `--config` and `--no-config` together are an error since 3.6.
- TypeScript config files (`prettier.config.ts`) need Node.js 22.6.0 or later, plus `--experimental-strip-types` before Node.js 24.3.0.

## Non-negotiables

- Run the version check first and act on its status.
- Inspect before editing. Match the existing setup and follow the repo's AGENTS.md.
- Never add files to `.prettierignore`, `prettier-ignore` comments or loosen CI checks just to make a failure go away. Ignore only what the user wants left alone, as narrowly as possible.
- Never commit `prettier --write` or `eslint --fix` output wholesale. Review the diff and keep formatting-only changes separate from logic changes.
- Verify by running Prettier, and report the commands and results, or why they could not run.

## Keeping this skill current

- The documented version lives only in `metadata.docs-version` above; `scripts/check-version.mjs` reads it from there.
- To update, fetch each page at the new tag, for example `gh api 'repos/prettier/prettier/contents/docs/options.md?ref=<version>' --jq .content | base64 -d`, compare it with the matching reference, then update the facts, the `Source:` line, `docs-version` and `docs-source`.
- Add each release's option, CLI and output changes to version-differences.md, from `CHANGELOG.md` and the `website/blog/` release posts at the tag.
- Re-check house-style.md against the user's repositories when their setup changes, and keep the repo name next to every pattern.
- Re-run the cases in `evals/evals.json` after editing.
