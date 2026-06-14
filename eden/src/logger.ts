/**
 * The ONE module allowed to touch stdout (R23 / 05 stdout-purity lesson). ESLint bans
 * `console.*` everywhere else. Human log lines carry the journal `actor` (R41) so a log
 * tag never lies about who acted. (ESLint allows console.* in this file only.)
 */

function stamp(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

/** The stdout seam. Every method takes the journal `actor` (R41) so a log tag never lies. */
export interface Logger {
  /** A timed info line; the optional `ms` renders as a trailing `(<ms>ms)`. */
  line(actor: string, msg: string, ms?: number): void;
  info(actor: string, msg: string): void;
  warn(actor: string, msg: string): void;
  error(actor: string, msg: string): void;
}

function emit(stream: 'log' | 'warn' | 'error', actor: string, msg: string, ms?: number): void {
  const tail = ms === undefined ? '' : ` (${ms}ms)`;
  console[stream](`[${stamp()}] ${actor}  ${msg}${tail}`);
}

/** The process-wide logger singleton — the only sanctioned writer to stdout/stderr (R23). */
export const logger: Logger = {
  line: (actor, msg, ms) => emit('log', actor, msg, ms),
  info: (actor, msg) => emit('log', actor, msg),
  warn: (actor, msg) => emit('warn', actor, `WARN ${msg}`),
  error: (actor, msg) => emit('error', actor, `ERROR ${msg}`),
};
