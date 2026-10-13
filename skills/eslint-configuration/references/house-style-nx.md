Source: the user's repository desvia (root and project eslint.config.mjs files, apps/mobile/package.json, nx.json and AGENTS.md read 2026-10-12). Not part of the ESLint docs: these are the user's preferences, not ESLint requirements.

# House style for Nx and Expo (ESLint)

Companion to house-style.md, which has the shared core, the ordering rule and where the repos differ. Use this for Nx workspaces and Expo or React Native apps.

## Nx monorepo

Source: desvia. The root config holds everything shared; each project config spreads it. Nx generates plain arrays, and desvia keeps them.

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

- One `source:<project>` tag per project, set in the project's `package.json` (`"nx": { "tags": ["source:mobile"] }`) and listed in `depConstraints`. desvia's real list also has `source:www` and `source:mapbox-native`.
- The `consistent-type-imports` rule is the new-setup default; desvia itself does not set it.
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

- Run lint through Nx, as desvia's AGENTS.md requires: `npx nx run-many -t lint` or `npx nx affected -t lint`, not `eslint` directly.

Dev dependencies (root): `eslint`, `@nx/eslint`, `@nx/eslint-plugin`, `typescript-eslint`, `jsonc-eslint-parser`, `eslint-plugin-prettier`, `eslint-config-prettier`, `prettier`, `eslint-plugin-simple-import-sort`, `eslint-plugin-unused-imports`.

## Expo / React Native (Nx project)

Source: desvia `apps/mobile`. The React rules come from Nx; the wrapper-component rule lives in the root config.

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
- desvia keeps this rule in the root config so the wrapper components' `eslint-disable` comments still work under lint-staged, which runs ESLint from the repository root. ESLint 9 used one config for every staged file; ESLint 10 looks up the nearest config per file, so after upgrading the rule could move into `apps/mobile/eslint.config.mjs`.
- A standalone Expo app (outside Nx) has no house example. Start from the plain TypeScript variant, ask before adding React-specific plugins, and copy the `no-restricted-imports` block.
