import {publishTextReservationSource} from '../observability/diagnostic-memory.js';
import { admitRequest } from './admission';
import { fail, LIMITS } from './contracts';
import type { TextRequest } from './contracts';
import { engine } from './profile.json';
import { textWorkspaceBudget } from '../protocol/text-budget';

const MiB = 1024 ** 2;
export type Reservation = Readonly<{ bytes: number; release(): void }>;
type ReservationState = { bytes: number; live: boolean; category: 'text' | 'other' };
export type TextReservationObserver = (textBytes:number,sequence:number,observerFaults:number)=>void;

// One authority per application realm, shared across controllers and loaders.
// Other in-realm consumers must reserve here too. The later writer must bridge
// this authority to its own process ledger before accepting prepared outputs.
// These are owned-allocation reservations, not measured process RSS or GC proof.
export class MemoryPool {
  #reservations = new WeakMap<Reservation, ReservationState>();
  #cpu = 0;
  #text = 0;
  #sequence = 0;
  #observerFaults = 0;
  #observer:TextReservationObserver|undefined;
  #notifying = false;
  // A bounded numeric observer; never transfers ownership or changes admission.
  // The central realm ledger books this observer's fixed diagnostic allowance.
  observeReservations(observer:TextReservationObserver):()=>void {
    if(this.#observer)fail('TEXT_RESERVATION_OBSERVER_EXISTS');
    this.#observer=observer;this.#notify();
    let live=true;return ()=>{if(!live)return;live=false;if(this.#observer===observer)this.#observer=undefined;};
  }
  get reservationObservation(){return Object.freeze({textBytes:this.#text,sequence:this.#sequence,observerFaults:this.#observerFaults,observing:!!this.#observer});}
  #notify(){
    // Failed telemetry cannot lose the successful booking's release handle.
    // Its fault counter makes subsequent peak observations incomplete.
    if(this.#notifying){this.#observerFaults++;return;}
    this.#notifying=true;
    try{this.#observer?.(this.#text,this.#sequence,this.#observerFaults);}catch{this.#observerFaults++;}finally{this.#notifying=false;}
  }
  #changed(){this.#sequence++;this.#notify();}
  #assertMutation(){if(this.#notifying){this.#observerFaults++;fail('TEXT_RESERVATION_OBSERVER_REENTRANCY');}}
  check(bytes: number, category: 'text' | 'other' = 'text') {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail('TEXT_RESERVATION');
    if (this.#cpu + bytes > 512 * MiB || category === 'text' && this.#text + bytes > 128 * MiB)
      fail('TEXT_MEMORY_BUDGET', { requested: bytes, cpu: this.#cpu, text: this.#text });
  }
  reserve(bytes: number, category: 'text' | 'other' = 'text'): Reservation {
    this.#assertMutation();
    this.check(bytes, category);
    const lease = this.#lease(bytes, category);
    this.#cpu += bytes; if (category === 'text') this.#text += bytes;
    this.#changed();
    return lease;
  }
  // Transfer a live, same-pool booking without a second admission or an unbooked
  // interval. The returned lease owns bytes formerly held by the source; its
  // remaining bytes are released independently. Notify only after both owners
  // exist, preserving the combined observer's synchronous sequence semantics.
  split(source: Reservation, bytes: number, category: 'text' | 'other' = 'text'): Reservation {
    this.#assertMutation();
    const state = this.#reservations.get(source);
    if (!state?.live || state.category !== category || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > state.bytes)
      fail('TEXT_RESERVATION_TRANSFER');
    const lease = this.#lease(bytes, category);
    state.bytes -= bytes;
    this.#changed();
    return lease;
  }
  // Replace the owner and its allowance atomically. Growth admits only the
  // additional bytes, leaving the original owner intact if admission fails.
  replace(source: Reservation, bytes: number, category: 'text' | 'other' = 'text'): Reservation {
    this.#assertMutation();
    const state = this.#reservations.get(source);
    if (!state?.live || state.category !== category || !Number.isSafeInteger(bytes) || bytes <= 0)
      fail('TEXT_RESERVATION_TRANSFER');
    const delta = bytes - state.bytes;
    this.check(Math.max(0, delta), category);
    const lease = this.#lease(bytes, category);
    state.live = false;
    this.#cpu += delta; if (category === 'text') this.#text += delta;
    this.#changed();
    return lease;
  }
  #lease(bytes: number, category: 'text' | 'other'): Reservation {
    const state: ReservationState = { bytes, live: true, category };
    const lease = Object.freeze({ get bytes() { return state.bytes; }, release: () => {
      if (!state.live) return; this.#assertMutation(); state.live = false;
      this.#cpu -= state.bytes; if (category === 'text') this.#text -= state.bytes;
      this.#changed();
    } });
    this.#reservations.set(lease, state);
    return lease;
  }
  get snapshot() { return Object.freeze({ cpuBytes: this.#cpu, textBytes: this.#text }); }
}
export const textMemory = new MemoryPool();
// Register the one realm authority synchronously before callers can reserve any
// font, parser, worker or prepared-output bytes. Main and worker realms retain
// separate ledgers; the browser's worker delegation is already charged once.
publishTextReservationSource(textMemory);
const ownedFonts = new WeakSet<Blob>();
export function registerFontBacking(blob: Blob) { ownedFonts.add(blob); }
export function unownedFontBytes(request: TextRequest) {
  return request.fonts.reduce((n, f) => n + (ownedFonts.has(f.bytes) ? 0 : f.bytes.size), 0);
}

export function planText(request: TextRequest, options: { legacy?: boolean; retainedRunQuota?: boolean } = {}) {
  const { indices, total } = admitRequest(request);
  let plan;
  try {
    if (options.legacy) {
      const glyphs = Math.max(64, indices.scalars * 8), lines = Math.max(indices.lines, glyphs);
      const layout = 16384 + (glyphs + indices.scalars + lines) * 1024;
      if (layout > LIMITS.layoutBytes) fail('TEXT_LAYOUT_BUDGET');
      plan = { glyphs, runs: glyphs, lines, rectangles: glyphs * 2, layout,
        raster: Math.ceil(request.frame.width) * Math.ceil(request.frame.height) * 4,
        indexes: (request.text.length + indices.bytes + indices.scalars + 3) * 128, workspace: 0 };
    } else plan = textWorkspaceBudget(request.text.length, indices, request.frame.width, request.frame.height, total, engine.wasm.bytes, options);
  }
  catch { fail('TEXT_MEMORY_BUDGET'); }
  const { glyphs, runs, lines, rectangles, layout, raster, indexes, workspace } = plan;
  // Caller Blob, clone backing, parser buffer and digest snapshot. Loader-owned
  // input leases are additional conservative reservations, never assumed aliases.
  const fonts = 4 * total - request.fonts.reduce((n, f) => n + (ownedFonts.has(f.bytes) ? f.bytes.size : 0), 0);
  const bytes = fonts + 4 * raster + (options.legacy ? 6 : 3) * layout + indexes + workspace + 65536;
  const startup = fonts - 2 * total + request.text.length * 4 + 65536;
  return Object.freeze({ bytes, startup, glyphs, runs, lines, rectangles, layout, raster, fonts, indexes, workspace });
}
export type TextPlan = ReturnType<typeof planText>;

// Reserve the compiled maximum, including all native font/shape/surface stores.
// Loader chunks, Blob, arrayBuffer, hash snapshot and compile input/code allowance
// are external; the extra JS allowance covers glue and fixed adapter objects.
export const engineReservationBytes = LIMITS.wasmBytes + 6 * engine.wasm.bytes + 4 * MiB;
export const engineResidentBytes = LIMITS.wasmBytes + 2 * engine.wasm.bytes + 4 * MiB;

const outputs = new WeakMap<object, Reservation>();
export function retainPrepared(value: object, bytes: number, source?: Reservation) {
  if (!value || typeof value !== 'object' || outputs.has(value)) fail('TEXT_PREPARED_OWNERSHIP');
  outputs.set(value, source === undefined ? textMemory.reserve(bytes) : textMemory.split(source, bytes));
}
export function releasePrepared(value: object) {
  outputs.get(value)?.release(); outputs.delete(value);
}
