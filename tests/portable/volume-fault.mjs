// Only the disposable 2 GiB image is filled and remounted; never the host disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {closeSync,openSync,fsyncSync,ftruncateSync,writeSync,statfsSync} from 'node:fs';
import {mkdir,mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {command,encode} from '../store/helpers.mjs';
import {digest} from '../raster/helpers.mjs';
const pause=()=>new Promise(r=>setTimeout(r,5));
test('real archive ENOSPC preserves pending identity and pins; writable retry succeeds; EROFS preserves copy',async t=>{
 assert.equal(process.platform,'darwin');const dir=await mkdtemp(join(await realpath(tmpdir()),'portable-fault-')),mount=join(dir,'mount'),image=join(dir,'fault.sparseimage');await mkdir(mount);let attached=false,w,fd;
 try{execFileSync('/usr/bin/hdiutil',['create','-size','2g','-type','SPARSE','-fs','HFS+','-volname','PortableCopyFault',image],{stdio:'pipe'});execFileSync('/usr/bin/hdiutil',['attach','-nobrowse','-owners','on','-mountpoint',mount,image],{stdio:'pipe'});attached=true;const root=join(mount,'private'),a={clientId:'client_1',sessionHash:'a'.repeat(64),now:Date.now(),expires:Date.now()+1800000};w=await openWriter({root});await w.protocolDefaults();await w.rememberClient(a.sessionHash,a.clientId,a.expires);const c0=command(EMPTY_EXPECTED_VERSIONS,{}, {width:1,height:1});assert.equal((await w.submit(encode(c0),w.epoch)).status,'accepted');const document=await w.document('document_1');await w.close();w=null;
 const gate=new SharedArrayBuffer(4);let hit;const reached=new Promise(r=>hit=r);w=await openWriter({root},{phase:'portable-archive-before-write',gate,onBarrier:hit});const c=command(EMPTY_EXPECTED_VERSIONS,{expectedDocumentRevision:'1',body:{type:'SaveCopy'}});assert.equal(await w.portableCommand(encode(c),a),null);await reached;
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true}),pins=db.prepare('SELECT * FROM portable_pins').all();assert(pins.length>0);db.close();fd=openSync(join(mount,'filler'),'wx',0o600);let filled=0;for(const size of [1048576,4096,512]){const b=Buffer.alloc(size,77);try{for(;;)filled+=writeSync(fd,b);}catch(e){assert.equal(e.code,'ENOSPC');}}fsyncSync(fd);const free=statfsSync(mount);Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
 let inventory;for(let n=0;n<500;n++){inventory=await w.portableInventory('',a);if(inventory.items[0]?.phase==='waiting-for-resources')break;await pause();}assert.equal(inventory.items[0].reason,'STORAGE_FULL',JSON.stringify(inventory));assert.equal((await w.commandState(c.command.commandId)).record,null);assert.deepEqual(await w.document('document_1'),document);const failed=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.deepEqual(failed.prepare('SELECT * FROM portable_pins').all(),pins);assert.equal(failed.prepare('SELECT count(*) n FROM portable_bundles').get().n,0);failed.close();
 ftruncateSync(fd,0);fsyncSync(fd);closeSync(fd);fd=undefined;await w.portableCommand(encode(c),a);let record;for(let n=0;n<1000;n++){record=(await w.commandState(c.command.commandId)).record;if(record)break;await pause();}assert.equal(record.receipt.status,'accepted');const e=(await w.events(String(BigInt(record.receipt.fromSeq)-1n))).events[0],bundle=e.payload.bundle,blob=join(root,'objects','sha256',bundle.blob.hash.slice(7,9),bundle.blob.hash.slice(7));assert.equal(digest(await readFile(blob)),bundle.blob.hash);await w.close();w=null;const metadata=digest(await readFile(join(root,'metadata.sqlite')));
 execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'pipe'});attached=false;execFileSync('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-owners','on','-mountpoint',mount,image],{stdio:'pipe'});attached=true;assert.throws(()=>openSync(join(root,'writer.lock'),'r+'),{code:'EROFS'});await assert.rejects(openWriter({root}));assert.equal(digest(await readFile(blob)),bundle.blob.hash);assert.equal(digest(await readFile(join(root,'metadata.sqlite'))),metadata);
 t.diagnostic(JSON.stringify({fillerBytes:filled,availableAtFault:free.bavail*free.bsize,archiveFault:inventory.items[0].reason,underlyingFault:'ENOSPC during archive emit after reservation',readOnlyError:'EROFS',pinsPreserved:true,exactRetry:true,powerLossQualified:false}));
 }finally{if(fd!==undefined)closeSync(fd);if(w)await w.close();if(attached)execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'pipe'});await rm(dir,{recursive:true,force:true});}
});
