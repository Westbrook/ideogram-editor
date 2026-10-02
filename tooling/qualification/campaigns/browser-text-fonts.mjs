import {createHash, randomUUID} from 'node:crypto';

const MiB = 1048576;
const SHA = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEQ = /^(0|[1-9][0-9]{0,19})$/;
const id = v => typeof v === 'string' && ID.test(v);
const seq = v => typeof v === 'string' && SEQ.test(v);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v, names) => object(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const int = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    let out = '"';
    for (const ch of value) {
      const cp = ch.codePointAt(0);
      if (cp >= 0xd800 && cp <= 0xdfff) throw Error('Invalid Unicode');
      out += cp < 32 ? '\\u' + cp.toString(16).padStart(4, '0') : ch === '"' || ch === '\\' ? '\\' + ch : ch;
    }
    return out + '"';
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!object(value)) throw Error('Invalid JSON value');
  return '{' + Object.keys(value).sort().map(k => canonical(k) + ':' + canonical(value[k])).join(',') + '}';
};

// Bound the data tree before serialization. The observer never retains font
// payloads or authored layer names/text in this envelope.
function boundedJSON(value, maximum) {
  let nodes = 0, units = 0;
  const visit = (v, depth) => {
    if (++nodes > 40000 || depth > 16) throw Error('Observation tree bound');
    if (typeof v === 'string') {if (v.length > 4096 || (units += v.length) > maximum) throw Error('Observation string bound');}
    else if (Array.isArray(v)) {if (v.length > 1600) throw Error('Observation array bound'); for (const x of v) visit(x, depth + 1);}
    else if (object(v)) {if (Object.keys(v).length > 32) throw Error('Observation object bound'); for (const [k, x] of Object.entries(v)) {visit(k, depth + 1); visit(x, depth + 1);}}
    else if (v !== null && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) throw Error('Observation scalar bound');
  };
  visit(value, 0);
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > maximum) throw Error('Observation encoded bound');
  return serialized;
}
const blob = (v, max, min = 1) => exact(v, 'hash,byteLength,mediaType') && SHA.test(v.hash) && typeof v.byteLength === 'string' && SEQ.test(v.byteLength) && Number(v.byteLength) >= min && Number(v.byteLength) <= max && typeof v.mediaType === 'string' && v.mediaType.length >= 1 && v.mediaType.length <= 128;
function fontValid(f) {
  if (!exact(f, 'schemaVersion,id,bytes,faceIndex,format,parserProfile,fsType,licenseRecord,origin,embedding') || f.schemaVersion !== 1 || !SHA.test(f.id) || !blob(f.bytes, 16 * MiB, 12) || !blob(f.licenseRecord, 65536) || f.faceIndex !== 0 || !['static-ttf', 'static-otf'].includes(f.format) || f.parserProfile !== 'sfnt-static-1-freetype-canvaskit040' || !int(f.fsType, 65535) || (f.fsType & ~0x0108) !== 0 || !['bundled', 'local-file'].includes(f.origin) || f.embedding !== 'permitted') return false;
  const {id, ...identity} = f;
  return hash(canonical(identity)) === id;
}
function rootValid(root) {
  return exact(root, 'documentId,revision,imageState,semanticDigest,orderedLayerIds,observedImageHash,observedImageBytes') && id(root.documentId) && seq(root.revision) && blob(root.imageState, MiB) && root.imageState.mediaType === 'application/json' && SHA.test(root.semanticDigest) && Array.isArray(root.orderedLayerIds) && root.orderedLayerIds.length <= 100 && root.orderedLayerIds.every(id) && new Set(root.orderedLayerIds).size === root.orderedLayerIds.length && root.observedImageHash === root.imageState.hash && root.observedImageBytes === Number(root.imageState.byteLength);
}
const closedEditor = v => exact(v, 'present,hidden,session') && v.present === true && v.hidden === true && v.session === '';
function unchangedPreview(raw, proof, fonts) {
  const state = raw.nativeEditorBefore;
  const fields = 'present,hidden,session,sessionId,documentId,documentRevision,layerId,layerVersion,generation,savedGeneration,preview,nativeTextHash';
  if (!object(proof) || boundedJSON(proof, 65536).length === 0 || !exact(state, fields) || !exact(raw.nativeEditorAfter, fields) || state.present !== true || state.hidden !== false || !id(state.session) || !id(state.sessionId) || !id(state.layerId) || !seq(state.layerVersion) || !int(state.generation, Number.MAX_SAFE_INTEGER)) return false;
  const {savedGeneration: beforeSaved, ...before} = state, {savedGeneration: afterSaved, ...after} = raw.nativeEditorAfter;
  const saved = v => v === null || int(v, state.generation);
  // Preview proves the current local version, not autosave completion. Permit
  // natural saving to advance while every native/preview identity stays exact.
  if (!saved(beforeSaved) || !saved(afterSaved) || beforeSaved !== null && (afterSaved === null || afterSaved < beforeSaved) || canonical(before) !== canonical(after)) return false;
  const token = proof.token, preview = state.preview, layer = raw.layers.find(l => l.id === state.layerId);
  if (!exact(token, 'documentId,documentRevision,layerId,layerVersion,sessionId,draftId') || token.documentId !== raw.before.documentId || token.documentRevision !== raw.before.revision || state.documentId !== token.documentId || state.documentRevision !== token.documentRevision || token.layerId !== state.layerId || token.layerVersion !== state.layerVersion || token.sessionId !== state.sessionId || token.draftId !== state.session || proof.generation !== state.generation || !exact(preview, 'id,generation,layerVersion,textHash,dependencyHash,rasterHash,width,height') || !id(preview.id) || preview.id !== proof.previewId || proof.actionId !== preview.id || preview.generation !== state.generation || preview.layerVersion !== state.layerVersion || !layer || layer.kind !== 'text' || layer.version !== state.layerVersion) return false;
  if (preview.textHash !== state.nativeTextHash || preview.textHash !== proof.sourceHash || preview.textHash !== layer.textHash || preview.dependencyHash !== proof.dependencyHash || preview.dependencyHash !== layer.renderDependencyHash || preview.rasterHash !== proof.rasterHash || preview.rasterHash !== layer.rasterHash || preview.width !== layer.width || preview.height !== layer.height) return false;
  return proof.fontFaces === layer.fontIds.length && proof.fontBytes === layer.fontIds.reduce((n, f) => n + Number(fonts.get(f).bytes.byteLength), 0);
}

