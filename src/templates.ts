// Every relay-authored Slack post (PLAN-v7 D4/D5/D6 + Appendix A). Plain
// words, no jargon, never the word "fired", never an unfilled slot, never a
// link that does not exist. None of these ever carries the start pattern.

import type { CaoEntry } from './config.js';

/**
 * C1-FU-4: the task text embedded in a short reply is clamped to 10 words (plus "…"),
 * so the (e) first line stays short; the full task stays in the brain row.
 */
export const SHORT_REPLY_TASK_WORDS = 10;
function short(task: string): string {
  const words = task.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= SHORT_REPLY_TASK_WORDS ? words.join(' ') : words.slice(0, SHORT_REPLY_TASK_WORDS).join(' ') + '…';
}

export const T = {
  /** D4/Appendix A (e): automatic adapter short reply. */
  startedAutomatically: (task: string, fireId: string): string =>
    `Started: ${short(task)} — fire id ${fireId} — started automatically — run link to follow.`,
  /** D4/D6: manual adapter short reply. */
  queuedForPerson: (task: string, fireId: string, cao: CaoEntry): string =>
    `Started: ${short(task)} — fire id ${fireId} — queued for a person. Muse CAO will start it in ${cao.home}.`,
  brainDown: (task: string, fireId: string): string => `Queued. Brain is down. Will retry. Task: ${short(task)} — fire id ${fireId}.`,
  /** D4 manual state machine: both the relay and the manual path down. */
  waitingBothDown: (task: string, fireId: string): string =>
    `Waiting. It will start at the next check-in. If the relay restarts before then, this start may be lost — please re-send it if no reply arrives. Task: ${short(task)} — fire id ${fireId}.`,
  alreadyRunning: (): string => 'Already running. No second run started.',
  /** KAR-FU-4: a person ran a /fire command; starts come from the CAO bots (the allowlist). */
  notAllowed: (): string => 'Starts come from the CAO bots only. Ask Muse CAO in main chat.',
  queueFull: (): string => 'Not started. The queue for this CAO is full (10 waiting).',
  /** Appendix A (e) second line. Gemini: session name plus Slack thread, not a link. */
  runLink: (link: string): string => `Run: ${link}`,
  stillWaitingOnPerson: (when: string): string => `Still waiting on a person. Next check-in at ${when}.`,
  linkMissing: (fireId: string): string =>
    `No run link yet for fire id ${fireId}, 35 minutes after the start. Muse CAO has been told.`,
  adapterTimeout: (fireId: string): string =>
    `The start for fire id ${fireId} got no answer within 5 minutes. Muse CAO has been told.`,
  lostOnRestart: (): string => 'A start was lost when the relay restarted. Please re-send it.',
  brainDownTooLong: (): string => 'Not started. Brain was down too long.',
  expired: (): string => 'Not started. It expired.',
  cancelled: (fireId: string): string => `Cancelled: fire id ${fireId}. It will not start.`,
  stopRequested: (fireId: string): string =>
    `Fire id ${fireId} was already claimed, so the abort is now a stop request. Muse CAO will stop the run.`,
  stopped: (fireId: string): string => `Stopped: fire id ${fireId}.`,
  abortUnknown: (): string => 'No start with that fire id is waiting here.',
  /** D4/D6 restore: each queued row gets "still waiting"; each claimed/started row gets its current state. */
  stillWaiting: (fireId: string): string => `Still waiting: fire id ${fireId} has not started yet.`,
  currentState: (fireId: string, state: string): string => `Fire id ${fireId} is ${state}.`,
  notRecorded: (): string => 'Not started. The start could not be recorded. Please re-send it.',
  capRefused: (reply: string): string => reply,
  orphanFailed: (fireId: string): string =>
    `The start for fire id ${fireId} was not recorded properly, so it will not run. Please re-send it.`,
  pending: (lines: string[]): string => `Pending starts: ${lines.join('; ')}`,
  /** D5 step 3 / Appendix A (d): the map. Log and Session each on their own line. */
  map: (done: string, logLabel: string, logUrl: string, session: string, stillOpen: string, caos: CaoEntry[]): string =>
    [
      `Done: ${done}`,
      `Log: <${logUrl}|${logLabel}>`,
      `Session: ${session}`,
      `Still open: ${stillOpen}`,
      '',
      caos.map((c) => `<@${c.botUserId}>`).join(' '),
    ].join('\n'),
  /** D5 step 3: the one-line pointer in #cao-bots, tagging all four. */
  pointer: (outcome: string, mapLink: string, caos: CaoEntry[]): string =>
    `Close-out: ${outcome}. Map is here: ${mapLink} ${caos.map((c) => `<@${c.botUserId}>`).join(' ')}`,
  /** R7-NEW-1: posted to the CAO's channel when the sweep flags a stalled run. */
  stalled: (fireId: string): string => `No activity for 6 hours on fire id ${fireId}. It may be stalled. Muse CAO has been told.`,
  /** R7-NEW-5: the poller's own liveness (the dead-alerter fallback). */
  pollerDown: (): string => 'The mini poller has stopped answering. Failover alerts are paused. Muse CAO has been told.',
  pollerBack: (): string => 'The mini poller is back.',
  /** R5-FU-9: the nightly off-host copy check found brain rows with no journal record in the copy. */
  copyGap: (cao: CaoEntry, n: number): string => `Nightly copy check: ${n} start(s) for ${cao.displayName} are missing from the journal copy. Muse CAO has been told.`,
  /** R7-NEW-3: a start-retry held in memory was lost when the relay restarted. */
  retryLost: (): string => 'A start waiting for its one retry was lost when the relay restarted. Please re-send it.',
  relayDown: (cao: CaoEntry): string => `${cao.displayName} relay is down. Starts for ${cao.displayName} are paused. Muse CAO has been told.`,
  relayBack: (cao: CaoEntry): string => `${cao.displayName} relay is back.`,
  dailyOpen: (open: string[], owed: string[], pending: string[], stalled: string[]): string =>
    [
      'Daily 9am open.',
      `Open: ${open.length ? open.join('; ') : 'None'}`,
      `Owed by each CAO: ${owed.length ? owed.join('; ') : 'None'}`,
      `Pending starts: ${pending.length ? pending.join('; ') : 'None'}`,
      ...(stalled.length ? [`Warning — no activity for 6 hours: ${stalled.join('; ')}`] : []),
    ].join('\n'),
} as const;

