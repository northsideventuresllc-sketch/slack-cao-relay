// D5 §6 — the close-out sweep, the daily 9am open, the 9am lock clear, and the
// sibling watch. Owner: the Muse relay program (it holds the brain key and is
// a member of all five CAO channels).

import { relayEvidence, type BrainApi, type FireRow, type RelayEvidence } from './brain.js';
import { isPlaceholder, type CaoEntry, type Registry } from './config.js';
import type { Poster } from './poster.js';
import { T, isRelayTemplate } from './templates.js';
import type { Logger } from './util/log.js';
import { appendLineSync, readJsonLines } from './util/durable.js';
import { readdirSync, existsSync } from 'node:fs';
import { startOfLocalWeek } from './util/time.js';
import { join } from 'node:path';
import { DAY, HOUR, iso, type Clock } from './util/time.js';

export const STALL_MS = 6 * HOUR;
export const UNCLOSED_MS = 24 * HOUR;
export const BRAIN_ROW_RETENTION_MS = 90 * DAY;
export const POLLER_AGENT = 'MINI-POLLER';
export const POLLER_STALE_MS = 5 * 60_000;

/**
 * The still-active test and the ONE stalled definition (D5 close signal + §6;
 * KAR-6, R7-NEW-2). A run is still active if ANY holds:
 * (a) the adapter's status(runId) reports the run as live — counted ONLY when
 *     the adapter has a real live probe (`liveStatus`). No v1 adapter has one:
 *     Muse and the three manual adapters all read the stored brain row, so
 *     prong (a) does NOT apply in v1, and still-active rests on (b) + (c);
 * (b) the CAO's channel has a message from that CAO in the last 6 hours
 *     (relay templates excluded);
 * (c) the run is under way (brain row `claimed`, `started` or `linked`) AND the
 *     last state-changing run-log entry by the CAO's own adapter is under 6 hours old.
 *
 * Stalled ⟺ NOT still active ⟺ (with no live probe) no activity — no (b)
 * message and no (c) entry — for 6 hours. D5 "fails all three for 6 hours" and
 * §6 "no activity for 6 hours" are the same test here, by construction.
 * Unclosed ⟺ stalled AND the last activity is over 24 hours old.
 */
export interface RunActivity {
  liveState: string | null; // adapter status() result; null = the adapter has no live probe (all v1 adapters)
  channelMsgAt: number | null;
  rowStatus: string;
  lastAdapterEntryAt: number | null;
  now: number;
}

const UNDER_WAY = new Set(['claimed', 'started', 'linked']);
const ENDED = new Set(['closed', 'failed', 'expired', 'cancelled', 'refused']);

export function lastActivityAt(a: RunActivity): number | null {
  const xs = [a.channelMsgAt, UNDER_WAY.has(a.rowStatus) ? a.lastAdapterEntryAt : null].filter((x): x is number => x !== null);
  return xs.length ? Math.max(...xs) : null;
}

export function stillActive(a: RunActivity): boolean {
  const pa = a.liveState !== null && !ENDED.has(a.liveState);
  const pb = a.channelMsgAt !== null && a.now - a.channelMsgAt < STALL_MS;
  const pc = UNDER_WAY.has(a.rowStatus) && a.lastAdapterEntryAt !== null && a.now - a.lastAdapterEntryAt < STALL_MS;
  return pa || pb || pc;
}

export function assessRun(a: RunActivity): { stillActive: boolean; stalled: boolean; unclosed: boolean; lastActivity: number | null } {
  const active = stillActive(a);
  const last = lastActivityAt(a);
  return { stillActive: active, stalled: !active, unclosed: !active && (last === null || a.now - last > UNCLOSED_MS), lastActivity: last };
}

export interface SweepFinding {
  cao: string;
  fireId: string;
  kind: 'stalled' | 'unclosed';
}

export interface HistoryReader {
  history(channel: string, oldestTs: string): Promise<Array<{ user: string | null; text: string; ts: string }>>;
}

export class MuseDuties {
  findings: SweepFinding[] = [];
  private siblingFails = new Map<string, number>();
  private siblingDown = new Set<string>();
  private stallPosted = new Set<string>();
  private pollerDown = false;

  constructor(
    private readonly brain: BrainApi,
    private readonly registry: Registry,
    private readonly poster: Poster,
    private readonly slack: HistoryReader,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly alert: (code: string, ids?: Record<string, string | number | null>) => void,
    private readonly fetchHealth: (port: number) => Promise<boolean>,
    private readonly tz: string = 'America/New_York',
  ) {}

  private caos(): CaoEntry[] {
    return this.registry.caos.filter((c) => !isPlaceholder(c.agentName));
  }

