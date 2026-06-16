import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // node_modules, runtime data, and CommonJS tooling config (linted as ESM otherwise).
    // `**/.eden-data*/**` covers the live journal dir AND the preserved run snapshots (.eden-data.run1,
    // live-tests/.runs/<x>/.eden-data, …) — all hold generated skill `.js` the lint gate must not judge,
    // mirroring the gitignore's `.eden-data*/`. live-tests/.runs/** also holds per-run evidence + configs.
    // .smoke/** is gitignored, throwaway smoke-harness scripts (Node CLI: console/process/Buffer by
    // design) — not shipped code, never part of the lint gate.
    ignores: ['node_modules/**', '**/.eden-data*/**', 'live-tests/.runs/**', 'dist/**', 'coverage/**', '**/*.cjs', '.smoke/**'],
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
  {
    // The dashboard ([website/](website/)) is hand-written browser glue (plain-JS IIFEs over the DOM +
    // the admin API), NOT part of the TypeScript gate. Lint it with browser globals so a real bug (a typo,
    // an undeclared variable in api.js) is still caught, but relax the rules that browser-module style
    // legitimately trips (console for debugging, empty catch/`this` aliasing, cross-file window singletons).
    files: ['website/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly',
        fetch: 'readonly', WebSocket: 'readonly', Promise: 'readonly', JSON: 'readonly',
        Math: 'readonly', Date: 'readonly', console: 'readonly', Object: 'readonly', Array: 'readonly', String: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        encodeURIComponent: 'readonly', decodeURIComponent: 'readonly',
        Event: 'readonly', CustomEvent: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', getComputedStyle: 'readonly',
        // cross-file singletons the website modules attach to window:
        EdenAPI: 'writable', UI: 'writable', Screens: 'writable', Eden: 'writable',
      },
    },
    rules: {
      'no-console': 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
