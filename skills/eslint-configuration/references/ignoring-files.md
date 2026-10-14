Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/ignore.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/configuration-files.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/migration-guide.md (MIT), condensed.

# Ignoring files

Two places define ignores: the config file (`globalIgnores()` or ignores-only objects) and the CLI (`--ignore-pattern`, repeatable, quoted).

## Defaults

- Always ignored: `["**/node_modules/", ".git/"]`. Your patterns are added after these.
- Dotfiles and dot directories (`.foo.js`, `.fixtures/`) are linted unless ignored; `.git` is the only dot directory ignored by default. Add `'**/.*'` to restore the eslintrc behavior of skipping dotfiles.
- `.eslintignore` is not read, and `--ignore-path` does not exist in flat config.

## Global and non-global ignores

| Kind       | How it is written                                                              | Can match directories (`dir/`) | Applies to          |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------ | ------------------- |
| Global     | `globalIgnores([...])`, or an object whose only key is `ignores` (plus `name`) | Yes                            | Every config object |
| Non-global | `ignores` next to `files`, `rules` or other keys                               | No, use `dir/**`               | That object only    |

Prefer `globalIgnores()` so the intent is explicit:

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', '**/generated/'], 'Ignore build output'),
  {
    files: ['src/**/*.js'],
    ignores: ['**/*.config.js'],
    rules: { semi: 'error' },
  },
]);
```

The second argument names the generated config object, which helps debugging.

## Directories

- `globalIgnores(['.config/'])` ignores the `.config` directory next to the config file and stops traversal into it.
- Unlike `.gitignore`, `.config` does not match at every depth. Use `'**/.config/'` to ignore it everywhere.
- Patterns ending in `/` match only directories; patterns without it match files and directories.

## Unignoring

```js
export default defineConfig([
  globalIgnores([
    '!node_modules/', // unignore the directory
    'node_modules/*', // ignore its content
    '!node_modules/mylibrary/', // unignore one package
  ]),
]);
```

- `build/**` ignores the directory and its contents, so traversal skips it and nothing inside can be unignored. Use `build/**/*` to ignore only the contents.
- Everything in `build` except `build/test.js`: `['build/**/*', '!build/test.js']`.
- Everything in `build` except `test.js` at any depth: `['build/**/*', '!build/**/*/', '!build/**/test.js']`.
- Lint only selected default-pattern files: `['**/*.js', '**/*.cjs', '**/*.mjs', '!**/src/**/*.js']`.
- Lint only TypeScript: globally ignore `['**/*.js', '**/*.cjs', '**/*.mjs']` and add an object with `files: ['**/*.ts']`.
- On the CLI: `npx eslint . --ignore-pattern '!node_modules/'`.

## Where patterns resolve

1. `globalIgnores()` in `eslint.config.*`: relative to the config file.
2. `globalIgnores()` in a file passed with `--config`: relative to the working directory.
3. `--ignore-pattern`: relative to the working directory.

ESLint 10 matches globs with minimatch 10, which understands POSIX character classes such as `[[:upper:]]`; check patterns that contain `[[:` sequences.

## Ignored-file warnings

Directories passed to the CLI skip ignored files silently. A file passed explicitly produces:

```text
foo.js
  0:0  warning  File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.
```

lint-staged passes explicit paths, so this appears for staged files that match an ignore. With `--max-warnings 0` the warning fails the hook; add `--no-warn-ignored` instead of removing the ignore. `--no-ignore` disables all ignore patterns.

## .gitignore and other ignore files

ESLint 10.4.0 and later export `includeIgnoreFile()` from `eslint/config`:

```js
// eslint.config.mjs
import { fileURLToPath } from 'node:url';

import { defineConfig, includeIgnoreFile } from 'eslint/config';

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

export default defineConfig([
  includeIgnoreFile(gitignorePath, {
    gitignoreResolution: true,
    name: 'Imported .gitignore patterns',
  }),
  {
    // your config
  },
]);
```

- `{ gitignoreResolution: true }` interprets patterns relative to the ignore file, as git does. Always use it for `.gitignore` files.
- Without it (or with `false`), patterns resolve relative to the ESLint config file; use that for other ignore-pattern files.
- Pass an array of paths to include several files; the helper then returns an array of config objects.
- Before 10.4.0, `includeIgnoreFile(path, 'name')` came from `@eslint/compat`. That helper is deprecated in favor of the `eslint/config` one, which can resolve patterns relative to the ignore file.

## Migrating ignore patterns

`.eslintignore` and `ignorePatterns` become global ignores. `temp.js` in `.eslintignore` matched at any depth; in flat config it matches only next to the config file, so write `**/temp.js`. Directory patterns such as `config/*` keep working relative to the config file.