  private async lastCaoMessageAt(cao: CaoEntry): Promise<number | null> {
    try {
      const oldest = String((this.clock() - DAY) / 1000);
      const msgs = await this.slack.history(cao.channelId, oldest);
      let last: number | null = null;
      for (const m of msgs) {
        if (m.user !== cao.botUserId || isRelayTemplate(m.text)) continue;
        const at = Number(m.ts) * 1000;
        if (Number.isFinite(at) && (last === null || at > last)) last = at;
      }
      return last;
    } catch {
      return null;
    }
  }

  /**
   * Every 6 hours. Flags (1) stalled and (2) unclosed, separately, matching on
   * fire id. Detection timing (R7-NEW-1): a run is flagged by the FIRST sweep
   * after 6 hours of silence — so between 6 and 12 hours after its last
   * activity, not "within 6 hours". The warning is posted to the CAO's channel
   * at once when flagged (once per silence), and listed again in the next 9am message.
   */
  async sweep(opts: { post?: boolean } = {}): Promise<SweepFinding[]> {
    const now = this.clock();
    const out: SweepFinding[] = [];
    for (const cao of this.caos()) {
      let rows: FireRow[];
      try {
        rows = await this.brain.listFireRows(cao.agentName, ['claimed', 'started', 'linked']);
      } catch {
        this.log.warn('sweep: brain unreachable', { cao: cao.key });
        continue;
      }
      if (rows.length === 0) continue;
      const msgAt = await this.lastCaoMessageAt(cao);
      for (const row of rows) {
        const ev = relayEvidence(row);
        const progress = Date.parse(ev?.last_progress_at ?? row.fired_at ?? '');
        const verdict = assessRun({
          liveState: null, // no v1 adapter has a live probe (KAR-6): prong (a) does not apply
          channelMsgAt: msgAt,
          rowStatus: row.status ?? '',
          lastAdapterEntryAt: Number.isFinite(progress) ? progress : null,
          now,
        });
        if (verdict.stalled) {
          out.push({ cao: cao.key, fireId: row.id, kind: 'stalled' });
          const key = `${row.id}|${verdict.lastActivity ?? 'none'}`;
          if (opts.post !== false && !this.stallPosted.has(key)) {
            this.stallPosted.add(key);
            this.alert('run-stalled', { cao: cao.key, fireId: row.id });
            await this.poster.post(cao.channelId, T.stalled(row.id), 'template', row.id);
          }
        }
        if (verdict.unclosed) out.push({ cao: cao.key, fireId: row.id, kind: 'unclosed' });
      }
    }
    this.findings = out;
    return out;
  }

  /** 9am: clear the already-running lock of runs stalled 6 hours (D4 lock-clear actor: the Muse relay program). */
  async clearStalledLocks(): Promise<void> {
    const now = this.clock();
    for (const cao of this.caos()) {
      const rows = await this.brain.listFireRows(cao.agentName, ['claimed', 'started', 'linked']).catch(() => [] as FireRow[]);
      for (const row of rows) {
        const ev = relayEvidence(row);
        if (!ev || ev.lock_cleared) continue;
        const progress = Date.parse(ev.last_progress_at ?? row.fired_at ?? '');
        if (!Number.isFinite(progress) || now - progress < STALL_MS) continue;
        const next: RelayEvidence = { ...ev, v: ev.v + 1, lock_cleared: { by: 'cao-relay-muse', at: iso(now) } };
        const ok = await this.brain.patchFireRow(row.id, { evidence: next }, { version: ev.v }).catch(() => null);
        if (ok) this.log.info('stalled lock cleared', { cao: cao.key, fireId: row.id });
      }
    }
  }

  /** 9am: the daily open in #cao-bots — what is open, what each CAO owes, pending starts, and sweep warnings. */
  async dailyOpen(): Promise<void> {
    const now = this.clock();
    const open: string[] = [];
    const owed: string[] = [];
    const pending: string[] = [];
    for (const cao of this.caos()) {
      const closed = await this.brain.listFireRows(cao.agentName, ['closed']).catch(() => [] as FireRow[]);
      for (const row of closed) {
        if (now - Date.parse(row.completed_at ?? '') > DAY) continue;
        const items = (relayEvidence(row)?.closeout?.still_open ?? 'None').split(';').map((s) => s.trim()).filter((s) => s && s !== 'None');
        for (const it of items) {
          open.push(`${cao.displayName}: ${it}`);
          const m = /Owner:\s*(.+?)\.?$/i.exec(it);
          if (m?.[1]) owed.push(`${m[1]} — ${it.replace(/\s*Owner:.*$/i, '')}`);
        }
      }
      const queued = await this.brain.listFireRows(cao.agentName, ['queued']).catch(() => [] as FireRow[]);
      for (const row of queued) pending.push(`${cao.displayName} — fire id ${row.id}`);
    }
    const byId = new Map<string, string>(this.registry.caos.map((c) => [c.key, c.displayName]));
    const stalled = this.findings.map((f) => `${byId.get(f.cao) ?? f.cao} fire id ${f.fireId}${f.kind === 'unclosed' ? ' (not closed after 24 hours)' : ''}`);
    await this.poster.post(this.registry.caoBotsChannelId, T.dailyOpen(open, owed, pending, stalled), 'template');
  }

