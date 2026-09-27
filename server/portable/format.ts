import {UnsupportedText,portableTextSupport} from '../text/validation.js';
import { defineTransactions, addTransaction, validateTransactions, validateLegacySurvivors } from './transactions.js';
import { providerRecord } from './provenance.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, readSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobRef } from '../../src/protocol/store.js';
import type { PortableManifest, PortableSegment, PortableRoot } from '../../src/protocol/portable.js';
import { canonical, hashBytes, isId, isSeq, validateBlob } from '../storage/canonical.js';
import { parseControlJSON } from '../../src/protocol/json.js';
import { keys, requireValue as ok, entity, event } from '../../src/protocol/validate.js';
import { privateFile } from '../storage/files.js';
import { ZipIndex, crc32, write, tick, invalid, type ZipSource } from './zip.js';
export const SEGMENT_BYTES=128*1024*1024;
export const RECORD_BYTES=16384;
export function json(bytes:Uint8Array):any {const v=parseControlJSON(bytes);if(canonical(v)!==Buffer.from(bytes).toString('utf8'))invalid();return v;}
export function defineIndex(db:DatabaseSync){db.exec(`CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,record_hash TEXT,PRIMARY KEY(kind,id)) STRICT;
 CREATE TABLE events(seq TEXT PRIMARY KEY,tx TEXT NOT NULL,json TEXT NOT NULL) STRICT;
 CREATE TABLE refs(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL,media TEXT NOT NULL,crc INTEGER,stamp TEXT) STRICT;
 CREATE TABLE assets_queue(id TEXT PRIMARY KEY,done INTEGER NOT NULL DEFAULT 0) STRICT;
 CREATE TABLE payloads(hash TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
 CREATE TABLE segments(path TEXT PRIMARY KEY,sha256 TEXT NOT NULL,bytes TEXT NOT NULL,kind TEXT NOT NULL,count TEXT NOT NULL,level INTEGER NOT NULL) STRICT;
 CREATE TABLE records(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL) STRICT;`);defineTransactions(db);}
