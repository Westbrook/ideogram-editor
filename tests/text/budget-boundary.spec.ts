import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startLocalServer } = await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
type NativeFont = { url: string; hash: string; bytes: number; licenseHash: string };
let server: Awaited<ReturnType<typeof startLocalServer>>, origin: string, root: string, font: NativeFont;

test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(resolve('vendor/text/manifest.json'), 'utf8'));
  const source = manifest.fonts.find((value: { id: string }) => value.id === 'NotoSans');
  expect(source).toBeDefined();
  const assets = resolve(process.env.TEXT_APP??'artifacts/p1c1/app','assets');
  const matches: string[] = [];
  for (const name of await readdir(assets)) {
    if (!/^NotoSans-Regular-.*\.ttf$/.test(name)) continue;
    const bytes = await readFile(resolve(assets, name));
    if (bytes.length === source.bytes && createHash('sha256').update(bytes).digest('hex') === source.sha256) matches.push(name);
  }
  expect(matches).toHaveLength(1);
  font = { url: '/assets/' + matches[0], hash: 'sha256:' + source.sha256, bytes: source.bytes, licenseHash: source.licenseHash };
  root = await mkdtemp(resolve(await realpath(tmpdir()), 'ie-text-budget-'));
  server = await startLocalServer({ root: resolve(root, 'private'), staticDirectory: resolve(process.env.TEXT_APP??'artifacts/p1c1/app') });
  origin = server.origin;
});

test.afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true });
});

async function prepareBoundary(page: Page, text: string) {
  return page.evaluate(async ({ text, font }) => {
    const f = (window as any).textFixture;
    const before = f.textMemory.snapshot;
    let fontBlob: Blob | undefined, request: any, prepared: any, inspection: any, layout: any, pixels: Uint8Array | undefined;
    let result: any;
    try {
      // Use the exact sealed, app-distributed bundled face as an explicit caller
      // input. The foundation's permanent bundled-font cache is deliberately not
      // populated: zero below means released ownership, never a cache reset.
      const response = await fetch(font.url);
      if (!response.ok) throw Error('BOUNDARY_FONT_FETCH');
      fontBlob = await response.blob();
      if (fontBlob.size !== font.bytes || await f.hashBytes(fontBlob) !== font.hash) throw Error('BOUNDARY_FONT_IDENTITY');
      request = {
        token: { documentId: 'budget-document', documentRevision: '1', layerId: 'budget-layer', layerVersion: '1', sessionId: 'budget-session', generation: 1 },
        text, fonts: [{ hash: font.hash, bytes: fontBlob, faceIndex: 0, origin: 'bundled', license: { hash: font.licenseHash, embedding: 'permitted' } }],
        style: { primaryFont: font.hash, explicitFallbacks: [], sizePx: 32, lineHeightMultiplier: 1.2, fill: [40, 90, 190, 255], align: 'start', direction: 'auto' },
        frame: { width: 360, height: 180 },
      };
      const plan = f.planText(request);
      prepared = await f.renderer.prepare(request);
      const retained = f.textMemory.snapshot;
      // Inspection belongs to the test caller. Book its parsed layout, text and
      // pixels separately rather than implying that output retention covers it.
      inspection = f.textMemory.reserve(6 * prepared.layout.size + 4 * prepared.rgba.size + 4 * prepared.textUtf8.size + 65536);
      layout = JSON.parse(await prepared.layout.text());
      pixels = new Uint8Array(await prepared.rgba.arrayBuffer());
      const paragraphs = layout.paragraphs.map((paragraph: any) => {
        let glyphs = 0, offsetsValid = true, suppliedFont = true, glyphsValid = true;
        for (const run of paragraph.runs) {
          glyphs += run.glyphs.length;
          offsetsValid &&= run.offsetsUtf8.length === run.glyphs.length + 1 && run.offsetsUtf16.length === run.glyphs.length + 1 &&
            run.positions.length === 2 * (run.glyphs.length + 1) && run.inkBounds.length === run.glyphs.length &&
            run.offsetsUtf16.every((value: number, index: number) => value >= paragraph.startUtf16 && value <= paragraph.endUtf16 && run.offsetsUtf8[index] === value);
          suppliedFont &&= run.fontHash === font.hash;
          glyphsValid &&= run.glyphs.every((value: number) => Number.isInteger(value) && value > 0);
        }
        // Every non-LF ASCII scalar must retain its own grapheme record, even
        // when its native line is below the visible raster frame.
        let next = paragraph.startUtf16;
        let coverage = true;
        for (const cluster of paragraph.clusters) {
          coverage &&= cluster.startUtf16 === next && cluster.endUtf16 === next + 1 && cluster.startUtf8 === next && cluster.endUtf8 === next + 1;
          next++;
        }
        coverage &&= next === paragraph.endUtf16;
        return { start: paragraph.startUtf16, end: paragraph.endUtf16, glyphs, clusters: paragraph.clusters.length,
          runs: paragraph.runs.length, lines: paragraph.lines.length, coverage, offsetsValid, suppliedFont, glyphsValid };
      });
      result = { before, retained, plan, allocation: prepared.allocation, inputBytes: prepared.textUtf8.size,
        exactText: await prepared.textUtf8.text() === text, inputUnchanged: request.text === text,
        layoutBytes: prepared.layout.size, layoutHash: prepared.layoutHash, textHash: prepared.textHash,
        logicalLines: layout.logicalLines, paragraphs, overflow: prepared.overflow,
        mappingIdentity: layout.utf16ToUtf8.length === text.length + 1 && layout.utf8ToUtf16.length === text.length + 1 &&
          layout.utf16ToUtf8.every((value: number, index: number) => value === index) && layout.utf8ToUtf16.every((value: number, index: number) => value === index),
        visiblePixels: pixels.some((value, index) => index % 4 === 3 && value > 0),
      };
    } finally {
      layout = undefined; pixels = undefined;
      inspection?.release(); inspection = undefined;
      if (prepared) f.releasePrepared(prepared);
      prepared = undefined; request = undefined; fontBlob = undefined;
      f.renderer.dispose();
    }
    return { ...result, released: f.textMemory.snapshot, lifecycle: f.renderer.lifecycle };
  }, { text, font });
}

