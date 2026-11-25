// Hand-off files: one line per carried message, so a CAO that is not listening in Slack can still read what was said.
// This is also the fallback while the two Slack keys are not in place (nothing else can reach a CAO then).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Inbox } from './router.js';

export function writeInbox(dir: string, item: Inbox, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${item.cao}.jsonl`);
  appendFileSync(file, JSON.stringify({ at: now.toISOString(), from: item.from, text: item.text, slack: item.source }) + '\n', { mode: 0o600 });
  return file;
}
