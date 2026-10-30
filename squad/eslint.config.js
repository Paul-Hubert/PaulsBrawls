import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Runtime data (submitted command sources live there), live-test evidence, CommonJS tooling config.
    ignores: ['node_modules/**', '**/.squad-data*/**', 'live-tests/.runs/**', 'bench/.runs/**', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // console.* is banned everywhere except logger.ts (one stdout writer, copied from Eden's R23).
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests and fakes model loosely typed mineflayer surfaces.
    files: ['tests/**/*.ts', 'live-tests/**/*.ts', 'bench/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Plain-JS test fixtures and the typecheck worker run on Node.
    files: ['tests/**/*.mjs', 'src/script/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', setInterval: 'readonly', setTimeout: 'readonly', clearInterval: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    // The command API reference types what plain-JS commands receive (`args` is whatever the manifest declares).
    files: ['reference/**/*.d.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Stock commands and exemplars are what the author agent reads: plain ESM JavaScript run by the runtime, with
    // the squad globals (squad.d.ts) in scope.
    files: ['agent/**/*.mjs', 'src/stock/**/*.mjs', 'bench/commands/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        squad: 'readonly', Vec3: 'readonly', goals: 'readonly', Movements: 'readonly',
        goTo: 'readonly', follow: 'readonly', mineBlock: 'readonly', craftItem: 'readonly', smeltItem: 'readonly',
        placeItem: 'readonly', killMob: 'readonly', exploreUntil: 'readonly', getItemFromChest: 'readonly',
        depositItemIntoChest: 'readonly', checkItemInsideChest: 'readonly', attack: 'readonly', shoot: 'readonly',
        equip: 'readonly', eat: 'readonly', pickupDrops: 'readonly', findBlock: 'readonly',
        nearestEntity: 'readonly', nearestHostile: 'readonly', isFriend: 'readonly', blockKey: 'readonly',
        sleep: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', BotLeftError: 'readonly', OrderStoppedError: 'readonly',
      },
    },
  },
);
