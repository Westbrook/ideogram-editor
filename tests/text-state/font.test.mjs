import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isolated} from './helpers.mjs';
import {upload,workspace,terminal,doc} from '../portable/helpers.mjs';
const profile=JSON.parse(await readFile('src/text/profile.json'));
test('durable font parser is exactly the approved bounded parser algorithm',async()=>{
 const old=await readFile('src/text/font.ts','utf8'),derived=await readFile('server/text/font.ts','utf8');assert.equal(derived.slice(derived.indexOf('export const PARSER_PROFILE')),old.slice(old.indexOf('export const PARSER_PROFILE')));
});
test('real font worker refuses restricted and corrupt staged bytes without altering the document',async t=>{
 const f=await isolated(t);await terminal(f,f.command({}, {width:1,height:1}));const font=profile.fonts.find(f=>f.id==='NotoSans'),bytes=await readFile('vendor/text/'+font.file),licenseBytes=await readFile('vendor/text/'+font.licenseFile);
 async function stage(data,purpose){const s=await upload(f,data,purpose,purpose==='caption'?'text/plain':'application/octet-stream');return (await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset.blob;}
 const license=await stage(licenseBytes,'caption'),restricted=Buffer.from(bytes);let offset;for(let i=0;i<restricted.readUInt16BE(4);i++){const at=12+16*i;if(restricted.toString('ascii',at,at+4)==='OS/2')offset=restricted.readUInt32BE(at+8);}assert(offset);restricted.writeUInt16BE(2,offset+8);
 const before=await doc(f);for(const data of [restricted,Buffer.from('not a font')]){const source=await stage(data,'font'),r=await terminal(f,f.command({expectedDocumentRevision:before.revision,body:{type:'ImportFont',source,license,origin:'local-file',embeddingReviewed:true}}));assert.equal(r.json.receipt.status,'rejected',r.text);assert.deepEqual(await doc(f),before);}
 const source=await stage(bytes,'font'),accepted=await terminal(f,f.command({expectedDocumentRevision:before.revision,body:{type:'ImportFont',source,license,origin:'bundled',embeddingReviewed:true}}));assert.equal(accepted.json.receipt.status,'accepted');assert.deepEqual(await doc(f),before);
});
test('text realms share the writer budget; retries renew one owner and explicit release returns capacity',async t=>{
 const f=await isolated(t);assert.equal((await f.post('/api/v1/text-admission/realm_one',{protocolVersion:1})).status,200);
 assert.notEqual((await f.post('/api/v1/text-admission/realm_two',{protocolVersion:1})).status,200);
 for(let i=0;i<4;i++)assert.equal((await f.post('/api/v1/text-admission/realm_one',{protocolVersion:1})).status,200);
 const count=()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM text_admissions').get().n;}finally{db.close();}};assert.equal(count(),1);
 assert.equal((await f.post('/api/v1/text-admission/realm_one/release',{protocolVersion:1})).status,200);assert.equal(count(),0);assert.equal((await f.post('/api/v1/text-admission/realm_two',{protocolVersion:1})).status,200);assert.equal(count(),1);
});

test('missing and corrupt exact fonts retain text drafts with stable receipts and allow the next valid generation',async t=>{
 const f=await isolated(t);await terminal(f,f.command({}, {width:120,height:70}));
 async function stage(bytes,purpose='caption'){const s=await upload(f,bytes,purpose,purpose==='caption'?'text/plain':'application/octet-stream');return (await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;}
 const pinned=profile.fonts.find(x=>x.id==='NotoSans'),fontBytes=await readFile('vendor/text/'+pinned.file),source=(await stage(fontBytes,'font')).blob,license=(await stage(await readFile('vendor/text/'+pinned.licenseFile))).blob;
 const imported=await terminal(f,f.command({expectedDocumentRevision:'1',body:{type:'ImportFont',source,license,origin:'bundled',embeddingReviewed:true}}));assert.equal(imported.json.receipt.status,'accepted');
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});let font;try{font=db.prepare('SELECT json FROM assets').all().map(r=>JSON.parse(r.json)).find(a=>a.font)?.font;}finally{db.close();}assert(font);
 const textUtf8=(await stage(Buffer.from('Missing font keeps this literal draft'))).blob,body={schemaVersion:1,kind:'text-draft-1',textUtf8,style:{primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:32,lineHeightMultiplier:1.2,fill:[40,90,190,255],align:'start',direction:'auto'},frame:{width:120,height:70},fonts:[font]},asset=await stage(Buffer.from(JSON.stringify(body))),before=await doc(f),path=join(f.root,'objects','sha256',font.bytes.hash.slice(7,9),font.bytes.hash.slice(7));
 let seq='0';for(const fault of ['missing','corrupt','valid']){if(fault==='missing')await unlink(path);else await writeFile(path,fault==='corrupt'?Buffer.from('bad font'):fontBytes,{mode:0o600});
  const request={protocolVersion:1,requestId:randomUUID(),sessionId:'font-recovery',expectedUISeq:seq,body:{type:'SaveDraft',draft:{id:'recoverable-font',generation:String(Number(seq)+1),kind:'text',documentId:before.id,targetLayerId:null,expectedDocumentRevision:before.revision,assetId:asset.id,composing:false}}};
  const r=await f.post('/api/v1/ui/font-recovery',request);assert.equal(r.status,200,r.text);assert.equal(r.json.status,'accepted');assert.deepEqual((await f.post('/api/v1/ui/font-recovery',request)).json,r.json);seq=r.json.uiSeq;assert.deepEqual(await doc(f),before);
 }
 await unlink(path);await symlink(join(f.root,'metadata.sqlite'),path);const request={protocolVersion:1,requestId:randomUUID(),sessionId:'font-recovery',expectedUISeq:seq,body:{type:'SaveDraft',draft:{id:'unsafe-font',generation:'1',kind:'text',documentId:before.id,targetLayerId:null,expectedDocumentRevision:before.revision,assetId:asset.id,composing:false}}};
 const refused=await f.post('/api/v1/ui/font-recovery',request);assert.notEqual(refused.status,200);assert.equal((await f.read('/api/v1/ui/font-recovery')).json.uiSeq,seq);assert.deepEqual(await doc(f),before);await unlink(path);await writeFile(path,fontBytes,{mode:0o600});
 assert.equal((await f.post('/api/v1/ui/font-recovery',request)).json.status,'accepted');await f.server.close();
});
