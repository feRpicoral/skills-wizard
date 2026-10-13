---
title: Linting and Formatting
summary: ESLint flat config, Prettier, import sorting, Husky and commitlint
group: stack
scopes: [project]
defaults: []
---

## Linting and Formatting

- Use ESLint flat config (`eslint.config.mjs`) with Prettier (`.prettierrc` set to `{ "singleQuote": true }`), `eslint-plugin-simple-import-sort`, and `eslint-plugin-unused-imports` (`^_` prefix for intentionally unused arguments or variables).
- Enforce pre-commit checks with Husky, `lint-staged`, and commitlint (`type(scope): description` with a required lowercase `scope`).
- Run `yarn lint`, `yarn format:check` (or `prettier --check`), and `yarn typecheck` before finishing changes; never silence lint errors with inline `eslint-disable` comments without a concrete justification.
- Delegate full ESLint or Prettier setup and migrations to the `eslint-configuration` and `prettier-configuration` skills.
