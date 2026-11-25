// CTO -> CAO backward compatibility. Until the cutover (docs/CAO-CUTOVER.md) the live
// host still sets CTO_RELAY_* and the brain still holds rows written with the old
// agent names. New code writes CAO names and reads CAO_RELAY_* first, then falls back.
// Remove this file after the cutover is verified and a migration has rewritten old rows.

/** Old agent_comms agent name -> current registry agentName (read-side mapping). */
export const LEGACY_AGENT_NAMES: Readonly<Record<string, string>> = {
  'Claude CTO': 'Claude CAO',
  'Gemini CTO': 'Gemini CAO',
  'AXON-Hermes CTO': 'AXON-Hermes CAO',
  'MUSE CTO': 'MUSE',
};

/** Map an old agent name to its CAO name; any other name is returned unchanged. */
export function canonicalAgentName(name: string): string {
  return LEGACY_AGENT_NAMES[name] ?? name;
}

/** The name plus every old spelling that maps to it (for to_agent in.(...) filters). */
export function agentNameAliases(name: string): string[] {
  const canon = canonicalAgentName(name);
  return [canon, ...Object.entries(LEGACY_AGENT_NAMES).filter(([, v]) => v === canon).map(([k]) => k)];
}

/**
 * Return a copy of env in which every CAO_RELAY_* variable that is unset is filled from
 * its CTO_RELAY_* twin (CAO_RELAY_CAO from CTO_RELAY_CTO). CAO_* always wins.
 */
export function withLegacyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('CTO_RELAY_') || v === undefined) continue;
    const next = k === 'CTO_RELAY_CTO' ? 'CAO_RELAY_CAO' : `CAO_${k.slice(4)}`;
    if (out[next] === undefined || out[next] === '') out[next] = v;
  }
  return out;
}