// Independent W=30G+1024runs+512lines+256KiB for these fixed ASCII specimens:
// (G,runs,lines)=(131072,2303,4096) and (114688,1792,3584).
const cases = [
  { name: '16 KiB and 256 logical lines', text: ['A'.repeat(64), ...Array.from({ length: 255 }, () => 'A'.repeat(63))].join('\n'), bytes: 16384, paragraphs: 256, workspace: 8649728 },
  { name: '14 KiB in one naturally wrapped paragraph', text: 'A'.repeat(14 * 1024), bytes: 14 * 1024, paragraphs: 1, workspace: 7372800 },
];

for (const specimen of cases) {
  test('actual native budget retains ' + specimen.name, async ({ page }, info) => {
    const errors: string[] = [], requests: string[] = [], opened = new Set<string>(), closed = new Set<string>();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => requests.push(request.url()));
    page.on('worker', worker => { opened.add(worker.url()); worker.once('close', () => closed.add(worker.url())); });
    const response = await page.goto(origin);
    expect(response!.headers()['content-security-policy']).not.toContain('wasm-unsafe-eval');
    await page.waitForFunction(() => !!(window as any).textFixture);
    const result = await prepareBoundary(page, specimen.text);
    await info.attach('native-budget-boundary', { body: JSON.stringify({ specimen: { bytes: specimen.bytes, paragraphs: specimen.paragraphs }, result }), contentType: 'application/json' });

    expect(result.before).toEqual({ cpuBytes: 0, textBytes: 0 });
    expect(result.inputBytes).toBe(specimen.bytes);
    expect(result.exactText).toBe(true);
    expect(result.inputUnchanged).toBe(true);
    expect(result.mappingIdentity).toBe(true);
    expect(result.logicalLines).toBe(specimen.paragraphs);
    expect(result.paragraphs).toHaveLength(specimen.paragraphs);
    const expectedParagraphs = specimen.text.split('\n');
    let start = 0, glyphs = 0, lines = 0, runs = 0;
    for (const [index, value] of result.paragraphs.entries()) {
      const expected = expectedParagraphs[index];
      expect(value.start).toBe(start);
      expect(value.end).toBe(start + expected.length);
      expect(value.glyphs).toBe(expected.length);
      expect(value.clusters).toBe(expected.length);
      expect(value.coverage && value.offsetsValid && value.suppliedFont && value.glyphsValid).toBe(true);
      expect(value.lines).toBeGreaterThan(1);
      glyphs += value.glyphs; lines += value.lines; runs += value.runs;
      start += expected.length + 1;
    }
    expect(start - 1).toBe(specimen.bytes);
    expect(glyphs).toBe(specimen.bytes - (specimen.paragraphs - 1));
    expect(glyphs).toBeLessThanOrEqual(result.plan.glyphs);
    expect(runs).toBeLessThanOrEqual(result.plan.runs);
    expect(lines).toBeLessThanOrEqual(result.plan.lines);
    expect(result.layoutBytes).toBeGreaterThan(65536);
    expect(result.layoutBytes).toBeLessThanOrEqual(result.plan.layout);
    expect(result.plan.layout).toBeLessThanOrEqual(8 * 1024 ** 2);
    expect(result.plan.workspace).toBe(specimen.workspace);
    expect(result.allocation.layoutBytes).toBe(result.layoutBytes);
    expect(result.allocation.rasterBytes).toBe(360 * 180 * 4);
    expect(result.allocation.wasmHeapBytes).toBeLessThanOrEqual(32 * 1024 ** 2);
    expect(result.allocation.gpuBytes).toBe(0);
    expect(result.overflow).toBe(true);
    expect(result.visiblePixels).toBe(true);
    expect(result.retained.textBytes).toBeLessThanOrEqual(128 * 1024 ** 2);
    expect(result.released).toEqual({ cpuBytes: 0, textBytes: 0 });
    expect(result.lifecycle).toMatchObject({ activeWorkers: 0, idleWorkers: 0, queuedRequests: 0, disposed: true, uncertainBytes: 0 });
    expect(opened.size).toBe(1);
    await expect.poll(() => closed.size).toBe(opened.size);
    expect(requests.every(url => new URL(url).origin === origin)).toBe(true);
    expect(errors).toEqual([]);
  });
}
