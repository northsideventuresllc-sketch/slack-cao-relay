// Configuration: the CAO registry (config/registry.json) and the process
// environment, both validated with Zod. No secret values live here — keys are
// read from systemd credential files at start (see src/credentials.ts).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { withLegacyEnv } from './legacy.js';

export const CAO_KEYS = ['muse', 'claude', 'gemini', 'axon-hermes'] as const;
export type CaoKey = (typeof CAO_KEYS)[number];

const PLACEHOLDER = /^<[^>]+>$/;

const CaoEntrySchema = z.object({
  key: z.enum(CAO_KEYS),
  displayName: z.string().min(1),
  appId: z.string().min(1),
  botUserId: z.string().min(1),
  adapter: z.enum(['automatic-muse', 'manual']),
  agentName: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string().min(1),
  command: z.string().regex(/^\/fire-[a-z-]+$/),
  healthPort: z.number().int().min(1).max(65535),
  home: z.string().min(1),
  runLinkForm: z.string().min(1),
});
export type CaoEntry = z.infer<typeof CaoEntrySchema>;

const CapsSchema = z.object({
  perFireTokenBudget: z.number().int().positive(),
  monthlyTokenCeiling: z.number().int().positive(),
  weeklyStartFloor: z.number().int().positive(),
  dailyStartCapTotal: z.number().int().positive(),
  monthlyStartCapTotal: z.number().int().positive(),
  perCaoWeeklyManualCap: z.number().int().positive(),
  manualMinutesPerStart: z.number().int().positive(),
  dailyManualMinutesCeiling: z.number().int().positive(),
});
export type Caps = z.infer<typeof CapsSchema>;

export const RegistrySchema = z.object({
  workspace: z.object({ teamId: z.string().min(1), domain: z.string().min(1) }),
  caoBotsChannelId: z.string().min(1),
  jbUserId: z.string().min(1),
  allowlist: z.object({ extraAuthorIds: z.array(z.string().min(1)) }),
  healthBind: z.array(z.string().min(1)).min(1),
  caos: z.array(CaoEntrySchema).length(4),
  caps: CapsSchema,
});
export type Registry = z.infer<typeof RegistrySchema>;

const EnvSchema = z.object({
  CAO_RELAY_CAO: z.enum(CAO_KEYS),
  CAO_RELAY_STATE_DIR: z.string().min(1).optional(),
  CAO_RELAY_REGISTRY: z.string().min(1).optional(),
  CAO_RELAY_BLOCKLIST: z.string().min(1).optional(),
  CAO_RELAY_HOLDER: z.string().min(1).default('vm'),
  CAO_RELAY_TZ: z.string().min(1).default('America/New_York'),
  CAO_RELAY_RUN_DIR: z.string().min(1).default('/run/cao-relay'),
  CAO_RELAY_VAULT_DIR: z.string().min(1).optional(),
  CAO_RELAY_VAULT_WEB_BASE: z.string().url().optional(),
  CAO_RELAY_VAULT_REPO_URL: z.string().min(1).optional(),
  CAO_RELAY_HTTPS_PROXY: z.string().url().optional(),
  CAO_RELAY_POST_QUEUE: z.string().min(1).optional(),
  CAO_RELAY_MIRROR_DIR: z.string().min(1).optional(),
  CAO_RELAY_ARCHIVE_DIR: z.string().min(1).optional(),
  CAO_RELAY_HEALTH_BIND: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url().optional(),
  CAO_RELAY_KEY_DIR: z.string().min(1).optional(),
  CREDENTIALS_DIRECTORY: z.string().min(1).optional(),
  CAO_RELAY_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface RelayConfig {
  cao: CaoEntry;
  registry: Registry;
  holder: string; // "vm" | "mini" — goes into cao_relay_lease.holder
  timezone: string;
  stateDir: string; // /var/lib/cao-relay/<cao>
  runDir: string; // /run/cao-relay
  blocklistPath: string;
  vaultDir: string | null;
  vaultWebBase: string | null;
  vaultRepoUrl: string | null; // C2-FU-3: cloned on first close-out read-back
  httpsProxy: string | null;
  postQueuePath: string | null; // Muse only
  mirrorDir: string | null; // Muse only
  archiveDir: string | null; // Muse only: brain rows past 90 days, filed into the vault nightly (R7-FU-12)
  healthBind: string[];
  supabaseUrl: string | null; // Muse only (direct brain access); others use the broker
  credentialsDir: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..');

export function loadRegistry(path?: string): Registry {
  const p = path ?? join(REPO_ROOT, 'config', 'registry.json');
  const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
  return RegistrySchema.parse(raw);
}

/** Every placeholder that would stop this CAO's program from starting. */
export function placeholdersBlocking(registry: Registry, cao: CaoKey): string[] {
  const found: string[] = [];
  for (const entry of registry.caos) {
    if (PLACEHOLDER.test(entry.channelId)) found.push(`${entry.key}.channelId`);
    if (entry.key === cao) {
      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === 'string' && PLACEHOLDER.test(v) && k !== 'channelId') found.push(`${entry.key}.${k}`);
      }
    }
  }
  if (PLACEHOLDER.test(registry.caoBotsChannelId)) found.push('caoBotsChannelId');
  return found;
}

export function isPlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v);
}

