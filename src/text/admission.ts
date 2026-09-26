import { fail, LIMITS } from './contracts';
import type { TextRequest } from './contracts';

// Each entry is a scalar boundary; -1 marks the interior of a UTF-16 surrogate
// pair or UTF-8 sequence. Ranges are half-open; no rounding/clamping is allowed.
export function textIndices(text: string) {
  scanText(text);
  const utf16ToUtf8: number[] = Array(text.length + 1).fill(-1), utf8ToUtf16: number[] = [];
  const scalars: { codepoint: number; utf16: number; utf8: number }[] = [];
  let bytes = 0, lines = 1;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    if (cp >= 0xd800 && cp <= 0xdfff) fail('TEXT_SURROGATE', { utf16: i });
    if (cp === 13) fail('TEXT_REQUIRES_REVIEWED_LF_CONVERSION');
    if (cp === 10) lines++;
    const count = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    utf16ToUtf8[i] = bytes; utf8ToUtf16[bytes] = i;
    scalars.push({ codepoint: cp, utf16: i, utf8: bytes });
    for (let j = 1; j < count; j++) utf8ToUtf16[bytes + j] = -1;
    bytes += count; i += cp > 65535 ? 2 : 1;
  }
  if (bytes > LIMITS.textBytes) fail('TEXT_BYTES');
  if (lines > LIMITS.lines) fail('TEXT_LINES');
  utf16ToUtf8[text.length] = bytes; utf8ToUtf16[bytes] = text.length;
  return { utf16ToUtf8, utf8ToUtf16, scalars, bytes, lines };
}

// No encoded buffers, index arrays, or per-scalar objects before admission.
export function scanText(text: string) {
  if (typeof text !== 'string' || text.length > LIMITS.textBytes) fail('TEXT_BYTES');
  let bytes = 0, lines = 1, scalars = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    if (cp >= 0xd800 && cp <= 0xdfff) fail('TEXT_SURROGATE', { utf16: i });
    if (cp === 13) fail('TEXT_REQUIRES_REVIEWED_LF_CONVERSION');
    if (cp === 10) lines++;
    bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    scalars++; i += cp > 65535 ? 2 : 1;
  }
  if (bytes > LIMITS.textBytes) fail('TEXT_BYTES');
  if (lines > LIMITS.lines) fail('TEXT_LINES');
  return { bytes, lines, scalars };
}

export function admitRequest(request: TextRequest) {
  if (!request || !request.token || !request.style || !request.frame || !Array.isArray(request.fonts)) fail('TEXT_REQUEST');
  const { token, style, frame, fonts } = request;
  for (const key of ['documentId', 'documentRevision', 'layerId', 'layerVersion', 'sessionId'] as const)
    if (typeof token[key] !== 'string' || !token[key].length || token[key].length > 256) fail('TEXT_TOKEN');
  if (!Number.isSafeInteger(token.generation) || token.generation < 0) fail('TEXT_TOKEN');
  const indices = scanText(request.text);
  if (![frame.width, frame.height].every(n => Number.isFinite(n) && n > 0 && n <= LIMITS.side) ||
      Math.ceil(frame.width) * Math.ceil(frame.height) > LIMITS.pixels) fail('TEXT_FRAME');
  if (![style.sizePx, style.lineHeightMultiplier].every(n => Number.isFinite(n) && n > 0) ||
      style.sizePx > LIMITS.side || style.lineHeightMultiplier * style.sizePx > LIMITS.side) fail('TEXT_STYLE_LIMIT');
  if (!['left','center','right','start','end'].includes(style.align) || !['auto','ltr','rtl'].includes(style.direction) ||
      !Array.isArray(style.fill) || style.fill.length !== 4 || !style.fill.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) fail('TEXT_STYLE');
  if (!Array.isArray(style.explicitFallbacks) || style.explicitFallbacks.length >= LIMITS.faces || fonts.length < 1 || fonts.length > LIMITS.faces) fail('FONT_ORDER');
  const order = [style.primaryFont, ...style.explicitFallbacks];
  if (fonts.length < 1 || fonts.length > LIMITS.faces || order.length !== fonts.length || new Set(order).size !== order.length) fail('FONT_ORDER');
  let total = 0;
  const hashes = new Set<string>();
  for (const font of fonts) {
    if (!font || !/^sha256:[a-f0-9]{64}$/.test(font.hash) || hashes.has(font.hash) || !order.includes(font.hash)) fail('FONT_ORDER');
    if (!(font.bytes instanceof Blob) || font.bytes.size > LIMITS.faceBytes) fail('FONT_SIZE');
    if (font.faceIndex !== 0) fail('FONT_FACE_INDEX');
    if (!['bundled','local-file'].includes(font.origin) || font.license?.embedding !== 'permitted' || !/^sha256:[a-f0-9]{64}$/.test(font.license.hash)) fail('FONT_EMBEDDING_UNKNOWN');
    total += font.bytes.size; hashes.add(font.hash);
  }
  if (total > LIMITS.fontBytes) fail('FONT_SET_SIZE');
  return { indices, order, total };
}
