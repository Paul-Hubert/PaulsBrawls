// VillagerInbox (layer 3, villagers/) — the concrete instance of the types/ `Inbox` interface, one per
// villager. The Inbox is the ONLY God→villager channel: God holds the interface, never a Villager, so
// god/ never imports villagers/ (11 §7 note / the dependency law). main.ts wires one inbox per villager
// and hands the interface to God.
//
// Delivery is journaled (inbox.delivered) BEFORE the villager reads it (05) — the audit trail behind
// the website's "talk to a villager" box and every critique/directive God sends.

import type { Inbox, InboxMessage } from '../types/index';
import type { JournalAppender } from '../journal/journal';

/** A single villager's inbox — deliver appends + journals; drain hands the villager its pending messages. */
export class VillagerInbox implements Inbox {
  private readonly messages: InboxMessage[] = [];

  constructor(
    private readonly villager: string,
    private readonly journal: JournalAppender,
  ) {}

  /** Deliver a message (journaled first, ONCE, as `actor` — 05). */
  deliver(m: InboxMessage, actor = 'engine'): void {
    this.journal.append(actor, 'inbox.delivered', { to: this.villager, from: m.from, kind: m.kind }, {});
    this.messages.push(m);
  }

  /** Hand the villager its pending messages and clear the inbox (the brain folds them into §8). */
  drain(): InboxMessage[] {
    return this.messages.splice(0, this.messages.length);
  }

  /** Non-destructive peek — admin /villagers shows inbox depth without draining it. */
  depth(): number {
    return this.messages.length;
  }
}
