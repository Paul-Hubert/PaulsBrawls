// Reservations shared across orders (docs/29 §5.2 `squad.claim`): a block two orders' bots both want, a chest, an
// area. A claim is held by an order until it unclaims, its TTL runs out, or the order ends.

export interface Claim {
  orderId: string;
  expires: number;
}

export class ClaimRegistry {
  private readonly claims = new Map<string, Claim>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True when the key is now this order's (free, expired, or already its own). */
  claim(key: string, orderId: string, ttlSeconds = 300): boolean {
    const c = this.claims.get(key);
    const t = this.now();
    if (c && c.orderId !== orderId && c.expires > t) return false;
    this.claims.set(key, { orderId, expires: t + Math.max(1, ttlSeconds) * 1000 });
    return true;
  }

  /** Whether another order holds the key. */
  heldByOther(key: string, orderId: string): boolean {
    const c = this.claims.get(key);
    return !!c && c.orderId !== orderId && c.expires > this.now();
  }

  unclaim(key: string, orderId: string): void {
    if (this.claims.get(key)?.orderId === orderId) this.claims.delete(key);
  }

  releaseAll(orderId: string): void {
    for (const [k, c] of this.claims) if (c.orderId === orderId) this.claims.delete(k);
  }

  size(): number {
    return this.claims.size;
  }
}
