Source: https://github.com/prettier/prettier/blob/3.9.10/CHANGELOG.md, https://github.com/prettier/prettier/tree/3.9.10/website/blog, https://github.com/prettier/prettier/tree/3.9.10/docs/options.md (MIT), condensed.

# Version differences in Prettier 3.x

Read this when the version check reports `older`, when planning an upgrade, or when output differs between machines. The other references describe 3.9.10.

Every Prettier release can change output, including patch releases. After any upgrade, run `prettier --write .`, review the diff and commit it separately from other changes.

## Options, parsers and CLI features by version

| Feature                                                                                                                                                          | Since |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `trailingComma` default `"all"` (was `"es5"`)                                                                                                                    | 3.0.0 |
| `.gitignore` honored by default                                                                                                                                  | 3.0.0 |
| Plugins must be listed explicitly (plugin search removed)                                                                                                        | 3.0.0 |
| `--log-level` (was `--loglevel`), repeatable `--ignore-path`                                                                                                     | 3.0.0 |
| `experimentalTernaries` / `--experimental-ternaries`                                                                                                             | 3.1.0 |
| Files supported only by plugins are processed by the CLI                                                                                                         | 3.1.0 |
| `jsonc` parser, absolute plugin paths in config                                                                                                                  | 3.2.0 |
| `package.yaml` configuration                                                                                                                                     | 3.3.0 |
| `.jj` (Jujutsu) directories ignored                                                                                                                              | 3.4.0 |
| `objectWrap`, `experimentalOperatorPosition`, TypeScript config files                                                                                            | 3.5.0 |
| `--experimental-cli`, `mjml` parser, `checkIgnorePragma` / `--check-ignore-pragma`, `@prettier/plugin-oxc`, `@prettier/plugin-hermes`, `URL` values in `plugins` | 3.6.0 |
| `--config` together with `--no-config` is an error                                                                                                               | 3.6.0 |
| No `node_modules/.cache` directory created without `--cache`                                                                                                     | 3.7.0 |
| `.git` files (worktrees, submodules) stop the `.editorconfig` search; `--cache-strategy content` fixed                                                           | 3.9.0 |
| Ignored files no longer cached incorrectly                                                                                                                       | 3.9.1 |
| `@prettier/plugin-yuku`                                                                                                                                          | 3.9.6 |

## Output changes worth knowing

- 3.0.0: trailing commas everywhere possible by default (function parameters, calls, type parameters); Flow syntax no longer parsed by the `babel` parser (use `flow` or `babel-flow`); multiple spaces in Markdown inline code preserved; unknown files no longer formatted with `babel`.
- 3.1.0: indentation restored for nested ternaries; Angular control flow syntax supported.
- 3.4.0: a large batch of formatting fixes across JavaScript, TypeScript, CSS, Markdown and YAML. Two that often show up as drift:
  - Markdown unordered lists lost the extra spaces after the marker. With `tabWidth: 4` (common for Markdown), 3.0.x to 3.3.x print `-   item` and 3.4.0 and later print `- item`, so a file formatted by the older version fails `--check` on the newer one.
  - YAML: a key with a trailing comment followed by an indented comment (`workflow_dispatch: # manual` on one line, `# note` below) was printed as `key:# comment` before 3.4.0. That output is invalid for the newer YAML parser, which reports a `SyntaxError`.
- 3.7.0: TypeScript classes and interfaces print consistently (extra indentation of class type parameters removed, heritage clauses and opening braces aligned with classes).
- 3.8.0: Angular template syntax additions.
- 3.9.0: the Markdown parser moved from `remark-parse` v8 to `micromark` v4 (better CommonMark and GFM compliance, setext headings supported) and the YAML parser was upgraded to `yaml` v2. Expect diffs in `.md` and `.yml` files when crossing 3.9.0. The MDX parser was not migrated yet.
- 3.9.x patches: mostly Markdown fixes after the parser change (tables, lists, blockquotes, Liquid syntax), plus TypeScript and Angular fixes. 3.9.10 updated the GFM table extension.

## Working with an older install

- Any 3.x below 3.9.10: options and flags marked later in the table do not exist, and passing them fails or does nothing. Do not add them to the config until the project upgrades.
- Below 3.9.0 (and especially below 3.4.0): Markdown and YAML output differs from 3.9.x, so a teammate or CI on 3.9 sees diffs in `.md` and `.yml` files that the older install calls formatted.
- Below 3.5.0: no `prettier.config.ts` or `.prettierrc.ts`; use `.mjs` or JSON.
- Below 3.0.0 (2.x): `trailingComma` defaulted to `"es5"`, `.gitignore` was not honored, and plugins could be discovered automatically. Upgrading to 3.x changes output and may require listing plugins explicitly.
- When the declared range is newer than the installed version (a stale `node_modules`), reinstall from the lockfile before judging any formatting difference.
