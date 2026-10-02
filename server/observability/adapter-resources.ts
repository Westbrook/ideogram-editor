import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isMainThread, threadId } from 'node:worker_threads';

type Release = () => void;
type Scope = { owner: string; releases: Release[]; closed: boolean };
type Group = { owner: string; kind: string; buffers: number; handles: number; reservedBytes: number };
type Backing = { bytes: number; owners: number };
const NOOP: Release = () => {};
const MAX_LEASES = 8192, MAX_GROUPS = 128;
const AGGREGATE_MAGIC = 0x57414f574e455231n;
const AGGREGATE_HEADER = 24, AGGREGATE_PARTICIPANTS = 128;
const AGGREGATE_WORDS = AGGREGATE_HEADER + AGGREGATE_PARTICIPANTS * 2;
const CURRENT = 4, PEAK = 5, SEQUENCE = 6, GAPS = 7;
const WINDOW_GENERATION=8,WINDOW_PEAK=9,WINDOW_MODE=10,IN_FLIGHT=11,WINDOW_START_NS=12,WINDOW_END_NS=13,WINDOW_END_CPU=14,WINDOW_SEQUENCE=15,WINDOW_SERIAL=16;
const UNCOVERED_STATE=17,WINDOW_COVERAGE_START=18,WINDOW_COVERAGE_END=19;
const UNCOVERED_BITS=32n,UNCOVERED_MASK=(1n<<UNCOVERED_BITS)-1n,UNCOVERED_ACTIVATION=(1n<<UNCOVERED_BITS)+1n;
const uncoveredActive=(state:bigint)=>Number(state&UNCOVERED_MASK),uncoveredActivations=(state:bigint)=>Number(state>>UNCOVERED_BITS);
const COVERAGE_CONTRACT='backend-adapter-owned-resources-1' as const;
// Current ownership and window generation share one atomic word. This makes
// each byte transition belong to exactly one side of a B0/B1 boundary.
const CPU_BITS=40n,CPU_MASK=(1n<<CPU_BITS)-1n,MAX_WINDOW_GENERATION=(1n<<23n)-1n;
const ownedBytes=(state:bigint)=>state&CPU_MASK,windowGeneration=(state:bigint)=>state>>CPU_BITS;
const tagged=(generation:bigint,bytes:bigint)=>(generation<<CPU_BITS)|bytes;
const participantState = (id: number) => AGGREGATE_HEADER + id * 2;
const participantBytes = (id: number) => participantState(id) + 1;

function newAggregate() {
  const words = new BigInt64Array(new SharedArrayBuffer(AGGREGATE_WORDS * 8));
  words[0] = AGGREGATE_MAGIC; words[1] = 1n; words[2] = BigInt(process.pid);
  words[3] = BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15));
  words[participantState(0)] = 2n; // Process/main owner; writer slots start at one.
  return words;
}

/** One linearized current-byte counter and monotonic CAS maximum per process.
 * Participant contributions support cleanup after a confirmed worker exit.
 * Unexpected exits make integrity incomplete: a killed worker may have stopped
 * between the contribution and aggregate updates. Such data cannot prove a cap.
 */
