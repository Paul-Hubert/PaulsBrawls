import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // node_modules, runtime data, and CommonJS tooling config (linted as ESM otherwise).
    ignores: ['node_modules/**', '.eden-data/**', 'dist/**', 'coverage/**', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // R23 / docs/05 stdout-purity lesson: console.* is banned everywhere...
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // ...except logger.ts, the ONE module allowed to touch stdout.
    files: ['src/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Fakes and tests print diagnostics and model loosely-typed mineflayer surfaces;
    // they are not shipped code.
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
