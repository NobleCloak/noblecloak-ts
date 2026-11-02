// Standalone flat config. Rules mirror the workspace posture (no `any`, no unused vars, type-only
// imports, `.js` suffixes on relative imports — Engineering Standards §15) without importing
// a private template config, which the private-dependency guard forbids.
// Test files are linted like every other file.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// A relative specifier must end in an explicit runtime extension.
const RELATIVE_WITHOUT_EXTENSION = String.raw`/^\.{1,2}\/(?!.*\.(?:js|mjs|cjs|json|css)$)/`;
const SUFFIX_MESSAGE =
  'Relative imports must use an explicit .js suffix (Engineering Standards §15).';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/.astro/**',
      '**/storybook-static/**',
      '**/e2e/.build/**',
      '**/next-env.d.ts',
      'artifacts/**',
      // Generated from the module API document (packages/spec/openapi.public.yaml) by packages/client/tools/generate-schema.ts.
      'packages/client/src/schema.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportDeclaration[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
        {
          selector: `ExportNamedDeclaration[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
        {
          selector: `ExportAllDeclaration[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
        {
          selector: `ImportExpression[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  }
);
