---
title: Linting and Formatting
summary: ESLint flat config, Prettier, import sorting, Husky and commitlint
group: stack
scopes: [project]
defaults: []
---

## Linting and Formatting

- Defer to the repository's existing linter and formatter configuration when present. For new setups, use ESLint flat config (`eslint.config.mjs`) with `typescript-eslint`, `eslint-plugin-prettier/recommended`, `eslint-plugin-simple-import-sort`, and `eslint-plugin-unused-imports` (`^_` prefix for intentionally unused arguments or variables), alongside Prettier (`.prettierrc` with `{ "singleQuote": true }`).
- Enforce pre-commit and commit message checks with Husky, `lint-staged`, and `commitlint` requiring header-only Conventional Commits (`type(scope): description` with a lowercase `scope`).
- Run `yarn lint`, `yarn format:check`, and `yarn typecheck` before finishing changes; never silence lint errors with inline `eslint-disable` comments without a concrete justification.
- Use the `eslint-configuration` and `prettier-configuration` skills when setting up, migrating, or modifying ESLint or Prettier configurations.
