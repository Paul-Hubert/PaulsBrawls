// The typecheck worker (src/script/check.ts). TypeScript's checker is synchronous and the first program parses every
// library file (~5 s): on the main thread that would freeze every bot's physics, so it runs here. Plain JS so the
// worker needs no loader. One message = one command file (already given its JSDoc types by the main thread); the
// answer is the raw diagnostics of that file. Parsed library files are cached across checks.

import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';

import ts from 'typescript';

const { root, reference } = workerData;
const FILE = join(root, '.check', 'command.mjs').replace(/\\/g, '/');
const REF = reference.replace(/\\/g, '/');

const OPTIONS = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: false,
  noImplicitAny: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts'],
  types: [],
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
};

const cache = new Map();
let oldProgram;

function check(text) {
  const host = ts.createCompilerHost(OPTIONS, true);
  const baseGet = host.getSourceFile.bind(host);
  const norm = (n) => n.replace(/\\/g, '/');
  host.getSourceFile = (name, lang, onError, create) => {
    if (norm(name) === FILE) return ts.createSourceFile(name, text, lang, true, ts.ScriptKind.JS);
    const hit = cache.get(name);
    if (hit) return hit;
    const sf = baseGet(name, lang, onError, create);
    if (sf) cache.set(name, sf);
    return sf;
  };
  const baseExists = host.fileExists.bind(host);
  host.fileExists = (name) => norm(name) === FILE || baseExists(name);
  const baseRead = host.readFile.bind(host);
  host.readFile = (name) => (norm(name) === FILE ? text : baseRead(name));
  host.getCurrentDirectory = () => root;

  const program = ts.createProgram({ rootNames: [REF, FILE], options: OPTIONS, host, oldProgram });
  oldProgram = program;
  const sf = program.getSourceFile(FILE);
  if (!sf) return [];
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => {
    const out = {
      code: d.code,
      error: d.category === ts.DiagnosticCategory.Error,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    };
    if (d.start !== undefined) {
      const lc = sf.getLineAndCharacterOfPosition(d.start);
      out.line = lc.line + 1;
      out.column = lc.character + 1;
    }
    return out;
  });
}

parentPort.on('message', ({ id, text }) => {
  try {
    parentPort.postMessage({ id, diagnostics: check(text) });
  } catch (e) {
    parentPort.postMessage({ id, error: e && e.stack ? e.stack : String(e) });
  }
});