class ProcessOwnedAggregate {
  private words = newAggregate();
  private participant: number | null = 0;
  private contribution = 0;
  private bound = isMainThread;
  buffer() { return this.words.buffer as SharedArrayBuffer; }
  gap() { Atomics.add(this.words, GAPS, 1n); }
  uncovered():Release {
    // Activation count and active count are one atomic state. A transient
    // uncovered owner cannot disappear between two quiescence samples.
    const before=Atomics.add(this.words,UNCOVERED_STATE,UNCOVERED_ACTIVATION);
    if(before<0n||uncoveredActive(before)===Number(UNCOVERED_MASK)||uncoveredActivations(before)>=0x7ffffffe)this.gap();
    let released=false;
    return ()=>{if(released)return;released=true;const state=Atomics.sub(this.words,UNCOVERED_STATE,1n);if(uncoveredActive(state)===0)this.gap();};
  }
  reserveParticipant(): number | null {
    for (let id = 1; id < AGGREGATE_PARTICIPANTS; id++) {
      if (Atomics.compareExchange(this.words, participantState(id), 0n, 1n) === 0n) return id;
    }
    this.gap(); return null;
  }
  bind(buffer: SharedArrayBuffer, participant: number | null, priorGaps: number) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== AGGREGATE_WORDS * 8) throw Error('Invalid ownership aggregate');
    const words = new BigInt64Array(buffer);
    if (Atomics.load(words, 0) !== AGGREGATE_MAGIC || Atomics.load(words, 1) !== 1n || Atomics.load(words, 2) !== BigInt(process.pid)) throw Error('Ownership aggregate identity mismatch');
    if (this.contribution !== 0) throw Error('Cannot move active ownership contributions');
    this.words = words; this.participant = null; this.bound = false;
    if (priorGaps) Atomics.add(words, GAPS, BigInt(priorGaps));
    if (participant === null || !Number.isInteger(participant) || participant < 1 || participant >= AGGREGATE_PARTICIPANTS ||
      Atomics.compareExchange(words, participantState(participant), 1n, 2n) !== 1n) { this.gap(); return; }
    this.participant = participant; this.bound = true;
  }
  private raisePeak(current: bigint) {
    let peak = Atomics.load(this.words, PEAK);
    while (current > peak) { const previous = Atomics.compareExchange(this.words, PEAK, peak, current); if (previous === peak) break; peak = previous; }
  }
  private raiseWindowPeak(generation:bigint,current:bigint){
    if(generation===0n)return;
    // Preserve the superset invariant even when this observation races the
    // booking thread between its current update and its own lifetime-peak CAS.
    this.raisePeak(current);
    let peak=Atomics.load(this.words,WINDOW_PEAK);
    while(windowGeneration(peak)===generation&&current>ownedBytes(peak)){
      const previous=Atomics.compareExchange(this.words,WINDOW_PEAK,peak,tagged(generation,current));if(previous===peak)break;peak=previous;
    }
  }
  update(next: number) {
    const delta = next - this.contribution; this.contribution = next;
    if (!delta || this.participant === null) return;
    Atomics.add(this.words,IN_FLIGHT,1n);
    try{
      Atomics.add(this.words, participantBytes(this.participant), BigInt(delta));
      const before=Atomics.add(this.words,CURRENT,BigInt(delta)),state=before+BigInt(delta),current=ownedBytes(state),generation=windowGeneration(state);
      if(windowGeneration(before)!==generation||ownedBytes(before)+BigInt(delta)<0n||current>CPU_MASK){this.gap();return;}
      this.raisePeak(current);this.raiseWindowPeak(generation,current);
      if(generation!==0n)Atomics.add(this.words,WINDOW_SEQUENCE,1n);
      Atomics.add(this.words, SEQUENCE, 1n);
    }finally{Atomics.sub(this.words,IN_FLIGHT,1n);}
  }
  beginLifecycleWindow(){
    const previousMode=Atomics.load(this.words,WINDOW_MODE);
    if((previousMode!==0n&&previousMode!==4n)||Atomics.compareExchange(this.words,WINDOW_MODE,previousMode,1n)!==previousMode)throw Error('Ownership lifecycle window already active or awaiting seal');
    const generation=Atomics.add(this.words,WINDOW_SERIAL,1n)+1n;
    if(generation>MAX_WINDOW_GENERATION){this.gap();Atomics.store(this.words,WINDOW_MODE,previousMode);throw Error('Ownership lifecycle window identity exhausted');}
    Atomics.store(this.words,WINDOW_GENERATION,generation);Atomics.store(this.words,WINDOW_SEQUENCE,0n);Atomics.store(this.words,WINDOW_END_NS,0n);
    // The coverage bracket is deliberately wider than the byte window. An
    // activation at either boundary may conservatively invalidate coverage.
    Atomics.store(this.words,WINDOW_COVERAGE_START,Atomics.load(this.words,UNCOVERED_STATE));
    Atomics.store(this.words,WINDOW_COVERAGE_END,0n);
    // Only a successful tagged-current CAS opens the window. Failed attempts
    // replace their provisional baseline; they cannot import a pre-B0 peak.
    for(;;){const state=Atomics.load(this.words,CURRENT);if(windowGeneration(state)!==0n){this.gap();throw Error('Ownership lifecycle boundary mismatch');}
      Atomics.store(this.words,WINDOW_PEAK,tagged(generation,ownedBytes(state)));
      if(Atomics.compareExchange(this.words,CURRENT,state,tagged(generation,ownedBytes(state)))===state)break;
    }
    Atomics.store(this.words,WINDOW_START_NS,process.hrtime.bigint());Atomics.store(this.words,WINDOW_MODE,2n);
  }
  endLifecycleWindow(){
    if(Atomics.compareExchange(this.words,WINDOW_MODE,2n,3n)!==2n)throw Error('No active ownership lifecycle window');
    const generation=Atomics.load(this.words,WINDOW_GENERATION);
    for(;;){const state=Atomics.load(this.words,CURRENT);if(windowGeneration(state)!==generation){this.gap();throw Error('Ownership lifecycle boundary mismatch');}
      if(Atomics.compareExchange(this.words,CURRENT,state,ownedBytes(state))===state){this.raiseWindowPeak(generation,ownedBytes(state));Atomics.store(this.words,WINDOW_END_CPU,ownedBytes(state));break;}
    }
    Atomics.store(this.words,WINDOW_COVERAGE_END,Atomics.load(this.words,UNCOVERED_STATE));
    Atomics.store(this.words,WINDOW_END_NS,process.hrtime.bigint());
    // Never spin waiting for a paused/killed worker. A later snapshot can seal
    // after all updates that linearized before B1 have finished their peak CAS.
  }
  /** Call only after Worker 'exit', or if its constructor failed before start. */
  retire(participant: number | null, unexpectedExit: boolean) {
    if (participant === null) return;
    if (!Number.isInteger(participant) || participant < 1 || participant >= AGGREGATE_PARTICIPANTS) { this.gap(); return; }
    const state = Atomics.load(this.words, participantState(participant)); if (state === 0n) return;
    const remaining = Atomics.exchange(this.words, participantBytes(participant), 0n);
    if (remaining) {const before=Atomics.sub(this.words,CURRENT,remaining);if(ownedBytes(before)<remaining)this.gap();}
    // A clean worker has released all producer scopes before it exits. Nonzero
    // residue or an abnormal exit never gains completeness from this cleanup.
    if (state === 2n && (unexpectedExit || remaining !== 0n)) this.gap();
    Atomics.store(this.words, participantState(participant), 0n); Atomics.add(this.words, SEQUENCE, 1n);
  }
  snapshot() {
    const state=Atomics.load(this.words,CURRENT),current=ownedBytes(state);this.raisePeak(current);this.raiseWindowPeak(windowGeneration(state),current);
    // Raising the peak with an actually observed atomic current is evidence,
    // not fabricated equality. A returned current never exceeds its peak.
    if(Atomics.load(this.words,WINDOW_MODE)===3n&&Atomics.load(this.words,WINDOW_END_NS)!==0n&&Atomics.load(this.words,IN_FLIGHT)===0n)Atomics.compareExchange(this.words,WINDOW_MODE,3n,4n);
    const mode=Atomics.load(this.words,WINDOW_MODE),generation=Atomics.load(this.words,WINDOW_GENERATION),windowCurrent=Atomics.load(this.words,CURRENT);
    if(mode===2n&&windowGeneration(windowCurrent)===generation)this.raiseWindowPeak(generation,ownedBytes(windowCurrent));
    const windowPeak=Atomics.load(this.words,WINDOW_PEAK),ended=Atomics.load(this.words,WINDOW_END_NS),started=Atomics.load(this.words,WINDOW_START_NS),
      windowSequence=Atomics.load(this.words,WINDOW_SEQUENCE),endCPU=Atomics.load(this.words,WINDOW_END_CPU),
      coverageStart=Atomics.load(this.words,WINDOW_COVERAGE_START),coverageEnd=Atomics.load(this.words,WINDOW_COVERAGE_END);
    const coherent=windowGeneration(windowPeak)===generation&&mode===Atomics.load(this.words,WINDOW_MODE)&&generation===Atomics.load(this.words,WINDOW_GENERATION)&&
      (mode===4n&&ended!==0n||mode===2n&&ended===0n&&windowGeneration(windowCurrent)===generation);
    const gaps=Atomics.load(this.words,GAPS);
    const intervalCoverageComplete=this.bound&&gaps===0n&&coherent&&mode===4n&&uncoveredActive(coverageStart)===0&&uncoveredActive(coverageEnd)===0&&uncoveredActivations(coverageStart)===uncoveredActivations(coverageEnd);
    const lifecycleWindow=mode===0n?null:{id:`${Atomics.load(this.words,2)}:${Atomics.load(this.words,3).toString(16)}:${generation}`,
      scope:'independent-B0-lifecycle-window' as const,startMonotonicNs:String(started),endMonotonicNs:ended===0n?null:String(ended),boundaryClockSemantics:'post-linearization-monotonic-observations' as const,
      sequence:Number(windowSequence),currentCpuBytes:coherent?Number(ended===0n?ownedBytes(windowCurrent):endCPU):null,peakCpuBytes:coherent?Number(ownedBytes(windowPeak)):null,
      sealed:coherent&&mode===4n,integrityComplete:this.bound&&gaps===0n&&coherent,
      coverage:{contract:COVERAGE_CONTRACT,startActivationCount:uncoveredActivations(coverageStart),startActiveUncoveredOwners:uncoveredActive(coverageStart),
        endActivationCount:ended===0n?null:uncoveredActivations(coverageEnd),endActiveUncoveredOwners:ended===0n?null:uncoveredActive(coverageEnd),complete:intervalCoverageComplete}};
    // Read lifetime peak last: it must cover the finalized lifecycle snapshot,
    // including allocations observed by another worker during these reads.
    const peak=Atomics.load(this.words,PEAK);
    let activeParticipants = 0, reservedParticipants = 0;
    for (let id = 0; id < AGGREGATE_PARTICIPANTS; id++) { const state = Atomics.load(this.words, participantState(id)); if (state === 2n) activeParticipants++; else if (state === 1n) reservedParticipants++; }
    const safe = current >= 0n && current <= BigInt(Number.MAX_SAFE_INTEGER) && peak <= BigInt(Number.MAX_SAFE_INTEGER);
    const coverageState=Atomics.load(this.words,UNCOVERED_STATE);
    return { kind: 'adapter-process-owned-resources-1' as const, shared: this.bound,
      aggregateId: `${Atomics.load(this.words, 2)}:${Atomics.load(this.words, 3).toString(16)}`, pid: process.pid,
      window: 0, peakScope: 'process-lifetime' as const, sequence: Number(Atomics.load(this.words, SEQUENCE)),
      currentCpuBytes: safe ? Number(current) : null, peakCpuBytes: safe ? Number(peak) : null,
      activeParticipants, reservedParticipants, droppedTransitions: Number(gaps),
      integrityComplete: this.bound && safe && gaps === 0n,
      lifecycleWindow,
      coverageWitness:{kind:'uncovered-owner-transitions-1' as const,contract:COVERAGE_CONTRACT,activationCount:uncoveredActivations(coverageState),activeUncoveredOwners:uncoveredActive(coverageState)},
      coverageComplete:intervalCoverageComplete&&safe,
      semantics: 'Atomic simultaneous owned backing bytes plus booked leases across bound realms; uncovered allocations and RSS excluded.' };
  }
}

