import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
 const f=await isolated(t);for(const id of ['realm_one','realm_two'])assert.equal((await f.post('/api/v1/text-admission/'+id,{protocolVersion:1})).status,200);
 const third=await f.post('/api/v1/text-admission/realm_three',{protocolVersion:1});assert.notEqual(third.status,200,third.text);
 for(let i=0;i<4;i++)assert.equal((await f.post('/api/v1/text-admission/realm_one',{protocolVersion:1})).status,200);
 const count=()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) n FROM text_admissions').get().n;}finally{db.close();}};assert.equal(count(),2);
 assert.equal((await f.post('/api/v1/text-admission/realm_one/release',{protocolVersion:1})).status,200);assert.equal(count(),1);assert.equal((await f.post('/api/v1/text-admission/realm_three',{protocolVersion:1})).status,200);assert.equal(count(),2);
});
