#!/usr/bin/env node
// cao-relay CLI.
//   cao-relay run                         one relay program (CAO from CAO_RELAY_CAO; legacy CTO_RELAY_CTO still read)
//   cao-relay heartbeat                   write Muse CAO's cao_heartbeat row (cron cao-heartbeat)
//   cao-relay poller                      the mini poller (1-minute cron on the mini; secrets on stdin)
//   cao-relay checkin-report              Claude CAO's 9am check-in report on the mini (brain key on stdin)
//   cao-relay admin <cmd> --cao <cao> …   control socket: claim | start | link | stopped | closeout | review-clear | journal-has | status
//   cao-relay post-queue-append …         append one validated entry to the Muse post-queue (run as cao-relay-muse)

import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { withLegacyEnv } from './legacy.js';
import { ControlCommandSchema, controlSocketPath, sendControl } from './control.js';
import { writeHeartbeat } from './heartbeat.js';
import { runPoller } from './poller.js';
import { checkinReport } from './checkin.js';
import { appendPostQueue, PostQueueEntrySchema } from './postqueue.js';
import { RelayProgram } from './relay.js';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const v = argv[i + 1];
      out[a.slice(2)] = v !== undefined && !v.startsWith('--') ? (i++, v) : 'true';
    }
  }
  return out;
}

const num = (v: string | undefined): number | null => (v === undefined ? null : Number(v));

async function main(): Promise<number> {
  const [cmd = 'run', ...rest] = process.argv.slice(2);
  const env = withLegacyEnv();
  switch (cmd) {
    case 'run':
      return new RelayProgram(loadConfig()).run();
    case 'heartbeat':
      return writeHeartbeat();
    case 'poller':
      return runPoller();
    case 'checkin-report':
      return checkinReport();
    case 'admin': {
      const [sub, ...more] = rest;
      const f = flags(more);
      const cao = f.cao ?? env.CAO_RELAY_CAO;
      if (!sub || !cao) {
        process.stderr.write('usage: cao-relay admin <cmd> --cao <cao> [--fire-id ID] [--name N] [--link L] [--vault-log-path P] [--session-url U] [--tokens N] [--minutes N]\n');
        return 64;
      }
      const command = ControlCommandSchema.parse({
        cmd: sub,
        fireId: f['fire-id'],
        name: f.name,
        link: f.link,
        vaultLogPath: f['vault-log-path'],
        sessionUrl: f['session-url'] ?? null,
        tokens: num(f.tokens),
        minutes: num(f.minutes),
      });
      const res = await sendControl(controlSocketPath(env.CAO_RELAY_RUN_DIR ?? '/run/cao-relay', cao), command);
      process.stdout.write(JSON.stringify(res) + '\n');
      return (res as { ok?: boolean }).ok ? 0 : 1;
    }
    case 'copy-check': {
      // R5-FU-9: run by cao-relay-offhost-copy.sh after each copy. Reads the journal copy,
      // extracts its fire ids (fire-request ids + brain ids mapped from brain-down starts),
      // and asks the Muse program to compare them with the brain rows.
      const f = flags(rest);
      if (!f.target || !f.copy) {
        process.stderr.write('usage: cao-relay copy-check --target <cao> --copy <journal copy path>\n');
        return 64;
      }
      const ids = new Set<string>();
      for (const line of readFileSync(f.copy, 'utf8').split('\n')) {
        try {
          const r = JSON.parse(line) as { kind?: string; fireId?: string; brainId?: string; state?: string };
          if (r.kind === 'fire-request' && r.fireId) ids.add(r.fireId);
          if (r.state === 'brain-written' && r.brainId) ids.add(r.brainId);
        } catch {
          // torn line: skip
        }
      }
      const command = ControlCommandSchema.parse({ cmd: 'copy-check', target: f.target, ids: [...ids] });
      const res = await sendControl(controlSocketPath(env.CAO_RELAY_RUN_DIR ?? '/run/cao-relay', 'muse'), command);
      process.stdout.write(JSON.stringify(res) + '\n');
      return (res as { ok?: boolean }).ok ? 0 : 1;
    }
    case 'post-queue-append': {
      const f = flags(rest);
      const entry = PostQueueEntrySchema.parse(f.kind === 'fire' ? { kind: 'fire', cao: f.cao, task: f.task } : { kind: 'post', channel: f.channel, text: f.text });
      appendPostQueue(env.CAO_RELAY_POST_QUEUE ?? '/var/lib/cao-relay/muse/post-queue.jsonl', entry);
      return 0;
    }
    default:
      process.stderr.write(`unknown command ${cmd}\n`);
      return 64;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(JSON.stringify({ msg: 'fatal', err: (err as { name?: string }).name ?? 'error' }) + '\n');
    process.exit(1);
  },
);
