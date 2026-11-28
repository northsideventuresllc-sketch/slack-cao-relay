// CTO -> CAO backward compatibility for environment variables. Until the cutover (docs/CAO-CUTOVER.md)
// the live host may still set CTO_RELAY_*. New code reads CAO_RELAY_* first, then falls back.
// The old `axon-hermes` relay key is read as `axon`. Remove this file after the cutover is verified.

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
  if (out.CAO_RELAY_CAO === 'axon-hermes') out.CAO_RELAY_CAO = 'axon';
  return out;
}
