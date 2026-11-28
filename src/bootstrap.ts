// Start-up of ONE relay, in the order that keeps it independent and bot-only:
//   1. the brain answers (fail-closed), and this relay takes its own lease;
//   2. its Slack tokens from the doorman, with its own identity (a refusal stops this relay only; a doorman
//      that does not answer is a retry, not a refusal);
//   3. the token-shape guard (bot token xoxb-, app token xapp-; a user token xoxp- is refused);
//   4. auth.test with the bot token names a bot_id and this CAO's bot user.
// No step reads another relay's heartbeat or waits for another program: each relay starts, holds its own
// lease and posts on its own.

import type { BrainApi } from './brain.js';
import type { RelayConfig } from './config.js';
import { DoormanRefused, DoormanUnreachable, fetchRelayTokens, type DoormanApi } from './doorman.js';
import { LeaseHeldElsewhere, LeaseManager } from './lease.js';
import { EXIT_STAY_DOWN } from './channel/slack.js';
import { NotABotError, TokenGuardError, assertSlackTokenShapes } from './slackguard.js';
import { errorCode, type Logger } from './util/log.js';
import type { Clock } from './util/time.js';

export const EXIT_RETRY = 1; // systemd Restart=on-failure retries (brain down, lease held elsewhere)

export class Fatal extends Error {
  constructor(readonly exitCode: number, readonly reason: string) {
    super(reason);
  }
}

/** The part of the Slack channel start-up needs. */
export interface SlackProbe {
  authTest(): Promise<{ userId: string; botId: string }>;
}

export interface BootstrapDeps<S extends SlackProbe> {
  doorman: DoormanApi;
  makeBrain: () => BrainApi;
  makeSlack: (tokens: { botToken: string; appToken: string }) => S;
  clock: Clock;
  log: Logger;
  alert: (code: string) => void;
}

export interface Bootstrapped<S extends SlackProbe> {
  brain: BrainApi;
  lease: LeaseManager;
  slack: S;
}

export async function bootstrapRelay<S extends SlackProbe>(cfg: RelayConfig, deps: BootstrapDeps<S>): Promise<Bootstrapped<S>> {
  const cao = cfg.cao;

  const brain = deps.makeBrain();
  try {
    await brain.ping();
  } catch {
    throw new Fatal(EXIT_RETRY, 'brain unreachable at startup (fail-closed)');
  }

  const lease = new LeaseManager(brain, cao.key, `${cfg.holder}:cao-relay-${cao.key}`, deps.clock, deps.log, (code) => deps.alert(code));
  try {
    await lease.acquire();
  } catch (err) {
    if (err instanceof LeaseHeldElsewhere) throw new Fatal(EXIT_RETRY, 'lease held by another live holder');
    throw new Fatal(EXIT_RETRY, 'lease acquisition failed (fail-closed)');
  }

  let tokens: { botToken: string; appToken: string };
  try {
    tokens = await fetchRelayTokens(cao.key, deps.doorman, deps.clock);
  } catch (err) {
    lease.stop();
    if (err instanceof DoormanRefused) {
      deps.log.error('doorman refused this relay', { cao: cao.key, secret: err.secretName, why: err.why }); // name and reason, never a value
      throw new Fatal(EXIT_STAY_DOWN, `doorman refused ${err.secretName} (this relay stays down; the others are not affected)`);
    }
    if (err instanceof DoormanUnreachable) {
      deps.log.warn('doorman did not answer; will retry', { cao: cao.key, secret: err.secretName, why: err.why });
      throw new Fatal(EXIT_RETRY, 'doorman unreachable (retry)');
    }
    throw new Fatal(EXIT_STAY_DOWN, 'doorman call failed');
  }
  try {
    assertSlackTokenShapes(tokens.botToken, tokens.appToken);
  } catch (err) {
    lease.stop();
    if (err instanceof TokenGuardError) {
      deps.log.error('slack token refused', { cao: cao.key, which: err.which, shape: err.shape }); // shape only
      throw new Fatal(EXIT_STAY_DOWN, `${err.which} token has the wrong shape (${err.shape}); posting is bot-token-only`);
    }
    throw err;
  }

  let slack: S;
  try {
    slack = deps.makeSlack(tokens);
  } catch (err) {
    lease.stop();
    if (err instanceof TokenGuardError) throw new Fatal(EXIT_STAY_DOWN, `${err.which} token has the wrong shape (${err.shape})`);
    throw err;
  }
  try {
    const me = await slack.authTest();
    if (me.userId !== cao.botUserId) throw new Fatal(EXIT_STAY_DOWN, 'bot token belongs to a different bot user');
  } catch (err) {
    lease.stop();
    if (err instanceof Fatal) throw err;
    if (err instanceof NotABotError) {
      deps.alert('token-not-a-bot');
      throw new Fatal(EXIT_STAY_DOWN, 'auth.test answered without a bot_id (not a bot token)');
    }
    deps.alert('token-revoked-or-invalid');
    deps.log.warn('auth.test failed', { err: errorCode(err) });
    throw new Fatal(EXIT_STAY_DOWN, 'Slack bot token rejected (fails closed for this CAO only)');
  }
  return { brain, lease, slack };
}
