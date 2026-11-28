// The brain (Supabase NI Brain, project uaztknnipdxxptrmlxlb), reached ONLY through the four public
// wrapper functions of supabase/migrations/0004_relay_to_aos.sql:
//   aos_relay_select / aos_relay_upsert / aos_relay_update / aos_relay_delete
// over three tables in the `aos` schema (which is off the REST API):
//   aos.cao_relay_lease, aos.cao_heartbeat, aos.relay_pointers
// Message text stays in Slack. The brain keeps pointer rows only: where a relayed message lives
// (slack_link), the fire it started (fire_id) and a state (posted, delivered, answered, failed).
// No column anywhere holds a body. the old comms table is retired and is not read or written here.
//
// The finer run state (claimed, started, linked, closed ...) and the evidence block (hashes, claim,
// close-out facts) are this relay's own bookkeeping; they live in the relay's local ledger
// (src/ledger.ts), not in the brain.
//
// Key placement: the `apikey` header only (RUNBOOK Phase 1 key store). The key must be the service_role key:
// the wrappers are granted to service_role only.

import { randomBytes } from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { z } from 'zod';
import type { FireLedger, LedgerRec } from './ledger.js';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** Brain-row statuses for a start (D4 manual state machine). Kept as the relay's own fine state. */
export const ROW_STATUSES = ['queued', 'claimed', 'started', 'linked', 'closed', 'failed', 'expired', 'refused', 'cancelled'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
export const TERMINAL_ROW_STATUSES: ReadonlySet<string> = new Set(['closed', 'failed', 'expired', 'refused', 'cancelled']);

/** The pointer states in aos.relay_pointers. */
export const POINTER_STATES = ['posted', 'delivered', 'answered', 'failed'] as const;
export type PointerState = (typeof POINTER_STATES)[number];

/** Fine run state -> the coarse state the brain keeps. */
export function pointerStateFor(status: string): PointerState {
  switch (status) {
    case 'queued':
      return 'posted';
    case 'claimed':
    case 'started':
    case 'linked':
      return 'delivered';
    case 'closed':
      return 'answered';
    default:
      return 'failed'; // failed, expired, refused, cancelled
  }
}

/** Coarse pointer state -> the nearest fine state (for rows another relay wrote: its evidence is not here). */
export function statusForPointer(state: string): RowStatus {
  switch (state) {
    case 'posted':
      return 'queued';
    case 'delivered':
      return 'claimed';
    case 'answered':
      return 'closed';
    default:
      return 'failed';
  }
}

/** The relay's evidence block for one run. Ids, hashes, links and states only. */
export const RelayEvidenceSchema = z.object({
  v: z.number().int().nonnegative(), // optimistic-concurrency version for read-modify-write
  cao: z.string(),
  task_hash: z.string(),
  norm_hash: z.string(),
  idem_key: z.string().optional(),
  epoch: z.number().int(),
  slack: z
    .object({ channel_id: z.string(), ts: z.string().nullable(), permalink: z.string().nullable() })
    .optional(),
  reply_ts: z.string().nullable().optional(),
  run_chat_url: z.string().nullable().optional(),
  link_posted_at: z.string().nullable().optional(),
  last_progress_at: z.string().optional(), // last state-changing entry by the CAO's own adapter
  claim: z.object({ name: z.string(), at: z.string() }).optional(),
  lock_cleared: z.object({ by: z.string(), at: z.string() }).optional(),
  closeout: z
    .object({
      requested_at: z.string(),
      vault_log_path: z.string(),
      session_url: z.string().nullable(),
      tokens: z.number().int().nonnegative().nullable(),
      minutes: z.number().nonnegative().nullable(),
      still_open: z.string().nullable().optional(), // filled after the vault read-back (vault-filed text only)
      map_permalink: z.string().nullable().optional(),
    })
    .optional(),
  writer: z.string().optional(),
  archived_at: z.string().optional(), // set once the row has been exported to the vault archive (90-day retention)
});
export type RelayEvidence = z.infer<typeof RelayEvidenceSchema>;

/** One run as the relay sees it. There is no body: the task text lives in Slack, behind `slack_link`. */
export interface FireRow {
  id: string; // the pointer row id: relay-<yyyymmddhhmmss>-<4 hex>
  created_at?: string | null;
  from_agent?: string | null;
  to_agent?: string | null;
  status?: string | null;
  fired_at?: string | null;
  completed_at?: string | null;
  evidence?: unknown;
  slack_link?: string | null;
}

export function relayEvidence(row: FireRow): RelayEvidence | null {
  const ev = row.evidence;
  if (!ev || typeof ev !== 'object') return null;
  const r = RelayEvidenceSchema.safeParse((ev as { relay?: unknown }).relay);
  return r.success ? r.data : null;
}

export const LeaseRowSchema = z.object({
  name: z.string(),
  epoch: z.number().int(),
  holder: z.string(),
  acquired_at: z.string(),
  heartbeat_at: z.string(),
  expires_at: z.string(),
});
export type LeaseRow = z.infer<typeof LeaseRowSchema>;

export const HeartbeatRowSchema = z.object({ agent: z.string(), heartbeat_at: z.string() });
export type HeartbeatRow = z.infer<typeof HeartbeatRowSchema>;

export const PointerRowSchema = z.object({
  row_id: z.string(),
  from_cao: z.string(),
  to_cao: z.string(),
  slack_channel: z.string(),
  slack_link: z.string(),
  fire_id: z.string().nullable().optional(),
  state: z.string(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type PointerRow = z.infer<typeof PointerRowSchema>;

export interface NewFireRow {
  toAgent: string;
  fromAgent: string;
  toHarness: string; // the target CAO key
  evidence: RelayEvidence;
  firedAt: string;
}

export interface FirePatch {
  status?: RowStatus;
  completed_at?: string | null;
  evidence?: RelayEvidence;
}

export interface FirePatchGuard {
  statusIn?: string[]; // only patch if the current status is one of these
  version?: number; // only patch if evidence.relay.v equals this
}

/** Every brain operation the relay uses. */
export interface BrainApi {
  ping(): Promise<void>;
  insertFireRow(row: NewFireRow): Promise<FireRow>;
  getFireRow(id: string): Promise<FireRow | null>;
  listFireRows(toAgent: string, statuses: readonly string[]): Promise<FireRow[]>;
  findFireRowByIdem(toAgent: string, idemKey: string): Promise<FireRow | null>;
  patchFireRow(id: string, patch: FirePatch, guard?: FirePatchGuard): Promise<FireRow | null>;
  getLease(name: string): Promise<LeaseRow | null>;
  insertLease(row: LeaseRow): Promise<LeaseRow | null>; // null = another relay took the new row first
  casLease(name: string, expectEpoch: number, next: LeaseRow): Promise<LeaseRow | null>; // null = lost the race
  renewLease(name: string, epoch: number, heartbeatAt: string, expiresAt: string): Promise<LeaseRow | null>; // null = epoch is stale
  upsertHeartbeat(agent: string, at: string): Promise<void>;
  getHeartbeat(agent: string): Promise<HeartbeatRow | null>;
  /** Push every pointer state the brain has not yet confirmed (the ledger is written first; the brain follows). Returns rows synced. */
  syncPointers?(): Promise<number>;
}

export class BrainError extends Error {
  constructor(
    readonly code: 'unreachable' | 'timeout' | 'http' | 'shape',
    readonly status: number | null,
  ) {
    super(`brain ${code}${status !== null ? ' ' + status : ''}`);
    this.name = 'BrainError';
  }
}

// ---------------------------------------------------------------------------
// The aosRelay client: select, upsert and update over the wrappers (aos_relay_delete exists in the SQL; this relay does not call it)
// ---------------------------------------------------------------------------

export type RelayTable = 'cao_relay_lease' | 'cao_heartbeat' | 'relay_pointers';
export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
/** `{"col": value}` is equals; `{"col": {"lt": v}}` also takes ne, lte, gt, gte. */
export type Filter = Record<string, unknown>;

export interface AosRelayApi {
  select(table: RelayTable, filter: Filter, limit?: number): Promise<unknown[]>;
  /** `onConflict: 'nothing'` inserts only when the key is new (returns [] if the row already existed). */
  upsert(table: RelayTable, row: Record<string, unknown>, conflict: string, onConflict?: 'update' | 'nothing'): Promise<unknown[]>;
  /** Compare-and-swap: returns the number of rows changed. */
  update(table: RelayTable, filter: Filter, patch: Record<string, unknown>): Promise<number>;
}

export interface HttpAosRelayOptions {
  supabaseUrl: string; // <SUPABASE_URL>, from the environment
  apiKey: string; // the service_role key, read from the tmpfs credential file, never logged
  httpsProxy?: string | null;
  timeoutMs?: number;
}

export class HttpAosRelay implements AosRelayApi {
  private readonly base: string;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpAosRelayOptions) {
    this.base = opts.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/';
    this.dispatcher = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : undefined;
    this.timeoutMs = opts.timeoutMs ?? 2500;
  }

  private async rpc(fn: string, body: Record<string, unknown>): Promise<unknown> {
    let res;
    try {
      res = await undiciFetch(this.base + fn, {
        method: 'POST',
        headers: { apikey: this.opts.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        dispatcher: this.dispatcher,
      });
    } catch (err) {
      const name = err && typeof err === 'object' ? (err as { name?: string }).name : '';
      throw new BrainError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', null);
    }
    const text = await res.text();
    if (res.status >= 400) throw new BrainError('http', res.status); // body never surfaced: it can echo input
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new BrainError('shape', res.status);
    }
  }

  private static arr(json: unknown): unknown[] {
    if (!Array.isArray(json)) throw new BrainError('shape', null);
    return json;
  }

  private static count(json: unknown): number {
    if (typeof json !== 'number' || !Number.isInteger(json)) throw new BrainError('shape', null);
    return json;
  }

  async select(table: RelayTable, filter: Filter, limit = 100): Promise<unknown[]> {
    return HttpAosRelay.arr(await this.rpc('aos_relay_select', { p_table: table, p_filter: filter, p_limit: limit }));
  }

  async upsert(table: RelayTable, row: Record<string, unknown>, conflict: string, onConflict: 'update' | 'nothing' = 'update'): Promise<unknown[]> {
    return HttpAosRelay.arr(await this.rpc('aos_relay_upsert', { p_table: table, p_row: row, p_conflict: conflict, p_on_conflict: onConflict }));
  }

  async update(table: RelayTable, filter: Filter, patch: Record<string, unknown>): Promise<number> {
    return HttpAosRelay.count(await this.rpc('aos_relay_update', { p_table: table, p_filter: filter, p_patch: patch }));
  }
}

// ---------------------------------------------------------------------------
// Pointer helpers
// ---------------------------------------------------------------------------

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `relay-<yyyymmddhhmmss>-<4 hex>`, made by the relay (UTC). */
export function newRelayRowId(nowMs: number, rand: () => string = () => randomBytes(2).toString('hex')): string {
  const d = new Date(nowMs);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `relay-${stamp}-${rand()}`;
}

/** A Slack message link built from its parts: https://<domain>/archives/<channel>/p<ts without the dot>. */
export function slackLinkFor(domain: string, channelId: string, ts: string | null): string {
  const base = `https://${domain}/archives/${channelId}`;
  return ts && /^\d+\.\d+$/.test(ts) ? `${base}/p${ts.replace('.', '')}` : base;
}

/** Channel id and message ts back out of a slack_link (for fetching the text from Slack). */
export function parseSlackLink(link: string): { channelId: string; ts: string | null } | null {
  const m = /^https:\/\/[a-z0-9.-]+\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?(?:[/?#].*)?$/i.exec(link);
  if (!m?.[1]) return null;
  return { channelId: m[1], ts: m[2] && m[3] ? `${m[2]}.${m[3]}` : null };
}

/** What DirectBrain needs to know about the four CAOs to write a pointer. */
export interface PointerDirectory {
  slackDomain: string; // e.g. northsidevent-jtb2955.slack.com
  caoBotsChannelId: string;
  caos: ReadonlyArray<{ key: string; agentName: string; channelId: string; channelName: string }>;
}

export interface DirectBrainOptions {
  supabaseUrl?: string; // <SUPABASE_URL>, from the environment
  apiKey?: string; // service_role key from the tmpfs credential file, never logged
  httpsProxy?: string | null;
  timeoutMs?: number;
  relay?: AosRelayApi; // tests pass a stub wrapper; otherwise the HTTP client over supabaseUrl + apiKey
  ledger?: FireLedger | null; // this relay's own run ledger; absent for the poller and the cron tools
  directory?: PointerDirectory; // needed for fire rows (pointers); not for leases and heartbeats
  clock?: () => number;
  randomHex?: () => string;
  onNoPointer?: (ids: { fireId: string; reason: string }) => void; // a run that cannot have a pointer row (alert, ids only)
}

export class DirectBrain implements BrainApi {
  private readonly relay: AosRelayApi;
  private readonly ledger: FireLedger | null;
  private readonly clock: () => number;
  private readonly held = new Map<string, LeaseRow>(); // the lease rows this relay took (renew needs no re-read)

  constructor(private readonly opts: DirectBrainOptions) {
    if (opts.relay) this.relay = opts.relay;
    else {
      if (!opts.supabaseUrl || !opts.apiKey) throw new Error('DirectBrain needs supabaseUrl and apiKey');
      this.relay = new HttpAosRelay({ supabaseUrl: opts.supabaseUrl, apiKey: opts.apiKey, httpsProxy: opts.httpsProxy ?? null, timeoutMs: opts.timeoutMs ?? 2500 });
    }
    this.ledger = opts.ledger ?? null;
    this.clock = opts.clock ?? Date.now;
  }

  private dir(): PointerDirectory {
    if (!this.opts.directory) throw new Error('DirectBrain needs a pointer directory for fire rows');
    return this.opts.directory;
  }

  private keyForAgent(agent: string | null | undefined): string | null {
    return this.dir().caos.find((c) => c.agentName === agent)?.key ?? null;
  }

  private agentForKey(key: string): string {
    return this.dir().caos.find((c) => c.key === key)?.agentName ?? key;
  }

  private rows<T>(json: unknown[], schema: z.ZodType<T>): T[] {
    return json.map((r) => {
      const p = schema.safeParse(r);
      if (!p.success) throw new BrainError('shape', null);
      return p.data;
    });
  }

  async ping(): Promise<void> {
    await this.relay.select('cao_heartbeat', {}, 1);
  }

  // ---- pointers ------------------------------------------------------------

  /** The pointer a run would have, or null when it cannot have one (unknown sender or target, or a CAO writing to itself). */
  private pointerFor(rec: LedgerRec): Record<string, unknown> | null {
    return this.pointerOrWhy(rec).pointer;
  }

  private pointerOrWhy(rec: LedgerRec): { pointer: Record<string, unknown> | null; why: string } {
    const d = this.dir();
    const to = this.keyForAgent(rec.to_agent);
    const from = this.keyForAgent(rec.from_agent);
    if (!to) return { pointer: null, why: 'unknown-target' };
    if (!from) return { pointer: null, why: 'sender-not-a-cao' };
    if (from === to) return { pointer: null, why: 'same-cao' }; // the table needs two different CAOs
    const ev = rec.evidence;
    const channelId = ev.slack?.channel_id ?? d.caos.find((c) => c.key === to)?.channelId ?? d.caoBotsChannelId;
    const channelName = channelId === d.caoBotsChannelId ? 'cao-bots' : (d.caos.find((c) => c.channelId === channelId)?.channelName ?? d.caos.find((c) => c.key === to)?.channelName ?? 'cao-bots');
    return {
      why: '',
      pointer: {
        row_id: rec.id,
        from_cao: from,
        to_cao: to,
        slack_channel: channelName,
        slack_link: ev.slack?.permalink ?? slackLinkFor(d.slackDomain, channelId, ev.slack?.ts ?? null),
        fire_id: rec.id, // shortcut: the run id is the fire id; the wake id of an automatic start is not a separate value in this relay
        state: pointerStateFor(rec.status),
      },
    };
  }

  /** Tell the owner (an alert with ids only) when a run has no pointer, unless the sender is plainly not a CAO (a person's start). */
  private noPointer(rec: LedgerRec): void {
    const { pointer, why } = this.pointerOrWhy(rec);
    if (pointer || why === 'sender-not-a-cao') return;
    this.opts.onNoPointer?.({ fireId: rec.id, reason: why });
  }

  private async writePointer(rec: LedgerRec): Promise<void> {
    const p = this.pointerFor(rec);
    if (!p) return this.noPointer(rec);
    await this.relay.upsert('relay_pointers', p, 'row_id');
  }

  /** Move a pointer to the state of `rec.status`; a pointer that is missing is written whole. updated_at is the database's (trigger). */
  private async setPointerState(rec: LedgerRec): Promise<void> {
    if (!this.pointerFor(rec)) return this.noPointer(rec);
    const n = await this.relay.update('relay_pointers', { row_id: rec.id }, { state: pointerStateFor(rec.status) });
    if (n === 0) await this.writePointer(rec);
  }

  /** Mark a ledger record synced only if its coarse state is still the one that was pushed. */
  private markSynced(id: string, pushedState: PointerState): void {
    const cur = this.ledger?.get(id);
    if (cur && pointerStateFor(cur.status) === pushedState && !cur.pointer_synced) this.ledger?.put({ ...cur, pointer_synced: true });
  }

  async syncPointers(): Promise<number> {
    if (!this.ledger) return 0;
    let n = 0;
    for (const rec of this.ledger.list()) {
      if (rec.pointer_synced) continue;
      try {
        await this.setPointerState(rec);
      } catch {
        return n; // the brain is still down: the next minute tries again
      }
      this.markSynced(rec.id, pointerStateFor(rec.status));
      n++;
    }
    return n;
  }

  private toFireRow(rec: LedgerRec): FireRow {
    return {
      id: rec.id,
      created_at: rec.created_at,
      from_agent: rec.from_agent,
      to_agent: rec.to_agent,
      status: rec.status,
      fired_at: rec.fired_at,
      completed_at: rec.completed_at,
      evidence: { relay: structuredClone(rec.evidence) },
      slack_link: rec.slack_link,
    };
  }

  /** A run another relay wrote: only the pointer is here. Its evidence stays with that relay. */
  private fromPointer(p: PointerRow): FireRow {
    const status = statusForPointer(p.state);
    return {
      id: p.row_id,
      created_at: p.created_at ?? null,
      from_agent: this.agentForKey(p.from_cao),
      to_agent: this.agentForKey(p.to_cao),
      status,
      fired_at: p.created_at ?? null,
      completed_at: TERMINAL_ROW_STATUSES.has(status) ? (p.updated_at ?? null) : null,
      evidence: null,
      slack_link: p.slack_link,
    };
  }

  // ---- fire rows -------------------------------------------------------------

  async insertFireRow(row: NewFireRow): Promise<FireRow> {
    if (!this.ledger) throw new Error('fire rows need the relay ledger');
    const now = this.clock();
    const created = new Date(now).toISOString();
    const id = newRelayRowId(now, this.opts.randomHex);
    const d = this.dir();
    const ev = row.evidence;
    const rec: LedgerRec = {
      id,
      created_at: created,
      from_agent: row.fromAgent,
      to_agent: row.toAgent,
      status: 'queued',
      fired_at: row.firedAt,
      completed_at: null,
      evidence: ev,
      slack_link: ev.slack?.permalink ?? slackLinkFor(d.slackDomain, ev.slack?.channel_id ?? d.caoBotsChannelId, ev.slack?.ts ?? null),
      pointer_synced: false,
    };
    this.ledger.put(rec); // local first: a pointer write that times out is adopted by the retry (findFireRowByIdem)
    await this.writePointer(rec);
    this.markSynced(id, pointerStateFor(rec.status));
    return this.toFireRow({ ...rec, pointer_synced: true });
  }

  async getFireRow(id: string): Promise<FireRow | null> {
    const rec = this.ledger?.get(id);
    if (rec) return this.toFireRow(rec);
    const [p] = this.rows(await this.relay.select('relay_pointers', { row_id: id }, 1), PointerRowSchema);
    return p ? this.fromPointer(p) : null;
  }

  async listFireRows(toAgent: string, statuses: readonly string[]): Promise<FireRow[]> {
    const own = (this.ledger?.list() ?? []).filter((r) => r.to_agent === toAgent && statuses.includes(r.status));
    const ownIds = new Set((this.ledger?.list() ?? []).map((r) => r.id));
    const out = own.map((r) => this.toFireRow(r));
    const to = this.keyForAgent(toAgent);
    if (to) {
      // Pointers another relay wrote for this CAO (the Muse program's view of its siblings): one read per state.
      // shortcut: the select wrapper has no ORDER BY, so the read is bounded by a 30-day created_at window and a 500-row cap.
      const since = new Date(this.clock() - 30 * 24 * 3600_000).toISOString();
      const states = [...new Set(statuses.map(pointerStateFor))];
      for (const state of states) {
        const ps = this.rows(await this.relay.select('relay_pointers', { to_cao: to, state, created_at: { gte: since } }, 500), PointerRowSchema);
        for (const p of ps) {
          if (ownIds.has(p.row_id)) continue;
          const row = this.fromPointer(p);
          if (statuses.includes(row.status ?? '')) out.push(row);
        }
      }
    }
    return out.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  }

  async findFireRowByIdem(toAgent: string, idemKey: string): Promise<FireRow | null> {
    const rec = this.ledger?.list().find((r) => r.to_agent === toAgent && r.evidence.idem_key === idemKey);
    if (!rec) return null;
    if (!rec.pointer_synced) {
      await this.writePointer(rec);
      this.markSynced(rec.id, pointerStateFor(rec.status));
    }
    return this.toFireRow(rec);
  }

  async patchFireRow(id: string, patch: FirePatch, guard?: FirePatchGuard): Promise<FireRow | null> {
    const rec = this.ledger?.get(id);
    if (!rec) return null;
    if (guard?.statusIn && !guard.statusIn.includes(rec.status)) return null;
    if (guard?.version !== undefined && rec.evidence.v !== guard.version) return null;
    const next: LedgerRec = { ...rec, evidence: patch.evidence ?? rec.evidence };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.completed_at !== undefined) next.completed_at = patch.completed_at;
    // The ledger first, with the pointer marked unsynced; the brain follows. A brain that is down never loses the state:
    // syncPointers() pushes it at start-up and every minute.
    const pointerChanged = pointerStateFor(next.status) !== pointerStateFor(rec.status) || !rec.pointer_synced;
    if (pointerChanged) next.pointer_synced = false;
    this.ledger?.put(next);
    if (pointerChanged) {
      try {
        await this.setPointerState(next);
        this.markSynced(id, pointerStateFor(next.status));
      } catch {
        // left unsynced on purpose
      }
    }
    return this.toFireRow(next);
  }

  // ---- lease and heartbeat (aos.cao_relay_lease, aos.cao_heartbeat) -------------

  async getLease(name: string): Promise<LeaseRow | null> {
    return this.rows(await this.relay.select('cao_relay_lease', { name }, 1), LeaseRowSchema)[0] ?? null;
  }

  /** Insert-do-nothing: null when a row for this name already exists (the caller re-reads and competes on epoch). */
  async insertLease(row: LeaseRow): Promise<LeaseRow | null> {
    const got = await this.relay.upsert('cao_relay_lease', { ...row }, 'name', 'nothing');
    const taken = this.rows(got, LeaseRowSchema)[0] ?? null;
    if (taken) this.held.set(taken.name, taken);
    return taken;
  }

  /** Compare-and-swap on name + epoch; `next.epoch` is the old epoch + 1. Rows changed = 1 means this relay holds it. */
  async casLease(name: string, expectEpoch: number, next: LeaseRow): Promise<LeaseRow | null> {
    const n = await this.relay.update('cao_relay_lease', { name, epoch: expectEpoch }, {
      epoch: next.epoch,
      holder: next.holder,
      acquired_at: next.acquired_at,
      heartbeat_at: next.heartbeat_at,
      expires_at: next.expires_at,
    });
    if (n !== 1) return null;
    this.held.set(name, { ...next });
    return { ...next };
  }

  async renewLease(name: string, epoch: number, heartbeatAt: string, expiresAt: string): Promise<LeaseRow | null> {
    const n = await this.relay.update('cao_relay_lease', { name, epoch }, { heartbeat_at: heartbeatAt, expires_at: expiresAt });
    if (n !== 1) return null;
    const known = this.held.get(name);
    const row = known && known.epoch === epoch ? { ...known, heartbeat_at: heartbeatAt, expires_at: expiresAt } : await this.getLease(name);
    if (row) this.held.set(name, row);
    return row;
  }

  async upsertHeartbeat(agent: string, at: string): Promise<void> {
    await this.relay.upsert('cao_heartbeat', { agent, heartbeat_at: at }, 'agent');
  }

  async getHeartbeat(agent: string): Promise<HeartbeatRow | null> {
    return this.rows(await this.relay.select('cao_heartbeat', { agent }, 1), HeartbeatRowSchema)[0] ?? null;
  }
}
