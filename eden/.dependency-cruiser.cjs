// The dependency law (docs/08), enforced in CI. Imports run STRICTLY DOWNWARD:
//   types (0) -> {journal, config, bots} (1) -> {skills, llm} (2) -> {god, villagers, social} (3)
//   admin (consumer) imports anything; nothing imports admin except main.ts.
//   layer-3 actors NEVER import each other.
// An upward import fails the build with no exception short of a new decision record.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cycle means a missing seam — break it with an interface in types/.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'types-imports-nothing',
      severity: 'error',
      comment: 'Layer 0: types/ holds interfaces + enums only, imports no other local module.',
      from: { path: '^src/types/' },
      to: { path: '^src/', pathNot: '^src/types/' },
    },
    {
      name: 'journal-only-types',
      severity: 'error',
      comment: 'journal/ imports nothing but types/. If it needs to know about skills, the design is wrong.',
      from: { path: '^src/journal/' },
      to: { path: '^src/', pathNot: '^src/(journal/|types/)' },
    },
    {
      name: 'config-only-types',
      severity: 'error',
      comment: 'config.ts validates data; it imports only types/.',
      from: { path: '^src/config\\.ts$' },
      to: { path: '^src/', pathNot: '^src/types/' },
    },
    {
      name: 'render-only-types',
      severity: 'error',
      comment:
        'render/ is the shared pure-string layer (Snapshot→string, token estimate). It imports only ' +
        'types/, so god/ and villagers/ can both use it without importing each other (the dependency law).',
      from: { path: '^src/render/' },
      to: { path: '^src/', pathNot: '^src/(render/|types/)' },
    },
    {
      name: 'views-only-journal-types',
      severity: 'error',
      comment:
        'views/ is LAYER 1 (11 §8): it FOLDS the journal and imports ONLY journal/ + types/. The website ' +
        "rollout/skill/relations pages are folds of the journal (P4 derived-state), read UPWARD by " +
        'admin/, skills/library, and god/ — placing it lower than skills/ is what keeps those reads legal.',
      from: { path: '^src/views/' },
      to: { path: '^src/', pathNot: '^src/(views/|journal/|types/)' },
    },
    {
      name: 'bots-no-upward',
      severity: 'error',
      comment: 'Layer 1 bots/ may use journal/config/types — never engines or actors.',
      from: { path: '^src/bots/' },
      to: { path: '^src/(skills|llm|god|villagers|social|admin)/' },
    },
    {
      name: 'engines-no-actors',
      severity: 'error',
      comment: 'Layer 2 engines (skills/, llm/) never import layer-3 actors or admin.',
      from: { path: '^src/(skills|llm)/' },
      to: { path: '^src/(god|villagers|social|admin)/' },
    },
    {
      name: 'god-no-peers',
      severity: 'error',
      comment: 'Layer-3 actors never import each other; God reaches villagers via an injected Inbox.',
      from: { path: '^src/god/' },
      to: { path: '^src/(villagers|social|admin)/' },
    },
    {
      name: 'villagers-no-peers',
      severity: 'error',
      from: { path: '^src/villagers/' },
      to: { path: '^src/(god|social|admin)/' },
    },
    {
      name: 'social-no-peers',
      severity: 'error',
      from: { path: '^src/social/' },
      to: { path: '^src/(god|villagers|admin)/' },
    },
    {
      name: 'no-import-admin',
      severity: 'error',
      comment: 'admin/ is a pure consumer — deleting it must break nothing. Only main.ts may wire it.',
      from: { path: '^src/', pathNot: '^src/(admin/|main\\.ts$)' },
      to: { path: '^src/admin/' },
    },
    {
      name: 'no-import-cli',
      severity: 'error',
      comment: 'cli/ (eden rebuild-stats) is a standalone consumer — nothing in the graph imports it.',
      from: { path: '^src/', pathNot: '^src/cli/' },
      to: { path: '^src/cli/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mts', '.cts', '.json'],
    },
  },
};
