// Raw per-visit observer records, not a substitute for the pinned web-vitals
// reference algorithm. No element selectors, DOM text, URLs or interaction
// contents enter this channel. Closing a visit is a real pagehide event.
const TYPES = new Set(['largest-contentful-paint', 'layout-shift', 'event', 'first-input', 'long-animation-frame']);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export function safeVitalRecord(value) {
  if (!value || !['start', 'entry', 'final'].includes(value.kind) || !numeric(value.timeOrigin) || !numeric(value.atMs)) return null;
  if (value.kind !== 'entry') return { kind: value.kind, timeOrigin: value.timeOrigin, atMs: value.atMs, visible: value.visible === true, ...(value.overflow === true ? { overflow: true } : {}) };
  if (!TYPES.has(value.type) || !numeric(value.startTime) || !numeric(value.duration)) return null;
  const result = { kind: value.kind, timeOrigin: value.timeOrigin, atMs: value.atMs, type: value.type, startTime: value.startTime, duration: value.duration };
  for (const key of ['interactionId', 'processingStart', 'processingEnd', 'renderTime', 'loadTime', 'size', 'value', 'blockingDuration']) if (numeric(value[key])) result[key] = value[key];
  if (typeof value.hadRecentInput === 'boolean') result.hadRecentInput = value.hadRecentInput;
  return result;
}

export function summarizeVisit(visit) {
  const missing = ['Pinned canonical web-vitals algorithm is not installed in this collector; raw browser entries are not field or canonical metric qualification'];
  if (!visit.finalized) missing.push('Visit has no real final page lifecycle event');
  if (visit.overflow) missing.push('Raw visit observation limit reached');
  const entries = visit.entries;
  return { id: visit.id, clockOriginUnixMs: visit.timeOrigin, clock: 'browser-performance-milliseconds', startMs: visit.startMs, endMs: visit.endMs ?? null,
    finalized: visit.finalized, initialVisibility: visit.visible ? 'visible' : 'hidden', overflow: visit.overflow,
    observedEntries: entries.length, eventEntries: entries.filter(entry => entry.type === 'event').length,
    eligibleInteractionIds: new Set(entries.filter(entry => entry.type === 'event' && entry.interactionId > 0).map(entry => entry.interactionId)).size,
    entries, lcp: null, inp: null, cls: null, status: 'INCONCLUSIVE', missing };
}

export async function installBrowserVitals(context, { maxVisits = 1000, maxEntries = 10000 } = {}) {
  if (!Number.isSafeInteger(maxVisits) || maxVisits < 1 || maxVisits > 1000 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw Error('Invalid bounded vital observer limits');
  const visits = new Map(); let disabled = false, rejected = 0, droppedVisits = 0;
  await context.exposeBinding('__ieCampaignVital', (source, value) => {
    if (disabled || source.frame.parentFrame()) return;
    const record = safeVitalRecord(value); if (!record) { rejected++; return; }
    let visit = visits.get(record.timeOrigin);
    if (!visit) {
      if (visits.size >= maxVisits) { droppedVisits++; return; }
      visit = { id: visits.size + 1, timeOrigin: record.timeOrigin, startMs: record.atMs, visible: record.visible, entries: [], finalized: false, overflow: false }; visits.set(record.timeOrigin, visit);
    }
    if (record.kind === 'final') { visit.finalized = true; visit.endMs = record.atMs; visit.overflow ||= record.overflow === true; }
    else if (record.kind === 'entry') { if (visit.entries.length < maxEntries) visit.entries.push(record); else visit.overflow = true; }
  });
  await context.addInitScript(({ maxEntries }) => {
    if (window.top !== window) return;
    const send = data => { void globalThis.__ieCampaignVital({ timeOrigin: performance.timeOrigin, atMs: performance.now(), ...data }).catch(() => {}); };
    const observers = []; let emitted = 0, overflow = false;
    const entries = values => {
      for (const entry of values) {
        if (emitted >= maxEntries) { overflow = true; continue; }
        emitted++;
        const data = { kind: 'entry', type: entry.entryType, startTime: entry.startTime, duration: entry.duration };
        for (const key of ['interactionId', 'processingStart', 'processingEnd', 'renderTime', 'loadTime', 'size', 'value', 'blockingDuration', 'hadRecentInput']) if (key in entry) data[key] = entry[key];
        send(data);
      }
    };
    send({ kind: 'start', visible: document.visibilityState === 'visible' });
    for (const type of ['largest-contentful-paint', 'layout-shift', 'event', 'first-input', 'long-animation-frame']) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      const observer = new PerformanceObserver(list => entries(list.getEntries()));
      observer.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) }); observers.push(observer);
    }
    addEventListener('pagehide', () => { for (const observer of observers) { entries(observer.takeRecords()); observer.disconnect(); } send({ kind: 'final', visible: document.visibilityState === 'visible', overflow }); }, { once: true });
  }, { maxEntries });
  return { snapshot: () => ({ kind: 'browser-raw-visits-1', visits: [...visits.values()].map(summarizeVisit), rejectedRecords: rejected, droppedVisits, canonicalMetricsQualified: false }), close: () => { disabled = true; } };
}
