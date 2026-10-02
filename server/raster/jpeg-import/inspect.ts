// Staged only. This parser makes no native decoder calls and allocates at most
// one 64 KiB input page plus bounded marker descriptors. It is not pixel proof.
export type JPEGComponent = Readonly<{ id: number; horizontal: number; vertical: number; quantization: number }>;
export type JPEGMetadataSegment = Readonly<{offset: number; length: number}>;
export type OversizedJPEG = Readonly<{
  kind: 'jpeg-scanline-file-v1'; width: number; height: number; encodedBytes: number;
  progressive: boolean; scans: number; metadataBytes: number;
  components: readonly JPEGComponent[];
  icc: readonly JPEGMetadataSegment[] | null; exif: JPEGMetadataSegment | null;
}>;
export type JPEGReservation = Readonly<{
  kind: 'jpeg-scanline-file-v1'; coefficientBytes: number; nativeBytes: number;
  hostBytes: number; scratchBytes: number; cpuBytes: number;
}>;
type Reader = (offset: number, length: number) => Buffer;
const reject = (code = 'RASTER_FORMAT'): never => { throw Error(code); };
const MAX_MARKERS = 65536;
const MAX_METADATA = 4 * 1024 * 1024;

export function inspectOversizedJPEG(read: Reader, encodedBytes: number, check: () => void): OversizedJPEG {
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes < 4) reject('RASTER_TRUNCATED');
  let page: Buffer = Buffer.alloc(0);
  let start = -1;
  const byte = (offset: number) => {
    if (offset < 0 || offset >= encodedBytes) reject('RASTER_TRUNCATED');
    if (offset < start || offset >= start + page.length) {
      check(); start = offset; page = read(offset, Math.min(65536, encodedBytes - offset));
      if (page.length !== Math.min(65536, encodedBytes - offset)) reject('RASTER_TRUNCATED');
    }
    return page[offset - start];
  };
  const uint16 = (offset: number) => byte(offset) * 256 + byte(offset + 1);
  if (byte(0) !== 255 || byte(1) !== 216) reject();
  let at = 2, width = 0, height = 0, progressive = false, scans = 0, markers = 0, metadataBytes = 0, ended = false;
  const components: JPEGComponent[] = [];
  let exif: JPEGMetadataSegment | null = null, iccCount = 0;
  const icc = new Map<number, JPEGMetadataSegment>();
  const starts = (at: number, count: number, text: string) => count >= text.length && [...text].every((c, i) => byte(at + i) === c.charCodeAt(0));
  while (at < encodedBytes) {
    check(); if (++markers > MAX_MARKERS) reject('RASTER_RESOURCES');
    if (byte(at++) !== 255) reject();
    let marker = byte(at++); while (marker === 255) marker = byte(at++);
    if (marker === 217) { if (at !== encodedBytes) reject(); ended = true; break; }
    if (marker === 0 || marker === 216 || marker === 1 || marker >= 208 && marker <= 215) reject();
    const length = uint16(at);
    if (length < 2 || at + length > encodedBytes) reject('RASTER_TRUNCATED');
    if (marker >= 224 || marker === 254) {
      metadataBytes += length;
      if (metadataBytes > MAX_METADATA) reject('RASTER_RESOURCES');
    }
    if (marker === 226 && starts(at + 2, length - 2, 'ICC_PROFILE\0')) {
      if (length < 16) reject('RASTER_METADATA');
      const sequence = byte(at + 14), count = byte(at + 15);
      if (!sequence || !count || sequence > count || icc.has(sequence) || iccCount && iccCount !== count) reject('RASTER_METADATA');
      iccCount = count; icc.set(sequence, Object.freeze({offset: at + 16, length: length - 16}));
    }
    if (marker === 225 && starts(at + 2, length - 2, 'Exif\0\0')) {
      // Match the established libvips rule: first Exif-prefixed APP1 wins.
      if (!exif) exif = Object.freeze({offset: at + 2, length: length - 2});
    }
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (![192, 193, 194].includes(marker) || width || scans) reject('RASTER_DEPTH');
      if (length < 8 || byte(at + 2) !== 8) reject('RASTER_DEPTH');
      height = uint16(at + 3); width = uint16(at + 5);
      // JPEG's encoded axes are uint16. Native JPEG_MAX_DIMENSION can be lower;
      // the sealed bridge independently checks its actual supported envelope.
      if (width < 1 || height < 1) reject('RASTER_EXTENT');
      const count = byte(at + 7);
      if (![1, 3].includes(count) || length !== 8 + count * 3) reject('RASTER_CHANNELS');
      const ids = new Set<number>(); let blocksPerMCU = 0;
      for (let i = 0; i < count; i++) {
        const offset = at + 8 + i * 3, id = byte(offset), sampling = byte(offset + 1);
        const horizontal = sampling >> 4, vertical = sampling & 15, quantization = byte(offset + 2);
        if (ids.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || quantization > 3) reject();
        ids.add(id); blocksPerMCU += horizontal * vertical;
        components.push(Object.freeze({id, horizontal, vertical, quantization}));
      }
      if (count > 1 && blocksPerMCU > 10) reject();
      progressive = marker === 194;
    }
    // Arithmetic, hierarchical and DNL streams have a different allocation or
    // geometry contract. Do not let the native decoder silently adopt one.
    if ([200, 204, 220, 222, 223].includes(marker)) reject('RASTER_DEPTH');
    if (marker === 218) {
      if (!width || length < 6) reject();
      const count = byte(at + 2);
      if (count < 1 || count > components.length || length !== 6 + count * 2) reject();
      const ids = new Set<number>();
      for (let i = 0; i < count; i++) {
        const id = byte(at + 3 + i * 2), tables = byte(at + 4 + i * 2);
        if (ids.has(id) || !components.some(c => c.id === id) || tables >> 4 > 3 || (tables & 15) > 3) reject();
        ids.add(id);
      }
      scans++;
    }
    at += length;
    if (marker === 218) {
      let found = false;
      while (at < encodedBytes) {
        if (byte(at++) !== 255) continue;
        const markerStart = at - 1;
        let next = byte(at++); while (next === 255) next = byte(at++);
        if (next === 0 || next >= 208 && next <= 215) continue;
        at = markerStart; found = true; break;
      }
      if (!found) reject('RASTER_TRUNCATED');
    }
  }
  if (!ended || !width || !scans) reject('RASTER_TRUNCATED');
  if (icc.size !== iccCount) reject('RASTER_METADATA');
  const iccSegments = iccCount ? Object.freeze(Array.from({length: iccCount}, (_, i) => {const segment = icc.get(i + 1); if (!segment) return reject('RASTER_METADATA'); return segment;})) : null;
  return Object.freeze({kind: 'jpeg-scanline-file-v1', width, height, encodedBytes, progressive, scans, metadataBytes, components: Object.freeze(components), icc: iccSegments, exif});
}

