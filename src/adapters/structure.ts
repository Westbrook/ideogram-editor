import { canonical, parseControlJSON } from '../protocol/json.js';
import { SHA256 } from '../protocol/sha256.js';

// App inspection bounds, not provider limits or tensor-file size limits. Bytes
// outside this profile stay retained for inspection/requalification. Only the
// header is parsed; weights are streamed and hashed by the owning asset store.
export const SAFETENSORS_HEADER_MAX = 1024 * 1024;
export const SAFETENSORS_TENSOR_MAX = 16_384;
export const SAFETENSORS_RANK_MAX = 64;
export const SAFETENSORS_INSPECTION_PROFILE = 'safetensors-inspection-1' as const;
const bits = Object.freeze({ BOOL: 8, U8: 8, I8: 8, F4: 4, F6_E2M3: 6, F6_E3M2: 6,
  F8_E5M2: 8, F8_E4M3: 8, F8_E8M0: 8, F8_E4M3FNUZ: 8, F8_E5M2FNUZ: 8,
  I16: 16, U16: 16, F16: 16, BF16: 16, I32: 32, U32: 32, F32: 32,
  I64: 64, U64: 64, F64: 64, C64: 64 });
export type SafetensorsDtype = keyof typeof bits;
export type SafetensorsErrorCode = 'ADAPTER_HEADER_LIMIT' | 'ADAPTER_INVALID_HEADER' |
  'ADAPTER_INVALID_LENGTH' | 'ADAPTER_TENSOR_LIMIT' | 'ADAPTER_UNSUPPORTED_DTYPE' |
  'ADAPTER_INVALID_TENSOR' | 'ADAPTER_INVALID_OFFSETS' | 'ADAPTER_EMPTY_WEIGHTS';