/** Producer ownership, not a heap profiler. No bytes, paths, IDs or input text are retained.
 * Buffer sizes are observed backing-store sizes. Reservations are booked leases,
 * never a multiplication of a later inventory. Releasing a lease means that the
 * producer relinquished ownership; it makes no assertion about garbage collection.
 */
export class AdapterResourceObserver {
  private context = new AsyncLocalStorage<Scope>();
  private identities = new WeakMap<object, number>();
  private backings = new Map<number, Backing>();
  private groups = new Map<string, Group>();
  private nextBacking = 0;
  private leases = 0;
  private backingBytes = 0;
  private reservedBytes = 0;
  private peakCpuBytes = 0;
  private peakBackingBytes = 0;
  private peakReservedBytes = 0;
  private dropped = 0;
  private unscoped = 0;
  private seq = 0;
  private window = 0;
  private started = performance.now();
  private aggregate = new ProcessOwnedAggregate();
  private aggregateBound = false;
  private returned = new WeakMap<ArrayBufferView, Release>();
  private returnedCount = 0;
  private uncoveredOwners=new Map<string,number>();
  private uncoveredActivations=0;
  private workers=new Map<string,{kind:string;pid:number;threadId:number;parentThreadId:number}>();
  readonly instanceId = randomUUID();

