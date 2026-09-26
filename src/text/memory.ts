import { admitRequest } from './admission';
import { fail, LIMITS } from './contracts';
import type { TextRequest } from './contracts';
import profile from './profile.json';

const MiB = 1024 ** 2;
export type Reservation = Readonly<{ bytes: number; release(): void }>;

// One authority per application realm, shared across controllers and loaders.
// Other in-realm consumers must reserve here too. The later writer must bridge
// this authority to its own process ledger before accepting prepared outputs.
// These are owned-allocation reservations, not measured process RSS or GC proof.
class MemoryPool {
  #cpu = 0;
  #text = 0;
  check(bytes: number, category: 'text' | 'other' = 'text') {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail('TEXT_RESERVATION');
    if (this.#cpu + bytes > 512 * MiB || category === 'text' && this.#text + bytes > 128 * MiB)
      fail('TEXT_MEMORY_BUDGET', { requested: bytes, cpu: this.#cpu, text: this.#text });
  }
  reserve(bytes: number, category: 'text' | 'other' = 'text'): Reservation {
    this.check(bytes, category);
    this.#cpu += bytes; if (category === 'text') this.#text += bytes;
    let live = true;
    return Object.freeze({ bytes, release: () => {
      if (!live) return; live = false;
      this.#cpu -= bytes; if (category === 'text') this.#text -= bytes;
    } });
  }
  get snapshot() { return Object.freeze({ cpuBytes: this.#cpu, textBytes: this.#text }); }
}
export const textMemory = new MemoryPool();
const ownedFonts = new WeakSet<Blob>();
export function registerFontBacking(blob: Blob) { ownedFonts.add(blob); }
export function unownedFontBytes(request: TextRequest) {
  return request.fonts.reduce((n, f) => n + (ownedFonts.has(f.bytes) ? 0 : f.bytes.size), 0);
}

export function planText(request: TextRequest) {
  const { indices, total } = admitRequest(request);
  const glyphs = Math.max(64, indices.scalars * 8), runs = glyphs;
  const lines = Math.max(indices.lines, glyphs), rectangles = glyphs * 2;
  // Bound strings/objects/typed exports as well as their serialized copies.
  // Numeric JSON values use at most 32 characters; one glyph gets 1024 bytes,
  // one scalar/cluster 1024, and a native line 1024. No truncation on overflow.
  const layout = 16384 + (glyphs + indices.scalars + lines) * 1024;
  if (layout > LIMITS.layoutBytes) fail('TEXT_LAYOUT_BUDGET');
  const raster = Math.ceil(request.frame.width) * Math.ceil(request.frame.height) * 4;
  const indexes = (request.text.length + indices.bytes + indices.scalars + 3) * 128;
  // Caller Blob, clone backing, parser buffer and digest snapshot. Loader-owned
  // input leases are additional conservative reservations, never assumed aliases.
  const fonts = 4 * total - request.fonts.reduce((n, f) => n + (ownedFonts.has(f.bytes) ? f.bytes.size : 0), 0);
  const bytes = fonts + 4 * raster + 6 * layout + indexes + 65536;
  const startup = fonts - 2 * total + request.text.length * 4 + 65536;
  return Object.freeze({ bytes, startup, glyphs, runs, lines, rectangles, layout, raster, fonts, indexes });
}
export type TextPlan = ReturnType<typeof planText>;

// Reserve the compiled maximum, including all native font/shape/surface stores.
// Loader chunks, Blob, arrayBuffer, hash snapshot and compile input/code allowance
// are external; the extra JS allowance covers glue and fixed adapter objects.
export const engineReservationBytes = LIMITS.wasmBytes + 6 * profile.engine.wasm.bytes + 4 * MiB;
export const engineResidentBytes = LIMITS.wasmBytes + 2 * profile.engine.wasm.bytes + 4 * MiB;

const outputs = new WeakMap<object, Reservation>();
export function retainPrepared(value: object, bytes: number) {
  outputs.set(value, textMemory.reserve(bytes));
}
export function releasePrepared(value: object) {
  outputs.get(value)?.release(); outputs.delete(value);
}
