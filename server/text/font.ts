// Derived from the approved src/text/font.ts algorithm; tests pin function equality.
const LIMITS={faceBytes:16777216};
function fail(code:string, _details?:unknown):never{throw new Error(code);}
export const PARSER_PROFILE = 'sfnt-static-1-freetype-canvaskit040';

// Container/admission validation precedes isolated FreeType interpretation. This
// is deliberately not a claim to sanitize arbitrary OpenType tables. Native
// parsing runs only in the owned, byte/time/heap-bounded worker.
export function inspectFont(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12 || bytes.byteLength > LIMITS.faceBytes) fail('FONT_SIZE');
  const view = new DataView(bytes), data = new Uint8Array(bytes);
  const u16 = (at: number) => view.getUint16(at), u32 = (at: number) => view.getUint32(at);
  const signature = u32(0), count = u16(4), end = 12 + count * 16;
  if (signature !== 0x00010000 && signature !== 0x4f54544f) fail('FONT_STATIC_SFNT_REQUIRED');
  if (!count || count > 128 || end > bytes.byteLength) fail('FONT_TABLE_DIRECTORY');
  const tables = new Map<string, { offset: number; length: number }>();
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, tag = String.fromCharCode(...data.subarray(at, at + 4));
    const checksum = u32(at + 4), offset = u32(at + 8), length = u32(at + 12);
    if (tables.has(tag) || !/^[\x20-\x7e]{4}$/.test(tag) || offset % 4 || offset < end || offset + length > bytes.byteLength || !length) fail('FONT_TABLE_BOUNDS', { tag });
    if (ranges.some(([start, stop]) => offset < stop && start < offset + length)) fail('FONT_TABLE_OVERLAP');
    let sum = 0;
    for (let j = 0; j < length; j += 4) {
      let value = 0;
      for (let k = 0; k < 4; k++) value = value * 256 + (j + k < length && !(tag === 'head' && j + k >= 8 && j + k < 12) ? data[offset + j + k] : 0);
      sum = (sum + value) >>> 0;
    }
    if (sum !== checksum) fail('FONT_TABLE_CHECKSUM', { tag });
    tables.set(tag, { offset, length }); ranges.push([offset, offset + length]);
  }
  for (const tag of ['fvar','gvar','CFF2','SVG ','COLR','CPAL','CBDT','CBLC','sbix']) if (tables.has(tag)) fail('FONT_UNSUPPORTED_TABLE', { tag });
  function required(tag: string, size: number) {
    const entry = tables.get(tag); if (!entry || entry.length < size) fail('FONT_REQUIRED_TABLE', { tag }); return entry!;
  }
  const head = required('head',54), os2 = required('OS/2',78), maxp = required('maxp',6);
  required('name',6); required('cmap',4); required('hhea',36); required('hmtx',4);
  if (u32(head.offset + 12) !== 0x5f0f3cf5 || u16(head.offset + 18) < 16 || u16(head.offset + 18) > 16384 || !u16(maxp.offset + 4)) fail('FONT_METRICS');
  const fsType = u16(os2.offset + 8);
  // Full-font editable embedding only. Preview/print, restricted, bitmap-only
  // and unknown bits are blocked. No-subsetting is honored by retaining bytes.
  if (fsType & ~0x0108 || (fsType & 0x000e) !== 0 && (fsType & 0x000e) !== 8) fail('FONT_EMBEDDING_RESTRICTED', { fsType });
  if (u16(os2.offset) > 5) fail('FONT_OS2_VERSION');
  // This initial profile supplies regular, upright, normal-width faces only.
  // Refuse other static styles rather than asking Skia to synthesize a match.
  if (u16(os2.offset + 4) !== 400 || u16(os2.offset + 6) !== 5 || u16(os2.offset + 62) & 0x0201) fail('FONT_STYLE_UNSUPPORTED');
  if (signature === 0x00010000) {
    const glyf = required('glyf',1), loca = required('loca',2), glyphCount = u16(maxp.offset + 4), format = view.getInt16(head.offset + 50);
    if (format !== 0 && format !== 1) fail('FONT_LOCA');
    const stride = format === 0 ? 2 : 4;
    if (loca.length < (glyphCount + 1) * stride) fail('FONT_LOCA');
    let previous = 0;
    for (let i = 0; i <= glyphCount; i++) {
      const next = stride === 2 ? u16(loca.offset + i * 2) * 2 : u32(loca.offset + i * 4);
      if (next < previous || next > glyf.length || (next !== previous && next - previous < 10)) fail('FONT_LOCA');
      previous = next;
    }
  } else {
    const cff = required('CFF ',4);
    if (data[cff.offset] !== 1 || data[cff.offset + 2] < 4 || data[cff.offset + 2] >= cff.length || data[cff.offset + 3] < 1 || data[cff.offset + 3] > 4) fail('FONT_CFF_HEADER');
  }
  return { format: signature === 0x00010000 ? 'static-ttf' as const : 'static-otf' as const,
    parserProfile: PARSER_PROFILE, fsType, glyphCount: u16(maxp.offset + 4), tableCount: count };
}