  /**
   * Nightly: brain rows are retained 90 days, then archived to the vault (D6
   * store table). R7-FU-12 — home and format: terminal start rows older than
   * 90 days are exported to /var/lib/cao-relay/muse/archive/brain-archive-<YYYY-MM>.jsonl
   * (JSON lines, one full agent_comms row per line, task text in `body`) and marked
   * `archived_at`. The nightly cao-relay-offhost-copy.sh files that directory into
   * the vault at $VAULT_ARCHIVE_PATH within a day, where the retrieval test can
   * find it. Rows are NOT deleted from the brain: deletion after archive is a
   * COUNCIL GATE decision.
   */
  async archiveOldRows(dir: string): Promise<number> {
    const now = this.clock();
    let n = 0;
    let archived: Set<string> | null = null;
    for (const cao of this.caos()) {
      const rows = await this.brain.listFireRows(cao.agentName, ['closed', 'failed', 'expired', 'refused', 'cancelled']).catch(() => [] as FireRow[]);
      for (const row of rows) {
        const ev = relayEvidence(row);
        const done = Date.parse(row.completed_at ?? row.fired_at ?? '');
        if (!ev || ev.archived_at || !Number.isFinite(done) || now - done < BRAIN_ROW_RETENTION_MS) continue;
        // ECO-FU-4: if an earlier night appended this row but its `archived_at` patch failed, do not append it again.
        if (archived === null) archived = archivedIds(dir);
        if (!archived.has(row.id)) {
          const month = iso(now).slice(0, 7);
          appendLineSync(join(dir, `brain-archive-${month}.jsonl`), JSON.stringify(row), 0o640);
          archived.add(row.id);
        }
        const ok = await this.brain.patchFireRow(row.id, { evidence: { ...ev, v: ev.v + 1, archived_at: iso(now) } }, { version: ev.v }).catch(() => null);
        if (ok) n++;
      }
    }
    return n;
  }

  /**
   * R7-NEW-5 — breaks the dead-alerter circle. The mini poller writes its own
   * cao_heartbeat row (agent MINI-POLLER) every minute; this program checks it
   * every minute. Stale over 5 minutes → alert + visible post in #cao-bots, once
   * per incident. If BOTH this program and the poller are down, Claude CAO's
   * own 9am check-in (`cao-relay checkin-report`) shows both stale heartbeats.
   */
  async watchPoller(): Promise<void> {
    let age: number;
    try {
      const hb = await this.brain.getHeartbeat(POLLER_AGENT);
      age = hb ? this.clock() - Date.parse(hb.heartbeat_at) : Number.POSITIVE_INFINITY;
    } catch {
      return; // brain down: the lease rule already stops this program
    }
    if (age > POLLER_STALE_MS && !this.pollerDown) {
      this.pollerDown = true;
      this.alert('mini-poller-stale', { ageMs: Number.isFinite(age) ? age : null });
      await this.poster.post(this.registry.caoBotsChannelId, T.pollerDown(), 'template');
    } else if (age <= POLLER_STALE_MS && this.pollerDown) {
      this.pollerDown = false;
      await this.poster.post(this.registry.caoBotsChannelId, T.pollerBack(), 'template');
    }
  }

  /**
   * R5-FU-9 — the nightly off-host copy check against the brain rows. `copyIds`
   * are the fire ids found in last night's journal copy for `cao`. Any brain row
   * fired 1–23 hours ago (not refused) with no id in the copy is a gap: posted in
   * #cao-bots and alerted.
   */
  async copyCheck(cao: CaoEntry, copyIds: string[]): Promise<{ gap: number }> {
    const now = this.clock();
    const seen = new Set(copyIds);
    const statuses = ['queued', 'claimed', 'started', 'linked', 'closed', 'failed', 'expired', 'cancelled'];
    const rows = await this.brain.listFireRows(cao.agentName, statuses);
    const gap = rows.filter((r) => {
      const at = Date.parse(r.fired_at ?? '');
      return Number.isFinite(at) && now - at >= HOUR && now - at <= 23 * HOUR && !seen.has(r.id);
    });
    if (gap.length > 0) {
      this.alert('offhost-copy-gap', { cao: cao.key, gap: gap.length });
      await this.poster.post(this.registry.caoBotsChannelId, T.copyGap(cao, gap.length), 'template');
    }
    return { gap: gap.length };
  }

