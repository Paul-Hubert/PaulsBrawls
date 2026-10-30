// A minimal RCON client (Source RCON protocol): the live test's ground truth and its admin hand (give, tp, summon).

import { Socket } from 'node:net';

export class Rcon {
  private socket?: Socket;
  private buf = Buffer.alloc(0);
  private id = 0;
  private readonly waiting = new Map<number, (body: string) => void>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = new Socket();
      s.once('error', reject);
      s.connect(this.port, this.host, () => resolve());
      s.on('data', (d) => this.onData(d));
      this.socket = s;
    });
    const r = await this.send(3, this.password);
    if (r === null) throw new Error('RCON login refused');
  }

  command(cmd: string): Promise<string> {
    return this.send(2, cmd).then((r) => r ?? '');
  }

  close(): void {
    this.socket?.end();
  }

  private send(type: number, body: string): Promise<string | null> {
    const id = ++this.id;
    const payload = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + payload.length);
    p.writeInt32LE(10 + payload.length, 0);
    p.writeInt32LE(id, 4);
    p.writeInt32LE(type, 8);
    payload.copy(p, 12);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`RCON timeout: ${body}`)), 10_000);
      this.waiting.set(id, (b) => {
        clearTimeout(t);
        resolve(b);
      });
      this.waiting.set(-1, () => {
        clearTimeout(t);
        resolve(null);
      });
      this.socket!.write(p);
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const body = this.buf.subarray(12, 4 + len - 2).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      const cb = this.waiting.get(id);
      if (cb) {
        this.waiting.delete(id);
        cb(body);
      }
    }
  }
}
