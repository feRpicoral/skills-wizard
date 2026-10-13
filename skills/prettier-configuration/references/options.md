Source: https://github.com/prettier/prettier/tree/3.9.10/docs/options.md, https://github.com/prettier/prettier/tree/3.9.10/docs/option-philosophy.md, https://github.com/prettier/prettier/tree/3.9.10/website/blog (MIT), condensed.

# Options

Set options in a configuration file (configuration.md), not as CLI flags, so the CLI, editors and other tools agree.

## All options

| Option                           | Config key                     | CLI flag                                              | Default         | Values                                      |
| -------------------------------- | ------------------------------ | ----------------------------------------------------- | --------------- | ------------------------------------------- |
| Experimental Ternaries           | `experimentalTernaries`        | `--experimental-ternaries`                            | `false`         | `true`, `false`                             |
| Experimental Operator Position   | `experimentalOperatorPosition` | `--experimental-operator-position <start\|end>`       | `"end"`         | `"start"`, `"end"`                          |
| Print Width                      | `printWidth`                   | `--print-width <int>`                                 | `80`            | integer                                     |
| Tab Width                        | `tabWidth`                     | `--tab-width <int>`                                   | `2`             | integer                                     |
| Tabs                             | `useTabs`                      | `--use-tabs`                                          | `false`         | `true`, `false`                             |
| Semicolons                       | `semi`                         | `--no-semi`                                           | `true`          | `true`, `false`                             |
| Quotes                           | `singleQuote`                  | `--single-quote`                                      | `false`         | `true`, `false`                             |
| Quote Props                      | `quoteProps`                   | `--quote-props <as-needed\|consistent\|preserve>`     | `"as-needed"`   | `"as-needed"`, `"consistent"`, `"preserve"` |
| JSX Quotes                       | `jsxSingleQuote`               | `--jsx-single-quote`                                  | `false`         | `true`, `false`                             |
| Trailing Commas                  | `trailingComma`                | `--trailing-comma <all\|es5\|none>`                   | `"all"`         | `"all"`, `"es5"`, `"none"`                  |
| Bracket Spacing                  | `bracketSpacing`               | `--no-bracket-spacing`                                | `true`          | `true`, `false`                             |
| Object Wrap                      | `objectWrap`                   | `--object-wrap <preserve\|collapse>`                  | `"preserve"`    | `"preserve"`, `"collapse"`                  |
| Bracket Line                     | `bracketSameLine`              | `--bracket-same-line`                                 | `false`         | `true`, `false`                             |
| JSX Brackets (deprecated)        | `jsxBracketSameLine`           | `--jsx-bracket-same-line`                             | `false`         | `true`, `false`                             |
| Arrow Function Parentheses       | `arrowParens`                  | `--arrow-parens <always\|avoid>`                      | `"always"`      | `"always"`, `"avoid"`                       |
| Range                            | `rangeStart`, `rangeEnd`       | `--range-start <int>`, `--range-end <int>`            | `0`, `Infinity` | character offsets                           |
| Parser                           | `parser`                       | `--parser <string>`                                   | none (inferred) | see Parser below                            |
| File Path                        | `filepath`                     | `--stdin-filepath <string>`                           | none            | path                                        |
| Require Pragma                   | `requirePragma`                | `--require-pragma`                                    | `false`         | `true`, `false`                             |
| Insert Pragma                    | `insertPragma`                 | `--insert-pragma`                                     | `false`         | `true`, `false`                             |
| Check Ignore Pragma              | `checkIgnorePragma`            | `--check-ignore-pragma`                               | `false`         | `true`, `false`                             |
| Prose Wrap                       | `proseWrap`                    | `--prose-wrap <always\|never\|preserve>`              | `"preserve"`    | `"always"`, `"never"`, `"preserve"`         |
| HTML Whitespace Sensitivity      | `htmlWhitespaceSensitivity`    | `--html-whitespace-sensitivity <css\|strict\|ignore>` | `"css"`         | `"css"`, `"strict"`, `"ignore"`             |
| Vue script and style indentation | `vueIndentScriptAndStyle`      | `--vue-indent-script-and-style`                       | `false`         | `true`, `false`                             |
| End of Line                      | `endOfLine`                    | `--end-of-line <lf\|crlf\|cr\|auto>`                  | `"lf"`          | `"lf"`, `"crlf"`, `"cr"`, `"auto"`          |
| Embedded Language Formatting     | `embeddedLanguageFormatting`   | `--embedded-language-formatting=<off\|auto>`          | `"auto"`        | `"auto"`, `"off"`                           |
| Single Attribute Per Line        | `singleAttributePerLine`       | `--single-attribute-per-line`                         | `false`         | `true`, `false`                             |

`plugins` and `overrides` are configuration keys too; see plugins.md and configuration.md.

## Notes per option

