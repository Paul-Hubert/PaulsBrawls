// A typed, async Minecraft RCON client for the live-scenario harness. Opens ONE TCP connection,
// authenticates, then runs commands strictly sequentially (one in flight at a time). Each command's
// response is accumulated across however many response packets the server splits it into (a long
// `data get entity … Inventory` exceeds the 4096-byte RCON frame) and resolved after a short quiescence
// debounce — sequential issue + idle-debounce is simple and correct for our scale. This is the tracked,
// type-clean successor to `.smoke/rcon.mjs` (which read only the first packet and could truncate).
//
// Protocol (Source RCON): each packet is int32-LE length, int32-LE request-id, int32-LE type, an ASCII
// body, then two NUL bytes. Types: 3 = auth, 2 = command / auth-response, 0 = command response.

import net from 'node:net';

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const AUTH_REQUEST_ID = 0x5eed;
/** ms of silence after the last response chunk before a command's reply is considered complete. */
const QUIESCE_MS = 60;
/** hard ceiling per command so a wedged server can't hang a scenario forever. */
const COMMAND_TIMEOUT_MS = 15_000;

/** The send seam scenarios + checks use — fire one command, get the server's textual reply. */
export type RconSend = (command: string) => Promise<string>;

interface Pending {
  command: string;
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  buf: string;
  quiesce?: ReturnType<typeof setTimeout>;
  hard: ReturnType<typeof setTimeout>;
}

function frame(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'ascii');
  const len = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + len);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

/** A live RCON session. Construct, `await connect()`, then `send`/`sendAll`; always `close()` when done. */
export class RconClient {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string;
  private sock: net.Socket | undefined;
  private rx = Buffer.alloc(0);
  private nextId = 1;
  private readonly queue: Pending[] = [];
  private current: Pending | undefined;
  private authResolve: (() => void) | undefined;
  private authReject: ((err: Error) => void) | undefined;
  private authed = false;

  constructor(opts: { host: string; port: number; password: string }) {
    this.host = opts.host;
    this.port = opts.port;
    this.password = opts.password;
  }

  /** Open the socket and authenticate. Rejects on bad password or connection error. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
      const sock = net.connect(this.port, this.host, () => {
        sock.write(frame(AUTH_REQUEST_ID, TYPE_AUTH, this.password));
      });
      this.sock = sock;
      sock.on('data', (d) => this.onData(d));
      sock.on('error', (e) => this.fail(new Error(`RCON socket error: ${e.message}`)));
      sock.on('close', () => {
        if (!this.authed) this.fail(new Error('RCON socket closed before auth'));
      });
    });
  }

  /** Send one command; resolves with the server's (possibly multi-packet) textual reply, trimmed. */
  send(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.sock || !this.authed) {
        reject(new Error(`RCON not connected — cannot send "${command}"`));
        return;
      }
      const pending: Pending = {
        command,
        resolve,
        reject,
        buf: '',
        hard: setTimeout(() => this.timeout(pending), COMMAND_TIMEOUT_MS),
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  /** Run a list of commands in order, returning each reply. Stops at the first that throws. */
  async sendAll(commands: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const c of commands) out.push(await this.send(c));
    return out;
  }

  /** Close the socket (idempotent). */
  close(): void {
    try {
      this.sock?.end();
    } catch {
      /* noop */
    }
    this.sock = undefined;
  }

  private pump(): void {
    if (this.current || this.queue.length === 0 || !this.sock) return;
    this.current = this.queue.shift();
    this.sock.write(frame(this.nextId++, TYPE_COMMAND, this.current!.command));
  }

  private onData(d: Buffer): void {
    this.rx = Buffer.concat([this.rx, d]);
    while (this.rx.length >= 4) {
      const len = this.rx.readInt32LE(0);
      if (this.rx.length < 4 + len) break;
      const id = this.rx.readInt32LE(4);
      const body = this.rx.subarray(12, 4 + len - 2).toString('ascii');
      this.rx = this.rx.subarray(4 + len);
      this.dispatch(id, body);
    }
  }

  private dispatch(id: number, body: string): void {
    if (!this.authed) {
      // The auth response is a TYPE_COMMAND packet: id === AUTH_REQUEST_ID on success, -1 on failure.
      if (id === -1) {
        this.fail(new Error('RCON auth failed — wrong password?'));
        return;
      }
      if (id === AUTH_REQUEST_ID) {
        this.authed = true;
        this.authResolve?.();
        this.authResolve = this.authReject = undefined;
        this.pump();
      }
      return;
    }
    const cur = this.current;
    if (!cur) return; // stray packet (e.g. the empty type-0 echo some servers emit) — ignore
    cur.buf += body;
    if (cur.quiesce) clearTimeout(cur.quiesce);
    cur.quiesce = setTimeout(() => this.complete(), QUIESCE_MS);
  }

  private complete(): void {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.hard);
    this.current = undefined;
    cur.resolve(cur.buf.trim());
    this.pump();
  }

  private timeout(p: Pending): void {
    if (this.current === p) {
      this.current = undefined;
      if (p.quiesce) clearTimeout(p.quiesce);
      p.reject(new Error(`RCON command timed out after ${COMMAND_TIMEOUT_MS}ms: "${p.command}"`));
      this.pump();
    }
  }

  private fail(err: Error): void {
    if (this.authReject) {
      this.authReject(err);
      this.authResolve = this.authReject = undefined;
    }
    const cur = this.current;
    this.current = undefined;
    if (cur) {
      clearTimeout(cur.hard);
      if (cur.quiesce) clearTimeout(cur.quiesce);
      cur.reject(err);
    }
    for (const p of this.queue.splice(0)) {
      clearTimeout(p.hard);
      p.reject(err);
    }
  }
}
