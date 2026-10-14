import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: globals.browser },
  },
  ...tseslint.configs.recommended,
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      quotes: ['error', 'double'],
      semi: ['error', 'always'],
      indent: ['error', 4],
      'comma-dangle': ['error', 'never'],
    },
  },
  globalIgnores(['dist/**']),
]);
