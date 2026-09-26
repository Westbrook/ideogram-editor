import CanvasKitInit from 'canvaskit-wasm';
import type { CanvasKit, Typeface } from 'canvaskit-wasm';
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import profile from './profile.json';
import { admitRequest, textIndices } from './admission';
import { fail, hashBytes, LIMITS, readSealedAsset } from './contracts';
import type { PreparedText, TextRequest } from './contracts';
import { inspectFont } from './font';
import { paragraphDirection } from './bidi';
import { planText } from './memory';

type Kit = CanvasKit & { HEAPU8: Uint8Array; purgeOwnedTextCaches(): void; _free(pointer: number): void };
type FontCache = { provider: ReturnType<CanvasKit['TypefaceFontProvider']['Make']>; faces: {hash: string; face: Typeface}[] };
const fontCaches = new WeakMap<Kit, FontCache>();
function suppliedFaces(ck: Kit, order: string[], buffers: Map<string, ArrayBuffer>): FontCache {
  // Keep exact registered faces for this worker lifetime. They live entirely in
  // its booked heap; repeated font-set switches do not reload identical bytes.
  // No unproven native cache eviction/refund is used to admit another face.
  let cache = fontCaches.get(ck);
  if (!cache) { cache = {provider: ck.TypefaceFontProvider.Make(), faces: []}; fontCaches.set(ck, cache); }
  const missing = order.filter(hash => !cache!.faces.some(face => face.hash === hash));
  if (cache.faces.length + missing.length > LIMITS.faces) fail('FONT_CACHE_CAPACITY');
  for (const hash of missing) {
    cache.provider.registerFont(buffers.get(hash)!, hash);
    const face = cache.provider.matchFamilyStyle(hash, { weight: ck.FontWeight.Normal, width: ck.FontWidth.Normal, slant: ck.FontSlant.Upright });
    if (!face) fail('FONT_NATIVE_PARSE', { hash });
    cache.faces.push({hash, face});
  }
  if (cache.provider.countFamilies() !== cache.faces.length) fail('FONT_NATIVE_PARSE');
  // Only this request's ordered supplied faces may occur in accepted runs.
  return { provider: cache.provider, faces: order.map(hash => cache!.faces.find(face => face.hash === hash)!) };
}
export async function createTextEngine(): Promise<Kit> {
  const url = new URL(wasmUrl, location.href);
  if (url.origin !== location.origin) fail('TEXT_ENGINE_ORIGIN');
  const bytes = await (await readSealedAsset(url, profile.engine.wasm.bytes)).arrayBuffer();
  if (bytes.byteLength !== profile.engine.wasm.bytes || await hashBytes(bytes) !== 'sha256:' + profile.engine.wasm.sha256) fail('TEXT_ENGINE_HASH');
  const module = await WebAssembly.compile(bytes);
  const memoryName = WebAssembly.Module.exports(module).find(e => e.kind === 'memory')?.name;
  if (!memoryName) fail('TEXT_ENGINE_ABI');
  const options = {
    locateFile: () => url.href,
    instantiateWasm(importObject: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(module, importObject);
      const memory = instance.exports[memoryName] as WebAssembly.Memory;
      if (memory.buffer.byteLength !== 16 * 1024 ** 2) fail('TEXT_HEAP_PROFILE');
      receive(instance); return instance.exports;
    },
  };
  const kit = await CanvasKitInit(options) as Kit;
  if (kit.ParagraphBuilder.RequiresClientICU()) fail('TEXT_UNICODE_PROFILE');
  return kit;
}