  aggregateBuffer() { return this.aggregate.buffer(); }
  reserveAggregateParticipant() { return this.aggregate.reserveParticipant(); }
  bindAggregate(buffer: SharedArrayBuffer, participant: number | null) {
    if (this.aggregateBound || this.leases !== 0) throw Error('Ownership aggregate must bind once before acquiring leases');
    this.aggregate.bind(buffer, participant, this.dropped + this.unscoped); this.aggregateBound = true;
  }
  retireAggregateParticipant(participant: number | null, unexpectedExit = false) { this.aggregate.retire(participant, unexpectedExit); }
  beginLifecycleWindow(){this.aggregate.beginLifecycleWindow();}
  endLifecycleWindow(){this.aggregate.endLifecycleWindow();}
  private drop() { this.dropped++; this.aggregate.gap(); }
  uncovered(owner:string):Release {
    if(!/^[a-zA-Z0-9:.-]{1,64}$/.test(owner)||(!this.uncoveredOwners.has(owner)&&this.uncoveredOwners.size>=MAX_GROUPS)){this.drop();return NOOP;}
    const releaseAggregate=this.aggregate.uncovered(),releaseHandle=this.handle(owner,'uncovered-owner');
    this.uncoveredOwners.set(owner,(this.uncoveredOwners.get(owner)??0)+1);this.uncoveredActivations++;let done=false;
    return ()=>{if(done)return;done=true;const count=this.uncoveredOwners.get(owner)!-1;if(count===0)this.uncoveredOwners.delete(owner);else this.uncoveredOwners.set(owner,count);releaseHandle();releaseAggregate();};
  }
  returnedBuffer<T extends ArrayBufferView>(owner:string,kind:string,value:T):T {
    if(this.returned.has(value))return value;
    if(this.returnedCount>=MAX_LEASES){this.drop();return value;}
    const release=this.buffer(owner,kind,value);this.returnedCount++;
    this.returned.set(value,()=>{this.returnedCount--;release();});return value;
  }
  releaseReturned(value:ArrayBufferView){const release=this.returned.get(value);if(!release)return false;this.returned.delete(value);release();return true;}
  worker(kind:string,id:number):Release{
    if(!Number.isSafeInteger(id)||id<1||!['writer','raster','text-font','text-verification'].includes(kind)||this.workers.size>=128){this.drop();return NOOP;}
    const key=kind+':'+id;if(this.workers.has(key)){this.drop();return NOOP;}
    this.workers.set(key,{kind,pid:process.pid,threadId:id,parentThreadId:threadId});const release=this.handle('owned-worker',kind);let done=false;
    return ()=>{if(!done){done=true;this.workers.delete(key);release();}};
  }

