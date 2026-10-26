import path from 'path';
import ts from 'typescript';

/**
 * Type-checks an LLM-drafted villager script against the published VillagerAPI
 * `.d.ts` BEFORE it ever runs (VILLAGE_PLAN §D4 — "the killer feature").
 * Compile errors go back to the bot as tool-result feedback, with line numbers
 * relative to its own code.
 *
 * Strictness is deliberately relaxed (no strictNullChecks): the goal is to
 * catch calls to nonexistent API methods and arity/type mismatches, not to
 * make a chat model fight the full strict gauntlet.
 */

const SCRIPT_FILE = '/villager-script.ts';

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.None,
  lib: ['lib.es2022.d.ts'],
  noEmit: true,
  strict: false,
  noImplicitAny: false,
  skipLibCheck: true,
  types: [],
  allowJs: true,
};

export function typecheckScript(code: string, apiDts: string): string[] {
  // Top-level await is fine in our sandbox (the script body is wrapped in an
  // async IIFE) — wrap the same way here so tsc doesn't reject it.
  const wrapped = `${apiDts}\n(async () => {\n${code}\n})();\n`;
  // Line offset of the script body inside the wrapped file, for remapping.
  const lineOffset = apiDts.split('\n').length + 1;

  const defaultLibPath = ts.getDefaultLibFilePath(COMPILER_OPTIONS);
  const libDir = path.dirname(defaultLibPath);

  const virtualFiles = new Map<string, string>([[SCRIPT_FILE, wrapped]]);

  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const virtual = virtualFiles.get(fileName);
      if (virtual !== undefined) {
        return ts.createSourceFile(fileName, virtual, languageVersion, true);
      }
      const onDisk = ts.sys.readFile(fileName) ?? ts.sys.readFile(path.join(libDir, fileName));
      return onDisk !== undefined
        ? ts.createSourceFile(fileName, onDisk, languageVersion, true)
        : undefined;
    },
    getDefaultLibFileName: () => defaultLibPath,
    getDefaultLibLocation: () => libDir,
    writeFile: () => { /* noEmit */ },
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (fileName) =>
      virtualFiles.has(fileName) || ts.sys.fileExists(fileName) || ts.sys.fileExists(path.join(libDir, fileName)),
    readFile: (fileName) =>
      virtualFiles.get(fileName) ?? ts.sys.readFile(fileName) ?? ts.sys.readFile(path.join(libDir, fileName)),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };

  const program = ts.createProgram([SCRIPT_FILE], COMPILER_OPTIONS, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((d) => d.file?.fileName === SCRIPT_FILE);

  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file && d.start !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      const scriptLine = line + 1 - lineOffset;
      if (scriptLine >= 1) return `line ${scriptLine}: ${message}`;
    }
    return message;
  });
}
