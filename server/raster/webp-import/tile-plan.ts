// SOURCE STAGING ONLY. No default identity or halo is issued by this module.
export const WEBP_NATIVE_BYTES = 128 * 1024 * 1024;
export const WEBP_IO_BYTES = 65536;
export const WEBP_WRAPPER_BYTES = 128 * 1024;
const MAPPING_GRANULARITY = 16384;
const hash = /^sha256:[0-9a-f]{64}$/;
export type WebPSourceStamp = Readonly<{dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint}>;
type Chunk = Readonly<{offset: number; length: number}>;
export type WebPDescriptor = Readonly<{
  width: number; height: number; encodedBytes: number; flags: number | null;
  bitstreamHasAlpha: boolean; image: Chunk & {type: 'VP8 ' | 'VP8L'};
  alpha?: Chunk; stamp: WebPSourceStamp;
}>;
export type WebPOriginal = Readonly<{
  path: string; descriptor: WebPDescriptor; effectiveAlpha: boolean;
  // The durable inspection binds original identity, descriptor and metadata.
  // This trusted server value is not supplied directly by a browser request.
  inspectionHash: string;
}>;
export type QualifiedWebPHalo = Readonly<{
  kind: 'encoded-grid-expand-align-origin-clamp-trim-v1';
  pixelProfile: 'libwebp-1.6.0-full-rgba8-v1';
  left: number; top: number; right: number; bottom: number;
  originAlignment: number; proofHash: string;
}>;
export type QualifiedWebPIdentity = Readonly<{
  status: 'qualified'; kind: 'webp-advanced-file-v1'; abiVersion: 1;
  decoderVersion: 0x010600; platform: NodeJS.Platform; arch: string;
  artifact: Readonly<{path: string; bytes: number; hash: string}>;
  sourceHash: string; producerHash: string; qualificationHash: string;
  residentCodeBytes: number; loader: 'held-descriptor-v1';
  // null means unavailable. A guessed/default halo must never enable decoding.
  halo: QualifiedWebPHalo | null;
}>;
export type WebPTile = Readonly<{
  x: number; y: number; width: number; height: number;
  cropLeft: number; cropTop: number; cropWidth: number; cropHeight: number;
  trimLeft: number; trimTop: number;
}>;
export type WebPReservation = Readonly<{
  kind: 'webp-advanced-file-v1'; nativeBytes: number; outputMappingBytes: number;
  hostBytes: number; codeBytes: number; cpuBytes: number;
  sourceScratchBytes: number; tileScratchBytes: number; scratchBytes: number;
  width: number; height: number; coreWidth: number; coreHeight: number;
  tileCount: number; halo: QualifiedWebPHalo; inspectionHash: string;
}>;
function fail(code: string): never { throw Error(code); }
const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
const activeAlpha = (d: WebPDescriptor) => d.flags === null ? d.bitstreamHasAlpha &&
  d.alpha?.offset !== d.image.offset + d.image.length + d.image.length % 2 + 8 : Boolean(d.flags & 16);
