// Alerts. A local alerts file that is always written (it survives a brain outage and is read at the
// 9am check-in) plus a log line. Alerts carry machine codes and ids only. There is no brain row for an
// alert: the old comms table is retired, and message text never goes into the brain. The alert also becomes a
// run row (kind `alert`) in the relay's own run log, so the relay's own harness CAO sees it with the runs.

import { join } from 'node:path';
import type { RunLog } from './runlog.js';
import { appendLineCapped } from './util/durable.js';
import type { Logger } from './util/log.js';
import { iso, type Clock } from './util/time.js';

export class Alerter {
  readonly path: string;
  private runlog: RunLog | null = null;

  constructor(
    stateDir: string,
    private readonly cao: string,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    this.path = join(stateDir, 'alerts.jsonl');
  }

  attachRunLog(runlog: RunLog): void {
    this.runlog = runlog;
  }

  alert(code: string, ids: Record<string, string | number | null> = {}): void {
    const rec = { at: iso(this.clock()), cao: this.cao, code, ...ids };
    try {
      appendLineCapped(this.path, JSON.stringify(rec));
    } catch {
      this.log.error('alert file write failed', { code });
    }
    try {
      this.runlog?.write({ kind: 'alert', fireId: typeof ids.fireId === 'string' ? ids.fireId : null, writer: 'relay', reason: code });
    } catch {
      // the alerts file already holds it
    }
    this.log.warn('alert', { code, ...ids });
  }
}
