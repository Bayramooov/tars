// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Spawning processes is the Claude Code worker's job alone. */
const NO_CHILD_PROCESS = ['child_process', 'node:child_process', 'execa', 'cross-spawn'].map((name) => ({
  name,
  message: 'Only src/claude/child.ts may spawn processes.',
}));

/** Tools reach the filesystem only through the path-hardened stores. */
const NO_FS = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].map((name) => ({
  name,
  message: 'Tools must go through a store in src/stores/, never the filesystem directly.',
}));

/** Chromium is driven only by the browser and render modules. */
const NO_PLAYWRIGHT = [{ name: 'playwright', message: 'Only src/browser/ may drive Chromium.' }];

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 4],
      'max-depth': ['error', 4],
      complexity: ['error', 9],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { paths: [...NO_CHILD_PROCESS, ...NO_PLAYWRIGHT] }],
    },
  },
  {
    files: ['src/claude/child.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: NO_PLAYWRIGHT }] },
  },
  {
    files: ['src/browser/**'],
    rules: { 'no-restricted-imports': ['error', { paths: NO_CHILD_PROCESS }] },
  },
  {
    files: ['src/tools/**'],
    rules: { 'no-restricted-imports': ['error', { paths: [...NO_CHILD_PROCESS, ...NO_PLAYWRIGHT, ...NO_FS] }] },
  },
  {
    // Tests and fakes: drive real processes and longer scenarios; the size rails are for app code.
    files: ['test/**', '*.config.ts', 'eslint.config.js'],
    rules: {
      'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': 'off',
      complexity: 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
