Source: https://github.com/prettier/prettier/tree/3.9.10/docs/plugins.md, https://github.com/prettier/prettier/tree/3.9.10/docs/sharing-configurations.md, https://github.com/prettier/prettier/tree/3.9.10/docs/cli.md, https://github.com/prettier/prettier/tree/3.9.10/website/blog, https://github.com/tailwindlabs/prettier-plugin-tailwindcss/blob/v0.8.1/README.md (MIT), condensed.

# Plugins

Plugins add languages or formatting behavior. The core `prettier` package covers JavaScript and other web languages; other languages need a plugin.

## Loading plugins

- Config file (preferred, so editors and CI agree):

  ```json
  { "plugins": ["prettier-plugin-foo"] }
  ```

  ```js
  // prettier.config.mjs
  import * as prettierPluginFoo from 'prettier-plugin-foo';

  /** @type {import("prettier").Config} */
  const config = { plugins: [prettierPluginFoo] };

  export default config;
  ```

- CLI: `prettier --write main.foo --plugin=prettier-plugin-foo` (repeatable).
- API: `await prettier.format(code, { parser: 'foo', plugins: [prettierPluginFoo] })`.

Strings in `plugins` are passed to `import()`, so a package name or a path works (absolute paths since 3.2.0, `URL` objects since 3.6.0). Since 3.0.0 Prettier no longer searches for plugins automatically: every plugin must be listed.

## Official plugins

- `@prettier/plugin-php`, `@prettier/plugin-pug`, `@prettier/plugin-ruby`, `@prettier/plugin-xml` (listed in the docs).
- `@prettier/plugin-oxc` (parsers `oxc` and `oxc-ts`) and `@prettier/plugin-hermes` (parser `hermes`, Flow syntax), announced in 3.6.0, and `@prettier/plugin-yuku` (parsers `yuku` and `yuku-ts`), added in 3.9.6. They are installed separately from `prettier`.

## Community plugins in the docs

Among others: `prettier-plugin-astro`, `prettier-plugin-svelte`, `prettier-plugin-java`, `prettier-plugin-kotlin`, `prettier-plugin-rust`, `prettier-plugin-sh`, `prettier-plugin-sql`, `prettier-plugin-sql-cst`, `prettier-plugin-toml`, `prettier-plugin-prisma`, `prettier-plugin-nginx`, `prettier-plugin-jinja-template`, `prettier-plugin-go-template`, `prettier-plugin-solidity`, `prettier-plugin-properties`. Check the plugin's own docs for options and supported Prettier versions.

## prettier-plugin-tailwindcss

Not listed in the Prettier docs; maintained by Tailwind Labs (https://github.com/tailwindlabs/prettier-plugin-tailwindcss). Facts from its README at v0.8.1:

- Requires Prettier 3 and is ESM-only (since 0.5.x).
- Sorts classes in `class`, `className` and framework equivalents, and in `@apply`.
- Tailwind CSS v4: set `tailwindStylesheet` to the CSS entry point (paths are relative to the Prettier config file). Tailwind CSS v3: it finds `tailwind.config.js` next to the Prettier config, or set `tailwindConfig`.
- It must be the last entry in `plugins` when combined with other plugins (it has explicit compatibility workarounds for a list of them, such as `prettier-plugin-astro` and the sort-imports plugins).

```json
{
  "singleQuote": true,
  "plugins": ["prettier-plugin-tailwindcss"],
  "tailwindStylesheet": "./src/app/globals.css"
}
```

## Cache and versions

`--cache` does not include plugin versions in its key; delete `node_modules/.cache/prettier/.prettier-cache` after updating a plugin. Pin plugin versions like Prettier itself, since plugin releases change output too.

## Plugins in shared configs

A shareable config that uses plugins lists them in its `plugins` array and declares them as `dependencies` (or `peerDependencies`) of the config package.

## Writing plugins

Out of scope here. A plugin exports `languages`, `parsers`, `printers`, `options` and `defaultOptions`; see the upstream plugins page for the API.
