import { test, expect } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { startLocalServer } = await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
const output = resolve(process.env.IE_RECOVERY_OUTPUT ?? 'artifacts/p1b2');
let root: string, server: any;
test.beforeEach(async ({ page, context }) => {
  await context.route('**/*', route => { if (new URL(route.request().url()).hostname !== '127.0.0.1') throw Error('Nonlocal request denied'); return route.continue(); });
  root = await mkdtemp(join(await realpath(tmpdir()), 'ie-metadata-browser-'));
  server = await startLocalServer({ root, staticDirectory: resolve(process.env.IE_RECOVERY_APP??resolve(output, 'browser-app')) });
  await page.goto(server.issuePairingURL()); await expect(page.locator('#state')).toHaveText('Recovery consumer ready');
});
test.afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });

test('journal scans keep exact pending originals without collecting terminal history', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { BrowserJournal, allocationLedger } = (window as any).harness;
    const journal = await BrowserJournal.open('metadata-' + crypto.randomUUID()), before = allocationLedger.snapshot();
    // A real IDB transaction seeds long historical delivery storage efficiently.
    const db = journal.db as IDBDatabase, tx = db.transaction('entries', 'readwrite'), store = tx.objectStore('entries');
    for (let n = 0; n < 2000; n++) store.put({ wire: 'terminal-' + n, result: { kind: 'receipt' } }, 'command:' + String(n).padStart(5, '0'));
    const pending = { wire: '{"original":"exact whitespace preserved"}', request: { command: { commandId: 'pending' } }, result: { kind: 'pending' } };
    store.put(pending, 'command:pending'); await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    const getAll = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function () { throw Error('Bulk history materialization forbidden'); };
    const retained: unknown[] = []; let visited = 0, peak = 0;
    try { await journal.scan('command:', (value: any) => { visited++; peak = Math.max(peak, allocationLedger.snapshot().cpuBytes - before.cpuBytes); if (value.result?.kind !== 'receipt') retained.push(value); }); }
    finally { IDBObjectStore.prototype.getAll = getAll; }
    const exists = await journal.has('command:pending'), exact = await journal.get('command:pending'); journal.close();
    return { visited, retained, pending, exists, exact, peak, remaining: allocationLedger.snapshot().cpuBytes - before.cpuBytes };
  });
  expect(result.visited).toBe(2001); expect(result.retained).toEqual([result.pending]); expect(result.exact).toEqual(result.pending); expect(result.exists).toBe(true);
  expect(result.peak).toBe(1024 * 1024); expect(result.remaining).toBe(0);
});

test('font selection stops after requested unique matches and never retains historical registrations', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache, allocationLedger } = (window as any).harness, before = await cache.published();
    for (const [id, font] of [['a', 'requested-a'], ['b', 'requested-a'], ['c', 'requested-b'], ['z', 'historical']]) await cache.put('fonts', 'asset', id, { id, font: { id: font } });
    await cache.publish({ generation: 'fonts', cursor: '1', epoch: '1' }, before);
    const initial = allocationLedger.snapshot(), wanted = new Set(['requested-a', 'requested-b']); let visited = 0;
    const selected = await cache.collect('asset', (asset: any) => { visited++; if (!wanted.has(asset.font.id)) return false; wanted.delete(asset.font.id); return true; }, wanted.size);
    let invalid = ''; try { await cache.collect('asset', () => true, 17); } catch (error) { invalid = String(error); }
    return { selected, visited, invalid, remaining: allocationLedger.snapshot().cpuBytes - initial.cpuBytes };
  });
  expect(result.selected.map((asset: any) => asset.id)).toEqual(['a', 'c']); expect(result.visited).toBe(3); expect(result.invalid).toContain('CACHE_SELECTION_LIMIT'); expect(result.remaining).toBe(0);
});

test('cursor callback failure keeps journal originals and refunds the admitted read copy', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { BrowserJournal, allocationLedger } = (window as any).harness, journal = await BrowserJournal.open('refusal-' + crypto.randomUUID());
    const original = { request: { requestId: 'unknown-delivery' }, done: false }; await journal.put('ui-request:ui:unknown-delivery', original);
    const before = allocationLedger.snapshot(); let failure = '';
    try { await journal.scan('ui-request:ui:', () => { throw Error('CONTROL_ADMISSION_REFUSED'); }); } catch (error) { failure = String(error); }
    const retained = await journal.get('ui-request:ui:unknown-delivery'); journal.close();
    return { failure, original, retained, remaining: allocationLedger.snapshot().cpuBytes - before.cpuBytes };
  });
  expect(result.failure).toContain('CONTROL_ADMISSION_REFUSED'); expect(result.retained).toEqual(result.original); expect(result.remaining).toBe(0);
});
