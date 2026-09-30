import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {send} from './review-fixture.mjs';
const [root,hash,phase]=process.argv.slice(2),owner=await acquireRoot(root),gate=new Int32Array(new SharedArrayBuffer(4));let db;
db=new StoreDatabase(root,point=>{
 if(point!==phase||!db?.db.prepare("SELECT 1 FROM deletion_objects WHERE hash=? AND state='unlinking'").get(hash))return;
 process.send({type:'barrier',phase:point,hash,present:existsSync(join(root,'objects/sha256',hash.slice(7,9),hash.slice(7))),effects:globalThis.__storeNetworkCounters.read()});Atomics.wait(gate,0,0);
});
process.send({type:'ready'});
process.on('message',async()=>{try{await send(db,{type:'CollectDocumentGarbage',documentId:'document_2'});process.send({type:'unexpected-completion'});}catch(e){process.send({type:'error',message:e.message});}});
