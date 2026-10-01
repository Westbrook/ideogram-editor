import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const REVISION = 'PERF-8+A3/TEST-1+A3';
export const digest = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const errorRecord = error => ({ name: String(error?.name ?? 'Error'), code: typeof error?.code === 'string' ? error.code : null, message: String(error?.message ?? error).slice(0, 2048) });
export class PrerequisiteError extends Error {
  constructor(message, evidence = null) { super(message); this.name = 'PrerequisiteError'; this.code = 'CAMPAIGN_PREREQUISITE'; this.evidence = evidence; }
}
// All controller-local adapters use the Node performance time origin. Browser
// and server spans retain their own clock-domain labels and local durations.
export const monotonic = () => performance.now();

export async function fileIdentity(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Expected an ordinary nonsymlink file');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: 'sha256:' + hash.digest('hex') };
}

export async function exclusiveJSON(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

/** A new owned artifact directory, never a reused or symlinked evidence path. */
export async function createOutput(repo, requested) {
  const root = await realpath(repo), allowed = join(root, 'artifacts'), output = resolve(root, requested);
  if (!output.startsWith(allowed + sep)) throw Error('Campaign output must be a new directory under artifacts/');
  await mkdir(allowed, { recursive: true, mode: 0o700 });
  let current = allowed;
  for (const part of ['', ...relative(allowed, dirname(output)).split(sep).filter(Boolean)]) {
    if (part) { current = join(current, part); await mkdir(current, { recursive: true, mode: 0o700 }); }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw Error('Campaign parents must be canonical nonsymlink directories');
  }
  await mkdir(output, { mode: 0o700 }); return output;
}

/** Hash-chained, fsynced append-only events preserve partial starts after a kill. */
export async function createJournal(path) {
  const handle = await open(path, 'wx', 0o600); let sequence = 0, previous = null, chain = Promise.resolve(), closed = false;
  return {
    append(value) {
      if (closed) throw Error('Journal is closed');
      chain = chain.then(async () => {
        const event = { ...sanitize(value), sequence: ++sequence, previous, utc: new Date().toISOString(), monotonicMs: monotonic() };
        const hash = digest(event); await handle.writeFile(JSON.stringify({ ...event, hash }) + '\n'); await handle.sync(); previous = hash; return hash;
      }); return chain;
    },
    async close() { if (closed) return; closed = true; await chain; await handle.close(); },
  };
}

export function readJournal(text) {
  const events = []; let previous = null, incompleteTail = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let event;
    try { event = JSON.parse(lines[i]); }
    catch { if (i === lines.length - 1) { incompleteTail = true; break; } throw Error('Invalid complete journal line'); }
    const { hash, ...body } = event;
    if (body.sequence !== events.length + 1 || body.previous !== previous || digest(body) !== hash) throw Error('Campaign journal chain mismatch');
    events.push(body); previous = hash;
  }
  return { events, head: previous, incompleteTail };
}

/** Keep performance evidence metadata-only even if a driver accidentally returns
 * a provider object. Exact prompt/pixel artifacts belong to the private fixture,
 * not performance receipts. URLs can carry signed credentials and are omitted. */
export function sanitize(value, key = '', depth = 0) {
  if (depth > 30) return '[omitted: depth]';
  if (/^(?:authorization|cookie|setCookie|key|secret|token|prompt|caption|pixels|imageData|body|requestBody|responseBody|url|href|providerReply|rawResponse)$/i.test(key)) return '[omitted: private payload]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return /(?:Bearer\s+\S+|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|https?:\/\/[^\s]*[?&](?:token|key|signature|credential)=)/i.test(value) ? '[omitted: secret-bearing text]' : value.slice(0, 16384);
  if (Array.isArray(value)) return value.map(item => sanitize(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
  return null;
}

export async function readSealedJSON(path, expected = null) {
  if (!isAbsolute(path)) throw Error('Sealed input path must be absolute');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 128 * 1024 * 1024) throw Error('Sealed JSON must be an ordinary file at most 128 MiB');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw Error('Sealed JSON changed during read');
    const identity = { bytes: bytes.length, sha256: digest(bytes) };
    if (expected && expected !== identity.sha256) throw Error('Sealed input digest mismatch');
    return { value: JSON.parse(bytes.toString('utf8')), identity, bytes };
  } finally { await handle.close(); }
}

export async function intervalWait(durationMs, signal) {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw Error('Invalid wait duration');
  const start = monotonic();
  while (monotonic() - start < durationMs) {
    if (signal?.aborted) throw signal.reason ?? Error('Campaign aborted');
    await new Promise(resolve => setTimeout(resolve, Math.min(250, durationMs - (monotonic() - start))));
  }
  return { requestedMs: durationMs, startMs: start, endMs: monotonic(), elapsedMs: monotonic() - start };
}

export function attemptIdentity(cell, cache, ordinal, prime = false) { return `${cell.id}/${cache}/${prime ? 'prime' : 'scored'}/${ordinal}`; }
export function uniqueId(prefix) { return prefix + '-' + randomUUID(); }
