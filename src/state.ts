// Small local state: which relayed post answers which thread, and which Slack events were already handled.
// One JSON file, written whole and swapped into place so a crash never leaves half a file. No database.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Links } from './router.js';

interface Disk { links: Record<string, string>; seen: string[] }
const MAX_LINKS = 4000;
const MAX_SEEN = 2000;

export class State implements Links {
  private links = new Map<string, string>();
  private seen: string[] = [];
  private seenSet = new Set<string>();

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8')) as Disk;
        for (const [k, v] of Object.entries(d.links ?? {})) this.links.set(k, v);
        for (const s of d.seen ?? []) this.markSeen(s);
      } catch {
        /* a bad file is treated as empty: worst case an old thread stops answering */
      }
    }
  }
  private static key(channel: string, ts: string): string { return `${channel}:${ts}`; }
  private static split(k: string): { channel: string; ts: string } {
    const i = k.indexOf(':');
    return { channel: k.slice(0, i), ts: k.slice(i + 1) };
  }

  get(channel: string, ts: string): { channel: string; ts: string } | undefined {
    const v = this.links.get(State.key(channel, ts));
    return v ? State.split(v) : undefined;
  }
  /** Link both ways. Re-reading the disk first keeps `send` and the running relay from undoing each other. */
  link(a: { channel: string; ts: string }, b: { channel: string; ts: string }): void {
    this.reload();
    this.links.set(State.key(a.channel, a.ts), State.key(b.channel, b.ts));
    this.links.set(State.key(b.channel, b.ts), State.key(a.channel, a.ts));
    while (this.links.size > MAX_LINKS) {
      const first = this.links.keys().next().value;
      if (first === undefined) break;
      this.links.delete(first);
    }
    this.save();
  }
  /** True the first time an event id is seen, false after (Slack re-delivers on slow acks). */
  firstTime(id: string): boolean {
    if (this.seenSet.has(id)) return false;
    this.markSeen(id);
    this.save();
    return true;
  }
  private markSeen(id: string): void {
    this.seen.push(id);
    this.seenSet.add(id);
    while (this.seen.length > MAX_SEEN) { const o = this.seen.shift(); if (o) this.seenSet.delete(o); }
  }
  private reload(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as Disk;
      for (const [k, v] of Object.entries(d.links ?? {})) if (!this.links.has(k)) this.links.set(k, v);
    } catch { /* keep memory copy */ }
  }
  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const d: Disk = { links: Object.fromEntries(this.links), seen: this.seen };
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
