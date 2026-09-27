import { blob, id, keys, seq, requireValue as ok } from './validate.js';
export const textCommands = ['ImportFont', 'CreateTextLayer', 'CommitTextEdit', 'ReplaceTextFont', 'RasterizeTextDerivative'];
export const isTextCommand = (type) => textCommands.includes(type);
export const hash = (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function textBody(b) {
    const fields = { ImportFont: ['source', 'license', 'origin', 'embeddingReviewed'], CreateTextLayer: ['layerId', 'name', 'candidate', 'draft', 'admissionId'], CommitTextEdit: ['layerId', 'layerVersion', 'candidate', 'draft', 'admissionId', 'reviewedDependencyHash'], ReplaceTextFont: ['layerId', 'layerVersion', 'candidate', 'draft', 'admissionId', 'reviewedDependencyHash'], RasterizeTextDerivative: ['layerId', 'layerVersion', 'newLayerId', 'name', 'hideOriginal', 'reviewedRender', 'draft'] };
    keys(b, ['type', ...fields[b.type]]);
    if (b.type === 'ImportFont') {
        blob(b.source);
        blob(b.license);
        ok(['bundled', 'local-file'].includes(b.origin) && b.embeddingReviewed === true);
        return;
    }
    ok(id(b.layerId));
    if ('layerVersion' in b)
        ok(seq(b.layerVersion));
    if ('name' in b)
        ok(typeof b.name === 'string' && b.name.length > 0 && new TextEncoder().encode(b.name).length <= 1024);
    if ('candidate' in b) {
        blob(b.candidate);
        ok(b.candidate.mediaType === 'application/json' && BigInt(b.candidate.byteLength) <= 65536n && id(b.admissionId));
    }
    if ('reviewedDependencyHash' in b)
        ok(hash(b.reviewedDependencyHash));
    if (b.type === 'RasterizeTextDerivative')
        ok(id(b.newLayerId) && hash(b.reviewedRender) && typeof b.hideOriginal === 'boolean');
    if (b.draft !== null) {
        keys(b.draft, ['sessionId', 'draftId', 'generation']);
        ok(id(b.draft.sessionId) && id(b.draft.draftId) && seq(b.draft.generation));
    }
    else
        ok(b.type === 'RasterizeTextDerivative');
}
export function fontVersion(f) { keys(f, ['schemaVersion', 'id', 'bytes', 'faceIndex', 'format', 'parserProfile', 'fsType', 'licenseRecord', 'origin', 'embedding']); blob(f.bytes); blob(f.licenseRecord); ok(f.schemaVersion === 1 && hash(f.id) && f.faceIndex === 0 && ['static-ttf', 'static-otf'].includes(f.format) && f.parserProfile === 'sfnt-static-1-freetype-canvaskit040' && Number.isInteger(f.fsType) && f.fsType >= 0 && f.fsType <= 65535 && !(f.fsType & ~0x0108) && ((f.fsType & 14) === 0 || (f.fsType & 14) === 8) && ['bundled', 'local-file'].includes(f.origin) && f.embedding === 'permitted' && BigInt(f.bytes.byteLength) >= 12n && BigInt(f.bytes.byteLength) <= 16777216n && BigInt(f.licenseRecord.byteLength) > 0n && BigInt(f.licenseRecord.byteLength) <= 65536n); }
export function textSource(s) {
    keys(s, ['schemaVersion', 'text', 'render']);
    ok(s.schemaVersion === 1);
    const t = s.text, r = s.render;
    keys(t, ['schemaVersion', 'id', 'textUtf8', 'style', 'frame', 'layoutPolicy', 'fonts']);
    blob(t.textUtf8);
    ok(t.schemaVersion === 1 && hash(t.id) && t.layoutPolicy === 'text-layout-1' && BigInt(t.textUtf8.byteLength) <= 16384n && Array.isArray(t.fonts) && t.fonts.length > 0 && t.fonts.length <= 16);
    t.fonts.forEach(fontVersion);
    const st = t.style;
    keys(st, ['primaryFont', 'explicitFallbacks', 'sizePx', 'lineHeightMultiplier', 'fill', 'align', 'direction']);
    ok(hash(st.primaryFont) && Array.isArray(st.explicitFallbacks) && st.explicitFallbacks.every(hash) && st.explicitFallbacks.length < 16 && [st.sizePx, st.lineHeightMultiplier].every(x => Number.isFinite(x) && x > 0) && st.sizePx <= 8192 && st.sizePx * st.lineHeightMultiplier <= 8192 && ['left', 'center', 'right', 'start', 'end'].includes(st.align) && ['auto', 'ltr', 'rtl'].includes(st.direction) && Array.isArray(st.fill) && st.fill.length === 4 && st.fill.every((n) => Number.isInteger(n) && n >= 0 && n <= 255));
    keys(t.frame, ['width', 'height']);
    ok([t.frame.width, t.frame.height].every(n => Number.isFinite(n) && n > 0 && n <= 8192) && Math.ceil(t.frame.width) * Math.ceil(t.frame.height) <= 25000000);
    const order = [st.primaryFont, ...st.explicitFallbacks];
    ok(new Set(order).size === order.length && order.length === t.fonts.length && t.fonts.every((f, i) => f.bytes.hash === order[i]) && t.fonts.reduce((n, f) => n + Number(f.bytes.byteLength), 0) <= 67108864);
    keys(r, ['schemaVersion', 'id', 'textVersion', 'rendererProfile', 'dependencyHash', 'layout', 'pixels', 'width', 'height', 'overflow', 'resolvedFonts']);
    keys(r.rendererProfile, ['schemaVersion', 'id', 'manifest']);
    blob(r.rendererProfile.manifest);
    blob(r.layout);
    blob(r.pixels);
    ok(r.schemaVersion === 1 && hash(r.id) && r.textVersion === t.id && r.rendererProfile.schemaVersion === 1 && hash(r.rendererProfile.id) && hash(r.dependencyHash) && r.width === Math.ceil(t.frame.width) && r.height === Math.ceil(t.frame.height) && r.pixels.byteLength === String(r.width * r.height * 4) && r.pixels.mediaType === 'application/x-ideogram-rgba8' && BigInt(r.layout.byteLength) <= 8388608n && BigInt(r.rendererProfile.manifest.byteLength) <= 65536n && typeof r.overflow === 'boolean' && Array.isArray(r.resolvedFonts) && r.resolvedFonts.length === t.fonts.length && r.resolvedFonts.every((x, i) => x === t.fonts[i].id));
}
export const textRefs = (s) => [s.text.textUtf8, s.render.layout, s.render.pixels, s.render.rendererProfile.manifest, ...s.text.fonts.flatMap(f => [f.bytes, f.licenseRecord])];
export function textDraft(v) {
    keys(v, ['schemaVersion', 'kind', 'textUtf8', 'style', 'frame', 'fonts']);
    blob(v.textUtf8);
    ok(v.schemaVersion === 1 && v.kind === 'text-draft-1' && Array.isArray(v.fonts) && v.fonts.length <= 16 && v.style && typeof v.style === 'object' && v.frame && typeof v.frame === 'object');
    v.fonts.forEach(fontVersion);
}
export const draftRefs = (v) => [v.textUtf8, ...v.fonts.flatMap(f => [f.bytes, f.licenseRecord])];
