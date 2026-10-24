// VillagerInbox (layer 3, villagers/) — the concrete instance of the types/ `Inbox` interface, one per
// villager. The Inbox is the ONLY God→villager channel: God holds the interface, never a Villager, so
// god/ never imports villagers/ (11 §7 note / the dependency law). main.ts wires one inbox per villager
// and hands the interface to God.
//
// Delivery is journaled (inbox.delivered) BEFORE the villager reads it (05) — the audit trail behind
// the website's "talk to a villager" box and every critique/directive God sends.

import type { Inbox, InboxMessage } from '../types/index';
import type { JournalAppender } from '../journal/journal';

/**
 * Called AFTER a message is delivered + journaled — the seam that lets reactivity raise an `inbox` event
 * (HIGH-3) without the inbox importing the actor layer. main.ts wires it to VillagerReactivity.signalInbox.
 * It carries the delivered message so the wiring can decide what to react to (e.g. NOT directives — the
 * rollout coordinator already drains those; the reflex is for non-directive tells/critiques, per CRIT-4).
 */
export type InboxDeliveryHook = (villager: string, m: InboxMessage) => void;

/** A single villager's inbox — deliver appends + journals; drain hands the villager its pending messages. */
export class VillagerInbox implements Inbox {
  private readonly messages: InboxMessage[] = [];
  private onDeliver: InboxDeliveryHook | undefined;

  constructor(
    private readonly villager: string,
    private readonly journal: JournalAppender,
  ) {}

  /** Register the post-delivery hook (HIGH-3 inbox reflex). Idempotent-unsafe: set once from main.ts. */
  setDeliveryHook(hook: InboxDeliveryHook): void {
    this.onDeliver = hook;
  }

  /** Deliver a message (journaled first — 05), then notify the optional reactivity hook (never throws into
   *  the delivery path — a reflex hiccup must not lose the message, which is already journaled + queued). */
  deliver(m: InboxMessage): void {
    this.journal.append('engine', 'inbox.delivered', { to: this.villager, from: m.from, kind: m.kind }, {});
    this.messages.push(m);
    this.onDeliver?.(this.villager, m);
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
