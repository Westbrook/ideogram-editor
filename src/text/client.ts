import { frozen, LIMITS, TextFailure } from './contracts';
import type { PreparedText, TextRequest } from './contracts';
import { engineReservationBytes, engineResidentBytes, planText, retainPrepared, textMemory, unownedFontBytes } from './memory';
import type { Reservation, TextPlan } from './memory';
import { retainWorkerPhases } from '../observability/browser-worker-observations.js';
export { releasePrepared, textMemory } from './memory';
export type { PreparedText, TextRequest, TextToken, TextStyle, FontInput } from './contracts';

type Pending = { serial: number; request: TextRequest; plan: TextPlan; lease: Reservation; deadline: number; recycled: boolean;
  resolve(value: PreparedText): void; reject(error: unknown): void };

// One active job and one latest pending request. A successful stock terminate()
// ends our ownership of private worker allocations; it does not promise instant
// RSS reclamation or execution of native finally blocks. Caller/output leases
// are separate. Only an actual termination API failure keeps uncertain bookings.
export class TextRenderer {
  #serial = 0;
  #disposed = false;
  #worker?: Worker;
  #ready = false;
  #engineLease?: Reservation;
  #pending?: Pending;
  #scheduled = false;
  #active?: { serial: number; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; lease: Reservation };
  #terminations = 0;
  #terminationFailed = false;
  #uncertainLeases = new Set<Reservation>();
  #terminate(): boolean {
    const worker = this.#worker; if (!worker) return true;
    worker.onmessage = null; worker.onerror = null;
    this.#ready = false;
    // A thrown termination retains the actual retry handle and every private
    // reservation. Repeated attempts neither mint capacity nor count it twice.
    try { worker.terminate(); }
    catch { this.#terminationFailed = true; return false; }
    this.#worker = undefined; this.#terminations++; this.#terminationFailed = false;
    this.#engineLease?.release(); this.#engineLease = undefined;
    for (const lease of this.#uncertainLeases) lease.release(); this.#uncertainLeases.clear();
    return true;
  }
  #dropPending(code: string) {
    const pending = this.#pending; if (!pending) return;
    this.#pending = undefined; pending.lease.release(); pending.reject(new TextFailure(code));
  }
  #stop(code: string) {
    const active = this.#active; if (!active) return;
    this.#active = undefined; clearTimeout(active.timer);
    if (this.#terminate()) active.lease.release();
    else { this.#uncertainLeases.add(active.lease); code = 'TEXT_TERMINATION_FAILED'; }
    active.reject(new TextFailure(code));
  }
  cancel() { this.#serial++; this.#dropPending('TEXT_CANCELLED'); if(this.#active)this.#stop('TEXT_CANCELLED');else if(this.#terminationFailed)this.#terminate(); }
  dispose() { this.#disposed = true; this.cancel(); if(!this.#terminationFailed)this.#terminate();if(this.#terminationFailed)throw new TextFailure('TEXT_TERMINATION_FAILED'); }
  get lifecycle() { return Object.freeze({ activeWorkers: this.#active ? 1 : 0, idleWorkers: this.#worker && !this.#active ? 1 : 0,
    queuedRequests: this.#pending ? 1 : 0, terminations: this.#terminations, disposed: this.#disposed, uncertainBytes: (this.#terminationFailed ? this.#engineLease?.bytes??0 : 0)+[...this.#uncertainLeases].reduce((bytes,lease)=>bytes+lease.bytes,0) }); }
  async prepare(input: TextRequest): Promise<PreparedText> {
    if (this.#disposed) throw new TextFailure('TEXT_DISPOSED');
    const plan = planText(input); // scan only; no index arrays or native work
    if(this.#terminationFailed&&!this.#terminate())throw new TextFailure('TEXT_TERMINATION_FAILED');
    this.#dropPending('TEXT_STALE'); this.#stop('TEXT_STALE');
    if(this.#terminationFailed)throw new TextFailure('TEXT_TERMINATION_FAILED');
    const serial = ++this.#serial;
    textMemory.check(plan.bytes + (this.#worker ? 0 : engineResidentBytes));
    const lease = textMemory.reserve(plan.startup);
    let request: TextRequest;
    try {
      // Only small, known metadata is copied. Immutable font handles alias input;
      // postMessage is the sole font structured-clone boundary.
      const t = input.token, s = input.style;
      request = { text: input.text, token: { documentId: t.documentId, documentRevision: t.documentRevision,
        layerId: t.layerId, layerVersion: t.layerVersion, sessionId: t.sessionId, generation: t.generation },
        frame: { width: input.frame.width, height: input.frame.height },
        style: { primaryFont: s.primaryFont, explicitFallbacks: [...s.explicitFallbacks], sizePx: s.sizePx,
          lineHeightMultiplier: s.lineHeightMultiplier, fill: [...s.fill], align: s.align, direction: s.direction },
        fonts: input.fonts.map(f => ({ hash: f.hash, bytes: f.bytes, faceIndex: f.faceIndex, origin: f.origin,
          license: { hash: f.license.hash, embedding: f.license.embedding } })) };
    } catch (error) { lease.release(); throw error; }
    return new Promise((resolve, reject) => {
      this.#pending = { serial, request, plan, lease, resolve, reject, deadline: performance.now() + LIMITS.deadlineMs, recycled: false };
      if (this.#scheduled) return;
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        const pending = this.#pending; this.#pending = undefined;
        if (pending) this.#start(pending);
      });
    });
  }
  #start(pending: Pending) {
    const { serial, request, plan, resolve, reject } = pending;
    let lease = pending.lease, newEngine: Reservation | undefined;
    try {
      if (!this.#worker) newEngine = textMemory.reserve(engineReservationBytes);
      if (this.#ready) { lease.release(); lease = textMemory.reserve(plan.bytes); }
      if (!this.#worker) {
        this.#worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ideogram-text-' + serial });
        this.#engineLease = newEngine;
      }
    } catch (error) { lease.release(); newEngine?.release(); reject(error); return; }
    const worker = this.#worker;
    const remaining = pending.deadline - performance.now();
    if (remaining <= 0) { lease.release(); this.#terminate(); reject(new TextFailure('TEXT_DEADLINE')); return; }
    const timer = setTimeout(() => this.#stop('TEXT_DEADLINE'), remaining);
    this.#active = { serial, reject, timer, lease };
    worker.onerror = event => { event.preventDefault(); this.#stop('TEXT_WORKER_FAILURE'); };
    worker.onmessage = event => {
      if (this.#active?.serial !== serial || serial !== this.#serial) return;
      const message = event.data;
      if (message.ready) {
        this.#engineLease!.release(); this.#engineLease = textMemory.reserve(engineResidentBytes); this.#ready = true;
        lease.release();
        try { lease = textMemory.reserve(plan.bytes); this.#active.lease = lease; worker.postMessage(request); }
        catch (error) { clearTimeout(timer); this.#active = undefined; worker.onmessage = null; lease.release(); reject(error); }
        return;
      }
      this.#active = undefined; clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null;
      if(message.phases)retainWorkerPhases(message.phases);
      if (!message.ok && !pending.recycled && ['FONT_CACHE_CAPACITY','TEXT_NATIVE_CAPACITY'].includes(message.code)) {
        if (!this.#terminate()) { this.#uncertainLeases.add(lease); reject(new TextFailure('TEXT_TERMINATION_FAILED')); return; }
        lease.release();
        try {
          textMemory.check(plan.bytes + engineResidentBytes);
          this.#start({ ...pending, recycled: true, lease: textMemory.reserve(plan.startup) });
        } catch (error) { reject(error); }
        return;
      }
      if (!message.fatal || this.#terminate()) lease.release();
      else { this.#uncertainLeases.add(lease); reject(new TextFailure('TEXT_TERMINATION_FAILED')); return; }
      if (!message.ok) { reject(new TextFailure(message.code, message.details)); return; }
      const result = message.value as PreparedText;
      try {
        this.#validateResult(result, request, plan);
        const value = { ...result, dependencies: result.dependencies.map(d => ({ ...d, bytes: request.fonts.find(f => f.hash === d.hash)!.bytes })) };
        retainPrepared(value, result.rgba.size + result.layout.size + result.textUtf8.size + unownedFontBytes(request));
        resolve(frozen(value));
      } catch (error) { reject(error); }
    };
    try { if (this.#ready) worker.postMessage(request); } catch { this.#stop('TEXT_WORKER_FAILURE'); }
  }
  #validateResult(result: PreparedText, request: TextRequest, plan: TextPlan) {
    if (JSON.stringify(result.token) !== JSON.stringify(request.token)) throw new TextFailure('TEXT_STALE');
    if (!(result.rgba instanceof Blob) || result.rgba.size !== plan.raster || !(result.layout instanceof Blob) || result.layout.size > plan.layout ||
        !(result.textUtf8 instanceof Blob) || result.textUtf8.size > LIMITS.textBytes || result.dependencies.length !== request.fonts.length ||
        result.dependencies.some(d => !request.fonts.some(f => f.hash === d.hash && f.bytes.size === d.bytes.size))) throw new TextFailure('TEXT_RESULT_BUDGET');
  }
}
