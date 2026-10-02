import type { CanvasKit, Typeface } from 'canvaskit-wasm';
import profile from './profile.json';
import retainedStream from './retained-profiles/7a4dbc6c.json';
import retainedStableStream from './retained-profiles/4fd6f6a1.json';
import retainedIntegration from './retained-profiles/68efa85f.json';
import retainedCombinedCPU from './retained-profiles/6d77f925.json';
import retainedAdapterOwnership from './retained-profiles/c6ca02c2.json';
import retainedHTTPFraming from './retained-profiles/1c399d52.json';
import retainedDeferredManifest from './retained-profiles/e648eede.json';
import retainedStartupProfile from './retained-profiles/891a4688.json';
import retainedTextResources from './retained-profiles/b96236b0.json';
import retainedAdmissionSplit from './retained-profiles/2e9362c1.json';
import retainedParagraphBudget from './retained-profiles/6f7be5be.json';
import { admitRequest, textIndices } from './admission';
import { fail, hashBytes, LIMITS } from './contracts';
import type { PreparedText, TextRequest } from './contracts';
import { inspectFont } from './font';
import { paragraphDirection } from './bidi';
import { planText } from './memory';
import { LayoutWriter } from './layout-writer';
import type { PhaseRecorder } from '../observability/phases.js';