/** Pure inspection of bounded, untrusted raw data. This is not a runtime proof
 * issuer. The outer live collector/replayer must admit its own attempt token.
 * Only current associated font state is measured; no CPU/GPU/peak/R07 claim. */
export function inspectCurrentDocumentFonts(raw, expectedBinding, {draftProof} = {}) {
  const fail = message => ({measurements: [], missing: ['Current document fonts: ' + message]});
  try {
    if (!object(expectedBinding) || Object.keys(expectedBinding).length === 0 || boundedJSON(raw, MiB).length === 0 || boundedJSON(expectedBinding, 16384) !== boundedJSON(raw?.binding, 16384)) return fail('attempt binding differs');
    if (!exact(raw, 'kind,binding,clock,timeOrigin,startMs,endMs,before,after,layers,fonts,files,nativeEditorBefore,nativeEditorAfter,missing') || raw.kind !== 'current-document-fonts-1' || raw.clock !== 'browser-performance' || !Number.isFinite(raw.timeOrigin) || raw.timeOrigin <= 0 || !Number.isFinite(raw.startMs) || raw.startMs < 0 || !Number.isFinite(raw.endMs) || raw.endMs < raw.startMs || raw.endMs - raw.startMs > 60000 || !Array.isArray(raw.missing) || raw.missing.length !== 0) return fail('complete bounded observation and browser clocks required');
    if (!rootValid(raw.before) || !rootValid(raw.after) || canonical(raw.before) !== canonical(raw.after)) return fail('current document revision or image identity changed');
    if (!Array.isArray(raw.layers) || raw.layers.length !== raw.before.orderedLayerIds.length || raw.layers.length > 100 || !Array.isArray(raw.fonts) || raw.fonts.length > 1600 || !Array.isArray(raw.files) || raw.files.length > 16) return fail('full current layer/font/file inventory is unavailable');
    const fonts = new Map(), faces = new Map(), files = new Map(), used = new Set();
    for (const f of raw.fonts) {
      if (!fontValid(f) || fonts.has(f.id)) return fail('exact unique typed font versions required');
      fonts.set(f.id, f);
      const key = f.bytes.hash + ':' + f.faceIndex;
      const prior = faces.get(key);
      if (prior && (canonical(prior.bytes) !== canonical(f.bytes) || prior.format !== f.format || prior.parserProfile !== f.parserProfile || prior.fsType !== f.fsType)) return fail('one face has contradictory byte or parser identities');
      faces.set(key, f);
    }
    if (faces.size > 16) return fail('current face union exceeds the finite 16-face collector boundary');
    for (const [index, layer] of raw.layers.entries()) {
      if (!object(layer) || layer.id !== raw.before.orderedLayerIds[index] || !id(layer.id) || !seq(layer.version) || !['text', 'image'].includes(layer.kind)) return fail('layer inventory differs from the complete document order');
      if (layer.kind === 'image') {if (!exact(layer, 'id,version,kind')) return fail('image layer summary is malformed'); continue;}
      if (!exact(layer, 'id,version,kind,source,observedSourceHash,observedSourceBytes,textVersion,renderVersion,renderer,fontIds,textHash,renderDependencyHash,rasterHash,width,height') || !blob(layer.source, 65536) || layer.source.mediaType !== 'application/json' || layer.observedSourceHash !== layer.source.hash || layer.observedSourceBytes !== Number(layer.source.byteLength) || !SHA.test(layer.textVersion) || !SHA.test(layer.renderVersion) || !SHA.test(layer.textHash) || !SHA.test(layer.renderDependencyHash) || !SHA.test(layer.rasterHash) || !int(layer.width, 8192) || layer.width < 1 || !int(layer.height, 8192) || layer.height < 1 || layer.width * layer.height > 25000000 || !exact(layer.renderer, 'schemaVersion,id,manifest') || layer.renderer.schemaVersion !== 1 || !SHA.test(layer.renderer.id) || !blob(layer.renderer.manifest, 65536) || layer.renderer.manifest.mediaType !== 'application/json' || !Array.isArray(layer.fontIds) || layer.fontIds.length < 1 || layer.fontIds.length > 16 || new Set(layer.fontIds).size !== layer.fontIds.length) return fail('retained text source and renderer identity are incomplete');
      for (const id of layer.fontIds) {if (typeof id !== 'string' || !fonts.has(id)) return fail('a current source font is absent'); used.add(id);}
    }
    if (used.size !== fonts.size) return fail('font inventory contains an unassociated or missing version');
    const closed = closedEditor(raw.nativeEditorBefore) && closedEditor(raw.nativeEditorAfter);
    if (!closed && !unchangedPreview(raw, draftProof, fonts)) return fail('open native draft lacks stable actual preview lineage matching the accepted source and independently admitted phase evidence');
    const assetIds = new Set();
    for (const f of raw.files) {
      if (!exact(f, 'assetId,assetVersion,hash,bytes,observedHash,observedBytes,fontIds') || !id(f.assetId) || assetIds.has(f.assetId) || !seq(f.assetVersion) || !SHA.test(f.hash) || !int(f.bytes, 16 * MiB) || f.bytes < 12 || f.observedHash !== f.hash || f.observedBytes !== f.bytes || files.has(f.hash) || !Array.isArray(f.fontIds) || f.fontIds.length < 1 || f.fontIds.length > 1600 || new Set(f.fontIds).size !== f.fontIds.length) return fail('actual owned file hash/length evidence is incomplete or duplicated');
      const associated = [...fonts.values()].filter(font => font.bytes.hash === f.hash);
      if (!associated.length || associated.some(font => Number(font.bytes.byteLength) !== f.bytes) || canonical(associated.map(font => font.id).sort()) !== canonical([...f.fontIds].sort())) return fail('file does not cover its exact current font versions');
      files.set(f.hash, f); assetIds.add(f.assetId);
    }
    if ([...fonts.values()].some(f => !files.has(f.bytes.hash))) return fail('current font bytes were not all fetched and hashed');
    const total = [...files.values()].reduce((n, f) => n + f.bytes, 0), maximum = Math.max(0, ...[...files.values()].map(f => f.bytes));
    if (total > 64 * MiB) return fail('current font files exceed the finite 64 MiB collector boundary');
    const method = 'Complete stable current-document associated font union (including hidden layers); typed face/parser/profile/license references; sequential public owned-file SHA256 and length verification, unique files counted once. ' + (closed ? 'Native editor closed.' : 'Actual native text and preview tokens remain identical to independently admitted phase evidence and the current accepted render dependency; active draft adds no different font cohort.') + ' No allocation or physical-presentation claim.';
    return {measurements: [{name: 'R35CurrentFontFaces', value: faces.size, unit: 'count', method}, {name: 'R35SingleFontBytes', value: maximum, unit: 'bytes', method}, {name: 'R35CurrentFontSetBytes', value: total, unit: 'bytes', method}], missing: []};
  } catch {return fail('malformed or oversized raw observation');}
}