  private group(owner: string, kind: string): Group | undefined {
    // Call sites supply fixed categories, never arbitrary request identities.
    if (!/^[a-zA-Z0-9:.-]{1,64}$/.test(owner) || !/^[a-zA-Z0-9:.-]{1,64}$/.test(kind)) { this.drop(); return; }
    const key = owner + '/' + kind;
    const existing = this.groups.get(key); if (existing) return existing;
    if (this.groups.size >= MAX_GROUPS) { this.drop(); return; }
    const group = { owner, kind, buffers: 0, handles: 0, reservedBytes: 0 }; this.groups.set(key, group); return group;
  }
  private changed() {
    this.seq++;
    this.peakCpuBytes = Math.max(this.peakCpuBytes, this.backingBytes + this.reservedBytes);
    this.peakBackingBytes = Math.max(this.peakBackingBytes, this.backingBytes);
    this.peakReservedBytes = Math.max(this.peakReservedBytes, this.reservedBytes);
    this.aggregate.update(this.backingBytes + this.reservedBytes);
  }
  private admit(owner: string, kind: string): Group | undefined {
    if (this.leases >= MAX_LEASES) { this.drop(); return; }
    const group = this.group(owner, kind); if (group) this.leases++; return group;
  }
  buffer(owner: string, kind: string, value: ArrayBufferView): Release {
    // Shared payload stores require cross-realm identity tracking. The observer's
    // own counter SAB is never a payload. Do not double-count an unknown shared
    // payload as independent worker copies or grant complete coverage for it.
    if (value.buffer instanceof SharedArrayBuffer) { this.drop(); return NOOP; }
    const group = this.admit(owner, kind); if (!group) return NOOP;
    let id = this.identities.get(value.buffer);
    if (id === undefined) { id = ++this.nextBacking; this.identities.set(value.buffer, id); }
    const backing = this.backings.get(id);
    if (backing) backing.owners++;
    else { this.backings.set(id, { bytes: value.buffer.byteLength, owners: 1 }); this.backingBytes += value.buffer.byteLength; }
    group.buffers++; this.changed(); let released = false;
    // The closure captures an integer identity, never value or its ArrayBuffer.
    return () => { if (released) return; released = true; this.leases--; group.buffers--;
      const held = this.backings.get(id!); if (held && --held.owners === 0) { this.backingBytes -= held.bytes; this.backings.delete(id!); } this.changed(); };
  }
  handle(owner: string, kind: string): Release {
    const group = this.admit(owner, kind); if (!group) return NOOP;
    group.handles++; this.changed(); let released = false;
    return () => { if (!released) { released = true; this.leases--; group.handles--; this.changed(); } };
  }
  reservation(owner: string, kind: string, bytes: number): Release {
    if (!Number.isSafeInteger(bytes) || bytes < 0) { this.drop(); return NOOP; }
    const group = this.admit(owner, kind); if (!group) return NOOP;
    group.reservedBytes += bytes; this.reservedBytes += bytes; this.changed(); let released = false;
    return () => { if (!released) { released = true; this.leases--; group.reservedBytes -= bytes; this.reservedBytes -= bytes; this.changed(); } };
  }
  /** Returned read buffers are held until the receiving producer scope completes.
   * This deliberately conservative lifetime includes parse and postMessage use.
   * Unknown callers remain disclosed, rather than inventing a release instant.
   */
  retain<T extends ArrayBufferView>(owner: string, kind: string, value: T): T {
    const scope = this.context.getStore();
    if (!scope || scope.closed) { this.unscoped++; this.aggregate.gap(); return value; }
    if (scope.releases.length >= MAX_LEASES) { this.drop(); return value; }
    scope.releases.push(this.buffer(owner, kind, value)); return value;
  }
  async scope<T>(owner: string, run: () => Promise<T> | T): Promise<T> {
    const scope: Scope = { owner, releases: [], closed: false }, done = this.handle(owner, 'scope');
    return this.context.run(scope, async () => { try { return await run(); }
      finally { scope.closed = true; for (let i = scope.releases.length - 1; i >= 0; i--) scope.releases[i](); done(); } });
  }
  resetPeaks() {
    this.window++; this.started = performance.now(); this.peakCpuBytes = this.backingBytes + this.reservedBytes;
    this.peakBackingBytes = this.backingBytes; this.peakReservedBytes = this.reservedBytes; this.changed();
    // Shared peaks and gaps are process-lifetime evidence and are never reset.
  }
  snapshot() {
    return { kind: 'adapter-owned-resources-1' as const, instanceId: this.instanceId, pid: process.pid, parentPid:process.ppid, threadId, isMainThread,
      sequence: this.seq, window: this.window, startedAt: this.started, observedAt: performance.now(),
      cpuBytes: this.backingBytes + this.reservedBytes, peakCpuBytes: this.peakCpuBytes,
      backingBytes: this.backingBytes, peakBackingBytes: this.peakBackingBytes,
      reservedBytes: this.reservedBytes, peakReservedBytes: this.peakReservedBytes,
      backingStores: this.backings.size, activeLeases: this.leases,returnedBuffers:this.returnedCount,
      groups: [...this.groups.values()].map(group => ({ ...group })),
      droppedTransitions: this.dropped, unscopedReturnedBuffers: this.unscoped,
      aggregate: this.aggregate.snapshot(),
      ownedWorkerThreads:[...this.workers.values()].map(worker=>({...worker})),
      uncoveredOwners:[...this.uncoveredOwners].map(([owner,count])=>({owner,count})),uncoveredActivations:this.uncoveredActivations,
      coverage: { complete: false, observedBackingStores: true, bookedReservations: true,
        physicalHeap: false, nativeHashBytes: false, nativeIPCCopies: false, uninstrumentedProducers: false },
      semantics: 'Unique observed backing stores plus booked conservative leases; producer ownership, not RSS, V8 heap size or physical GC.' };
  }
}

// Modules are isolated per worker realm; main and writer observations remain separate.
export const adapterResources = new AdapterResourceObserver();
export type AdapterResourceSnapshot = ReturnType<AdapterResourceObserver['snapshot']>;