export type Kit = CanvasKit & { HEAPU8: Uint8Array; purgeOwnedTextCaches(): void; _free(pointer: number): void };
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
export async function prepareText(request: TextRequest, ck: Kit, rendererProfile = profile.id, phases?: PhaseRecorder): Promise<PreparedText> {
  const { order, total } = admitRequest(request);
  const indices = textIndices(request.text), plan = planText(request, { legacy: rendererProfile !== profile.id && rendererProfile !== retainedStream.id && rendererProfile !== retainedStableStream.id && rendererProfile !== retainedIntegration.id && rendererProfile !== retainedCombinedCPU.id && rendererProfile !== retainedAdapterOwnership.id && rendererProfile !== retainedHTTPFraming.id && rendererProfile !== retainedDeferredManifest.id && rendererProfile !== retainedStartupProfile.id && rendererProfile !== retainedTextResources.id && rendererProfile !== retainedAdmissionSplit.id && rendererProfile !== retainedParagraphBudget.id, retainedRunQuota: rendererProfile !== profile.id });
  const fontBuffers = new Map<string, ArrayBuffer>();
  let glyphBudget = plan.glyphs, runBudget = plan.runs, lineBudget = plan.lines, rectBudget = plan.rectangles;
  const dependencies: PreparedText['dependencies'][number][] = [];
  const fontReady=phases?.start('font.ready',{documentId:request.token.documentId,revision:request.token.documentRevision,layerId:request.token.layerId,sessionId:request.token.sessionId,generation:request.token.generation,count:order.length,bytes:total});
  try {
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
  const dependencyHash = await hashBytes(new TextEncoder().encode(JSON.stringify({ rendererProfile, textHash,
    style: { primaryFont:s.primaryFont, explicitFallbacks:s.explicitFallbacks, sizePx:s.sizePx,
      lineHeightMultiplier:s.lineHeightMultiplier, fill:s.fill, align:s.align, direction:s.direction },
    frame: {width:request.frame.width,height:request.frame.height}, fonts: dependencies.map(({bytes: _bytes, ...d}) => d) })));
  const {provider, faces} = suppliedFaces(ck, order, fontBuffers);
  fontReady?.end('ok',{boundary:'observed'});
  const collection = ck.FontCollection.Make();
  const width = Math.ceil(request.frame.width), height = Math.ceil(request.frame.height);
  let surface: ReturnType<CanvasKit['MakeSurface']> = null;
  let rasterMemory: ReturnType<CanvasKit['Malloc']> | undefined;
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
    const layoutWriter = new LayoutWriter(plan.layout);
    // The current layout contract fixes field order independently of the caller's
    // parsed/canonical object order. Only the retained streamed profile replays
    // its former insertion-sensitive frame bytes (restored by the verifier).
    const layoutFrame = rendererProfile === retainedStream.id ? request.frame : { width: request.frame.width, height: request.frame.height };
    layoutWriter.raw('{"version":"layout-1","policy":"text-layout-1","frame":').value(layoutFrame)
      .raw(',"indexConvention":').value('half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end')
      .raw(',"utf16ToUtf8":').array(indices.utf16ToUtf8).raw(',"utf8ToUtf16":').array(indices.utf8ToUtf16)
      .raw(',"lineHeightPolicy":').value('max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines')
      .raw(',"fontMetrics":').array(fontMetrics, m => layoutWriter.value({hash:m.hash,ascent:m.ascent,descent:m.descent,leading:m.leading}))
      .raw(',"intrinsicHeight":').value(intrinsicHeight).raw(',"requestedLineHeight":').value(lineHeight)
      .raw(',"logicalLines":').value(indices.lines).raw(',"paragraphs":[');
    let firstParagraph = true;
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
        const paragraphHeight = paragraph.getHeight();
        if (!firstParagraph) layoutWriter.raw(','); firstParagraph = false;
        layoutWriter.raw('{"startUtf16":').value(start16).raw(',"endUtf16":').value(start16 + text.length)
          .raw(',"startUtf8":').value(start8).raw(',"endUtf8":').value(start8 + local.bytes)
          .raw(',"top":').value(top).raw(',"height":').value(paragraphHeight).raw(',"direction":').value(direction)
          .raw(',"lines":').array(paragraph.getLineMetrics(), m => {
            overflow ||= m.left < 0 || m.left + m.width > request.frame.width;
            layoutWriter.value({ baseline: m.baseline + top,
              ascent: m.ascent, descent: m.descent, height: m.height, width: m.width, left: m.left,
              lineNumber: m.lineNumber, isHardBreak: m.isHardBreak,
              startUtf8: utf8(m.startIndex), endUtf8: utf8(m.endIndex),
              startUtf16: start16 + m.startIndex, endUtf16: start16 + m.endIndex,
              endExcludingWhitespacesUtf16: start16 + m.endExcludingWhitespaces,
              endIncludingNewlineUtf16: start16 + m.endIncludingNewline,
              endExcludingWhitespacesUtf8: utf8(m.endExcludingWhitespaces),
              endIncludingNewlineUtf8: utf8(m.endIncludingNewline) });
          }).raw(',"runs":[');
        const shaped = bounded.getShapedLinesBounded(glyphBudget, runBudget, lineCount);
        if (!shaped) fail('TEXT_LAYOUT_BUDGET');
        let firstRun = true;
        try {
          // The native unresolved list excludes some controls. If such a
          // character still produces glyph zero, retain the existing refusal
          // but identify only its native source grapheme, not the paragraph.
          // Visitor offsets are UTF-8 (including RTL runs); glyph-info ranges
          // are UTF-16 and may cover multiple scalars in one affected cluster.
          const missingRanges = new Map<number, {startUtf16: number; endUtf16: number; startUtf8: number; endUtf8: number}>();
          for (const line of shaped) for (const run of line.runs) {
            for (let i = 0; i < run.glyphs.length; i++) if (run.glyphs[i] === 0) {
              const index = utf16(run.offsets[i]) - start16;
              const glyph = paragraph.getGlyphInfoAt(index);
              if (!glyph || glyph.isEllipsis) fail('TEXT_CLUSTER_UNAVAILABLE', { utf16: start16 + index });
              const {start, end} = glyph.graphemeClusterTextRange;
              if (!(start <= index && index < end)) fail('TEXT_CLUSTER_INDEX');
              const startUtf8 = utf8(start), endUtf8 = utf8(end);
              missingRanges.set(start, {startUtf16: start16 + start, endUtf16: start16 + end, startUtf8, endUtf8});
            }
          }
          if (missingRanges.size) {
            const ranges = [...missingRanges.values()].sort((a,b) => a.startUtf16-b.startUtf16);
            const codepoints = new Set<number>();
            let range = 0;
            for (const scalar of local.scalars) {
              const index = start16 + scalar.utf16;
              while (range < ranges.length && index >= ranges[range].endUtf16) range++;
              if (range < ranges.length && index >= ranges[range].startUtf16) codepoints.add(scalar.codepoint);
            }
            fail('TEXT_MISSING_GLYPHS', { codepoints: [...codepoints].sort((a,b) => a-b), ranges });
          }
          for (const line of shaped) for (const run of line.runs) {
            glyphBudget -= run.glyphs.length; runBudget--;
            const fontHash = faces.find(f => run.typeface?.isAliasOf(f.face))?.hash;
            if (!fontHash) fail('TEXT_UNRESOLVED_RUN_FONT');
            if (run.fakeBold || run.fakeItalic) fail('TEXT_SYNTHETIC_FACE');
            const font = new ck.Font(run.typeface, run.size);
            let bounds: Float32Array;
            try {
              font.setHinting(ck.FontHinting.None); font.setSubpixel(true);
              bounds = font.getGlyphBounds(run.glyphs);
            } finally { font.delete(); }
            if (!firstRun) layoutWriter.raw(','); firstRun = false;
            layoutWriter.raw('{"fontHash":').value(fontHash).raw(',"size":').value(run.size).raw(',"flags":').value(run.flags)
              .raw(',"glyphs":').array(run.glyphs).raw(',"offsetsUtf8":').array(run.offsets, value => layoutWriter.value(value + start8))
              .raw(',"offsetsUtf16":').array(run.offsets, value => layoutWriter.value(utf16(value)))
              .raw(',"positions":').array(run.positions, (value, i) => layoutWriter.value(value + (i % 2 ? top : 0)))
              .raw(',"inkBounds":').array(run.glyphs, (_, i) => {
                const l = bounds[i*4] + run.positions[i*2], t = bounds[i*4+1] + run.positions[i*2+1] + top;
                const r = bounds[i*4+2] + run.positions[i*2], b = bounds[i*4+3] + run.positions[i*2+1] + top;
                overflow ||= r > l && b > t && (l < 0 || t < 0 || r > request.frame.width || b > request.frame.height);
                layoutWriter.raw('[').value(l).raw(',').value(t).raw(',').value(r).raw(',').value(b).raw(']');
              }).raw(',"top":').value(line.top + top).raw(',"bottom":').value(line.bottom + top)
              .raw(',"baseline":').value(line.baseline + top).raw('}');
          }
        } finally { for (const line of shaped) for (const run of line.runs) run.typeface?.delete(); }
        layoutWriter.raw('],"clusters":[');
        const seen = new Set<string>();
        let firstCluster = true;
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
          try {
            if (!firstCluster) layoutWriter.raw(','); firstCluster = false;
            layoutWriter.raw('{"startUtf16":').value(start16 + start).raw(',"endUtf16":').value(start16 + end)
              .raw(',"startUtf8":').value(start8 + local.utf16ToUtf8[start]).raw(',"endUtf8":').value(start8 + local.utf16ToUtf8[end])
              .raw(',"direction":').value(glyph.dir.value === ck.TextDirection.RTL.value ? 'rtl' : 'ltr')
              .raw(',"rect":').array(glyph.graphemeLayoutBounds, (value, i) => layoutWriter.value(value + (i % 2 ? top : 0)))
              .raw(',"ranges":[');
            for (let i = 0; i < rects.length; i += 5) {
              if (i) layoutWriter.raw(',');
              layoutWriter.raw('{"rect":[').value(rects[i]).raw(',').value(rects[i+1] + top)
                .raw(',').value(rects[i+2]).raw(',').value(rects[i+3] + top)
                .raw('],"direction":').value(rects[i+4] === 1 ? 'ltr' : 'rtl').raw('}');
            }
            layoutWriter.raw(']}');
          } finally { if (rects.length) ck._free(rects.byteOffset); }
        }
        layoutWriter.raw(']}');
        overflow ||= top + paragraphHeight > request.frame.height;
        canvas.drawParagraph(paragraph, 0, top);
        top += paragraphHeight; start16 += text.length + 1;
      } finally { paragraph?.delete(); builder.delete(); }
    }
    layoutWriter.raw('],"height":').value(top).raw(',"overflow":').value(overflow).raw('}');
    surface.flush();
    // Read the CPU surface's explicit unpremultiplied sRGB storage. No second
    // native full-frame allocation or implicit HTML canvas conversion occurs.
    const pixels = new Uint8Array(rasterMemory.toTypedArray());
    if (pixels.byteLength !== width * height * 4) fail('TEXT_READBACK');
    // Transparent RGB is canonical zero, independent of Skia's hidden color.
    for (let i = 0; i < pixels.length; i += 4) if (!pixels[i + 3]) pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    const layout = layoutWriter.finishBlob();
    const rgba = new Blob([pixels], { type: 'application/octet-stream' });
    if (ck.HEAPU8.byteLength > LIMITS.wasmBytes) fail('TEXT_HEAP_LIMIT');
    return { kind: 'prepared-text-1', token: request.token, rendererProfile, dependencyHash,
      dependencies, textUtf8, textHash, layout, layoutHash: await hashBytes(layout), rgba, rasterHash: await hashBytes(rgba),
      width, height, overflow, allocation: { wasmHeapBytes: ck.HEAPU8.byteLength, uniqueFontBytes: total,
        rasterBytes: rgba.size, layoutBytes: layout.size, gpuBytes: 0 } };
  } finally {
    surface?.delete(); if (rasterMemory?.byteOffset) ck.Free(rasterMemory);
    collection.delete();
    ck.purgeOwnedTextCaches();
  }
  } catch(error) { fontReady?.end('error');throw error; }
}
