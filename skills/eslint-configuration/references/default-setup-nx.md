Not part of the ESLint docs: this is the skill's opinionated default for new setups, not an ESLint requirement. Package compatibility notes are in default-setup.md.

# Default setup for Nx and Expo (ESLint)

Use this for Nx workspaces and Expo or React Native apps. Shared core rules: `eslint-plugin-prettier/recommended` after shared configs, `simple-import-sort/imports` and `simple-import-sort/exports` as `"error"`, `eslint-plugin-unused-imports` with `^_` ignore patterns, and `@typescript-eslint/consistent-type-imports` with `inline-type-imports`.

## Nx monorepo

The root config holds everything shared; each project config spreads it. Nx generates plain arrays; keep them.

```js
// eslint.config.mjs (workspace root)
import nx from '@nx/eslint-plugin';
import prettier from 'eslint-plugin-prettier/recommended';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  prettier,
  {
    ignores: ['**/dist', '**/out-tsc', '**/generated'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: 'source:api',
              onlyDependOnLibsWithTags: ['source:api', 'source:shared'],
            },
            {
              sourceTag: 'source:mobile',
              onlyDependOnLibsWithTags: ['source:mobile', 'source:shared'],
            },
            {
              sourceTag: 'source:shared',
              onlyDependOnLibsWithTags: ['source:shared'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
];
```

- One `source:<project>` tag per project, set in the project's `package.json` (`"nx": { "tags": ["source:mobile"] }`) and listed in `depConstraints`. Adjust the tags to the workspace's real projects.
- Project configs:

```js
// apps/api/eslint.config.mjs
import baseConfig from '../../eslint.config.mjs';

export default [...baseConfig];
```

```js
// libs/shared/eslint.config.mjs
import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
```

- Run lint through Nx: `npx nx run-many -t lint` or `npx nx affected -t lint`, not `eslint` directly, so Nx caching and project graphs apply. Follow the workspace's AGENTS.md if it says otherwise.

Dev dependencies (root): `eslint`, `@nx/eslint`, `@nx/eslint-plugin`, `typescript-eslint`, `jsonc-eslint-parser`, `eslint-plugin-prettier`, `eslint-config-prettier`, `prettier`, `eslint-plugin-simple-import-sort`, `eslint-plugin-unused-imports`.

## Expo / React Native (Nx project)

The React rules come from Nx; the wrapper-component rule lives in the root config.

```js
// apps/mobile/eslint.config.mjs
import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    ignores: ['.expo', 'web-build', 'cache', 'dist', '**/out-tsc'],
  },
];
```

Forcing the app's wrapper components, added to the root object that has `files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']`:

```js
'no-restricted-imports': [
  'error',
  {
    paths: [
      {
        name: 'react-native',
        importNames: ['Text', 'Button'],
        message:
          'Use the matching component from apps/mobile/src/app/components instead.',
      },
      {
        name: 'react-native',
        importNames: ['Image'],
        message: "Import from 'expo-image' instead.",
      },
      {
        name: 'react-native',
        importNames: ['SafeAreaView'],
        message:
          'Use the Screen component from apps/mobile/src/app/components instead.',
      },
    ],
  },
],
```

- Several entries with the same `name` all apply (ESLint 9 and later), so each import can get its own message.
- On ESLint 9, keep this rule in the root config so the wrapper components' `eslint-disable` comments still work under lint-staged, which runs ESLint from the repository root with one config for every staged file. ESLint 10 looks up the nearest config per file, so there the rule can live in `apps/mobile/eslint.config.mjs`.
- For a standalone Expo app (outside Nx), start from the plain TypeScript variant, ask before adding React-specific plugins, and copy the `no-restricted-imports` block.