export function validateWebPOriginal(original: WebPOriginal): void {
  const d = original.descriptor;
  const range = (c: Chunk) => integer(c.offset, 20, d.encodedBytes) && integer(c.length, 0, 0xffffffff) &&
    c.length + c.length % 2 <= d.encodedBytes - c.offset;
  if (!hash.test(original.inspectionHash) || typeof original.path !== 'string' ||
      !integer(d.width, 1, 16384) || !integer(d.height, 1, 16384) ||
      !integer(d.encodedBytes, 26, 0xffffffff + 8) ||
      (d.flags !== null && (!integer(d.flags, 0, 255) || (d.flags & 0xc3) !== 0)) ||
      typeof d.bitstreamHasAlpha !== 'boolean' || !['VP8 ', 'VP8L'].includes(d.image.type) ||
      !range(d.image) || d.image.length < (d.image.type === 'VP8 ' ? 10 : 5) ||
      (d.alpha !== undefined && !range(d.alpha)) || original.effectiveAlpha !== activeAlpha(d) ||
      [d.stamp.dev, d.stamp.ino, d.stamp.size, d.stamp.mtimeNs, d.stamp.ctimeNs].some(n => typeof n !== 'bigint') ||
      d.stamp.size !== BigInt(d.encodedBytes)) fail('RASTER_METADATA');
  if (original.effectiveAlpha && d.image.type === 'VP8 ' && d.alpha &&
      d.alpha.offset + d.alpha.length + d.alpha.length % 2 !== d.image.offset - 8) fail('RASTER_METADATA');
  if (original.effectiveAlpha && d.image.type === 'VP8 ' && d.alpha?.length === 0) fail('RASTER_FORMAT');
}
export function validateWebPIdentity(seal: QualifiedWebPIdentity | undefined): asserts seal is QualifiedWebPIdentity & {halo: QualifiedWebPHalo} {
  if (!seal || seal.status !== 'qualified' || seal.kind !== 'webp-advanced-file-v1' || seal.abiVersion !== 1 ||
      seal.decoderVersion !== 0x010600 || seal.platform !== process.platform || seal.arch !== process.arch ||
      !(seal.platform === 'darwin' && seal.arch === 'arm64' || seal.platform === 'linux' && ['arm64', 'x64'].includes(seal.arch)) ||
      seal.loader !== 'held-descriptor-v1' ||
      ![seal.artifact.hash, seal.sourceHash, seal.producerHash, seal.qualificationHash].every(h => hash.test(h)) ||
      seal.sourceHash !== 'sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564' ||
      !integer(seal.artifact.bytes, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(seal.residentCodeBytes, seal.artifact.bytes, Number.MAX_SAFE_INTEGER)) fail('RASTER_CODEC_UNQUALIFIED');
  const h = seal.halo;
  if (!h || h.kind !== 'encoded-grid-expand-align-origin-clamp-trim-v1' || h.pixelProfile !== 'libwebp-1.6.0-full-rgba8-v1' ||
      !hash.test(h.proofHash) || ![h.left, h.right, h.top, h.bottom].every(n => integer(n, 0, 16384)) ||
      !integer(h.originAlignment, 2, 8192) || (h.originAlignment & (h.originAlignment - 1)) !== 0) fail('RASTER_CODEC_UNQUALIFIED');
}
export function webpTileReservation(original: WebPOriginal, seal: QualifiedWebPIdentity): WebPReservation {
  validateWebPOriginal(original); validateWebPIdentity(seal);
  const {width, height} = original.descriptor, halo = Object.freeze({...seal.halo});
  // 5000*5000 is exactly25MP. A conservative square bound leaves room for all
  // halo edges plus the extra left/top expansion needed for origin alignment.
  const horizontal = halo.left + halo.right + halo.originAlignment - 1;
  const vertical = halo.top + halo.bottom + halo.originAlignment - 1;
  const coreWidth = Math.min(width, 2048, width <= 5000 ? 2048 : 5000 - horizontal);
  const coreHeight = Math.min(height, 2048, height <= 5000 ? 2048 : 5000 - vertical);
  if (coreWidth < 1 || coreHeight < 1) fail('RASTER_RESOURCES');
  const maxWidth = Math.min(width, coreWidth + horizontal), maxHeight = Math.min(height, coreHeight + vertical);
  const tileScratchBytes = maxWidth * maxHeight * 4;
  const outputMappingBytes = Math.ceil(tileScratchBytes / MAPPING_GRANULARITY) * MAPPING_GRANULARITY;
  const sourceScratchBytes = width * height * 4;
  const hostBytes = 2 * 1024 * 1024 + WEBP_WRAPPER_BYTES;
  const codeBytes = seal.residentCodeBytes, cpuBytes = WEBP_NATIVE_BYTES + outputMappingBytes + hostBytes + codeBytes;
  const scratchBytes = sourceScratchBytes + tileScratchBytes;
  const tileCount = Math.ceil(width / coreWidth) * Math.ceil(height / coreHeight);
  if (maxWidth > 8192 || maxHeight > 8192 || maxWidth * maxHeight > 25000000 ||
      ![tileScratchBytes, outputMappingBytes, sourceScratchBytes, cpuBytes, scratchBytes, tileCount].every(Number.isSafeInteger)) fail('RASTER_RESOURCES');
  return Object.freeze({kind: 'webp-advanced-file-v1', nativeBytes: WEBP_NATIVE_BYTES, outputMappingBytes,
    hostBytes, codeBytes, cpuBytes, sourceScratchBytes, tileScratchBytes, scratchBytes,
    width, height, coreWidth, coreHeight, tileCount, halo, inspectionHash: original.inspectionHash});
}
export function* webpTiles(plan: WebPReservation): Generator<WebPTile> {
  const {width, height, coreWidth, coreHeight, halo: h} = plan;
  for (let y = 0; y < height; y += coreHeight) for (let x = 0; x < width; x += coreWidth) {
    const w = Math.min(coreWidth, width - x), v = Math.min(coreHeight, height - y);
    const cropLeft = Math.floor(Math.max(0, x - h.left) / h.originAlignment) * h.originAlignment;
    const cropTop = Math.floor(Math.max(0, y - h.top) / h.originAlignment) * h.originAlignment;
    const cropWidth = Math.min(width, x + w + h.right) - cropLeft;
    const cropHeight = Math.min(height, y + v + h.bottom) - cropTop;
    if (cropLeft % 2 || cropTop % 2 || cropWidth > 8192 || cropHeight > 8192 || cropWidth * cropHeight > 25000000 ||
        cropWidth * cropHeight * 4 > plan.tileScratchBytes) fail('RASTER_RESOURCES');
    yield Object.freeze({x, y, width: w, height: v, cropLeft, cropTop, cropWidth, cropHeight, trimLeft: x - cropLeft, trimTop: y - cropTop});
  }
}
export function encodeWebPRequest(original: WebPOriginal, plan: WebPReservation, tile: WebPTile, request = Buffer.alloc(112)): Buffer {
  const d = original.descriptor, alpha = original.effectiveAlpha && d.image.type === 'VP8 ' ? d.alpha : undefined;
  if (request.byteLength !== 112) fail('RASTER_RESOURCES'); request.fill(0);
  request.writeUInt32LE(1, 0); request.writeUInt32LE(112, 4);
  [d.encodedBytes, d.image.offset, d.image.length, alpha?.offset ?? 0, alpha?.length ?? 0].forEach((n, i) => request.writeBigUInt64LE(BigInt(n), 8 + i * 8));
  [d.image.type === 'VP8 ' ? 1 : 2, d.width, d.height, Number(original.effectiveAlpha),
    tile.cropLeft, tile.cropTop, tile.cropWidth, tile.cropHeight,
    0, tile.cropWidth, tile.cropHeight, 0].forEach((n, i) => request.writeUInt32LE(n, 48 + i * 4));
  request.writeBigUInt64LE(BigInt(plan.nativeBytes), 96);
  request.writeBigUInt64LE(BigInt(plan.outputMappingBytes), 104);
  return request;
}