export function jpegScanlineReservation(image: OversizedJPEG): JPEGReservation {
  const {width, height, components} = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || width > 65535 || height < 1 || height > 65535 || ![1, 3].includes(components.length)) reject('RASTER_EXTENT');
  if (components.some(c => !Number.isInteger(c.horizontal) || !Number.isInteger(c.vertical) || c.horizontal < 1 || c.horizontal > 4 || c.vertical < 1 || c.vertical > 4)) reject();
  const maxH = Math.max(...components.map(c => c.horizontal)), maxV = Math.max(...components.map(c => c.vertical));
  // Reserve the full original coefficient grid even for baseline JPEG, because
  // non-interleaved sequential scans also retain coefficient arrays. Decoder
  // scale/crop is never used to reduce this charge. Each JBLOCK is 64 int16s.
  const mcuColumns = Math.ceil(width / (maxH * 8)), mcuRows = Math.ceil(height / (maxV * 8));
  const coefficientBytes = mcuColumns * mcuRows * components.reduce((n, c) => n + c.horizontal * c.vertical, 0) * 128;
  // A conservative admission request, not a claim about exact codec RSS. The
  // independent mmap cap is authoritative and returns RESOURCE on exhaustion.
  // Two grids allow native row-pointer/pool rounding; 64 MiB covers small pools,
  // page rounding, decoder tables and the bounded row transport. Qualification
  // must show representative successes within this cap before promotion.
  const nativeBytes = 2 * coefficientBytes + width * maxV * 8 * 16 + 64 * 1024 * 1024;
  const hostBytes = 2 * 1024 * 1024;
  const scratchBytes = width * height * 4;
  const cpuBytes = nativeBytes + hostBytes;
  if (![coefficientBytes, nativeBytes, scratchBytes, cpuBytes].every(Number.isSafeInteger)) reject('RASTER_RESOURCES');
  return Object.freeze({kind: 'jpeg-scanline-file-v1', coefficientBytes, nativeBytes, hostBytes, scratchBytes, cpuBytes});
}
