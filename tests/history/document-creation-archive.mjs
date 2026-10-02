// Test-owned, bounded adversarial corpus. Changes only declared color metadata;
// original PNG and RGBA bytes stay intact. Public import performs pixel checks.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {unpack,records,putRecords,pack,encoded,hash} from '../portable/archive-fixture.mjs';
import {ZipIndex,spool} from '../../dist/local/server/portable/zip.js';
import {decodeRecords} from '../../dist/local/server/portable/format.js';
import {validateClosure} from '../../dist/local/server/portable/closure.js';
import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';

export async function mismatchedSolidColor(root,bytes,color){
  const entries=await unpack(root,bytes),recordSet=records(entries),eventSet=records(entries,'events'),manifest=JSON.parse(entries.get('manifest.json'));
  assert.equal(manifest.segments.length,2,'Fixture is one fresh creation, not an unbounded archive rewrite');
  const objects=new Map(recordSet.values.filter(row=>row.kind==='object').map(row=>[row.sha256,row])),memo=new Map(),visiting=new Set();let plans=0,documents=0;
  const ref=value=>{
    if(value.mediaType!=='application/json')return value;
    if(memo.has(value.hash))return memo.get(value.hash);
    assert(!visiting.has(value.hash),'No metadata cycles in fixture');visiting.add(value.hash);
    const original=entries.get('objects/'+value.hash.slice(7));assert(original);assert.equal(hash(original),value.hash.slice(7));
    const rewritten=encoded(visit(JSON.parse(original))),sha=hash(rewritten),result={hash:'sha256:'+sha,byteLength:String(rewritten.length),mediaType:'application/json'};
    entries.set('objects/'+sha,rewritten);objects.set(sha,{schemaVersion:1,kind:'object',sha256:sha,bytes:result.byteLength,mediaType:result.mediaType,path:'objects/'+sha});memo.set(value.hash,result);visiting.delete(value.hash);return result;
  };
  const visit=value=>{
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(visit);
    if(Object.keys(value).sort().join(',')==='byteLength,hash,mediaType')return ref(value);
    const result=Object.fromEntries(Object.entries(value).map(([key,child])=>[key,visit(child)]));
    if(result.kind==='solid-background-v1'){result.color=[...color];plans++;}
    if(result.creationBackground?.kind==='solid'){result.creationBackground.color=[...color];documents++;}
    return result;
  };
  const rewrittenEvents=eventSet.values.map(visit),rows=[];
  for(const original of recordSet.values){
    if(original.kind==='object')continue;
    const rewritten=visit(original);
    if(rewritten.kind==='entity'){
      assert.deepEqual(rewritten.dependencies,[]);
      for(const root of manifest.rootRefs)if(root.recordHash==='sha256:'+hash(encoded(original)))root.recordHash='sha256:'+hash(encoded(rewritten));
    }else if(rewritten.kind==='transaction'){
      assert.equal(rewritten.sourceArchive,null);
      rewritten.eventsHash='sha256:'+hash(Buffer.concat(rewrittenEvents.filter(row=>row.event.transactionId===rewritten.receipt.transactionId).map(row=>Buffer.concat([encoded(row.event),Buffer.from('\n')]))));
    }
    rows.push(rewritten);
  }
  assert(plans>0&&documents>0);putRecords(entries,recordSet.path,[...rows,...objects.values()]);putRecords(entries,eventSet.path,rewrittenEvents);entries.set('manifest.json',encoded(manifest));
  return pack(root,entries);
}

export async function assertValidMetadataClosure(root,bytes){
  const file=join(root,randomUUID()+'.zip');await writeFile(file,bytes,{mode:0o600});const db=spool(join(root,randomUUID()+'.sqlite')),zip=new ZipIndex(file,db);
  try{
    await zip.headers(()=>{});await zip.hashes(()=>{});const manifest=await decodeRecords(zip,db,()=>{});assert.equal(manifest.unsupported,undefined);
    const read=async ref=>{const entry=zip.entry('objects/'+ref.hash.slice(7));assert.equal(entry.bytes,BigInt(ref.byteLength));assert.equal(entry.sha256,ref.hash.slice(7));const chunks=[];for await(const bytes of zip.chunks(entry,()=>{}))chunks.push(Buffer.from(bytes));return Buffer.concat(chunks);};
    let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);
    try{const document=await validateClosure(db,read,()=>{},memory,true,true,true,true,true,true);assert.equal(document.id,manifest.sourceNamespace);return document;}finally{assert.equal(memory.bytes,0);}
  }finally{zip.close();db.close();}
}
