import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';
import {installSchema18Packet} from '../recovery/schema18-packet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile,readFile,symlink,readdir,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {rootFor,command,encode} from '../store/helpers.mjs';
import {digest} from '../raster/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
const base='d84c1de55709bbd957222cac854905c41583a4e4';
const seed=String.raw`
import {openWriter} from './dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from './dist/local/src/protocol/store.js';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const w=await openWriter({root:process.argv[2]}),auth={clientId:'legacy_client',sessionHash:'e'.repeat(64),now:Date.now()-8*86400000,expires:Date.now()+1800000};
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex'),enc=x=>Buffer.from(JSON.stringify(x));
const cmd=(body,documentId=null,revision=null)=>({protocolVersion:1,command:{schemaVersion:1,commandId:randomUUID(),clientId:auth.clientId,sessionId:'legacy',correlationId:'legacy',causationId:null,transactionId:randomUUID(),documentId,expectedDocumentRevision:revision,expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:new Date().toISOString(),body}});
async function finish(body,kind='assetCommand',doc=null,rev=null){const c=cmd(body,doc,rev);let r=kind==='submit'?await w.submit(enc(c),w.epoch):await w[kind](enc(c),auth);for(let i=0;!r&&i<2000;i++){r=(await w.commandState(c.command.commandId)).record?.receipt;await new Promise(r=>setTimeout(r,5));}if(r?.status!=='accepted')throw Error(JSON.stringify(r));return {command:c,event:(await w.events(String(BigInt(r.fromSeq)-1n))).events.at(-1)};}
async function upload(bytes,purpose,mediaType){const s={protocolVersion:1,stagingId:randomUUID(),purpose,expectedBytes:String(bytes.length),sha256:hash(bytes),mediaType};await w.assetCreate(s,auth);const token=await w.assetBeginChunk(s.stagingId,'0',bytes.length,auth);await w.assetChunk(token,bytes,auth);return (await finish({type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;}
async function ui(body){const before=await w.uiRead('editor',auth);const receipt=await w.uiPersist(enc({protocolVersion:1,requestId:randomUUID(),sessionId:'editor',expectedUISeq:before.uiSeq,body}),auth);if(receipt.status!=='accepted')throw Error(JSON.stringify(receipt));}
const texts={},assets={};
async function draft(id,generation,doc,label,target=null,revision='1'){const bytes=Buffer.from('legacy exact '+label+' 🦋\nhttps://authored.invalid/?token=literal'),a=await upload(bytes,'caption','text/plain');texts[label]=bytes.toString();assets[label]=a;await ui({type:'SaveDraft',draft:{id,generation,kind:'prompt',documentId:doc,targetLayerId:target,expectedDocumentRevision:revision,assetId:a.id,composing:false}});}
try{
 await w.protocolDefaults();await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 for(const id of ['doc_a','doc_b'])await finish({type:'NewDocument',width:3,height:2,color:'sRGB',depth:8},'submit',id);
 const input=await upload(await readFile(process.argv[3]),'image','image/png'),preview=(await finish({type:'PrepareRaster',assetId:input.id},'rasterCommand')).event.payload.asset;
 const reviewed=(await finish({type:'ReviewRaster',assetId:preview.id},'rasterCommand')).event.payload;
 const image=(await finish({type:'ApproveRaster',assetId:preview.id,...reviewed},'rasterCommand')).event.payload.asset;
 await draft('applied','1','doc_a','history_owned','picture');
 const applied=await finish({type:'ImportAsset',assetId:image.id,layerId:'picture',name:'Picture',draft:{sessionId:'editor',draftId:'applied',generation:'1'}},'historyCommand','doc_a','1');
 await ui({type:'ClearDraft',draftId:'applied',generation:'1'});
 await draft('cleared','1','doc_a','cleared');await ui({type:'ClearDraft',draftId:'cleared',generation:'1'});
 await draft('superseded','1','doc_a','superseded');await draft('superseded','2','doc_a','current_a',null,'2');
 await draft('retarget','1','doc_a','retarget_old');await draft('retarget','2','doc_b','current_b');
 await draft('reused','1','doc_a','reused_old');await ui({type:'ClearDraft',draftId:'reused',generation:'1'});await draft('reused','1','doc_b','reused_b');
 for(let i=0;i<1005;i++)await ui({type:'FocusRequested',target:'canvas',generation:String(i)});
 const countCompacted=(await w.uiRead('editor',auth)).uiSeq;auth.now=Date.now();await ui({type:'FocusRequested',target:'history',generation:'1006'});
 console.log(JSON.stringify({texts,assets,applied:applied.command,countCompacted,ui:await w.uiRead('editor',auth),image,input}));
}finally{await w.close();}
`;
let prior;
test.before(async t=>{prior=await rootFor(t);compileLegacy(prior,base);await writeFile(join(prior,'seed.mjs'),seed);});
const auth=()=>({clientId:'legacy_client',sessionHash:'e'.repeat(64),now:Date.now(),expires:Date.now()+1800000});
async function fixture(t){const root=await rootFor(t);return {root,...JSON.parse(execFileSync(process.execPath,['--import',resolve('tests/session/no-egress.mjs'),join(prior,'seed.mjs'),root,resolve('tests/raster/fixtures/hidden-alpha.png')],{encoding:'utf8'}))};}
async function done(w,c,a){let r=await w.portableCommand(encode(c),a);for(let i=0;!r&&i<2000;i++){r=(await w.commandState(c.command.commandId)).record?.receipt;await new Promise(r=>setTimeout(r,5));}assert(r);return r;}
async function copy(w,id){const a=auth(),d=await w.document(id),c=command(EMPTY_EXPECTED_VERSIONS,{clientId:a.clientId,documentId:id,expectedDocumentRevision:d.revision,body:{type:'SaveCopy'}}),r=await done(w,c,a);assert.equal(r.status,'accepted');const e=(await w.events(String(BigInt(r.fromSeq)-1n))).events[0],verified=await w.bundleVerify(e.payload.bundle.bundleId,a),parts=[];for(let at=0;at<Number(verified.bundle.blob.byteLength);at+=32768)parts.push(await w.bundleContent(verified.handle,String(at),Math.min(32768,Number(verified.bundle.blob.byteLength)-at),a));await w.bundleRelease(verified.handle);return Buffer.concat(parts);}
async function reopen(w,bytes){const a=auth(),s={protocolVersion:1,stagingId:randomUUID(),purpose:'bundle',expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType:'application/x-ideogram-project'};await w.assetCreate(s,a);for(let at=0;at<bytes.length;at+=1048576){const b=bytes.subarray(at,at+1048576),token=await w.assetBeginChunk(s.stagingId,String(at),b.length,a);await w.assetChunk(token,b,a);}const commandFor=body=>command(EMPTY_EXPECTED_VERSIONS,{clientId:a.clientId,documentId:null,expectedDocumentRevision:null,body});const p=await done(w,commandFor({type:'PreviewBundleImport',stagingId:s.stagingId,expectedSha256:s.sha256}),a);assert.equal(p.status,'accepted',JSON.stringify(p));const e=(await w.events(String(BigInt(p.fromSeq)-1n))).events[0],review=await w.bundleReview(e.payload.reviewId,a);assert.equal(review.editable,true);assert.equal((await done(w,commandFor({type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}),a)).status,'accepted');return review;}
async function originals(root){const out={};async function visit(dir){for(const e of await readdir(join(root,dir),{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())await visit(path);else out[path]=digest(await readFile(join(root,path)));}}await visit('objects');return out;}
test('actual d84 two-document clear, supersede, retarget, reuse and count/age compaction retain only scoped required drafts',async t=>{
 const f=await fixture(t),old=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(old.prepare('PRAGMA user_version').get().user_version,6);assert.equal(old.prepare('SELECT count(*) n FROM ui_events').get().n,1);assert(BigInt(f.countCompacted)>1000n);const roots=old.prepare('SELECT * FROM roots ORDER BY owner,hash').all(),receipts=old.prepare('SELECT * FROM ui_receipts ORDER BY id').all();old.close();await installSchema18Packet(f.root);const objects=await originals(f.root),w=await openWriter({root:f.root});t.after(()=>w.close());await w.rememberClient(auth().sessionHash,auth().clientId,auth().expires,auth().sessionHash);
 const a=await copy(w,'doc_a'),b=await copy(w,'doc_b');for(const [label,text]of Object.entries(f.texts)){assert.equal(a.includes(Buffer.from(text)),['current_a','history_owned'].includes(label),'A '+label);assert.equal(b.includes(Buffer.from(text)),['current_b','reused_b'].includes(label),'B '+label);}
 for(const [archive,labels]of [[a,['current_a']],[b,['current_b','reused_b']]]){const review=await reopen(w,archive),ui=await w.uiRead(review.uiSessionIds[0],auth());assert.equal(ui.drafts.length,labels.length);for(const d of ui.drafts){assert.equal(d.documentId,review.documentId);const asset=await w.assetProjection(d.assetId);assert(labels.some(label=>asset.asset.blob.hash===f.assets[label].blob.hash));}assert.equal(review.scope,'selected-document-current-drafts-and-retained-domain-history');assert.equal(review.localRetentionExcluded,'obsolete-unattributed-ui-only');}
 const now=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});for(const r of roots)assert(now.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=? AND media_type=?').get(r.owner,r.hash,r.media_type));for(const r of receipts)assert.deepEqual(now.prepare('SELECT * FROM ui_receipts WHERE client_id=? AND id=?').get(r.client_id,r.id),r);now.close();for(const [path,hash]of Object.entries(objects))assert.equal(digest(await readFile(join(f.root,path))),hash);t.diagnostic(JSON.stringify({priorExecutable:base,sourceUISeq:f.ui.uiSeq,sourceObjects:Object.keys(objects).length,scopeA:['current_a','history_owned'],scopeB:['current_b','reused_b'],sourcePreserved:true}));
});
for(const fault of ['current-bytes','history-ownership'])test('legacy required '+fault+' failure refuses a complete-copy claim',async t=>{
 const f=await fixture(t);await installSchema18Packet(f.root);const w=await openWriter({root:f.root});t.after(()=>w.close());await w.rememberClient(auth().sessionHash,auth().clientId,auth().expires,auth().sessionHash);
 if(fault==='current-bytes'){const h=f.assets.current_a.blob.hash;await unlink(join(f.root,'objects','sha256',h.slice(7,9),h.slice(7)));}
 else{const db=new DatabaseSync(join(f.root,'metadata.sqlite'));db.prepare("DELETE FROM roots WHERE owner='ui:legacy_client:editor:applied:1'").run();db.close();}
 const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:'legacy_client',documentId:'doc_a',expectedDocumentRevision:'2',body:{type:'SaveCopy'}});let r;try{r=await done(w,c,auth());}catch(e){assert.equal(e.code,'MISSING_OBJECT');}if(r)assert.equal(r.status,'rejected');const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM portable_bundles').get().n,0);db.close();
});
