import type { Escalation } from '@shared/escalation'

/* Delivery.
 *
 * Nothing in this system sends a complaint to a public authority on its own.
 * That is a product decision, not a missing feature:
 *
 * A pothole detector cannot tell a pothole from a speed bump, a manhole cover
 * or a driver braking hard. The corroboration rules in shared/escalation.ts
 * make a false report unlikely, not impossible. A handful of spurious
 * complaints to a works department does two kinds of damage — it wastes public
 * officials' time, and it teaches them to ignore the next report, including the
 * true ones. An engineer reading a draft for ten seconds prevents both.
 *
 * So the pipeline is: detect, draft automatically, a person approves, then
 * deliver. The automation removes the writing, not the judgement.
 *
 * `OutboxNotifier` is what runs today: it records what would have gone out so
 * the flow is exercisable end to end without a mail server. `mailtoLink` in
 * shared/escalation.ts is the other half — the reviewer opens the draft in
 * their own mail client, where replies reach a human who is watching for them.
 */

export interface DeliveryResult {
  delivered: boolean
  /** How it went out, or why it did not. Shown to the reviewer. */
  detail: string
  at: string
}

export interface Notifier {
  send(escalation: Escalation): Promise<DeliveryResult>
  /** What has been sent, newest first. */
  history(): DeliveryResult[]
}

/**
 * Records deliveries instead of performing them.
 *
 * Not a stub to be replaced by "the real one" — this is the correct behaviour
 * until an operator has configured a mailbox they actually monitor. An SMTP
 * implementation slots in behind the same interface.
 */
export class OutboxNotifier implements Notifier {
  private sent: DeliveryResult[] = []

  async send(escalation: Escalation): Promise<DeliveryResult> {
    const result: DeliveryResult = {
      delivered: false,
      detail:
        `Recorded, not transmitted: no mail transport is configured. ` +
        `Open the draft in your mail client to send it from a mailbox someone reads. ` +
        `(${escalation.authority.name})`,
      at: new Date().toISOString(),
    }

    this.sent = [result, ...this.sent].slice(0, 200)
    console.log(
      `[escalation] ${escalation.id} for segment ${escalation.segmentId} marked sent by reviewer`,
    )
    return result
  }

  history(): DeliveryResult[] {
    return this.sent
  }
}