export function addRef(db:DatabaseSync,r:BlobRef){validateBlob(r);const old=db.prepare('SELECT * FROM refs WHERE hash=?').get(r.hash);if(old&&String(old.bytes)!==r.byteLength)invalid();db.prepare('INSERT OR IGNORE INTO refs(hash,bytes,media) VALUES (?,?,?)').run(r.hash,r.byteLength,r.mediaType);}
export function references(v:unknown,emit:(r:BlobRef)=>void){if(!v||typeof v!=='object')return;if(!Array.isArray(v)&&Object.keys(v).sort().join(',')==='byteLength,hash,mediaType'){validateBlob(v);emit(v);return;}for(const child of Object.values(v))references(child,emit);}
export function descriptor(r:any):PortableSegment{return {path:String(r.path),sha256:String(r.sha256),bytes:String(r.bytes),kind:r.kind,recordCount:String(r.count)};}
export async function fileSource(name:string,path:string,check:()=>void):Promise<ZipSource>{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),h=createHash('sha256'),b=Buffer.alloc(1048576);let size=0n,crc=0xffffffff;
 try{for(;;){check();const n=readSync(fd,b);if(!n)break;h.update(b.subarray(0,n));crc=crc32(b.subarray(0,n),crc);size+=BigInt(n);await tick();}}finally{closeSync(fd);}
 return {name,bytes:size,crc:(crc^0xffffffff)>>>0,sha256:h.digest('hex'),chunks:async function*(){const f=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),b=Buffer.alloc(1048576);try{for(;;){check();const n=readSync(f,b);if(!n)break;yield b.subarray(0,n);}}finally{closeSync(f);}}};
}
export async function encodeRecords(db:DatabaseSync,directory:string,sourceNamespace:string,highWater:string,check:()=>void,segmentBytes=SEGMENT_BYTES){
 if(segmentBytes<32768||segmentBytes>SEGMENT_BYTES)invalid();await validateTransactions(db,highWater,check);let number=0;
 const make=async(kind:'records'|'events'|'index',rows:AsyncIterable<unknown>,level:number)=>{
  let fd=-1,path='',count=0n,bytes=0;
  const end=async()=>{if(fd<0)return;fsyncSync(fd);closeSync(fd);fd=-1;const s=await fileSource(path,join(directory,path.replace('/','-')),check);db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?)').run(path,s.sha256,String(s.bytes),kind,String(count),level);};
  for await(const row of rows){check();const b=Buffer.from(canonical(row)+'\n');if(b.length>RECORD_BYTES+256||(row as any).kind!=='event'&&b.length>RECORD_BYTES+1)invalid();if(fd<0||bytes+b.length>segmentBytes){await end();path=`records/${number++}.jsonl`;fd=privateFile(join(directory,path.replace('/','-')));count=0n;bytes=0;}
   write(fd,b);count++;bytes+=b.length;await tick();
  }await end();
 };
 await make('records',(async function*(){
  for(const r of db.prepare('SELECT json FROM transactions ORDER BY archive,length(first_seq),first_seq').iterate())yield JSON.parse(String(r.json));
  for(const r of db.prepare('SELECT * FROM entities ORDER BY kind,id').iterate()){
   const payload=String(r.json),ref={hash:hashBytes(payload),byteLength:String(Buffer.byteLength(payload)),mediaType:'application/json'};addRef(db,ref);db.prepare('INSERT OR IGNORE INTO payloads VALUES (?,?)').run(ref.hash,payload);
   const record={schemaVersion:1,kind:'entity',entityType:String(r.kind),logicalId:String(r.id),payloadVersion:1,payloadRef:ref,dependencies:[]};const hash=hashBytes(canonical(record));db.prepare('UPDATE entities SET record_hash=? WHERE kind=? AND id=?').run(hash,r.kind,r.id);yield record;
  }
  for(const r of db.prepare('SELECT * FROM refs ORDER BY hash').iterate())yield {schemaVersion:1,kind:'object',sha256:String(r.hash).slice(7),bytes:String(r.bytes),mediaType:String(r.media),path:'objects/'+String(r.hash).slice(7)};
 })(),0);
 await make('events',(async function*(){for(const r of db.prepare('SELECT json FROM events ORDER BY length(seq),seq').iterate())yield {schemaVersion:1,kind:'event',event:JSON.parse(String(r.json))};})(),0);
 // Fanout stays bounded at 16 descriptors. Index levels are persisted, not resident.
 let level=0;while(Number(db.prepare('SELECT count(*) AS n FROM segments WHERE level=?').get(level)!.n)>16){
  await make('index',(async function*(){let group:PortableSegment[]=[];for(const r of db.prepare('SELECT * FROM segments WHERE level=? ORDER BY path').iterate(level)){group.push(descriptor(r));if(group.length===16){yield {schemaVersion:1,kind:'index',segments:group};group=[];}}if(group.length)yield {schemaVersion:1,kind:'index',segments:group};})(),level+1);level++;
 }
 const doc=db.prepare("SELECT id,record_hash FROM entities WHERE kind='document'").get();if(!doc)invalid();
 const manifest:PortableManifest={formatVersion:7,documentSchema:7,sourceNamespace,capturedHighWater:highWater,complete:true,rootRefs:[{kind:'document',logicalId:String(doc!.id),recordHash:String(doc!.record_hash)}],segments:db.prepare('SELECT * FROM segments WHERE level=? ORDER BY path').all(level).map(descriptor)};
 const fd=privateFile(join(directory,'manifest.json'));try{write(fd,Buffer.from(canonical(manifest)));fsyncSync(fd);}finally{closeSync(fd);}return manifest;
}
function segment(s:any){keys(s,['path','sha256','bytes','kind','recordCount']);ok(/^records\/(0|[1-9][0-9]*)\.jsonl$/.test(s.path)&&/^[a-f0-9]{64}$/.test(s.sha256)&&isSeq(s.bytes)&&BigInt(s.bytes)<=BigInt(SEGMENT_BYTES)&&['index','events','records'].includes(s.kind)&&isSeq(s.recordCount));}
async function* lines(zip:ZipIndex,name:string,check:()=>void){let pending=Buffer.alloc(0);for await(const b of zip.chunks(zip.entry(name),check)){let start=0;for(let at=0;at<b.length;at++)if(b[at]===10){const part=b.subarray(start,at);if(pending.length+part.length>RECORD_BYTES+255)invalid();const line=Buffer.concat([pending,part]);pending=Buffer.alloc(0);start=at+1;const value=json(line);if(value.kind!=='event'&&line.length>RECORD_BYTES)invalid();yield value;}pending=Buffer.concat([pending,b.subarray(start)]);if(pending.length>RECORD_BYTES+255)invalid();}if(pending.length)invalid();}
// Canonical root arrays are streamed independently. Each item is a small typed
// descriptor; total index size is never a JS array or a project admission cap.
async function root(zip:ZipIndex,db:DatabaseSync,check:()=>void):Promise<any>{
 const entry=zip.entry('manifest.json');if(entry.bytes>BigInt(SEGMENT_BYTES))invalid();const iterator=zip.chunks(entry,check)[Symbol.asyncIterator]();let block=Buffer.alloc(0),at=0;
 const peek=async()=>{if(at===block.length){const n=await iterator.next();if(n.done)return -1;block=Buffer.from(n.value);at=0;}return block[at];};
 const take=async()=>{const n=await peek();at++;return n;};
 const expect=async(n:number)=>{if(await take()!==n)invalid();};
 const value=async()=>{const bytes:number[]=[];let depth=0,string=false,escape=false;for(;;){const c=await peek();if(c<0)break;if(!string&&depth===0&&[44,93,125].includes(c))break;await take();bytes.push(c);if(bytes.length>65536)invalid();if(string){if(escape)escape=false;else if(c===92)escape=true;else if(c===34)string=false;}else if(c===34)string=true;else if(c===123||c===91)depth++;else if(c===125||c===93)depth--;}
  const raw=Buffer.from(bytes);let v:any;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{invalid();}if(canonical(v)!==raw.toString('utf8'))invalid();if(v&&typeof v==='object'&&!Array.isArray(v))json(raw);return v;
 };
 const scalar:any={};const seen=new Set<string>();await expect(123);let first=true,last='';for(;;){if(await peek()===125){await take();break;}if(!first)await expect(44);first=false;
  await expect(34);let name='';for(;;){const b=await take();if(b===34)break;if(!/[A-Za-z]/.test(String.fromCharCode(b))||b<0||name.length>32)invalid();name+=String.fromCharCode(b);}if(name<=last||seen.has(name))invalid();seen.add(name);last=name;await expect(58);
  if(name==='segments'||name==='rootRefs'){await expect(91);let initial=true;for(;;){if(await peek()===93){await take();break;}if(!initial)await expect(44);initial=false;const v=await value();if(name==='segments'){segment(v);db.prepare('INSERT INTO segment_queue VALUES (?,0,?)').run(v.path,canonical(v));}else{keys(v,['kind','logicalId','recordHash']);ok(isId(v.kind)&&isId(v.logicalId)&&/^sha256:[a-f0-9]{64}$/.test(v.recordHash));db.prepare('INSERT INTO portable_roots VALUES (?,?,?)').run(v.kind,v.logicalId,v.recordHash);}}}
  else scalar[name]=await value();
 }if(await peek()!==-1||['capturedHighWater','complete','documentSchema','formatVersion','rootRefs','segments','sourceNamespace'].some(k=>!seen.has(k))||[1,2,3,4,5,6,7].includes(scalar.formatVersion)&&seen.size!==7)invalid();return scalar;
}
export async function decodeRecords(zip:ZipIndex,db:DatabaseSync,check:()=>void){
 defineIndex(db);db.exec('CREATE TABLE segment_queue(path TEXT PRIMARY KEY,state INTEGER NOT NULL,json TEXT NOT NULL) STRICT; CREATE TABLE portable_roots(kind TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT; CREATE TABLE segment_edges(parent TEXT NOT NULL,child TEXT NOT NULL,PRIMARY KEY(parent,child)) STRICT; CREATE TABLE dependency_edges(owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL) STRICT;');
 const manifest=await root(zip,db,check);if(!Number.isSafeInteger(manifest.formatVersion)||!Number.isSafeInteger(manifest.documentSchema)||!isId(manifest.sourceNamespace)||!isSeq(manifest.capturedHighWater)||typeof manifest.complete!=='boolean')invalid();
 if(![1,2,3,4,5,6,7].includes(manifest.formatVersion)||manifest.documentSchema!==(manifest.formatVersion>=3?manifest.formatVersion:2))return {...manifest,unsupported:'UNSUPPORTED_FORMAT_VERSION'};
 for(;;){check();const q=db.prepare('SELECT * FROM segment_queue WHERE state=0 ORDER BY path LIMIT 1').get();if(!q)break;const s=JSON.parse(String(q.json)),e=zip.entry(s.path);if(e.bytes!==BigInt(s.bytes)||e.sha256!==s.sha256)invalid();let count=0n;
  for await(const r of lines(zip,s.path,check)){count++;if(r.schemaVersion!==1)return {...manifest,unsupported:'UNSUPPORTED_RECORD_VERSION'};
   if(r.kind==='index'){keys(r,['schemaVersion','kind','segments']);if(s.kind!=='index'||!Array.isArray(r.segments))invalid();for(const child of r.segments){segment(child);const known=db.prepare('SELECT json FROM segment_queue WHERE path=?').get(child.path);if(known&&known.json!==canonical(child))invalid();if(!known)db.prepare('INSERT INTO segment_queue VALUES (?,0,?)').run(child.path,canonical(child));db.prepare('INSERT OR IGNORE INTO segment_edges VALUES (?,?)').run(s.path,child.path);}}
   else if(r.kind==='event'){keys(r,['schemaVersion','kind','event']);if(s.kind!=='events')invalid();if(r.event?.schemaVersion!==1||r.event?.payloadVersion!==1)return {...manifest,unsupported:'UNSUPPORTED_EVENT_VERSION'};if(!['DocumentCreated','CheckpointSaved','AssetRegistered','ImageEdited','HistoryNavigated','ImageEditPreviewPrepared','ImageEditReviewPrepared','BundleImported','BundlePrepared','BundleImportReviewed','PortableCancelled','StagingTransferReviewPrepared','RasterReviewPrepared','StagingOwnershipTransferred'].includes(r.event.type))return {...manifest,unsupported:'UNSUPPORTED_EVENT_KIND'};try{portableTextSupport(r.event);}catch(e){if(!(e instanceof UnsupportedText))throw e;return {...manifest,unsupported:e.message};}event(r.event);if(BigInt(r.event.workspaceSeq)>BigInt(manifest.capturedHighWater))invalid();try{db.prepare('INSERT INTO events VALUES (?,?,?)').run(r.event.workspaceSeq,r.event.transactionId,canonical(r.event));}catch{invalid();}}
   else if(r.kind==='transaction'){if(![2,3,4,5,6,7].includes(manifest.formatVersion)||s.kind!=='records')invalid();addTransaction(db,r);}
   else if(r.kind==='object'){keys(r,['schemaVersion','kind','sha256','bytes','mediaType','path']);if(s.kind!=='records'||!isSeq(r.bytes)||r.path!=='objects/'+r.sha256||!/^[0-9a-f]{64}$/.test(r.sha256))invalid();const e=zip.entry(r.path);if(e.bytes!==BigInt(r.bytes)||e.sha256!==r.sha256)invalid();if(db.prepare('SELECT 1 FROM refs WHERE hash=?').get('sha256:'+r.sha256))invalid();addRef(db,{hash:'sha256:'+r.sha256,byteLength:r.bytes,mediaType:r.mediaType});}
   else if(r.kind==='entity'){keys(r,['schemaVersion','kind','logicalId','entityType','payloadVersion','payloadRef','dependencies']);if(s.kind!=='records'||!isId(r.logicalId)||typeof r.entityType!=='string'||!Number.isSafeInteger(r.payloadVersion)||!Array.isArray(r.dependencies))invalid();validateBlob(r.payloadRef);if(r.payloadRef.mediaType!=='application/json')invalid();
    const hash=hashBytes(canonical(r));try{db.prepare('INSERT INTO records VALUES (?,?,?,?)').run(hash,r.entityType,r.logicalId,canonical(r));}catch{invalid();}
    for(const d of r.dependencies){keys(d,['kind','logicalId','recordHash']);db.prepare('INSERT INTO dependency_edges VALUES (?,?,?,?)').run(hash,d.kind,d.logicalId,d.recordHash);}
   }else return {...manifest,unsupported:'UNSUPPORTED_RECORD_KIND'};
  }
  if(count!==BigInt(s.recordCount))invalid();db.prepare('UPDATE segment_queue SET state=1 WHERE path=?').run(q.path);
 }
 // Kahn's walk lives in SQLite: shared acyclic index pages are legal, cycles
 // are not. Neither node count nor path depth becomes a resident JS collection.
 db.exec('CREATE TABLE segment_indegree(path TEXT PRIMARY KEY,n INTEGER NOT NULL) STRICT; CREATE TABLE ready_segments(path TEXT PRIMARY KEY) STRICT; CREATE INDEX segment_children ON segment_edges(child); INSERT INTO segment_indegree SELECT path,(SELECT count(*) FROM segment_edges WHERE child=path) FROM segment_queue; INSERT INTO ready_segments SELECT path FROM segment_indegree WHERE n=0;');
 let visited=0;for(;;){const ready=db.prepare('SELECT path FROM ready_segments ORDER BY path LIMIT 1').get();if(!ready)break;db.prepare('DELETE FROM ready_segments WHERE path=?').run(ready.path);visited++;
  for(const edge of db.prepare('SELECT child FROM segment_edges WHERE parent=?').iterate(ready.path)){db.prepare('UPDATE segment_indegree SET n=n-1 WHERE path=?').run(edge.child);if(db.prepare('SELECT n FROM segment_indegree WHERE path=?').get(edge.child)!.n===0)db.prepare('INSERT INTO ready_segments VALUES (?)').run(edge.child);}check();await tick();
 }if(visited!==Number(db.prepare('SELECT count(*) n FROM segment_queue').get()!.n))invalid();
 if(db.prepare("SELECT name FROM zip_entries WHERE name LIKE 'records/%' AND name NOT IN (SELECT path FROM segment_queue) LIMIT 1").get()||db.prepare("SELECT name FROM zip_entries WHERE name LIKE 'objects/%' AND substr(name,9) NOT IN (SELECT substr(hash,8) FROM refs) LIMIT 1").get())invalid();
 for(const r of db.prepare('SELECT * FROM portable_roots').iterate())if(!db.prepare('SELECT 1 FROM records WHERE hash=? AND kind=? AND id=?').get(r.hash,r.kind,r.id))invalid();
 for(const r of db.prepare('SELECT * FROM dependency_edges').iterate())if(!db.prepare('SELECT 1 FROM records WHERE hash=? AND kind=? AND id=?').get(r.hash,r.kind,r.id))invalid();
 for(const r of db.prepare('SELECT * FROM records').iterate()){const v=JSON.parse(String(r.json));if(v.payloadVersion!==1||!['document','history','checkpoint','asset','draft','portable-provider'].includes(v.entityType))return {...manifest,unsupported:'UNSUPPORTED_ENTITY_VERSION'};const ref=v.payloadRef,e=zip.entry('objects/'+ref.hash.slice(7));if(e.bytes!==BigInt(ref.byteLength)||e.bytes>65536n)invalid();const chunks:Buffer[]=[];for await(const b of zip.chunks(e,check))chunks.push(Buffer.from(b));const payload=json(Buffer.concat(chunks));try{portableTextSupport(payload);}catch(e){if(!(e instanceof UnsupportedText))throw e;return {...manifest,unsupported:e.message};}if(v.entityType==='portable-provider')providerRecord(payload);else if(v.entityType!=='draft')entity(v.entityType,payload);db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run(v.entityType,v.logicalId,canonical(payload),r.hash);}
 if(!db.prepare("SELECT 1 FROM portable_roots WHERE kind='document' AND id=?").get(manifest.sourceNamespace))invalid();
 if(manifest.formatVersion===1){await validateLegacySurvivors(db,check);return {...manifest,unsupported:'LEGACY_TRANSACTION_BOUNDS_UNAVAILABLE'};}
 await validateTransactions(db,manifest.capturedHighWater,check);
 return manifest;
}