export class SafetensorsError extends Error {
  constructor(readonly code: SafetensorsErrorCode) { super(code); }
}
const fail = (code: SafetensorsErrorCode): never => { throw new SafetensorsError(code); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unsigned = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export type SafetensorsTensor = Readonly<{ name: string; dtype: SafetensorsDtype;
  shape: readonly number[]; dataOffsets: readonly [number, number] }>;
export type SafetensorsStructure = Readonly<{ kind: typeof SAFETENSORS_INSPECTION_PROFILE;
  headerBytes: number; dataBytes: number; tensorCount: number; dtypes: readonly SafetensorsDtype[];
  tensorSignature: string; metadata: Readonly<Record<string, string>>; tensors: readonly SafetensorsTensor[] }>;

/** Read exactly eight prefix bytes before allocating a bounded header buffer. */
export function parseSafetensorsHeaderLength(prefix: Uint8Array, fileBytes: number): number {
  if (!unsigned(fileBytes) || fileBytes < 10 || prefix.byteLength !== 8) return fail('ADAPTER_INVALID_LENGTH');
  const length = new DataView(prefix.buffer, prefix.byteOffset, 8).getBigUint64(0, true);
  if (length > BigInt(SAFETENSORS_HEADER_MAX)) return fail('ADAPTER_HEADER_LIMIT');
  if (length < 2n || length + 8n > BigInt(fileBytes)) return fail('ADAPTER_INVALID_LENGTH');
  return Number(length);
}

/**
 * Header-only inspection against the verified length of the complete file.
 * Format source: https://github.com/safetensors/safetensors#format (2026-09-30).
 * This proves bounded structure, never model family or runtime compatibility.
 */
export function inspectSafetensorsHeader(header: Uint8Array, fileBytes: number): SafetensorsStructure {
  if (header.byteLength > SAFETENSORS_HEADER_MAX) return fail('ADAPTER_HEADER_LIMIT');
  if (!unsigned(fileBytes) || header.byteLength < 2 || fileBytes < header.byteLength + 8) return fail('ADAPTER_INVALID_LENGTH');
  if (header[0] !== 0x7b) return fail('ADAPTER_INVALID_HEADER');
  let last = header.length - 1;
  while (header[last] === 0x20) last--;
  if (header[last] !== 0x7d) return fail('ADAPTER_INVALID_HEADER');
  let parsed: Record<string, unknown>;
  try { parsed = parseControlJSON(header, SAFETENSORS_HEADER_MAX); } catch { return fail('ADAPTER_INVALID_HEADER'); }
  // serde's tensor dimensions/offsets are unsigned integers, not JSON floats
  // rounded back to an integer by JavaScript (for example 1e0 or 1.0).
  const source = new TextDecoder().decode(header);
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '"') {
      for (at++; at < source.length && source[at] !== '"'; at++) if (source[at] === '\\') at++;
    } else if (/[-0-9]/.test(source[at])) {
      const start = at;
      while (at + 1 < source.length && /[0-9eE+.-]/.test(source[at + 1])) at++;
      if (!/^(?:0|[1-9][0-9]*)$/.test(source.slice(start, at + 1))) return fail('ADAPTER_INVALID_TENSOR');
    }
  }
  const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
  const tensors: SafetensorsTensor[] = [];
  const dataBytes = fileBytes - header.byteLength - 8;
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '__metadata__') {
      if (!object(value)) return fail('ADAPTER_INVALID_HEADER');
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') return fail('ADAPTER_INVALID_HEADER');
        metadata[key] = item;
      }
      continue;
    }
    if (tensors.length >= SAFETENSORS_TENSOR_MAX) return fail('ADAPTER_TENSOR_LIMIT');
    if (!object(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'dtype') ||
      !Object.hasOwn(value, 'shape') || !Object.hasOwn(value, 'data_offsets')) return fail('ADAPTER_INVALID_TENSOR');
    if (typeof value.dtype !== 'string' || !Object.hasOwn(bits, value.dtype)) return fail('ADAPTER_UNSUPPORTED_DTYPE');
    if (!Array.isArray(value.shape) || value.shape.length > SAFETENSORS_RANK_MAX) return fail('ADAPTER_TENSOR_LIMIT');
    if (!value.shape.every(unsigned)) return fail('ADAPTER_INVALID_TENSOR');
    if (!Array.isArray(value.data_offsets) || value.data_offsets.length !== 2 || !value.data_offsets.every(unsigned)) return fail('ADAPTER_INVALID_OFFSETS');
    const [begin, end] = value.data_offsets as [number, number];
    if (end < begin || end > dataBytes) return fail('ADAPTER_INVALID_OFFSETS');
    const dtype = value.dtype as SafetensorsDtype;
    // BigInt avoids rounded shape products accepting a false range. Zero-sized
    // tensors and scalars follow safetensors, but an entirely empty adapter does
    // not contain usable weights and is refused separately below.
    const elements = value.shape.reduce((product: bigint, dimension: number) => product * BigInt(dimension), 1n);
    const bitCount = elements * BigInt(bits[dtype]);
    if (bitCount % 8n || bitCount / 8n !== BigInt(end - begin)) return fail('ADAPTER_INVALID_TENSOR');
    tensors.push(Object.freeze({ name, dtype, shape: Object.freeze([...value.shape]) as readonly number[],
      dataOffsets: Object.freeze([begin, end]) as readonly [number, number] }));
  }
  if (!tensors.length || !dataBytes) return fail('ADAPTER_EMPTY_WEIGHTS');
  // Range order is independent of JSON/name order. Empty ranges sort first at
  // a boundary; all ranges must form an exact partition with no trailing bytes.
  tensors.sort((a, b) => a.dataOffsets[0] - b.dataOffsets[0] || a.dataOffsets[1] - b.dataOffsets[1] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let end = 0;
  for (const tensor of tensors) {
    if (tensor.dataOffsets[0] !== end) return fail('ADAPTER_INVALID_OFFSETS');
    end = tensor.dataOffsets[1];
  }
  if (end !== dataBytes) return fail('ADAPTER_INVALID_OFFSETS');
  const tensorSignature = new SHA256().update(new TextEncoder().encode(canonical(tensors))).digest();
  return Object.freeze({ kind: SAFETENSORS_INSPECTION_PROFILE, headerBytes: header.byteLength,
    dataBytes, tensorCount: tensors.length, dtypes: Object.freeze([...new Set(tensors.map(t => t.dtype))].sort()),
    tensorSignature, metadata: Object.freeze(metadata), tensors: Object.freeze(tensors) });
}