  /**
   * ECO-FU-3 — the Monday review, measured. Every Monday at the 9am check-in
   * the Muse program counts last week's starts (total and per CAO, from the
   * brain rows) and the fired-run tokens reported at close-out, compares them
   * with the floor (5 starts a week) and the weekly share of the token ceiling,
   * appends the line to <stateDir>/weekly-review.jsonl, and alerts Muse CAO with
   * the numbers. If the total is below the floor for two reviews in a row AND
   * did not rise (flat trend), it raises `kill-switch-condition-met`. Pausing
   * stays Muse CAO's decision (runbook §12). Review tokens (≤50,000 a week) are
   * Muse CAO's own harness spend: recorded as null here, filled in at the review.
   */
  async weeklyReview(stateDir: string, caps: { monthlyTokenCeiling: number; weeklyFloor: number }): Promise<WeeklyReview> {
    const now = this.clock();
    const until = startOfLocalWeek(now, this.tz);
    const since = startOfLocalWeek(until - 1, this.tz);
    const perCao: Record<string, number> = {};
    let total = 0;
    let tokens = 0;
    let unmetered = 0;
    for (const cao of this.caos()) {
      const n = await this.brain.countStarts(iso(since), cao.agentName, iso(until));
      perCao[cao.key] = n;
      total += n;
      const closed = await this.brain.listFireRows(cao.agentName, ['closed']).catch(() => [] as FireRow[]);
      for (const r of closed) {
        const done = Date.parse(r.completed_at ?? '');
        if (!Number.isFinite(done) || done < since || done >= until) continue;
        const t = relayEvidence(r)?.closeout?.tokens;
        if (typeof t === 'number') tokens += t;
        else unmetered++;
      }
    }
    const path = join(stateDir, 'weekly-review.jsonl');
    const prev = (readJsonLines(path).values as WeeklyReview[]).at(-1) ?? null;
    const belowFloor = total < caps.weeklyFloor;
    const weeklyTokenShare = Math.round((caps.monthlyTokenCeiling * 7) / 30);
    const review: WeeklyReview = {
      weekStart: iso(since),
      weekEnd: iso(until),
      startsTotal: total,
      startsPerCao: perCao,
      firedRunTokens: tokens,
      unmeteredRuns: unmetered,
      weeklyTokenShare,
      overTokenShare: tokens > weeklyTokenShare,
      reviewTokens: null,
      belowFloor,
      killSwitchCondition: belowFloor && !!prev && prev.belowFloor && total <= prev.startsTotal,
    };
    if (prev?.weekStart === review.weekStart) return prev; // already reviewed this week
    appendLineSync(path, JSON.stringify(review), 0o600);
    this.alert('weekly-review-ready', { startsTotal: total, firedRunTokens: tokens, belowFloor: belowFloor ? 1 : 0 });
    if (review.killSwitchCondition) this.alert('kill-switch-condition-met', { startsTotal: total, previous: prev?.startsTotal ?? null });
    if (review.overTokenShare) this.alert('weekly-tokens-over-ceiling-share', { firedRunTokens: tokens, weeklyTokenShare });
    return review;
  }

  /** Every minute: the visible failure for a sibling program that is down (e.g. its token was revoked). */
  async watchSiblings(): Promise<void> {
    for (const cao of this.caos()) {
      if (cao.key === 'muse') continue;
      const up = await this.fetchHealth(cao.healthPort).catch(() => false);
      if (up) {
        this.siblingFails.set(cao.key, 0);
        if (this.siblingDown.delete(cao.key)) await this.poster.post(this.registry.caoBotsChannelId, T.relayBack(cao), 'template');
        continue;
      }
      const n = (this.siblingFails.get(cao.key) ?? 0) + 1;
      this.siblingFails.set(cao.key, n);
      if (n >= 3 && !this.siblingDown.has(cao.key)) {
        this.siblingDown.add(cao.key);
        this.alert('sibling-relay-down', { cao: cao.key });
        await this.poster.post(this.registry.caoBotsChannelId, T.relayDown(cao), 'template');
      }
    }
  }
}

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  startsTotal: number;
  startsPerCao: Record<string, number>;
  firedRunTokens: number;
  unmeteredRuns: number;
  weeklyTokenShare: number;
  overTokenShare: boolean;
  reviewTokens: number | null;
  belowFloor: boolean;
  killSwitchCondition: boolean;
}

/** Row ids already in the brain-archive files (ECO-FU-4 duplicate guard). */
function archivedIds(dir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const name of readdirSync(dir)) {
    if (!/^brain-archive-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    for (const v of readJsonLines(join(dir, name)).values) {
      const id = (v as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}
