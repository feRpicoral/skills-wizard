Source: https://github.com/prettier/prettier/tree/3.9.10/docs/integrating-with-linters.md, https://github.com/prettier/prettier/tree/3.9.10/docs/install.md, https://github.com/prettier/eslint-config-prettier/blob/v10.1.8/README.md, https://github.com/prettier/eslint-plugin-prettier/blob/v5.5.6/README.md (MIT), condensed.

# Integrating with linters

Prettier handles formatting; linters handle code quality. Linters' stylistic rules are unnecessary with Prettier and can conflict with it, so turn them off.

## What the Prettier docs recommend

- ESLint: `eslint-config-prettier`, which turns off every rule that is unnecessary or conflicts with Prettier.
- Stylelint: `stylelint-config-prettier` (named in the install docs).
- Run Prettier itself separately (`prettier --check .` in CI, the editor integration, a pre-commit hook).

Flat config setup from the eslint-config-prettier README, placed after the configs it should override:

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import someConfig from 'some-other-config-you-use';

export default defineConfig([someConfig, eslintConfigPrettier]);
```

- `eslint-config-prettier/flat` adds a `name` to the config object for the config inspector.
- It also turns off rules from `@typescript-eslint/eslint-plugin`, `@stylistic/eslint-plugin`, `eslint-plugin-react`, `eslint-plugin-unicorn`, `eslint-plugin-vue` and a few others, but only under their official plugin names. Renaming a plugin in flat config (`ts: typescriptEslint`) hides its rules from eslint-config-prettier.
- Rules in your own config objects placed after it are not turned off. Run the CLI helper to find them:

```bash
npx eslint-config-prettier src/index.ts
```

Exit codes: `0` no problems, `1` unexpected error, `2` conflicting rules found. Check one file per distinct config (`npx eslint-config-prettier index.js test/index.js`). For flat config the helper imports `eslint/use-at-your-own-risk`, which may break between ESLint releases.

## Running Prettier inside ESLint: eslint-plugin-prettier

The plugin reports Prettier differences as `prettier/prettier` lint errors and fixes them with `eslint --fix`. Its flat config preset:

```js
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  // other configs first
  eslintPluginPrettierRecommended,
];
```

- It enables `prettier/prettier`, turns off `arrow-body-style` and `prefer-arrow-callback` (they produce broken autofixes with this plugin), and enables eslint-config-prettier.
- Put it last so eslint-config-prettier can turn off conflicting rules from earlier configs.
- It installs neither Prettier nor ESLint; install `prettier` and `eslint-config-prettier` yourself.
- Keep Prettier options in `.prettierrc`, not in the rule's options: editor extensions read `.prettierrc` but not ESLint settings.
- When reformatting a large unformatted codebase, the README suggests temporarily disabling `prettier/prettier` and running `eslint --fix` and `prettier --write` separately.

The Prettier docs call these plugins (eslint-plugin-prettier, stylelint-prettier) "generally not recommended" today, listing three downsides: many red squiggly lines in the editor, slower than running Prettier directly, and one more layer where things can break. The user's house style uses eslint-plugin-prettier anyway; keep it and mention the trade-off in one sentence. In a repo that uses only eslint-config-prettier, keep that.

## prettier-eslint and prettier-stylelint

These run Prettier and then `eslint --fix` (or Stylelint) on the result. The docs reserve them for teams that cannot accept some part of Prettier's output, and note that they are much slower than Prettier alone.

## When editor saves and the linter fight

Symptoms: the file changes back and forth on save, ESLint reports formatting errors right after Prettier formatted, or ESLint prints a circular fixes warning.

1. Find conflicting stylistic rules: `npx eslint-config-prettier <file>`.
2. Delete them from the ESLint config (`indent`, `quotes`, `semi`, `comma-dangle` and similar core rules are deprecated formatting rules anyway). Do not keep them and rely on ordering to switch them off.
3. Make sure eslint-config-prettier, or `eslint-plugin-prettier/recommended`, comes after every shared config that enables formatting rules.
4. Install Prettier locally so the editor extension uses the project's version and `.prettierrc`; the install docs warn against editors running a different Prettier than the project.
5. Verify with `npx eslint .` and `npx prettier --check .`.

## lint-staged order

When lint-staged runs both tools, run ESLint before Prettier (install docs). The house block runs `eslint --fix` and then `prettier --write`.
