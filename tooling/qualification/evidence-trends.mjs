/** Static PERF §7 trend views from retained observations. No network or dashboard service. */
import { open, opendir, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileIdentity, relativeMember, createRetentionIndex, evidencePath, evidenceDestination, readEvidenceJSON } from './evidence-volume.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escape = value => String(value ?? 'unknown').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const code = value => typeof value === 'string' && /^[A-Za-z0-9_.:/+-]{1,256}$/.test(value) ? value : null;
const timestamp = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const read = readEvidenceJSON;
async function write(path, value) { const fd = await open(path, 'wx', 0o600); try { await fd.writeFile(value); await fd.sync(); } finally { await fd.close(); } }
export function trendPoints(receipt, raw) {
  const points = [], scopeRevision = code(receipt.revision), sourceRevision = code(receipt.identity?.before?.head), dirtyDigest = code(receipt.identity?.before?.digest);
  const inputFixture = code(receipt.inputIdentities?.fixtureManifest?.sha256);
  const groups = Array.isArray(receipt.groups) ? receipt.groups : [];
  for (const group of groups) {
    const fixture = code(group.fixtureIdentity?.sha256) ?? code(group.fixtureIdentity) ?? inputFixture;
    const attempts = Array.isArray(group.attempts) ? group.attempts : [], cellIdentity = digest(group.cell ?? null);
    for (const attempt of attempts.length ? attempts : [{ status: 'INCONCLUSIVE' }]) {
      if (points.length >= 10000) throw Error('Per-receipt trend bound');
      if (attempt.prime) continue;
      const actualFixture = code(attempt.result?.fixtureIdentity) ?? fixture;
      const workload = code(group.cell?.workload), cell = code(group.cell?.id), cache = ['cold', 'warm', 'single'].includes(group.cache) ? group.cache : 'unknown';
      const measuredMs = finite(attempt.elapsedMs) ? attempt.elapsedMs : null;
      const censored = attempt.censor !== undefined || attempt.timedOut === true;
      const lowerMs = finite(attempt.censor?.lowerMs) ? attempt.censor.lowerMs : null;
      const status = ['PASS', 'FAIL', 'INCONCLUSIVE'].includes(attempt.status) ? attempt.status : 'INCONCLUSIVE';
      // Exact cell digest includes dimensions, operation and prescribed counts. Never merge
      // unknown fixture identities or different scopes into a deceptively faster series.
      const series = digest({ cache, fixture: actualFixture, workload, cellIdentity, scopeRevision, unknownReceipt: actualFixture && cell && workload ? null : raw.sha256 });
      points.push({ series, cache, fixture: actualFixture, workload, cell, scopeRevision, sourceRevision, dirtyDigest,
        receiptId: code(receipt.receiptId), recordedAt: timestamp(receipt.finishedAt), attemptId: code(attempt.id), status,
        measuredMs: censored ? null : measuredMs, censored, lowerMs, upperMs: censored ? null : measuredMs,
        completeIdentity: !!(actualFixture && workload && cell && scopeRevision), raw });
    }
  }
  if (!points.length) points.push({ series: digest({ unknown: raw.sha256 }), cache: 'unknown', fixture: null, workload: null, cell: null, scopeRevision,
    sourceRevision, dirtyDigest, receiptId: code(receipt.receiptId), recordedAt: timestamp(receipt.finishedAt), attemptId: null,
    status: 'INCONCLUSIVE', measuredMs: null, censored: false, lowerMs: null, upperMs: null, completeIdentity: false, raw,
    reason: 'No recognized runtime campaign observations; raw receipt retained.' });
  return points;
}
export function renderTrends(document, htmlDirectory) {
  const groups = new Map(); for (const point of document.points) { if (!groups.has(point.series)) groups.set(point.series, []); groups.get(point.series).push(point); }
  const sections = [];
  for (const values of groups.values()) {
    const first = values[0], maximum = Math.max(1, ...values.map(point => point.measuredMs ?? point.lowerMs ?? 0));
    const ordered = [...values].sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
    const dots = ordered.map((point, index) => {
      const x = 30 + index * 900 / Math.max(1, ordered.length - 1), value = point.measuredMs ?? point.lowerMs, y = value === null ? 190 : 190 - value / maximum * 150;
      const rawHref = relative(htmlDirectory, point.raw.absolutePath).split('/').map(encodeURIComponent).join('/');
      const color = point.status === 'FAIL' ? '#b42318' : point.status === 'PASS' ? '#176341' : '#9a6700';
      const symbol = value === null ? `<text x="${x}" y="${y}" fill="${color}">?</text>` : point.censored ? `<path d="M${x-5} ${y+5} L${x} ${y-5} L${x+5} ${y+5}" fill="none" stroke="${color}"/>` : `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`;
      return `<a href="${escape(rawHref)}">${symbol}<title>${escape(point.status + ' ' + (point.censored ? 'right-censored ≥' + point.lowerMs : value) + ' ms; ' + point.recordedAt + '; source ' + point.sourceRevision)}</title></a>`;
    }).join('');
    sections.push(`<section><h2>${escape(first.cell)} · ${escape(first.cache)}</h2><p>Fixture ${escape(first.fixture)} · scope ${escape(first.scopeRevision)}. ${first.completeIdentity ? 'Exact fixture/scope series.' : 'Identity incomplete: isolated series, no comparison claim.'}</p><svg viewBox="0 0 980 220" role="img" aria-label="Observed elapsed milliseconds; triangles are right-censored lower bounds and question marks unavailable"><text x="0" y="20">${escape(maximum)} ms</text><path d="M25 25V195H950" fill="none" stroke="#888"/>${dots}</svg><table><thead><tr><th>UTC</th><th>Status</th><th>Elapsed ms</th><th>Source / dirty identity</th><th>Raw evidence</th></tr></thead><tbody>${ordered.map(point => `<tr><td>${escape(point.recordedAt)}</td><td>${escape(point.status)}</td><td>${point.censored ? '≥ ' + escape(point.lowerMs) + ' (right-censored)' : escape(point.measuredMs)}</td><td>${escape(point.sourceRevision)} / ${escape(point.dirtyDigest)}</td><td><a href="${escape(relative(htmlDirectory, point.raw.absolutePath).split('/').map(encodeURIComponent).join('/'))}">${escape(point.receiptId ?? point.raw.sha256)}</a></td></tr>`).join('')}</tbody></table></section>`);
  }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>Ideogram qualification trends</title><style>body{font:15px system-ui;margin:2rem;max-width:1100px;color:#17211e;background:#f7faf8}section{border-top:1px solid #bbc9c1;margin-top:2rem}svg{width:100%;max-height:250px}td,th{text-align:left;padding:.4rem;overflow-wrap:anywhere}table{width:100%;font-size:12px}a{color:#125c42}</style><h1>Retained qualification observations</h1><p>Cold, warm, single-session and exact fixture/scope series stay separate. Failed and censored starts remain visible. No interpolation, field percentile or cross-fixture aggregation is claimed. Unknown observations do not establish a pass.</p><p>Inputs: ${document.receipts}; unavailable inputs: ${document.unavailable.length}. Publication: ${escape(document.recordedAt)}.</p>${sections.join('')}<p>Unavailable receipt identities: ${escape(document.unavailable.map(item => item.sha256).join(', ') || 'none')}.</p>`;
}
export async function publishTrends({ allocation, receiptPath, outputDirectory }) {
  await evidenceDestination(allocation.root, outputDirectory, { directory: true, mustExist: true });
  const registry = join(allocation.root, '.evidence-lifecycle', 'runs'); await mkdir(registry, { recursive: true, mode: 0o700 });
  await evidencePath(allocation.root, '.evidence-lifecycle/runs');
  relativeMember(allocation.root, receiptPath); relativeMember(allocation.root, outputDirectory);
  const identity = await fileIdentity(receiptPath), entry = { path: relativeMember(allocation.root, receiptPath), ...identity };
  await write(join(registry, randomUUID() + '.json'), JSON.stringify(entry) + '\n');
  const points = [], unavailable = [], seen = new Set(); let receipts = 0;
  const handle = await opendir(registry);
  for await (const member of handle) {
    if (!member.isFile() || member.isSymbolicLink() || ++receipts > 10000) throw Error('Trend registry bound/type violation');
    const raw = await read(await evidencePath(allocation.root, '.evidence-lifecycle/runs/' + member.name));
    if (typeof raw.path !== 'string' || raw.path.length > 4096 || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) throw Error('Invalid bounded trend registry member');
    if (seen.has(raw.sha256)) continue; seen.add(raw.sha256);
    try {
      const absolutePath = await evidencePath(allocation.root, raw.path);
      if (JSON.stringify(await fileIdentity(absolutePath)) !== JSON.stringify({ bytes: raw.bytes, sha256: raw.sha256 })) throw Error('Trend receipt identity changed');
      const receipt = await read(absolutePath); const next = trendPoints(receipt, { ...raw, absolutePath });
      if (points.length + next.length > 10000) throw Error('Trend observation bound');
      points.push(...next);
    } catch { unavailable.push({ sha256: raw.sha256, reason: 'Retained receipt unavailable, changed or unsupported; never counted as passing.' }); }
  }
  const document = { kind: 'evidence-trend-index-1', recordedAt: new Date().toISOString(), allocationId: allocation.allocationId, receipts, points, unavailable, qualification: false, aggregatesAcrossFixtures: false };
  const json = JSON.stringify(document, null, 2) + '\n', html = renderTrends(document, outputDirectory);
  if (Buffer.byteLength(json) > 16 * 1024 * 1024 || Buffer.byteLength(html) > 16 * 1024 * 1024) throw Error('Trend publication bound');
  await write(join(outputDirectory, 'trends.json'), json); await write(join(outputDirectory, 'trends.html'), html);
  await createRetentionIndex({ allocation, output: join(outputDirectory, 'trend-retention.json'), entries: ['trends.json', 'trends.html'].map(name => ({ path: relativeMember(allocation.root, join(outputDirectory, name)), category: 'aggregate', createdAt: document.recordedAt })) });
  return { path: relativeMember(allocation.root, join(outputDirectory, 'trends.html')), receipts, points: points.length, unavailable: unavailable.length };
}
