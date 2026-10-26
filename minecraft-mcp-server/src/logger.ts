import fs from 'fs';
import path from 'path';

/**
 * Process-wide logging, two sinks:
 *
 *  - stderr — log(), every level, format unchanged since day one (stdout is
 *    reserved for the MCP stdio transport; see stdio-filter.ts). When a file
 *    sink is active, log() lines are mirrored into it too.
 *  - an optional FILE (initFileLog) — logDebug() writes here and ONLY here,
 *    so the console stays readable while the file captures the full trace
 *    (actions, events, scheduler decisions, LLM round-trips, memory writes).
 *
 * logDebug() is a no-op until initFileLog() is called — instrumentation can
 * stay in place permanently at zero cost for entrypoints that don't opt in.
 */

let fileStream: fs.WriteStream | null = null;
let activeFilePath: string | null = null;
let exitHookInstalled = false;

/** Open (append) the debug log file. Returns the resolved path. */
export function initFileLog(filePath: string): string {
  closeFileLog();
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const stream = fs.createWriteStream(resolved, { flags: 'a' });
  stream.on('error', (err) => {
    if (fileStream === stream) {
      fileStream = null;
      activeFilePath = null;
    }
    process.stderr.write(`${new Date().toISOString()} [minecraft] [mcp-server] [warn] file log disabled: ${err.message}\n`);
  });
  fileStream = stream;
  activeFilePath = resolved;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => closeFileLog());
  }
  writeFileLine('info', `==== log opened (pid ${process.pid}, argv: ${process.argv.slice(2).join(' ')}) ====`);
  return resolved;
}

export function fileLogPath(): string | null {
  return activeFilePath;
}

/** True when a debug file sink is active — gate expensive log-string assembly on this. */
export function debugEnabled(): boolean {
  return fileStream !== null;
}

export function closeFileLog(): void {
  if (fileStream) {
    try {
      fileStream.end();
    } catch {
      /* never throw out of logging */
    }
  }
  fileStream = null;
  activeFilePath = null;
}

function writeFileLine(level: string, message: string): void {
  if (!fileStream) return;
  try {
    fileStream.write(`${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    /* never throw out of logging */
  }
}

export function log(level: string, message: string): void {
  process.stderr.write(`${new Date().toISOString()} [minecraft] [mcp-server] [${level}] ${message}\n`);
  writeFileLine(level, message);
}

/** Debug line for the file sink only. `tag` identifies the source (bot name, subsystem). */
export function logDebug(tag: string, message: string): void {
  if (!fileStream) return;
  writeFileLine('debug', `[${tag}] ${message}`);
}
