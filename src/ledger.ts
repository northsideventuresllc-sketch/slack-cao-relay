// The relay's own run ledger: the fine run state (queued, claimed, started, linked, closed ...) and the
// evidence block (hashes, claim, close-out facts) for the runs THIS relay accepted. Local, durable
// (atomic rewrite of one JSON file), per relay. It holds ids, hashes, links and states only: never message
// text. The brain keeps only the pointer row for each run (see brain.ts); message text stays in Slack.

import { existsSync, readFileSync } from 'node:fs';
import type { RelayEvidence } from './brain.js';
import { writeFileAtomicSync } from './util/durable.js';

export interface LedgerRec {
  id: string; // relay-<yyyymmddhhmmss>-<4 hex>
  created_at: string;
  from_agent: string | null;
  to_agent: string | null;
  status: string;
  fired_at: string | null;
  completed_at: string | null;
  evidence: RelayEvidence;
  slack_link: string | null;
  pointer_synced: boolean; // false until the brain pointer row is written
}

export class FireLedger {
  private readonly recs = new Map<string, LedgerRec>();

  /** `path` null = in memory only (tests, one-shot tools). */
  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(raw)) for (const r of raw as LedgerRec[]) if (r && typeof r.id === 'string') this.recs.set(r.id, r);
      } catch {
        // a torn file: start empty; the journal and the pointer rows still hold the runs
      }
    }
  }

  get(id: string): LedgerRec | undefined {
    const r = this.recs.get(id);
    return r ? structuredClone(r) : undefined;
  }

  list(): LedgerRec[] {
    return [...this.recs.values()].map((r) => structuredClone(r));
  }

  put(rec: LedgerRec): void {
    this.recs.set(rec.id, structuredClone(rec));
    this.flush();
  }

  /** Drop rows already filed into the vault archive once they are past `olderThanMs` (local housekeeping). */
  pruneArchived(nowMs: number, olderThanMs: number): number {
    let n = 0;
    for (const [id, r] of this.recs) {
      const done = Date.parse(r.completed_at ?? '');
      if (r.evidence.archived_at && Number.isFinite(done) && nowMs - done > olderThanMs) {
        this.recs.delete(id);
        n++;
      }
    }
    if (n) this.flush();
    return n;
  }

  private flush(): void {
    if (this.path) writeFileAtomicSync(this.path, JSON.stringify([...this.recs.values()]));
  }
}
