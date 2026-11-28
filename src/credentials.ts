// The brain key arrives through tmpfs: ExecStartPre (`cao-relay-fetch-keys <cao>`) fetches
// it fresh from the Secure Vault into /run/credentials/cao-relay-<cao>/ on every start, and the
// unit passes that directory to the process as CAO_RELAY_KEY_DIR (D7). Fetched there on purpose:
// systemd loads LoadCredential= files before ExecStartPre runs, which would break "fresh fetch wins" (KAR-FU-3).
// The one LoadCredential= the unit does use is the relay's own doorman identity token
// (`doorman-identity`, src/doorman.ts): it is a static file under /etc/credstore, not a fetched key.
// Slack tokens are not here at all: they come from the doorman. Values are never logged.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// shortcut: one shared NI Brain key for all four relays (accepted decision); per-relay brain keys are a later change.
export const CRED_BRAIN = 'brain-key';

export class MissingCredential extends Error {
  constructor(readonly credName: string) {
    super(`missing credential ${credName}`);
    this.name = 'MissingCredential';
  }
}

export function readCredential(dir: string | null, name: string): string {
  if (!dir) throw new MissingCredential(name);
  const p = join(dir, name);
  if (!existsSync(p)) throw new MissingCredential(name);
  const v = readFileSync(p, 'utf8').trim();
  if (!v) throw new MissingCredential(name);
  return v;
}
