Source: https://github.com/prettier/prettier/tree/3.9.10/docs/precommit.md, https://github.com/prettier/prettier/tree/3.9.10/docs/install.md, https://github.com/prettier/prettier/tree/3.9.10/docs/ci.md, https://github.com/prettier/prettier/tree/3.9.10/docs/cli.md, https://github.com/prettier/prettier/tree/3.9.10/docs/options.md, https://github.com/typicode/husky/blob/v9.1.7/docs/how-to.md (MIT), condensed.

# Pre-commit hooks, CI and version drift

## lint-staged with Husky (the docs' first option)

Best when other tools (ESLint, Stylelint) also run on commit, or when partially staged files (`git add --patch`) must work. `npx mrm@2 lint-staged` sets both up automatically; to do it by hand, install `husky` and `lint-staged` as dev dependencies, then:

| Package manager | Setup                                          | `.husky/pre-commit`     |
| --------------- | ---------------------------------------------- | ----------------------- |
| npm             | `npx husky init`                               | `npx lint-staged`       |
| Yarn            | `npx husky init` (Yarn 2+: see the note below) | `yarn lint-staged`      |
| pnpm            | `pnpm exec husky init`                         | `pnpm exec lint-staged` |
| bun             | `bunx husky init`                              | `bunx lint-staged`      |

The docs' minimal lint-staged config:

```json
{
  "lint-staged": {
    "**/*": "prettier --write --ignore-unknown"
  }
}
```

When ESLint also runs, it must run before Prettier (`"*.{ts,tsx,js,jsx,cjs,mjs}": ["eslint --fix", "prettier --write"]`, `"*.{json,md,css,yml,yaml}": ["prettier --write"]`).

Yarn 2 and later do not run the `prepare` lifecycle script, so `husky init` (which writes `"prepare": "husky"`) does not install hooks on `yarn install`. The Husky docs use `"postinstall": "husky"` for Yarn instead (and `pinst` to disable it when publishing the package).

## Other hook options from the docs

- pretty-quick with simple-git-hooks: formats whole changed or staged files (`pretty-quick --staged`).
- Husky.Net: for .NET repos, a task running `npx prettier --ignore-unknown --write ${staged}`.
- git-format-staged: formats partially staged files safely by formatting the staged blobs directly (unstaged changes are never staged or formatted); requires Python. It respects `.prettierignore`.
- A plain `.git/hooks/pre-commit` shell script that runs `prettier --ignore-unknown --write` on staged files and re-adds them. If git still shows the files as modified afterward, add a `post-commit` hook running `git update-index -g`.

## CI

- Install the exact Prettier version from the lockfile (`npm ci`, `yarn install --immutable`, `pnpm install --frozen-lockfile`), then run `npx prettier . --check`. It exits 1 when any file needs formatting.
- A pre-commit hook keeps CI failures for formatting rare.
- Autofix option from the docs: the autofix.ci GitHub App with a workflow that runs `yarn prettier . --write` and then `autofix-ci/action@v1`; it requires a pinned Prettier version in the repository.
- Line endings: with `endOfLine: "lf"` (the default), `--check` in CI, a pre-commit hook and `* text=auto eol=lf` in `.gitattributes`, CRLF cannot creep in. Windows users may need to re-clone after adding `.gitattributes`.

## Why local and CI results differ

Check these in order:

1. Prettier version. The install docs say to install an exact version because even patch releases can change formatting, and `npx prettier` without a local install downloads the latest release. Run the skill's version check (it flags a stale `node_modules` outside the declared range) and compare `npx prettier --version` locally and in the CI log. Minor releases changed output noticeably (3.4.0 changed Markdown list-marker spacing under `tabWidth: 4` from `-   item` to `- item` and fixed YAML comment spacing; 3.9.0 replaced the Markdown parser and upgraded the YAML parser).
2. Install state. A `node_modules` installed before the lockfile changed keeps the old version. Reinstall from the lockfile.
3. Editor integration. The editor extension should use the project's local Prettier; a bundled or global copy formats differently.
4. Config resolution. Run `npx prettier --find-config-path <file>` in both places. A config or `.editorconfig` above the repository (for example in a home directory or a parent of a worktree before 3.9.0) can apply locally but not in CI.
5. Ignore files and working directory. The defaults are `./.gitignore` and `./.prettierignore` relative to where Prettier runs; a different working directory or an untracked local `.prettierignore` changes what is checked.
6. Plugins. Plugin versions are not part of `--cache` keys; clear the cache after updating plugins.

Fix the cause, then run `prettier --write .` with the correct version, review the diff, and commit it on its own. Do not add the failing files to `.prettierignore` or drop the CI check.