- Experimental Ternaries (3.1.0+): `true` puts the `?` after the condition ("curious ternaries"); `false` keeps the question mark on the line of the consequent.
- Experimental Operator Position (3.5.0+): `"start"` prints operators at the start of new lines when binary expressions wrap; `"end"` keeps them at the end of the previous line.
- Print Width: how long lines should roughly be, not a hard maximum. Prettier makes both shorter and longer lines. The docs recommend against more than 80 for readability and warn not to treat it like ESLint's `max-len`. `.editorconfig` `max_line_length` sets it unless overridden. To stop wrapping Markdown prose, use Prose Wrap instead.
- Tab Width: `.editorconfig` `indent_size` or `tab_width` sets it unless overridden.
- Tabs: tabs indent, spaces still align (for example in ternaries). `.editorconfig` `indent_style` sets it.
- Semicolons: `false` adds semicolons only at the start of lines that could break through automatic semicolon insertion.
- Quotes: JSX ignores `singleQuote` (use `jsxSingleQuote`). Prettier picks the other quote when it means fewer escapes: `"I'm double quoted"` stays double.
- Quote Props: `"as-needed"` quotes only where required, `"consistent"` quotes all keys of an object if one needs it, `"preserve"` keeps the input. Numeric keys are never unquoted in Angular expressions, TypeScript, Flow or Vue.
- Trailing Commas: default changed from `"es5"` to `"all"` in 3.0.0. `"all"` adds commas wherever possible, including function parameters and calls (needs ES2017 engines or transpiling) and TypeScript type parameters. `"es5"` covers objects and arrays plus type parameters in TypeScript and Flow. Single-line structures never get trailing commas.
- Object Wrap (3.5.0+): `"preserve"` keeps an object multi-line when there is a newline between `{` and the first key; `"collapse"` fits it on one line when possible.
- Bracket Line: puts the `>` of a multi-line HTML, JSX, Vue or Angular element at the end of the last line (not for self-closing elements). JSX Brackets is the deprecated (2.4.0) JSX-only form; use Bracket Line.
- Arrow Function Parentheses: default changed from `"avoid"` to `"always"` in 2.0.0. The docs prefer `"always"` because removing parentheses makes later edits (types, extra arguments, defaults) harder.
- Range: formats from the start of the line containing `rangeStart` to the end of the statement at `rangeEnd`.
- Parser: inferred from the file path, so you rarely need it. Never set it at the top level of a config, only inside `overrides`; otherwise every file type is parsed with it. Values: `babel`, `babel-flow`, `babel-ts`, `flow`, `typescript`, `espree`, `meriyah`, `acorn`, `css`, `scss`, `less`, `json`, `json5`, `jsonc` (3.2.0+), `json-stringify`, `graphql`, `markdown`, `mdx`, `html`, `vue`, `angular`, `lwc`, `mjml` (3.6.0+), `yaml`. The custom parser API was removed in 3.0.0; use plugins.
- File Path: tells the CLI or API which file name to infer the parser from (`cat foo | prettier --stdin-filepath foo.css`). Not useful in a config file.
- Require Pragma: only format files whose first comment is a docblock with `@prettier` or `@format`. Useful when adopting Prettier gradually.
- Insert Pragma: add `@format` to formatted files. When combined with Require Pragma, Require Pragma wins and Insert Pragma is ignored.
- Check Ignore Pragma (3.6.0+): skip files whose first comment is a docblock with `@noprettier` or `@noformat`. Off by default because the check has a small cost.
- Prose Wrap: default `"preserve"` because some renderers (GitHub comments, Bitbucket) are line-break sensitive. `"always"` wraps at `printWidth`; `"never"` puts each prose block on one line.
- HTML Whitespace Sensitivity (HTML, Vue, Angular, Handlebars): `"css"` follows each element's CSS `display` default (Handlebars treats it as `strict`), `"strict"` treats all whitespace around tags as significant, `"ignore"` treats it as insignificant.
- End of Line: default `lf` since 2.0.0. To keep a repo LF-only: keep `endOfLine: "lf"`, run Prettier in a pre-commit hook and with `--check` in CI, and add `* text=auto eol=lf` to `.gitattributes`. `"auto"` keeps existing line endings. `.editorconfig` `end_of_line` sets it.
- Embedded Language Formatting: `"auto"` formats code Prettier recognizes inside other files (tagged templates such as `html`, code blocks in Markdown); `"off"` never does.
- Single Attribute Per Line: one attribute per line in HTML, Vue and JSX.

## Option philosophy

- Prettier has options for historical reasons and will not add more; option requests are closed without discussion, including requests to preserve input formatting.
- Options that are easier to justify: `trailingComma: "es5"` (no transpiling), `proseWrap` (Markdown renderers), `htmlWhitespaceSensitivity` (HTML whitespace rules), `endOfLine` (keeping CRLF out of git), `quoteProps` (Google Closure Compiler).
- Options the docs call hard to justify and a source of bike-shedding: `arrowParens`, `jsxSingleQuote`, `bracketSameLine`, `bracketSpacing`.
- In practice: set only options the project needs, and do not restate defaults.