/** Read-only public protocol collector. Locator hints never establish font
 * membership: every accepted source contributes its actual typed identities.
 * No filesystem font reads, private editor access, input or draft mutations. */
export async function collectCurrentDocumentFonts({page, documentId, fontAssetIds, binding, signal, timeoutMs = 30000}) {
  if (!id(documentId) || !Array.isArray(fontAssetIds) || fontAssetIds.length > 16 || fontAssetIds.some(x => !id(x)) || new Set(fontAssetIds).size !== fontAssetIds.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !object(binding) || Object.keys(binding).length === 0) throw Error('Current font collector arguments are invalid');
  boundedJSON(binding, 16384); signal?.throwIfAborted();
  const nonce = randomUUID();
  const cancel = () => {void page.evaluate(n => {globalThis.__IDEOGRAM_CURRENT_FONT_READS__?.get(n)?.abort();}, nonce).catch(() => {});};
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    // Install the real owner before starting reads. If cancellation raced the
    // first evaluate call, the post-install signal check enters final cleanup.
    await page.evaluate(n => {
      const owners = globalThis.__IDEOGRAM_CURRENT_FONT_READS__ ??= new Map();
      if (owners.size !== 0) throw Error('Current font observation already owned');
      owners.set(n, new AbortController());
    }, nonce);
    signal?.throwIfAborted();
    const raw = await page.evaluate(async ({documentId, fontAssetIds, binding, nonce, timeoutMs}) => {
      const owners = globalThis.__IDEOGRAM_CURRENT_FONT_READS__, aborter = owners?.get(nonce);
      if (!aborter || owners.size !== 1) throw Error('Current font observation owner unavailable');
      const timer = setTimeout(() => aborter.abort(), timeoutMs), startMs = performance.now();
      const raw = {kind: 'current-document-fonts-1', binding, clock: 'browser-performance', timeOrigin: performance.timeOrigin, startMs, endMs: null, before: null, after: null, layers: [], fonts: [], files: [], nativeEditorBefore: null, nativeEditorAfter: null, missing: []};
      const check = (yes, code) => {if (!yes) throw Error(code);};
      const canonical = v => {
        if (v === null || typeof v === 'boolean') return String(v);
        if (typeof v === 'number') {check(Number.isFinite(v), 'FONT_JSON_NUMBER'); return JSON.stringify(v);}
        if (typeof v === 'string') {let s = '"'; for (const ch of v) {const p = ch.codePointAt(0); check(p < 0xd800 || p > 0xdfff, 'FONT_JSON_UNICODE'); s += p < 32 ? '\\u' + p.toString(16).padStart(4, '0') : ch === '"' || ch === '\\' ? '\\' + ch : ch;} return s + '"';}
        if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
        check(v && typeof v === 'object', 'FONT_JSON_OBJECT');
        return '{' + Object.keys(v).sort().map(k => canonical(k) + ':' + canonical(v[k])).join(',') + '}';
      };
      const encode = v => new TextEncoder().encode(canonical(v));
      const hash = async b => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(v => v.toString(16).padStart(2, '0')).join('');
      const editor = async () => {
        const node = document.querySelector('#native-text-editor'), state = {present: !!node, hidden: node?.hidden ?? null, session: node?.getAttribute('data-session') ?? null};
        if (!node || node.hidden) return state;
        const attr = name => {const v = node.getAttribute(name); check(v === null || typeof v === 'string' && v.length <= 128, 'FONT_NATIVE_ATTRIBUTE_BOUND'); return v;}, number = name => {const v = attr(name); return /^(0|[1-9][0-9]*)$/.test(v ?? '') && Number.isSafeInteger(Number(v)) ? Number(v) : null;};
        const value = document.querySelector('#native-text-content')?.value;
        check(typeof value === 'string' && value.length <= 16384, 'FONT_NATIVE_TEXT_BOUND');
        for (const ch of value) {const cp = ch.codePointAt(0); check(cp < 0xd800 || cp > 0xdfff, 'FONT_NATIVE_TEXT_UNICODE');}
        const text = new TextEncoder().encode(value); check(text.byteLength <= 16384, 'FONT_NATIVE_TEXT_BOUND');
        return {...state, sessionId: attr('data-text-session-id'), documentId: attr('data-text-document-id'), documentRevision: attr('data-text-document-revision'), layerId: attr('data-text-layer-id'), layerVersion: attr('data-text-layer-version'), generation: number('data-text-generation'), savedGeneration: number('data-text-saved-generation'), preview: {id: attr('data-preview-id'), generation: number('data-preview-generation'), layerVersion: attr('data-preview-layer-version'), textHash: attr('data-preview-text-hash'), dependencyHash: attr('data-preview-dependency-hash'), rasterHash: attr('data-preview-raster-hash'), width: number('data-preview-width'), height: number('data-preview-height')}, nativeTextHash: await hash(text)};
      };
      const read = async (path, maximum, expected) => {
        aborter.signal.throwIfAborted();
        const response = await fetch(path, {credentials: 'same-origin', headers: {'X-App-Client': 'LP-1'}, cache: 'no-store', redirect: 'error', signal: aborter.signal});
        let reader;
        try {
          check(response.status === 200 && response.body && !response.body.locked, 'FONT_PUBLIC_READ_FAILED');
          const declared = response.headers.get('content-length');
          check(declared === null || /^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= maximum && (expected === undefined || Number(declared) === expected), 'FONT_RESPONSE_LENGTH');
          reader = response.body.getReader();
          const bytes = new Uint8Array(expected ?? maximum); let offset = 0;
          while (true) {aborter.signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; check(chunk.value instanceof Uint8Array && offset + chunk.value.byteLength <= bytes.byteLength, 'FONT_RESPONSE_BOUND'); bytes.set(chunk.value, offset); offset += chunk.value.byteLength;}
          check(expected === undefined || offset === expected, 'FONT_FILE_LENGTH');
          return bytes.subarray(0, offset);
        } finally {
          if (reader) {try {await reader.cancel();} finally {reader.releaseLock();}}
          else if (response.body && !response.body.locked) await response.body.cancel();
        }
      };
      const json = async (path, max) => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await read(path, max)));
      const root = async () => {
        const projection = await json('/api/v1/documents/' + documentId, 131072);
        check(projection.protocolVersion === 1 && projection.projection?.kind === 'inline', 'FONT_DOCUMENT_PROJECTION');
        const doc = projection.projection.value;
        check(doc?.id === documentId && projection.entityVersion === doc.revision && /^(0|[1-9][0-9]{0,19})$/.test(doc.revision) && doc.image && Array.isArray(doc.orderedLayerIds) && doc.orderedLayerIds.length <= 100, 'FONT_DOCUMENT_ROOT');
        const image = await json('/api/v1/documents/' + documentId + '/image', 1048576);
        check(Array.isArray(image.layers) && image.layers.length <= 100 && image.layers.length === doc.orderedLayerIds.length && image.layers.every((l, i) => l.id === doc.orderedLayerIds[i]), 'FONT_COMPLETE_LAYER_ORDER');
        const bytes = encode(image), observedImageHash = await hash(bytes);
        check(observedImageHash === doc.image.state.hash && String(bytes.byteLength) === doc.image.state.byteLength, 'FONT_IMAGE_IDENTITY');
        return {root: {documentId, revision: doc.revision, imageState: doc.image.state, semanticDigest: doc.image.semanticDigest, orderedLayerIds: doc.orderedLayerIds, observedImageHash, observedImageBytes: bytes.byteLength}, layers: image.layers};
      };
      try {
        raw.nativeEditorBefore = await editor();
        const before = await root(); raw.before = before.root;
        const fonts = new Map();
        for (const layer of before.layers) {
          check(/^[A-Za-z0-9_-]{1,128}$/.test(layer.id) && ['text', 'image'].includes(layer.kind), 'FONT_LAYER_IDENTITY');
          const item = {id: layer.id, version: layer.version, kind: layer.kind};
          if (layer.kind === 'text') {
            const view = await json('/api/v1/documents/' + documentId + '/text?layerId=' + layer.id + '&revision=' + raw.before.revision, 65536);
            check(view.documentRevision === raw.before.revision && view.layerVersion === layer.version, 'FONT_SOURCE_REVISION');
            const source = view.source, bytes = encode(source), observedSourceHash = await hash(bytes);
            check(layer.source && observedSourceHash === layer.source.hash && String(bytes.byteLength) === layer.source.byteLength && Array.isArray(source.text?.fonts) && source.text.fonts.length >= 1 && source.text.fonts.length <= 16, 'FONT_SOURCE_IDENTITY');
            for (const font of source.text.fonts) {const previous = fonts.get(font.id); check(!previous || canonical(previous) === canonical(font), 'FONT_VERSION_CONFLICT'); fonts.set(font.id, font);}
            check(fonts.size <= 1600, 'FONT_VERSION_BOUND');
            Object.assign(item, {source: layer.source, observedSourceHash, observedSourceBytes: bytes.byteLength, textVersion: source.text.id, renderVersion: source.render.id, renderer: source.render.rendererProfile, fontIds: source.text.fonts.map(f => f.id), textHash: source.text.textUtf8.hash, renderDependencyHash: source.render.dependencyHash, rasterHash: source.render.pixels.hash, width: source.render.width, height: source.render.height});
          }
          raw.layers.push(item);
        }
        raw.fonts = [...fonts.values()];
        const wanted = new Map();
        for (const font of raw.fonts) {
          const n = Number(font.bytes?.byteLength); check(Number.isSafeInteger(n) && n >= 12 && n <= 16777216 && /^sha256:[a-f0-9]{64}$/.test(font.bytes?.hash), 'FONT_FILE_BOUND');
          const group = wanted.get(font.bytes.hash) ?? {bytes: n, fontIds: []}; check(group.bytes === n, 'FONT_FILE_CONFLICT'); group.fontIds.push(font.id); wanted.set(font.bytes.hash, group);
        }
        check(wanted.size <= 16 && [...wanted.values()].reduce((n, f) => n + f.bytes, 0) <= 67108864, 'FONT_CURRENT_SET_BOUND');
        const assets = new Map();
        // At most sixteen typed locator records, then one byte stream at a time.
        for (const assetId of fontAssetIds) {
          const response = await json('/api/v1/assets/' + assetId, 65536), asset = response.projection?.value;
          check(response.protocolVersion === 1 && response.projection?.kind === 'inline' && asset?.id === assetId && response.entityVersion === asset.version && asset.qualification === 'font' && asset.purpose === 'font' && asset.font, 'FONT_ASSET_PROJECTION');
          if (fonts.has(asset.font.id)) {check(canonical(fonts.get(asset.font.id)) === canonical(asset.font) && canonical(asset.blob) === canonical(asset.font.bytes), 'FONT_ASSET_IDENTITY'); assets.set(asset.font.id, asset);}
        }
        check(raw.fonts.every(f => assets.has(f.id)), 'FONT_CURRENT_ASSET_LOCATOR_MISSING');
        for (const [sha256, group] of wanted) {
          const asset = assets.get(group.fontIds[0]), bytes = await read('/api/v1/assets/' + asset.id + '/content', 16777216, group.bytes), observedHash = await hash(bytes);
          check(observedHash === sha256, 'FONT_OWNED_BYTES_CHANGED');
          raw.files.push({assetId: asset.id, assetVersion: asset.version, hash: sha256, bytes: group.bytes, observedHash, observedBytes: bytes.byteLength, fontIds: group.fontIds});
        }
        const after = await root(); raw.after = after.root;
        check(canonical(raw.before) === canonical(raw.after), 'FONT_CURRENT_ROOT_CHANGED');
        raw.nativeEditorAfter = await editor();
      } catch (error) {raw.missing.push(aborter.signal.aborted ? 'FONT_OBSERVATION_ABORTED' : /^[A-Z0-9_]{1,100}$/.test(error?.message ?? '') ? error.message : 'FONT_OBSERVATION_UNAVAILABLE');}
      finally {raw.endMs = performance.now(); clearTimeout(timer); aborter.abort(); owners.delete(nonce); if (owners.size === 0) delete globalThis.__IDEOGRAM_CURRENT_FONT_READS__;}
      return raw;
    }, {documentId, fontAssetIds, binding, nonce, timeoutMs});
    signal?.throwIfAborted(); boundedJSON(raw, MiB); return raw;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await page.evaluate(n => {
      const owners = globalThis.__IDEOGRAM_CURRENT_FONT_READS__, owner = owners?.get(n);
      if (owner) {owner.abort(); owners.delete(n); if (owners.size === 0) delete globalThis.__IDEOGRAM_CURRENT_FONT_READS__;}
    }, nonce).catch(() => {}); // Navigation destroys the entire old realm.
  }
}
