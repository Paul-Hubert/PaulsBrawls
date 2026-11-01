// The two ways a job's promise rejects (besides an AbortSignal's own reason): too late, or failed.

/** The answer could not be applied by the job's deadlineTick (still queued, carried over, or answered too late). */
export class JobLateError extends Error {
  override name = 'JobLateError';
  constructor(
    readonly type: string,
    readonly deadlineTick: number,
    /** The tick at which it was found late. */
    readonly tick: number,
  ) {
    super(`job ${type} is late (deadline tick ${deadlineTick}, now ${tick})`);
  }
}

/**
 * Why a job failed:
 *  - `threw`: its handler threw (or rejected); `message` and `remoteStack` are the handler's;
 *  - `workerDied`: its worker died twice under it (it is re-queued once);
 *  - `lostInput`: its worker died holding an input that was transferred to it, so it cannot be re-queued;
 *  - `unknownType`: no handler module exports this type;
 *  - `clone`: its input or result could not be copied between threads;
 *  - `unavailable`: no worker is alive and the inline fallback could not load (a handler or the world module);
 *  - `stopped`: the job pool stopped.
 */
export type JobFailReason = 'threw' | 'workerDied' | 'lostInput' | 'unknownType' | 'clone' | 'unavailable' | 'stopped';

export class JobFailedError extends Error {
  override name = 'JobFailedError';
  readonly type: string;
  readonly reason: JobFailReason;
  /** The handler's stack, in the thread it ran on (reason `threw`). */
  readonly remoteStack?: string;
  /** The name of the handler's error (TypeError…). */
  readonly remoteName?: string;

  constructor(type: string, reason: JobFailReason, message: string, remote?: { stack?: string; name?: string }) {
    super(message);
    this.type = type;
    this.reason = reason;
    if (remote?.stack) {
      this.remoteStack = remote.stack;
      this.stack = `${this.stack ?? `${this.name}: ${message}`}\n    --- in the job handler ---\n${remote.stack}`;
    }
    if (remote?.name) this.remoteName = remote.name;
  }
}
