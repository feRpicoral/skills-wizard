Source: https://github.com/prettier/prettier/tree/3.9.10/docs/cli.md, https://github.com/prettier/prettier/tree/3.9.10/docs/install.md, https://github.com/prettier/prettier/tree/3.9.10/website/blog (MIT), condensed.

# CLI

```bash
prettier [options] [file/dir/glob ...]
```

Run the project's local Prettier: `npx prettier`, `yarn exec prettier`, `pnpm exec prettier`, `bunx prettier` or `deno x prettier`. Without a local install, `npx` downloads the latest Prettier, which formats differently from the version the project pins.

## Everyday commands

```bash
prettier . --write           # format in place (alias -w); comparable to eslint --fix
prettier . --check           # report unformatted files (alias -c); exit 1 if any
prettier . --list-different  # print only the names of unformatted files (alias -l)
```

- `--check` prints `Checking formatting...` and either `All matched files use Prettier code style!` or one `[warn] <file>` line per file plus `[warn] Code style issues found in N files. Run Prettier with --write to fix.`
- Use `--list-different` when piping file names to another command.
- Quote globs (`"app/**/*.js"`) so Prettier expands them the same way on every platform.
- Put options in a config file rather than passing `--single-quote` and similar flags.

## How paths are resolved

1. An existing file is used as is.
2. An existing directory is searched recursively for files Prettier or its plugins support (by extension and well-known file names).
3. Anything else is a glob, using fast-glob syntax.

Files in `node_modules` are skipped (`--with-node-modules` includes them), symbolic links are not followed, and special characters are escaped as `[[]my-dir]/*.js` (the `\[` form does not work on Windows).

## Exit codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| `0`  | Everything formatted properly        |
| `1`  | Something was not formatted properly |
| `2`  | Something is wrong with Prettier     |

## Flags

| Flag                                                             | Purpose                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--debug-check`                                                  | Report when formatting might change code correctness. Cannot be combined with `--write`      |
| `--config <path>`                                                | Use this config file. Cannot be combined with `--no-config` since 3.6.0                      |
| `--no-config`                                                    | Ignore config files; use defaults                                                            |
| `--find-config-path <file>`                                      | Print the config file that applies to a file                                                 |
| `--config-precedence <cli-override\|file-override\|prefer-file>` | How CLI options and the config file combine (default `cli-override`)                         |
| `--no-editorconfig`                                              | Ignore `.editorconfig`                                                                       |
| `--ignore-path <file>`                                           | Ignore file to use, repeatable. Replaces the defaults `./.gitignore` and `./.prettierignore` |
| `--with-node-modules`                                            | Also format files in `node_modules`                                                          |
| `--ignore-unknown`, `-u`                                         | Skip files whose type Prettier does not know (for `"**/*"` patterns and lint-staged)         |
| `--no-error-on-unmatched-pattern`                                | Do not fail when a pattern matches nothing                                                   |
| `--log-level <error\|warn\|log\|debug\|silent>`                  | Logging level, default `log`. Renamed from `--loglevel` in 3.0                               |
| `--stdin-filepath <path>`                                        | Format stdin as if it were this file: `cat abc.css \| prettier --stdin-filepath abc.css`     |
| `--plugin <name>`                                                | Load a plugin, repeatable                                                                    |

Every formatting option also has a flag (options.md).

## Cache

```bash
prettier . --write --cache
prettier . --write --cache --cache-location=path/to/cache-file
prettier . --write --cache --cache-strategy metadata
```

- A file is reformatted only when one of these changes: the Prettier version, the options, the Node.js version, or the file (its content with `content`, its metadata such as timestamps with `metadata`).
- Default strategy: `content`. `metadata` is faster; `content` survives operations such as `git clone` that reset modification times.
- Default location: `./node_modules/.cache/prettier/.prettier-cache`. Running without `--cache` deletes it.
- Plugin versions are not part of the cache key; delete the cache after updating plugins.
- Fixed in recent releases: `--cache-strategy content` only compared file sizes before 3.9.0, and ignored files could be cached incorrectly before 3.9.1.

## Experimental CLI

Since 3.6.0 a faster, rewritten CLI can be tried with `--experimental-cli` or `PRETTIER_EXPERIMENTAL_CLI=1` (it was updated again in 3.9.0). The CLI docs page does not cover it; treat it as experimental and compare its results with the default CLI before relying on it in CI.
