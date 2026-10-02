// Test fixture protocol only. The product exposes retained reads, never these
// scalar selectors or serialized views across its public API.
const scalars = new Set([
  'projectionDigest', 'settings.journal_mode', 'settings.synchronous',
  'settings.foreign_keys', 'settings.busy_timeout', 'settings.page_count',
  'settings.max_page_count', 'missingCount', 'missing.0.code',
  'inventory.orphanCount', 'inventory.stagingCount',
  'observations.snapshot.latest', 'observations.snapshot.pressure',
]);
const views = new Set(['inventory', 'core-log', 'all']);
const invalid = () => Object.assign(Error('Unsupported test diagnostic selection'), { code: 'MALFORMED_REQUEST' });

function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJSON(item) ?? 'null').join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().flatMap(key => {
    const encoded = canonicalJSON(value[key]);
    return encoded === undefined ? [] : [JSON.stringify(key) + ':' + encoded];
  }).join(',') + '}';
  return JSON.stringify(value);
}

function send(channel, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      channel.off('disconnect', disconnected);
      error ? reject(error) : resolve();
    };
    const disconnected = () => finish(Error('Diagnostic IPC disconnected'));
    channel.once('disconnect', disconnected);
    if (!channel.connected) { disconnected(); return; }
    try {
      // false denotes backpressure. Only the callback or definite disconnect
      // ends the native handoff; never release merely because send returned.
      channel.send(message, error => finish(error));
    } catch (error) { finish(error); }
  });
}

export async function sendDiagnosticResult(writer, { id, method, args }, channel = process) {
  if (!Number.isSafeInteger(id) || id < 1 || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') throw invalid();
  const selector = args[0];
  if (!(method === 'diagnosticScalar' ? scalars.has(selector) : method === 'diagnosticJSON' && views.has(selector))) throw invalid();
  const read = await writer.readDiagnostics();
  try {
    const value = read.value;
    let result;
    if (method === 'diagnosticScalar') {
      result = selector.split('.').reduce((parent, key) => parent?.[key], value);
      if (result !== null && !['string', 'number', 'boolean'].includes(typeof result)) throw invalid();
    } else if (selector === 'inventory') result = canonicalJSON(value.inventory);
    else if (selector === 'core-log') result = JSON.stringify({
      runtime: value.node, sqlite: value.sqlite, settings: value.settings,
      filesystem: value.filesystem, resources: value.resources,
      observations: value.observations, memory: value.processMemory,
    });
    else result = JSON.stringify(value);
    if (method === 'diagnosticJSON' && typeof result !== 'string') throw invalid();
    await send(channel, { type: 'result', id, result });
  } finally { read.release(); }
}
