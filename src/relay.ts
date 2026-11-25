// The relay: listens to the five channels over Socket Mode, asks the router what to do, does it.
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { writeInbox } from './inbox.js';
import type { Registry } from './registry.js';
import { plan, type Plan, type Post } from './router.js';
import type { State } from './state.js';

export interface Poster { post(p: { channel: string; text: string; threadTs?: string }): Promise<string> }

/** Do what a plan says. Returns what was posted, for the log. A failed post never stops the others. */
export async function execute(p: Plan, deps: { poster: Poster; state: State; inboxDir: string; log: (s: string) => void }): Promise<string[]> {
  const done: string[] = [];
  for (const post of p.posts) {
    try {
      const ts = await deps.poster.post({ channel: post.channel, text: post.text, threadTs: post.threadTs });
      if (post.linkWith) deps.state.link(post.linkWith, { channel: post.channel, ts });
      done.push(`${post.channel}:${ts}`);
    } catch (e) {
      deps.log(`post failed to ${post.channel}: ${(e as Error).message}`);
    }
  }
  for (const item of p.inbox) {
    try { writeInbox(deps.inboxDir, item); } catch (e) { deps.log(`inbox write failed for ${item.cao}: ${(e as Error).message}`); }
  }
  return done;
}

export function slackPoster(web: WebClient): Poster {
  return {
    async post({ channel, text, threadTs }) {
      const r = await web.chat.postMessage({ channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false });
      if (!r.ts) throw new Error('Slack returned no timestamp');
      return r.ts;
    },
  };
}

export async function runRelay(opts: { reg: Registry; state: State; inboxDir: string; botToken: string; appToken: string; log: (s: string) => void }): Promise<never> {
  const web = new WebClient(opts.botToken);
  const me = await web.auth.test();
  const relayUserId = String(me.user_id ?? '');
  if (!relayUserId) throw new Error('could not learn the relay bot user id');
  const poster = slackPoster(web);
  const socket = new SocketModeClient({ appToken: opts.appToken });

  socket.on('message', async ({ event, body, ack }: { event: Record<string, unknown>; body?: { event_id?: string }; ack: () => Promise<void> }) => {
    await ack();
    try {
      const channel = String(event.channel ?? '');
      const ts = String(event.ts ?? '');
      const id = body?.event_id ?? `${channel}:${ts}`;
      if (!channel || !ts || !opts.state.firstTime(id)) return;
      const p = plan(opts.reg, {
        channel, ts,
        threadTs: event.thread_ts ? String(event.thread_ts) : undefined,
        userId: event.user ? String(event.user) : undefined,
        text: String(event.text ?? ''),
        subtype: event.subtype ? String(event.subtype) : undefined,
      }, opts.state, relayUserId);
      if (p.posts.length === 0 && p.inbox.length === 0) return;
      const done = await execute(p, { poster, state: opts.state, inboxDir: opts.inboxDir, log: opts.log });
      opts.log(`${channel}:${ts} ${p.why}; posted ${done.length}`);   // ids and the reason only, never the message text
    } catch (e) {
      opts.log(`event failed: ${(e as Error).message}`);
    }
  });

  await socket.start();
  opts.log(`relay up as ${relayUserId}`);
  return new Promise<never>(() => { /* runs until the process is stopped */ });
}

export type { Post };
