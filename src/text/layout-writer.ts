import { fail, LIMITS } from './contracts';

export const LAYOUT_CHUNK_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const controlEscapes: Readonly<Record<number, string>> = {8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r'};

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

// Serialize the layout directly into bounded UTF-8 buffers. Callers own native
// exports only until their fields have been written; no complete JS layout or
// complete JSON string is retained alongside these bytes. This is a writer for
// JSON data, with JSON.stringify's key order, escaping and number spelling.
export class LayoutWriter {
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private current: Uint8Array<ArrayBuffer> | undefined;
  private used = 0;
  private length = 0;
  private finished = false;
  private readonly ancestors = new Set<object>();

  constructor(private readonly limit = LIMITS.layoutBytes) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > LIMITS.layoutBytes) fail('TEXT_LAYOUT_SIZE');
  }

  get byteLength(): number { return this.length; }

  raw(value: string): this {
    if (this.finished) throw new Error('TEXT_LAYOUT_FINISHED');
    const bytes = utf8Bytes(value);
    // Refuse the append before allocating a new chunk or changing the output.
    if (bytes > this.limit - this.length) fail('TEXT_LAYOUT_SIZE');
    let offset = 0;
    while (offset < value.length) {
      this.current ??= new Uint8Array(LAYOUT_CHUNK_BYTES);
      let read: number;
      if (bytes === value.length) {
        // The layout's keys and numeric arrays are ASCII. Avoid an encoding
        // allocation/call per number while keeping the same byte boundary.
        read = Math.min(value.length - offset, LAYOUT_CHUNK_BYTES - this.used);
        for (let i = 0; i < read; i++) this.current[this.used + i] = value.charCodeAt(offset + i);
        offset += read; this.used += read;
      } else {
        let end = Math.min(value.length, offset + 16384);
        const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        const result = encoder.encodeInto(value.slice(offset, end), this.current.subarray(this.used));
        read = result.read; offset += read; this.used += result.written;
      }
      // A multi-byte scalar may not fit in the final 1–3 bytes of a chunk.
      if (this.used === LAYOUT_CHUNK_BYTES || read === 0) {
        this.chunks.push(this.current.subarray(0, this.used));
        this.current = undefined; this.used = 0;
      }
    }
    this.length += bytes;
    return this;
  }

  private string(value: string): void {
    this.raw('"');
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      let escaped: string | undefined;
      if (unit === 0x22) escaped = '\\"';
      else if (unit === 0x5c) escaped = '\\\\';
      else if (unit < 0x20) escaped = controlEscapes[unit] ?? '\\u' + unit.toString(16).padStart(4, '0');
      else if (unit >= 0xd800 && unit <= 0xdfff) {
        if (unit <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i++;
        else escaped = '\\u' + unit.toString(16).padStart(4, '0');
      }
      if (escaped !== undefined) {
        this.raw(value.slice(start, i)); this.raw(escaped); start = i + 1;
      } else if (i - start >= 8192) {
        this.raw(value.slice(start, i + 1)); start = i + 1;
      }
    }
    this.raw(value.slice(start)); this.raw('"');
  }

  value(value: unknown): this {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('TEXT_NONFINITE_LAYOUT');
      return this.raw(JSON.stringify(value));
    }
    if (typeof value === 'string') { this.string(value); return this; }
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'bigint') throw new TypeError('Cannot serialize BigInt');
      return this.raw(typeof value === 'boolean' ? String(value) : 'null');
    }
    if (this.ancestors.has(value)) throw new TypeError('Cannot serialize cyclic layout');
    this.ancestors.add(value);
    try {
      if (Array.isArray(value)) this.array(value);
      else {
        this.raw('{'); let first = true;
        for (const key of Object.keys(value)) {
          const item = (value as Record<string, unknown>)[key];
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          if (!first) this.raw(','); first = false;
          this.string(key); this.raw(':'); this.value(item);
        }
        this.raw('}');
      }
    } finally { this.ancestors.delete(value); }
    return this;
  }

  array<T>(values: ArrayLike<T>, write: (value: T, index: number) => unknown = value => this.value(value)): this {
    this.raw('[');
    for (let i = 0; i < values.length; i++) { if (i) this.raw(','); write(values[i], i); }
    return this.raw(']');
  }

  finishBlob(): Blob {
    if (this.finished) throw new Error('TEXT_LAYOUT_FINISHED');
    if (this.current && this.used) this.chunks.push(this.current.subarray(0, this.used));
    const blob = new Blob(this.chunks, {type: 'application/json'});
    this.chunks.length = 0; this.current = undefined; this.used = 0; this.finished = true;
    return blob;
  }
}
