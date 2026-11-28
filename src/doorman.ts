// The doorman: how a relay gets its Slack tokens. One identity per relay, one secret per call.
//
// A relay reads ITS OWN identity token from this machine's sign-in store:
//   mini (macOS):  keychain service `nvg-doorman-identity`, account = the identity
//   VM  (systemd): the credential `doorman-identity`, i.e. in the unit
//                  LoadCredential=doorman-identity:/etc/credstore/doorman-identity-<identity>
//                  read from $CREDENTIALS_DIRECTORY/doorman-identity
// then asks the doorman once per secret: agent = the relay name, job = `cao-relay`, secret =
// CAO_RELAY_<NAME>_BOT_TOKEN or CAO_RELAY_<NAME>_APP_TOKEN. A refusal stops only that relay.
// The call shape is nv-vault `Infrastructure Code/lib/doorman.mjs`: POST {token, agent, secret, job, run}
// with `Authorization: Bearer <publishable key>` and `apikey`.
//
// No relay holds, reads or asks for another relay's identity or secrets: the secret names and the identity
// are derived from the relay's own key and nowhere else. Values are never logged.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import type { CaoKey, HarnessIdentity } from './config.js';

export const DOORMAN_JOB = 'cao-relay';
export const KEYCHAIN_SERVICE = 'nvg-doorman-identity';
export const IDENTITY_CREDENTIAL = 'doorman-identity';

/** `refused` = the doorman answered no (the relay stays down). `unreachable` = no answer (network error, 5xx, not JSON): the relay retries. */
export type DoormanReply = { answer: 'given'; value: string } | { answer: 'refused'; why: string } | { answer: 'unreachable'; why: string };

export interface DoormanApi {
  ask(req: { agent: string; secret: string; job: string; run: string }): Promise<DoormanReply>;
}

/** The two secret names a relay may ask for, and nothing else. */
export function relaySecretNames(cao: CaoKey): { bot: string; app: string } {
  const name = cao.toUpperCase();
  return { bot: `CAO_RELAY_${name}_BOT_TOKEN`, app: `CAO_RELAY_${name}_APP_TOKEN` };
}

export class IdentityUnavailable extends Error {
  constructor(readonly identity: string, readonly store: 'keychain' | 'credential') {
    super(`doorman identity token unavailable (${store}, identity ${identity})`);
    this.name = 'IdentityUnavailable';
  }
}

export interface IdentityStoreOptions {
  platform?: NodeJS.Platform;
  identityDir?: string | null; // $CREDENTIALS_DIRECTORY
  exec?: (file: string, args: string[]) => string; // for the keychain read (tests stub it)
}

/** Read this relay's identity token from the machine's sign-in store. Never printed. */
export function readIdentityToken(identity: HarnessIdentity, opts: IdentityStoreOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const exec = opts.exec ?? ((f: string, a: string[]) => execFileSync(f, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }));
    let v: string;
    try {
      v = exec('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', identity, '-w']).trim();
    } catch {
      throw new IdentityUnavailable(identity, 'keychain');
    }
    if (!v) throw new IdentityUnavailable(identity, 'keychain');
    return v;
  }
  const dir = opts.identityDir ?? null;
  const p = dir ? join(dir, IDENTITY_CREDENTIAL) : null;
  if (!p || !existsSync(p)) throw new IdentityUnavailable(identity, 'credential');
  const v = readFileSync(p, 'utf8').trim();
  if (!v) throw new IdentityUnavailable(identity, 'credential');
  return v;
}

export interface HttpDoormanOptions {
  url: string;
  publishableKey: string;
  identityToken: string;
  httpsProxy?: string | null;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
}

export class HttpDoorman implements DoormanApi {
  private readonly dispatcher: ProxyAgent | undefined;

  constructor(private readonly opts: HttpDoormanOptions) {
    this.dispatcher = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : undefined; // one agent for the life of the relay
  }

  async ask(req: { agent: string; secret: string; job: string; run: string }): Promise<DoormanReply> {
    const o = this.opts;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.publishableKey}`, apikey: o.publishableKey },
      body: JSON.stringify({ token: o.identityToken, agent: req.agent, secret: req.secret, job: req.job, run: req.run }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    };
    try {
      const res = o.fetchImpl ? await o.fetchImpl(o.url, init) : await undiciFetch(o.url, { ...init, dispatcher: this.dispatcher });
      if (res.status >= 500) return { answer: 'unreachable', why: `doorman http ${res.status}` };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { answer: 'unreachable', why: `doorman answered http ${res.status} without JSON` };
      }
      const b = body as { answer?: unknown; value?: unknown; why?: unknown };
      const value = typeof b?.value === 'string' ? b.value.trim() : '';
      if (res.status >= 200 && res.status < 300 && b?.answer === 'given' && value.length > 0) return { answer: 'given', value };
      return { answer: 'refused', why: typeof b?.why === 'string' ? b.why.slice(0, 200) : `doorman refused (http ${res.status})` };
    } catch {
      return { answer: 'unreachable', why: 'doorman unreachable' };
    }
  }
}

export class DoormanRefused extends Error {
  constructor(readonly secretName: string, readonly why: string) {
    super(`doorman refused ${secretName}: ${why}`); // the secret NAME and the doorman's reason; never a value
    this.name = 'DoormanRefused';
  }
}

export class DoormanUnreachable extends Error {
  constructor(readonly secretName: string, readonly why: string) {
    super(`doorman unreachable for ${secretName}: ${why}`);
    this.name = 'DoormanUnreachable';
  }
}

/** Ask the doorman for this relay's bot and app tokens (two calls, its own names only). */
export async function fetchRelayTokens(cao: CaoKey, doorman: DoormanApi, now: () => number = Date.now): Promise<{ botToken: string; appToken: string }> {
  const names = relaySecretNames(cao);
  const run = `cao-relay-${cao}-${now()}`;
  const got: Record<'bot' | 'app', string> = { bot: '', app: '' };
  for (const kind of ['bot', 'app'] as const) {
    const r = await doorman.ask({ agent: cao, secret: names[kind], job: DOORMAN_JOB, run });
    if (r.answer === 'unreachable') throw new DoormanUnreachable(names[kind], r.why);
    if (r.answer !== 'given') throw new DoormanRefused(names[kind], r.why);
    got[kind] = r.value;
  }
  return { botToken: got.bot, appToken: got.app };
}