export function caoEntry(registry: Registry, key: CaoKey): CaoEntry {
  const e = registry.caos.find((c) => c.key === key);
  if (!e) throw new Error(`registry has no entry for ${key}`);
  return e;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const e = EnvSchema.parse(withLegacyEnv(env));
  const registry = loadRegistry(e.CAO_RELAY_REGISTRY);
  const cao = caoEntry(registry, e.CAO_RELAY_CAO);
  const stateDir = e.CAO_RELAY_STATE_DIR ?? `/var/lib/cao-relay/${cao.key}`;
  const isMuse = cao.key === 'muse';
  return {
    cao,
    registry,
    holder: e.CAO_RELAY_HOLDER,
    timezone: e.CAO_RELAY_TZ,
    stateDir,
    runDir: e.CAO_RELAY_RUN_DIR,
    blocklistPath: e.CAO_RELAY_BLOCKLIST ?? join(REPO_ROOT, 'config', 'blocklist.json'),
    vaultDir: e.CAO_RELAY_VAULT_DIR ?? null,
    vaultWebBase: e.CAO_RELAY_VAULT_WEB_BASE ?? null,
    vaultRepoUrl: e.CAO_RELAY_VAULT_REPO_URL ?? null,
    httpsProxy: e.CAO_RELAY_HTTPS_PROXY ?? null,
    postQueuePath: isMuse ? (e.CAO_RELAY_POST_QUEUE ?? '/var/lib/cao-relay/muse/post-queue.jsonl') : null,
    mirrorDir: isMuse ? (e.CAO_RELAY_MIRROR_DIR ?? join(stateDir, 'mirror')) : null,
    archiveDir: isMuse ? (e.CAO_RELAY_ARCHIVE_DIR ?? join(stateDir, 'archive')) : null,
    healthBind: e.CAO_RELAY_HEALTH_BIND ? e.CAO_RELAY_HEALTH_BIND.split(',').map((s) => s.trim()) : registry.healthBind,
    supabaseUrl: e.SUPABASE_URL ?? null,
    // The ExecStartPre tmpfs dir wins (fresh fetch on every start, D7); $CREDENTIALS_DIRECTORY is the fallback.
    credentialsDir: e.CAO_RELAY_KEY_DIR ?? e.CREDENTIALS_DIRECTORY ?? null,
    logLevel: e.CAO_RELAY_LOG_LEVEL,
  };
}

/** The five CAO channels: #cao-bots plus the four private CAO channels (D1). */
export function caoChannelIds(registry: Registry): Set<string> {
  return new Set([registry.caoBotsChannelId, ...registry.caos.map((c) => c.channelId)]);
}

/** Authors allowed to start work: the four CAO bots plus any configured extras. */
export function allowedAuthors(registry: Registry): Set<string> {
  return new Set([...registry.caos.map((c) => c.botUserId), ...registry.allowlist.extraAuthorIds]);
}

/** Effective daily start cap: the lower of the daily cap and the manual-minutes ceiling (D4 manual budget). */
export function effectiveDailyCap(caps: Caps): number {
  const manualPerDay = Math.floor(caps.dailyManualMinutesCeiling / caps.manualMinutesPerStart);
  return Math.min(caps.dailyStartCapTotal, manualPerDay);
}
