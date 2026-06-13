import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Lint-only, type-aware. Scoped to src/ for now — tests are excluded from
// tsconfig.json, so type-checked linting can't see them yet. Formatting is
// intentionally left to the editor; this config does not format code.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'tests/**', '*.config.*', 'fix-tests.cjs'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      // projectService wires up the TypeScript language service so type-aware
      // rules (no-floating-promises, no-misused-promises) work without
      // hand-listing tsconfig paths.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The rules that justify type-aware linting for an async, state-syncing
      // CLI: a forgotten await on an API call or a state write is a silent,
      // dangerous bug. Promote these to errors.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Allow underscore-prefixed unused args/vars — used for parameters kept
      // for signature consistency but not currently read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Command run* functions are async by convention (matches the commander
      // `.action(async (options) => ...)` call pattern and lets `expect(runX()).rejects`
      // catch synchronous UserError throws as a rejected promise). Some have no
      // internal await yet — that's fine, not a bug.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
