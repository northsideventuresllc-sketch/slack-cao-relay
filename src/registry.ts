// The five CAO channels and the four CAOs. Read once at start; the relay refuses to run on a bad file.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Cao = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  channelId: z.string().regex(/^C[A-Z0-9]{8,}$/, 'channelId must be a real Slack channel id'),
  channelName: z.string().regex(/^cao-[a-z]+$/),
  botUserId: z.string().regex(/^U[A-Z0-9]{8,}$/).optional(),
});

const Registry = z
  .object({
    workspace: z.object({ teamId: z.string(), domain: z.string() }),
    botsChannel: z.object({ channelId: z.string().regex(/^C[A-Z0-9]{8,}$/), channelName: z.literal('cao-bots') }),
    jbUserId: z.string().regex(/^U[A-Z0-9]{8,}$/),
    extraAuthorIds: z.array(z.string()).default([]),
    caos: z.array(Cao).length(4),
  })
  .superRefine((r, ctx) => {
    const ids = [r.botsChannel.channelId, ...r.caos.map((c) => c.channelId)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate channel id: there must be exactly five distinct channels' });
    const names = r.caos.flatMap((c) => c.aliases.map((a) => a.toLowerCase()));
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'duplicate CAO alias' });
  });

export type Cao = z.infer<typeof Cao>;
export type Registry = z.infer<typeof Registry>;

export function parseRegistry(raw: unknown): Registry {
  return Registry.parse(raw);
}
export function loadRegistry(path: string): Registry {
  return parseRegistry(JSON.parse(readFileSync(path, 'utf8')));
}
