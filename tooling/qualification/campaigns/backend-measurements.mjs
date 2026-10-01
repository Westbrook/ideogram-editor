// A number becomes a qualification observation only when its producing handler
// also supplies the actual measurement method and retained source evidence.
export function normalizeBackendMeasurements(cell, outcome) {
  if (!outcome.measurements || Array.isArray(outcome.measurements)) return outcome;
  const units = new Map((cell.requiredMeasurements ?? []).map(rule => [rule.name, rule.unit]));
  units.set('R26ProxyAddedHopMs', 'ms');
  for (const [name, value] of Object.entries(outcome.measurements)) {
    if (typeof value !== 'number') continue;
    const detail = outcome.measurementDetails?.[name], unit = detail?.unit ?? units.get(name);
    if (!Number.isFinite(value) || !unit || typeof detail?.method !== 'string' || !detail.method || !Array.isArray(detail.evidence) || !detail.evidence.length) continue;
    outcome.measurements[name] = { name, value, unit, method: detail.method, evidence: detail.evidence };
  }
  return outcome;
}
