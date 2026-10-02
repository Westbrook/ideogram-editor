// WJ/WC operation-input continuity. This does not grant a WQ global-inventory
// reset, a decoded-cache hit, OS page-cache state, or a physical measurement.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';

const SHA = /^sha256:[a-f0-9]{64}$/, DEC = /^(0|[1-9][0-9]*)$/;
export const WARM_PROOF_LIMIT = 1024 * 1024;
const equal = (a,b,message) => assert(isDeepStrictEqual(a,b),message);
export const warmDigest = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
export const warmCell = cell => ({id:cell.id ?? null,operation:cell.operation ?? null,workload:cell.workload ?? null,parameters:cell.parameters ?? {}});
export function warmFamily(cell) {
  if (['caption.case','caption.raw-ingest','native.boundary'].includes(cell?.operation)) return 'WJ';
  if (['portable.copy','portable.import'].includes(cell?.operation)&&!cell.parameters?.fault&&!cell.parameters?.scenario) return 'WC';
  return null;
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
function validIdentity(value) {return value && SHA.test(value.sha256) && DEC.test(String(value.byteLength)) && Number.isSafeInteger(Number(value.byteLength));}
const inventoryKeys=['commands','events_v2','assets','roots','queue_jobs','portable_bundles','portable_reviews','portable_namespaces','staged_assets','rootedBytes'].sort();
function inventory(value){assert(value && isDeepStrictEqual(Object.keys(value).sort(),inventoryKeys) && Object.entries(value).every(([key,item])=>key==='rootedBytes'?typeof item==='string'&&DEC.test(item):integer(item)),'Warm retained inventory is incomplete');}
function inputs(value){assert(validIdentity(value)&&integer(value.count),'Warm immutable-input observation is incomplete');}
function selectedInput(cell,fixture){
  if(warmFamily(cell)==='WC'){const ref=fixture?.portableSeal??fixture?.seal;assert(ref&&typeof ref.sha256==='string','WC selected seal unavailable');return {sha256:ref.sha256.startsWith('sha256:')?ref.sha256:'sha256:'+ref.sha256};}
  const id=cell.operation==='caption.raw-ingest'?(cell.parameters?.bytes===16777216?'RAW16M':cell.parameters?.bytes===16777217?'RAW16M_PLUS1':null):cell.parameters?.caseId??(/(?:^|[-/:])(WJ\d\d)(?:$|[-/:])/.exec(cell.id??'')?.[1]);
  const matches=fixture?.corpus?.files?.filter(entry=>entry.id===id);assert(matches?.length===1,'WJ selected corpus identity unavailable or ambiguous');
  const ref=matches[0];return {sha256:ref.sha256.startsWith('sha256:')?ref.sha256:'sha256:'+ref.sha256,byteLength:String(ref.byteLength)};
}

/** Scalar diagnostics of retained global results. None of these values is
 * subtracted from a fixed WQ workload or mistaken for a fresh store. */
export function warmInventory(root) {
  const db = new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
  try {
    const tables = ['commands','events_v2','assets','roots','queue_jobs','portable_bundles','portable_reviews','portable_namespaces','staged_assets'];
    const counts = Object.fromEntries(tables.map(table => [table,Number(db.prepare('SELECT count(*) n FROM '+table).get().n)]));
    let rootedBytes = 0n;
    for(const row of db.prepare('SELECT DISTINCT o.hash,o.byte_length FROM objects o JOIN roots r ON r.hash=o.hash').iterate()) rootedBytes += BigInt(row.byte_length);
    return {...counts,rootedBytes:String(rootedBytes)};
  } finally {db.close();}
}

/** Full immutable-object readback, one reusable bounded scratch per file. A
 * header/ref equality is not a substitute for these original bytes. */
export async function observeWarmObject(root, ref, signal) {
  assert(SHA.test(ref?.hash) && DEC.test(ref.byteLength) && Number.isSafeInteger(Number(ref.byteLength)),'Invalid warm input reference');
  const hash=ref.hash.slice(7), file=await open(join(root,'objects/sha256',hash.slice(0,2),hash),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const before=await file.stat(), expected=Number(ref.byteLength);
    assert(before.isFile() && before.size===expected,'Warm input length changed');
    const scratch=Buffer.alloc(Math.min(1048576,expected+1)), digest=createHash('sha256');let bytes=0;
    for(;;){signal?.throwIfAborted();const read=await file.read(scratch,0,scratch.length,bytes);if(!read.bytesRead)break;bytes+=read.bytesRead;assert(bytes<=expected,'Warm input grew');digest.update(scratch.subarray(0,read.bytesRead));}
    const after=await file.stat();assert(['dev','ino','size','mtimeMs','ctimeMs'].every(key=>before[key]===after[key]),'Warm input changed while reading');
    const actual={sha256:'sha256:'+digest.digest('hex'),byteLength:String(bytes)};
    equal(actual,{sha256:ref.hash,byteLength:ref.byteLength},'Warm input bytes changed');return actual;
  } finally {await file.close();}
}

export async function captureWarmInputRefs(writer, documentId) {
  const refs=new Map();let cursor='';const seen=new Set();
  do {
    assert(!seen.has(cursor),'Warm input closure cursor repeated');seen.add(cursor);
    const page=await writer.historyClosure(documentId,cursor);
    assert(Array.isArray(page.items),'Warm input closure page unavailable');
    for(const ref of page.items){assert(SHA.test(ref.hash)&&DEC.test(ref.byteLength)&&typeof ref.mediaType==='string','Invalid initial input closure');const key=ref.hash+'\0'+ref.mediaType,old=refs.get(key);if(old)equal(old,ref,'Conflicting immutable input reference');else refs.set(key,ref);assert(refs.size<=131072,'Warm input closure exceeds finite observation bound');}
    cursor=page.next;
  } while(cursor);
  return [...refs.values()].sort((a,b)=>a.hash.localeCompare(b.hash)||a.mediaType.localeCompare(b.mediaType));
}
export async function observeWarmInputs(root,refs,signal) {
  const digest=createHash('sha256');let bytes=0n;
  for(const ref of refs){const actual=await observeWarmObject(root,ref,signal);digest.update(JSON.stringify([ref.hash,ref.byteLength,ref.mediaType,actual])+'\n');bytes+=BigInt(actual.byteLength);}
  return {count:refs.length,byteLength:String(bytes),sha256:'sha256:'+digest.digest('hex')};
}

/** The closure holds the real writer capability. Tokens merely bind retained
 * observations; arbitrary JSON never creates or replaces this live owner. */
export function createWarmOwner(writer, root, descriptor=null) {
  assert(writer && typeof writer==='object' && writer.available===true,'Warm writer is unavailable');
  const epoch=writer.epoch, fixedDescriptor=descriptor?structuredClone(descriptor):null, ownerId=randomUUID();
  return candidate => {
    assert(candidate===writer && writer.available===true && writer.epoch===epoch,'Warm operation replaced or lost its writer owner');
    if(descriptor)equal(descriptor,fixedDescriptor,'Warm worker descriptor changed');
    return {ownerId,root,pid:process.pid,epoch,descriptor:fixedDescriptor};
  };
}

function snapshot(value) {
  assert(value && SHA.test(value.imageHash) && (value.historyHead===null||typeof value.historyHead==='string') && DEC.test(String(value.revision)),'Warm document observation is invalid');
  assert(integer(value.activeJobs),'Warm active-job count is unavailable');
  inventory(value.inventory);inputs(value.inputs);
}
export function inspectWarmProof(packet,{cell,sample,previous=null,reset,operation,fixture}) {
  assert(packet?.kind==='backend-warm-input-proof-1' && ['WJ','WC'].includes(packet.family),'Warm input proof kind is invalid');
  equal(packet.cell,warmCell(cell),'Warm cell identity changed');
  if(warmFamily(cell))equal(packet.family,warmFamily(cell),'Warm family changed');
  equal(packet.sample,{cache:sample.cache,ordinal:sample.ordinal??null,prime:sample.prime??null},'Warm sample schedule changed');
  assert(integer(packet.serial)&&packet.serial>=1,'Warm sample serial is invalid');
  assert(packet.owner && typeof packet.owner.ownerId==='string' && packet.owner.ownerId.length>=16 && typeof packet.owner.root==='string' && Number.isSafeInteger(packet.owner.pid) && packet.owner.pid>0 && typeof packet.owner.epoch==='string','Warm owner is invalid');
  const initialPortable=packet.family==='WC'&&packet.serial===1&&previous===null&&reset?.kind==='unopened-first-operation';
  if(!initialPortable){equal(packet.owner,reset.owner,'Warm reset and operation owners differ');
    equal(packet.before,reset.after,'Warm operation did not start from its observed reset');
    equal(packet.baseline,reset.baseline,'Warm reset baseline changed');equal(packet.input,reset.input,'Warm reset input changed');}
  assert(validIdentity(packet.input),'Exact warm input identity is unavailable');
  const selected=selectedInput(cell,fixture);assert(packet.input.sha256===selected.sha256 && (selected.byteLength===undefined||packet.input.byteLength===selected.byteLength),'Warm input differs from independently selected fixture');
  assert(packet.cache.kind==='retained-writer-connection-and-module-loader-1' && packet.cache.decodedResultCache==='not-used-by-selected-operation' && packet.cache.derivedResultCache==='per-operation-or-not-used' && packet.cache.operatingSystemPageCache==='unobserved','Warm cache scope is unsupported');
  if(previous){
    assert(packet.serial===previous.serial+1 && packet.previous===warmDigest(previous),'Warm preceding proof is missing, reordered or changed');
    equal(packet.owner,previous.owner,'Warm writer owner/root changed between samples');equal(packet.input,previous.input,'Warm source input changed between samples');equal(packet.baseline,previous.baseline,'Warm baseline changed between samples');
    equal(reset.before,previous.after,'Reset does not follow the preceding operation');
  }else assert(packet.serial===1 && packet.previous===null,'Warm cohort starts with borrowed history');
  if(packet.family==='WJ'){
    snapshot(packet.before);snapshot(packet.after);snapshot(packet.baseline);
    equal(packet.before.imageHash,packet.baseline.imageHash,'WJ baseline image/native state changed');equal(packet.before.historyHead,packet.baseline.historyHead,'WJ baseline history head changed');
    equal(packet.before.inputs,packet.baseline.inputs,'WJ original immutable input bytes changed');equal(packet.after.inputs,packet.baseline.inputs,'WJ operation changed immutable baseline inputs');
    assert(packet.before.activeJobs===packet.baseline.activeJobs && packet.after.activeJobs===packet.baseline.activeJobs,'WJ left an active job across samples');
    assert(operation?.observations?.sealedCorpus===true,'WJ input corpus was not sealed');
    equal(packet.input.sha256,operation.observations.originalHash??operation.observations.corpusHash,'WJ consumed corpus hash changed');
    equal(String(packet.input.byteLength),String(operation.observations.originalBytes??operation.observations.corpusBytes),'WJ consumed corpus length changed');
    if(reset.before && reset.before.historyHead!==packet.baseline.historyHead){assert(reset.undo?.receipt?.status==='accepted' && reset.undo.action==='Undo'&&typeof reset.undo.commandId==='string'&&reset.undo.receipt.commandId===reset.undo.commandId,'WJ reset did not accept public Undo');equal(reset.undo.previousHead,reset.before.historyHead,'WJ Undo reset the wrong history head');}
  }else{
    assert(SHA.test(packet.baseline?.closureIdentity)&&SHA.test(packet.baseline.sourceHash),'WC baseline closure identity is incomplete');
    for(const observed of [packet.before,packet.after]){assert(observed&&SHA.test(observed.sourceHash)&&integer(observed.importedDocuments),'WC source observation is invalid');inventory(observed.inventory);}
    const stress=String(cell.parameters?.closureBytes)==='4294967296'||cell.workload==='WC4G'||/4g|4GiB|stress/.test(cell.workload??'');
    const expected={events:stress?100000:10000,assets:stress?10000:1000,closureBytes:stress?'4294967296':'536870912'};
    for(const [key,value] of Object.entries(expected))equal(packet.baseline.counts?.[key],value,'WC baseline workload differs from selected cell');
    assert(integer(packet.baseline.counts.captionVersions)&&packet.baseline.counts.captionVersions>0&&(!stress||packet.baseline.counts.captionVersions===4096),'WC caption history is incomplete');
    const closure=operation?.evidence?.find(item=>item.kind==='portable-operation')?.closure;
    assert(closure && closure.fullHashesVerified===true && closure.semanticClosureVerified===true && closure.typedFeaturesVerified===true,'WC full closure verification is incomplete');
    equal(closure.inputIdentity,packet.baseline.closureIdentity,'WC output ancestry or immutable byte closure changed');
    equal(packet.before.sourceHash,packet.baseline.sourceHash,'WC source document changed');equal(packet.after.sourceHash,packet.baseline.sourceHash,'WC operation changed its source document');
    assert(packet.before.importedDocuments===0 && (initialPortable||reset.cleanupPending===0),'WC import reset is incomplete');
    if(cell.operation==='portable.import')assert(closure.ownedClosureHashesVerified===true && packet.after.importedDocuments===1,'WC import lacks owned closure proof');
    equal({events:closure.events,assets:closure.assets,closureBytes:closure.closureBytes,captionVersions:closure.captionVersions},packet.baseline.counts,'WC fixed closure counts changed');
  }
  const effects=packet.family==='WC'?packet.networkEffects:operation?.observations?.guardedNetworkEffects;equal(effects&&Object.keys(effects).sort(),['submit','upload','poll','cancel','fetch','socket','dns','datagram'].sort(),'Warm network-effect inventory is incomplete');assert(Object.values(effects).every(value=>value===0),'Warm network effects occurred');
  return {complete:true,family:packet.family,serial:packet.serial,cache:packet.cache,retainedGrowth:{before:packet.before.inventory,after:packet.after.inventory}};
}

export async function retainWarmProof(output,packet,options) {
  const verdict=inspectWarmProof(packet,options),bytes=Buffer.from(JSON.stringify(packet,null,2)+'\n');
  assert(bytes.length<=WARM_PROOF_LIMIT,'Warm proof exceeds its fixed evidence bound');
  const path=join(output,'backend-warm-'+randomUUID()+'.json');await writeFile(path,bytes,{flag:'wx',mode:0o600});
  return {kind:packet.kind,artifact:{path,bytes:bytes.length,sha256:warmDigest(bytes)},verdict};
}

/** Replay each actual attempt, including unscored primes, from sealed bytes.
 * The caller has already verified the journal against the declared schedule. */
export async function verifyWarmAttempt({cell,attempt,previous,workerProcessIdentity,readRetained,fixture}) {
  if(!warmFamily(cell))return null;
  const ref=attempt.result?.warmInput?.artifact;
  if(!ref){if(attempt.status==='PASS')throw Error('Passing WJ/WC attempt lacks complete warm input proof');return null;}
  assert(Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=WARM_PROOF_LIMIT&&SHA.test(ref.sha256),'Invalid warm proof artifact');
  const bytes=await readRetained(ref.path,{maximum:WARM_PROOF_LIMIT});assert(bytes.length===ref.bytes&&warmDigest(bytes)===ref.sha256,'Warm proof artifact changed');
  const packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  assert(packet.owner.pid===workerProcessIdentity.pid,'Warm proof belongs to another worker process');
  inspectWarmProof(packet,{cell,sample:attempt,previous,reset:attempt.reset?.warmReset,operation:attempt.result,fixture});
  return packet;
}