/** Prefixes of relay-authored posts — used to tell CAO words from relay templates in channel history. */
export const TEMPLATE_PREFIXES = [
  'Started:',
  'Queued.',
  'Waiting.',
  'Already running.',
  'Starts come from the CAO bots only.',
  'Not started.',
  'Run:',
  'Still waiting on a person.',
  'No run link yet',
  'The start for fire id',
  'A start was lost',
  'Cancelled: fire id',
  'Fire id ',
  'Still waiting:',
  'Stopped: fire id',
  'No start with that fire id',
  'Pending starts:',
  'Done:',
  'Close-out:',
  'Daily 9am open.',
  'Too many starts',
  'Say what the task is.',
  'Too long.',
  'Start one CAO at a time.',
  'I only take /fire commands here.',
  'Could not start this',
  'No activity for 6 hours',
  'The mini poller',
  'Nightly copy check:',
  'A start waiting for its one retry',
];

export function isRelayTemplate(text: string): boolean {
  return TEMPLATE_PREFIXES.some((p) => text.startsWith(p)) || / relay is (down|back)\./.test(text);
}

/** Appendix A word rule: words are space-separated; a standalone em dash is not a word. Outcome lines ≤ 20 words. */
export function countWords(line: string): number {
  return line.split(/\s+/).filter((w) => w.length > 0 && w !== '—').length;
}

export function clampWords(line: string, max = 20): string {
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  let n = 0;
  const out: string[] = [];
  for (const w of words) {
    if (w !== '—') n++;
    if (n > max) break;
    out.push(w);
  }
  return out.join(' ');
}
