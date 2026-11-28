// Cost reporting. There are NO start caps: no daily total, no monthly total, no per-CAO weekly cap.
// A relay never refuses to start for count or cost. A cost limit is the Token Accountant's job and is
// reported to the CAO. What remains here is the per-fire token budget used to FLAG a run that went over
// it at close-out (an `overrun` record in the journal and an alert); the flag never blocks a start.

import type { Caps } from './config.js';

export class CostEnvelope {
  constructor(private readonly caps: Caps) {}

  /** Close-out: a run over the per-fire budget is flagged for the Monday review. It never blocks a start. */
  isOverrun(tokens: number | null): boolean {
    return tokens !== null && tokens > this.caps.perFireTokenBudget;
  }
}
