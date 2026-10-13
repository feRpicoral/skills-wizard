Source: https://github.com/prettier/prettier/tree/3.9.10/docs/configuration.md, https://github.com/prettier/prettier/tree/3.9.10/docs/sharing-configurations.md, https://github.com/prettier/prettier/tree/3.9.10/docs/cli.md, https://github.com/prettier/prettier/tree/3.9.10/website/blog (MIT), condensed.

# Configuration

## Where Prettier looks, in order of precedence

1. A `"prettier"` key in `package.json` or `package.yaml`.
2. `.prettierrc`, written in JSON or YAML.
3. `.prettierrc.json`, `.prettierrc.yml`, `.prettierrc.yaml`, `.prettierrc.json5`.
4. `.prettierrc.js`, `prettier.config.js`, `.prettierrc.ts`, `prettier.config.ts`: `export default` or `module.exports`, depending on `type` in `package.json`.
5. `.prettierrc.mjs`, `prettier.config.mjs`, `.prettierrc.mts`, `prettier.config.mts`: `export default`.
6. `.prettierrc.cjs`, `prettier.config.cjs`, `.prettierrc.cts`, `prettier.config.cts`: `module.exports`.
7. `.prettierrc.toml`.

- Resolution starts in the directory of the file being formatted and walks up until a config is found (or none is).
- There is no global or per-user config, by design: results must not depend on the machine.
- Config files accept the same options as the API (options.md).
- TypeScript config files need Node.js 22.6.0 or later, and `--experimental-strip-types` before Node.js 24.3.0: `NODE_OPTIONS="--experimental-strip-types" prettier . --write`.

## Examples

```json
{
  "trailingComma": "es5",
  "tabWidth": 4,
  "semi": false,
  "singleQuote": true
}
```

```js
// prettier.config.mjs
/**
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 */
const config = {
  trailingComma: 'es5',
  tabWidth: 4,
  semi: false,
  singleQuote: true,
};

export default config;
```

```ts
// prettier.config.ts
import { type Config } from 'prettier';

const config: Config = {
  trailingComma: 'none',
};

export default config;
```

```yaml
# .prettierrc (YAML)
trailingComma: 'es5'
tabWidth: 4
semi: false
singleQuote: true
```

TOML (`.prettierrc.toml`) uses `key = value` lines with the same keys.

## Overrides

```json
{
  "semi": false,
  "overrides": [
    {
      "files": "*.test.js",
      "options": { "semi": true }
    },
    {
      "files": ["*.html", "legacy/**/*.js"],
      "excludeFiles": "legacy/vendor/**",
      "options": { "tabWidth": 4 }
    }
  ]
}
```

- `files` is required in each override, as a string or array of strings. `excludeFiles` is optional, also a string or array.
- Overrides can teach Prettier to parse unfamiliar files: `{ "files": "*.js", "options": { "parser": "flow" } }`.
- Never set `parser` at the top level. It disables extension-based inference and forces that parser on every file, such as CSS parsed as JavaScript.

## JSON schema

A schema for validating the config is published at https://www.schemastore.org/prettierrc.json.

## EditorConfig

If the project has `.editorconfig`, Prettier converts its properties to options; anything in the Prettier config overrides them. The search for `.editorconfig` stops at the project root, and since 3.9.0 a `.git` file (Git worktrees and submodules) also marks the root.

| `.editorconfig`                                  | Prettier option                              |
| ------------------------------------------------ | -------------------------------------------- |
| `end_of_line`                                    | `endOfLine`                                  |
| `indent_style`                                   | `useTabs`                                    |
| `indent_size` or `tab_width`                     | `tabWidth`                                   |
| `max_line_length`                                | `printWidth`                                 |
| `charset = utf-8`, `insert_final_newline = true` | Always Prettier's behavior, not configurable |

Prettier does not trim trailing whitespace inside template strings, even if the editor's `trim_trailing_whitespace` would. A copy-ready file matching the defaults:

```ini
[*]
charset = utf-8
insert_final_newline = true
end_of_line = lf
indent_style = space
indent_size = 2
max_line_length = 80
```

`--no-editorconfig` makes the CLI ignore `.editorconfig`.

## Choosing the config file from the CLI

- `--config <path>`: use this file (for example one in `config/`). Since 3.6.0 it cannot be combined with `--no-config`.
- `--no-config`: ignore config files and use defaults.
- `--find-config-path <file>`: print the config file that applies to a file; reuse it with `--config` to skip lookups.
- `--config-precedence`: `cli-override` (default, CLI flags win), `file-override` (config file wins), `prefer-file` (if a config file exists, ignore other CLI options). Meant for editor integrations.

## Shared configurations

A shareable config is an npm package that exports one Prettier config:

```json
{
  "name": "@username/prettier-config",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.js",
  "peerDependencies": { "prettier": ">=3.0.0" }
}
```

```js
// index.js
/** @type {import("prettier").Config} */
const config = { singleQuote: true };

export default config;
```

- Use it from `package.json` (`"prettier": "@username/prettier-config"`) or from `.prettierrc` containing only the string `"@username/prettier-config"`.
- To extend it, spread it in `prettier.config.mjs` and override keys:

```js
import usernamePrettierConfig from '@username/prettier-config';

/** @type {import("prettier").Config} */
const config = { ...usernamePrettierConfig, semi: false };

export default config;
```

- A shared config that uses plugins lists them in `plugins` and declares them as `dependencies` (or `peerDependencies`) of the package.
