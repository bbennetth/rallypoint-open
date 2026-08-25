// Flat-config ESLint (v9+). Single config for the whole monorepo —
// per-package rules can override if needed but the baseline is
// strict TS + import hygiene + zero warnings allowed in CI.

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import prettierConfig from 'eslint-config-prettier'
import staleAsyncPlugin from './tools/eslint/no-stale-async-setstate.js'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      'db/migrations/**',
      // Agent worktrees are sandboxed branches — lint runs on the main checkout only.
      '.claude/worktrees/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
    },
  },
  {
    // Components stay mounted while a useParams() id / prop changes, so an async
    // load that commits without a staleness guard can show entity A while writes
    // target B (see tools/eslint/stale-async-core.js). Flag it across all app
    // components; the fix is useAsyncTask()/ctx.stale() from @rallypoint/web-kit.
    files: ['apps/*/src/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    plugins: { rallypoint: staleAsyncPlugin },
    rules: { 'rallypoint/no-stale-async-setstate': 'error' },
  },
  prettierConfig,
]