function finite(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('TEXT_NONFINITE_LAYOUT');
  if (value && typeof value === 'object') Object.values(value).forEach(finite);
}
export async function prepareText(request: TextRequest, ck: Kit): Promise<PreparedText> {
  const { order, total } = admitRequest(request);
  const indices = textIndices(request.text), plan = planText(request);
  const fontBuffers = new Map<string, ArrayBuffer>();
  let glyphBudget = plan.glyphs, runBudget = plan.runs, lineBudget = plan.lines, rectBudget = plan.rectangles;
  const dependencies: PreparedText['dependencies'][number][] = [];
  // Font bytes are verified and parsed in this worker before FreeType sees them.
  for (const hash of order) {
    const font = request.fonts.find(f => f.hash === hash)!;
    const bytes = await font.bytes.arrayBuffer();
    if (await hashBytes(bytes) !== hash) fail('FONT_HASH', { hash });
    const record = inspectFont(bytes); fontBuffers.set(hash, bytes);
    dependencies.push({ hash, licenseHash: font.license.hash, faceIndex: 0,
      format: record.format, parserProfile: record.parserProfile, fsType: record.fsType, bytes: font.bytes });
  }
  const textUtf8 = new Blob([new TextEncoder().encode(request.text)], { type: 'text/plain;charset=utf-8' });
  const textHash = await hashBytes(textUtf8);
  const s = request.style;
  const dependencyHash = await hashBytes(new TextEncoder().encode(JSON.stringify({ rendererProfile: profile.id, textHash,
    style: { primaryFont:s.primaryFont, explicitFallbacks:s.explicitFallbacks, sizePx:s.sizePx,
      lineHeightMultiplier:s.lineHeightMultiplier, fill:s.fill, align:s.align, direction:s.direction },
    frame: {width:request.frame.width,height:request.frame.height}, fonts: dependencies.map(({bytes: _bytes, ...d}) => d) })));
  const {provider, faces} = suppliedFaces(ck, order, fontBuffers);
  const collection = ck.FontCollection.Make();
  const width = Math.ceil(request.frame.width), height = Math.ceil(request.frame.height);
  let surface: ReturnType<CanvasKit['MakeSurface']> = null;
  let rasterMemory: ReturnType<CanvasKit['Malloc']> | undefined;
  const paragraphs: unknown[] = [];
  let top = 0, start16 = 0, overflow = false;
  try {
    collection.setDefaultFontManager(provider);
    // The only manager is our explicit provider. Every returned run must also
    // resolve by native typeface identity to a supplied hash below.
    rasterMemory = ck.Malloc(Uint8Array, width * height * 4);
    if (!rasterMemory.byteOffset) fail('TEXT_SURFACE_ALLOCATION');
    surface = ck.MakeRasterDirectSurface({ width, height, colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }, rasterMemory, width * 4);
    if (!surface) fail('TEXT_SURFACE_ALLOCATION');
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    canvas.clipRect(ck.LTRBRect(0, 0, request.frame.width, request.frame.height), ck.ClipOp.Intersect, true);
    const { style } = request;
    const fontMetrics = faces.map(({hash,face}) => {
      const font = new ck.Font(face, style.sizePx);
      try { font.setHinting(ck.FontHinting.None); return { hash, ...font.getMetrics() }; }
      finally { font.delete(); }
    });
    // CanvasKit's heightMultiplier is relative to size, not font metrics.
    // Resolve our policy first: largest supplied face's ascent/descent/leading
    // span, scaled by the user's multiplier, with symmetric extra leading.
    const intrinsicHeight = Math.max(...fontMetrics.map(m => m.descent - m.ascent + m.leading));
    const lineHeight = intrinsicHeight * style.lineHeightMultiplier;
    if (!Number.isFinite(lineHeight) || lineHeight <= 0 || lineHeight > LIMITS.side) fail('TEXT_LINE_HEIGHT_LIMIT');
    const align = { left: ck.TextAlign.Left, center: ck.TextAlign.Center, right: ck.TextAlign.Right,
      start: ck.TextAlign.Start, end: ck.TextAlign.End }[style.align];
    for (const text of request.text.split('\n')) {
      const local = textIndices(text), start8 = indices.utf16ToUtf8[start16];
      const direction = style.direction === 'auto' ? paragraphDirection(text) : style.direction;
      const paragraphStyle = new ck.ParagraphStyle({ disableHinting: true, applyRoundingHack: false,
        textAlign: align, textDirection: direction === 'rtl' ? ck.TextDirection.RTL : ck.TextDirection.LTR,
        textStyle: { fontFamilies: order, fontSize: style.sizePx, fontStyle: { weight: ck.FontWeight.Normal, width: ck.FontWidth.Normal, slant: ck.FontSlant.Upright },
          heightMultiplier: lineHeight / style.sizePx, halfLeading: true, locale: 'und',
          color: ck.Color(...style.fill.slice(0, 3) as [number, number, number], style.fill[3] / 255) } });
      const builder = ck.ParagraphBuilder.MakeFromFontCollection(paragraphStyle, collection);
      let paragraph: ReturnType<typeof builder.build> | undefined;
      try {
        builder.addText(text); paragraph = builder.build(); paragraph.layout(request.frame.width);
        const bounded = paragraph as typeof paragraph & { getShapedLinesBounded(g: number, r: number, l: number): ReturnType<NonNullable<typeof paragraph>['getShapedLines']> | null; getRectsForRangeBounded(a: number, b: number, h: unknown, w: unknown, limit: number): Float32Array | null };
        const lineCount = paragraph.getNumberOfLines();
        if (lineCount > lineBudget) fail('TEXT_LAYOUT_BUDGET');
        lineBudget -= lineCount;
        const missing = paragraph.unresolvedCodepoints();
        if (missing.length) fail('TEXT_MISSING_GLYPHS', { codepoints: [...new Set(missing)].sort((a,b) => a-b) });
        const utf16 = (byte: number) => {
          if (!Number.isInteger(byte) || local.utf8ToUtf16[byte] === undefined || local.utf8ToUtf16[byte] < 0) fail('TEXT_LAYOUT_INDEX', { byte, text, metrics: paragraph!.getLineMetrics() });
          return start16 + local.utf8ToUtf16[byte];
        };
        const utf8 = (index: number) => {
          if (!Number.isInteger(index) || local.utf16ToUtf8[index] === undefined || local.utf16ToUtf8[index] < 0) fail('TEXT_LAYOUT_INDEX', { index });
          return start8 + local.utf16ToUtf8[index];
        };
        // SkParagraph TextLine::getMetrics exposes UTF-16 here; visitor run
        // offsets below are UTF-8. These are different native API conventions.
        const lines = paragraph.getLineMetrics().map(m => ({ baseline: m.baseline + top,
          ascent: m.ascent, descent: m.descent, height: m.height, width: m.width, left: m.left,
          lineNumber: m.lineNumber, isHardBreak: m.isHardBreak,
          startUtf8: utf8(m.startIndex), endUtf8: utf8(m.endIndex),
          startUtf16: start16 + m.startIndex, endUtf16: start16 + m.endIndex,
          endExcludingWhitespacesUtf16: start16 + m.endExcludingWhitespaces,
          endIncludingNewlineUtf16: start16 + m.endIncludingNewline,
          endExcludingWhitespacesUtf8: utf8(m.endExcludingWhitespaces),
          endIncludingNewlineUtf8: utf8(m.endIncludingNewline) }));
        const shaped = bounded.getShapedLinesBounded(glyphBudget, runBudget, lineCount);
        if (!shaped) fail('TEXT_LAYOUT_BUDGET');
        const runs: unknown[] = [];
        try {
          for (const line of shaped) for (const run of line.runs) {
            glyphBudget -= run.glyphs.length; runBudget--;
            const fontHash = faces.find(f => run.typeface?.isAliasOf(f.face))?.hash;
            if (!fontHash) fail('TEXT_UNRESOLVED_RUN_FONT');
            if (run.fakeBold || run.fakeItalic) fail('TEXT_SYNTHETIC_FACE');
            if (run.glyphs.some(g => g === 0)) fail('TEXT_MISSING_GLYPHS', { codepoints: local.scalars.map(s => s.codepoint) });
            const offsets = Array.from(run.offsets);
            const font = new ck.Font(run.typeface, run.size);
            let inkBounds: number[][];
            try {
              font.setHinting(ck.FontHinting.None); font.setSubpixel(true);
              const bounds = font.getGlyphBounds(run.glyphs);
              inkBounds = Array.from(run.glyphs, (_,i) => [bounds[i*4]+run.positions[i*2], bounds[i*4+1]+run.positions[i*2+1]+top,
                bounds[i*4+2]+run.positions[i*2], bounds[i*4+3]+run.positions[i*2+1]+top]);
            } finally { font.delete(); }
            overflow ||= inkBounds.some(([l,t,r,b]) => r > l && b > t && (l < 0 || t < 0 || r > request.frame.width || b > request.frame.height));
            runs.push({ fontHash, size: run.size, flags: run.flags,
              glyphs: Array.from(run.glyphs), offsetsUtf8: offsets.map(x => x + start8),
              offsetsUtf16: offsets.map(utf16), positions: Array.from(run.positions, (v,i) => v + (i % 2 ? top : 0)),
              inkBounds, top: line.top + top, bottom: line.bottom + top, baseline: line.baseline + top });
          }
        } finally { for (const line of shaped) for (const run of line.runs) run.typeface?.delete(); }
        const clusters: unknown[] = [], seen = new Set<string>();
        for (const scalar of local.scalars) {
          const glyph = paragraph.getGlyphInfoAt(scalar.utf16);
          if (!glyph || glyph.isEllipsis) fail('TEXT_CLUSTER_UNAVAILABLE', { utf16: start16 + scalar.utf16 });
          const { start, end } = glyph.graphemeClusterTextRange;
          if (local.utf16ToUtf8[start] === undefined || local.utf16ToUtf8[start] < 0 || local.utf16ToUtf8[end] === undefined || local.utf16ToUtf8[end] < 0) fail('TEXT_CLUSTER_INDEX');
          const key = start + ':' + end;
          if (seen.has(key)) continue; seen.add(key);
          const rects = bounded.getRectsForRangeBounded(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight, rectBudget);
          if (!rects) fail('TEXT_LAYOUT_BUDGET');
          rectBudget -= rects.length / 5;
          const ranges = [];
          try { for (let i = 0; i < rects.length; i += 5) ranges.push({rect: [rects[i], rects[i+1]+top, rects[i+2], rects[i+3]+top], direction: rects[i+4] === 1 ? 'ltr' : 'rtl'}); }
          finally { if (rects.length) ck._free(rects.byteOffset); }
          clusters.push({ startUtf16: start16 + start, endUtf16: start16 + end,
            startUtf8: start8 + local.utf16ToUtf8[start], endUtf8: start8 + local.utf16ToUtf8[end],
            direction: glyph.dir.value === ck.TextDirection.RTL.value ? 'rtl' : 'ltr',
            rect: Array.from(glyph.graphemeLayoutBounds, (v,i) => v + (i % 2 ? top : 0)),
            ranges });
        }
        const paragraphHeight = paragraph.getHeight();
        paragraphs.push({ startUtf16: start16, endUtf16: start16 + text.length, startUtf8: start8,
          endUtf8: start8 + local.bytes, top, height: paragraphHeight, direction, lines, runs, clusters });
        overflow ||= top + paragraphHeight > request.frame.height || lines.some(l => l.left < 0 || l.left + l.width > request.frame.width);
        canvas.drawParagraph(paragraph, 0, top);
        top += paragraphHeight; start16 += text.length + 1;
      } finally { paragraph?.delete(); builder.delete(); }
    }
    surface.flush();
    // Read the CPU surface's explicit unpremultiplied sRGB storage. No second
    // native full-frame allocation or implicit HTML canvas conversion occurs.
    const pixels = new Uint8Array(rasterMemory.toTypedArray());
    if (pixels.byteLength !== width * height * 4) fail('TEXT_READBACK');
    // Transparent RGB is canonical zero, independent of Skia's hidden color.
    for (let i = 0; i < pixels.length; i += 4) if (!pixels[i + 3]) pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    const layoutValue = { version: 'layout-1', policy: 'text-layout-1', frame: request.frame,
      indexConvention: 'half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end',
      utf16ToUtf8: indices.utf16ToUtf8, utf8ToUtf16: indices.utf8ToUtf16,
      lineHeightPolicy: 'max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines',
      fontMetrics: fontMetrics.map(m => ({hash:m.hash,ascent:m.ascent,descent:m.descent,leading:m.leading})),
      intrinsicHeight, requestedLineHeight: lineHeight, logicalLines: indices.lines, paragraphs, height: top, overflow };
    finite(layoutValue);
    const layout = new Blob([JSON.stringify(layoutValue)], { type: 'application/json' });
    if (layout.size > LIMITS.layoutBytes) fail('TEXT_LAYOUT_SIZE');
    const rgba = new Blob([pixels], { type: 'application/octet-stream' });
    if (ck.HEAPU8.byteLength > LIMITS.wasmBytes) fail('TEXT_HEAP_LIMIT');
    return { kind: 'prepared-text-1', token: request.token, rendererProfile: profile.id, dependencyHash,
      dependencies, textUtf8, textHash, layout, layoutHash: await hashBytes(layout), rgba, rasterHash: await hashBytes(rgba),
      width, height, overflow, allocation: { wasmHeapBytes: ck.HEAPU8.byteLength, uniqueFontBytes: total,
        rasterBytes: rgba.size, layoutBytes: layout.size, gpuBytes: 0 } };
  } finally {
    surface?.delete(); if (rasterMemory?.byteOffset) ck.Free(rasterMemory);
    collection.delete();
    ck.purgeOwnedTextCaches();
  }
}
