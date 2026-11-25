// The whole routing rule, as pure functions. No Slack, no disk, no clock in here, so it is easy to test.
//
// Rule 1. A message in a CAO channel (or #cao-bots) that starts "to <cao>:" or "to all:" is carried to that CAO's channel
//         as "From <name>: ...", and written to that CAO's inbox file. A mirror line goes to #cao-bots.
// Rule 2. A reply inside a carried thread goes back to the other side of the thread, so talk runs both ways.
// Rule 3. Everything else is ignored. The relay never answers its own posts and never answers an author it does not know.
import type { Cao, Registry } from './registry.js';

export interface Incoming {
  channel: string;
  ts: string;
  threadTs?: string;
  userId?: string;   // Slack user id (a person or a bot user)
  text: string;
  subtype?: string;
}

export interface Post { channel: string; text: string; threadTs?: string; linkWith?: { channel: string; ts: string } }
export interface Inbox { cao: string; from: string; text: string; source: { channel: string; ts: string; threadTs?: string } }
export interface Plan { posts: Post[]; inbox: Inbox[]; why: string }

/** channel:ts -> the other side of the thread (kept both ways). */
export interface Links { get(channel: string, ts: string): { channel: string; ts: string } | undefined }

const ADDRESS = /^\s*(?:to|@)\s*([a-z][a-z0-9-]*)\s*[:,\-–]\s*([\s\S]+)$/i;
const MAX_TEXT = 3000;

export function findCao(reg: Registry, name: string): Cao | undefined {
  const n = name.toLowerCase();
  return reg.caos.find((c) => c.key === n || c.aliases.includes(n));
}

/** Who wrote it, as a short name. A CAO bot user is that CAO; JB is JB; anyone else is unknown. */
export function authorName(reg: Registry, userId: string | undefined, channel: string): string | null {
  if (!userId) return null;
  if (userId === reg.jbUserId) return 'JB';
  const byBot = reg.caos.find((c) => c.botUserId === userId);
  if (byBot) return byBot.displayName;
  if (reg.extraAuthorIds.includes(userId)) {
    return reg.caos.find((c) => c.channelId === channel)?.displayName ?? 'Agent';
  }
  return null;
}

function clip(t: string): string {
  const s = t.trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' [cut]' : s;
}

export function plan(reg: Registry, msg: Incoming, links: Links, relayUserId: string): Plan {
  const none = (why: string): Plan => ({ posts: [], inbox: [], why });
  if (msg.userId === relayUserId) return none('own post');
  if (msg.subtype) return none(`subtype ${msg.subtype}`);
  if (!msg.text.trim()) return none('empty');

  const knownChannel = msg.channel === reg.botsChannel.channelId || reg.caos.some((c) => c.channelId === msg.channel);
  if (!knownChannel) return none('not one of the five channels');
  const who = authorName(reg, msg.userId, msg.channel);
  if (!who) return none('author not on the list');
  const text = clip(msg.text);

  // Rule 2: reply inside a carried thread -> the other side.
  if (msg.threadTs && msg.threadTs !== msg.ts) {
    const other = links.get(msg.channel, msg.threadTs);
    if (!other) return none('reply in a thread the relay did not carry');
    const dest = reg.caos.find((c) => c.channelId === other.channel);
    return {
      posts: [{ channel: other.channel, threadTs: other.ts, text: `${who} replied: ${text}` }],
      inbox: dest ? [{ cao: dest.key, from: who, text, source: { channel: msg.channel, ts: msg.ts, threadTs: msg.threadTs } }] : [],
      why: 'reply carried back',
    };
  }

  // Rule 1: "to <cao>: ..." at the top of a channel.
  const m = ADDRESS.exec(text);
  if (!m) return none('no address');
  const target = (m[1] ?? '').toLowerCase();
  const body = (m[2] ?? '').trim();
  if (!body) return none('empty body');

  const sender = reg.caos.find((c) => c.displayName === who);
  let targets: Cao[];
  if (target === 'all') targets = reg.caos.filter((c) => c.key !== sender?.key);
  else {
    const t = findCao(reg, target);
    if (!t) return none(`unknown CAO "${target}"`);
    if (sender && t.key === sender.key) return none('addressed to itself');
    targets = [t];
  }

  const posts: Post[] = targets.map((t) => ({
    channel: t.channelId,
    text: `From ${who}: ${body}`,
    linkWith: { channel: msg.channel, ts: msg.ts },
  }));
  // Mirror line for #cao-bots, unless the message was written there already.
  if (msg.channel !== reg.botsChannel.channelId) {
    posts.push({ channel: reg.botsChannel.channelId, text: `${who} to ${targets.map((t) => t.displayName).join(', ')}: ${body.length > 200 ? body.slice(0, 200) + ' [cut]' : body}` });
  }
  return {
    posts,
    inbox: targets.map((t) => ({ cao: t.key, from: who, text: body, source: { channel: msg.channel, ts: msg.ts } })),
    why: `carried to ${targets.map((t) => t.key).join(', ')}`,
  };
}
