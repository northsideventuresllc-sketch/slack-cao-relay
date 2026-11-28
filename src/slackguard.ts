// Bot-token-only posting. A CAO's post must come from that CAO's bot, never from JB's user.
//   - the bot token must look like xoxb-, the app token like xapp-; an empty token, a user token (xoxp-)
//     or anything else stops start-up;
//   - after start, auth.test with the bot token must answer with a bot_id;
//   - chat.postMessage is never given `as_user` or `user`.
// Only token SHAPES are ever logged, never values.

export type TokenShape = 'xoxb' | 'xapp' | 'xoxp' | 'empty' | 'other';

export function tokenShape(t: string | null | undefined): TokenShape {
  if (!t) return 'empty';
  if (t.startsWith('xoxb-')) return 'xoxb';
  if (t.startsWith('xapp-')) return 'xapp';
  if (t.startsWith('xoxp-')) return 'xoxp';
  return 'other';
}

export class TokenGuardError extends Error {
  constructor(readonly which: 'bot' | 'app', readonly shape: TokenShape) {
    super(`${which} token refused: shape ${shape}`); // shape only
    this.name = 'TokenGuardError';
  }
}

/** Throws unless this is a bot token (xoxb-). */
export function assertBotTokenShape(botToken: string | null | undefined): void {
  const bot = tokenShape(botToken);
  if (bot !== 'xoxb') throw new TokenGuardError('bot', bot);
}

/** Throws unless the bot token matches ^xoxb- and the app token matches ^xapp-. A xoxp- user token is always refused. */
export function assertSlackTokenShapes(botToken: string | null | undefined, appToken: string | null | undefined): void {
  const bot = tokenShape(botToken);
  const app = tokenShape(appToken);
  if (bot !== 'xoxb') throw new TokenGuardError('bot', bot);
  if (app !== 'xapp') throw new TokenGuardError('app', app);
}

export class NotABotError extends Error {
  constructor() {
    super('auth.test answered without a bot_id: the token is not a bot token');
    this.name = 'NotABotError';
  }
}

/** auth.test with the bot token must carry a bot_id. */
export function requireBotId(res: { bot_id?: string | null | undefined }): string {
  if (!res.bot_id) throw new NotABotError();
  return res.bot_id;
}

/** The postMessage arguments the relay may send: never as_user, never user. */
export function assertBotPostArgs(args: Record<string, unknown>): void {
  if ('as_user' in args || 'user' in args) throw new Error('chat.postMessage must not carry as_user or user (bot-token posting only)');
}
