import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {setup}=await import('../protocol/helpers.mjs');
const {importRaster,terminal}=await import('../raster/helpers.mjs');
const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
const {openWriter}=await import(pathToFileURL(resolve('dist/local/server/storage/writer.js')).href);
const {command,encode}=await import('../store/helpers.mjs');
let cleanup:(()=>Promise<any>)[]=[];
test.afterEach(async()=>{for(const fn of cleanup.reverse())await fn();cleanup=[];});
async function fixture(){
 const f=await setup({after:(fn:()=>Promise<any>)=>cleanup.push(fn)});await terminal(f,f.command({}, {width:3,height:2}));
 const image=await importRaster(f,'hidden-alpha.png');let d=(await f.read('/api/v1/documents/document_1')).json.projection.value;
 const c=f.command({expectedDocumentRevision:d.revision,body:{type:'ImportAsset',assetId:image.asset.id,layerId:'picture',name:'Original',draft:null}});
 const imported=await terminal(f,c);d=(await f.read('/api/v1/documents/document_1')).json.projection.value;
 await f.server.close();return {f,image,imported,c,document:d};
}
async function start(page:any,root:string){
 const server=await startLocalServer({root,staticDirectory:resolve(process.env.IE_RECOVERY_APP??resolve(process.env.IE_RECOVERY_OUTPUT??'artifacts/p1b5/recovery','browser-app'))});cleanup.push(()=>server.close());
 await page.goto(server.issuePairingURL());await expect(page.locator('#state')).toHaveText('Recovery consumer ready');return server;
}
const read=(page:any)=>page.evaluate(()=>(window as any).harness.read());
const recover=(page:any)=>page.evaluate(()=>(window as any).harness.client.recover());
test('real browser applies asset and image history atomically, stale tab cannot overwrite and reload retains current projection',async({page,context})=>{
 const f=await fixture(),server=await start(page,f.f.root);await recover(page);expect((await read(page)).document).toEqual(f.document);
 const second=await context.newPage();await second.goto(server.issuePairingURL());await expect(second.locator('#state')).toHaveText('Recovery consumer ready');await recover(second);
 await page.evaluate(async()=>{const h=(window as any).harness;Object.assign(h.session,await(await h.transport('/api/v1/session')).json());});
 const sent=await page.evaluate(async({ref,revision}:any)=>{const h=(window as any).harness;const c={protocolVersion:1,command:{schemaVersion:1,commandId:crypto.randomUUID(),clientId:h.session.clientId,sessionId:'tab1',correlationId:'correlation',causationId:null,transactionId:crypto.randomUUID(),documentId:'document_1',expectedDocumentRevision:revision,expectedEntityVersions:ref,issuedAt:new Date().toISOString(),body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{opacity:0.5},draft:null}}};let r=await h.send(c);while(r.value.kind==='pending'){await new Promise(r=>setTimeout(r,5));const response=await h.transport('/api/v1/commands/'+c.command.commandId);r={status:response.status,value:await response.json()};}return {c,r};},{ref:f.f.ref,revision:f.document.revision});expect(sent.r.value.receipt.status).toBe('accepted');
 await recover(page);await recover(second);const expected=(await read(page)).document;expect((await read(second)).document).toEqual(expected);
 const stale=structuredClone(sent.c);stale.command.commandId=crypto.randomUUID();stale.command.transactionId=crypto.randomUUID();
 const rejection=await second.evaluate(async c=>{const h=(window as any).harness;let r=await h.send(c);while(r.value.kind==='pending'){await new Promise(r=>setTimeout(r,5));r={status:200,value:await(await h.transport('/api/v1/commands/'+c.command.commandId)).json()};}return r.value;},stale);expect(rejection.receipt.code).toBe('STALE_REVISION');await recover(second);expect((await read(second)).document).toEqual(expected);
 await page.goto(server.issuePairingURL());await expect(page.locator('#state')).toHaveText('Recovery consumer ready');await recover(page);expect((await read(page)).document).toEqual(expected);
 expect(await page.evaluate(async id=>(window as any).harness.cache.read('history',id),expected.historyHead)).toMatchObject({kind:'image-edit',operation:'SetLayerProperties'});
});
test('new image history snapshot plus tail is equivalent to full replay and corrupt bytes never advance browser state',async({page})=>{
 const f=await fixture(),w=await openWriter({root:f.f.root});let d=await w.document('document_1');
 const auth={clientId:'snapshot_fixture',sessionHash:'a'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
 for(let i=0;i<245;i++){
  const c=command(f.f.ref,{clientId:auth.clientId,expectedDocumentRevision:d.revision,body:{type:'SaveCheckpoint',name:'Retained '+i}});await w.historyCommand(encode(c),auth);
  for(;;){const s=await w.commandState(c.command.commandId);if(s.record){expect(s.record.receipt.status).toBe('accepted');break;}await new Promise(r=>setTimeout(r,1));}d=await w.document('document_1');
 }
 {const diagnosticRead=await w.readDiagnostics();try{expect(BigInt(diagnosticRead.value.observations.snapshot.latest)).toBeGreaterThanOrEqual(250n);}finally{diagnosticRead.release();}}await w.close();
 await start(page,f.f.root);await recover(page);expect((await read(page)).document).toEqual(d);
 await page.evaluate(async()=>{const h=(window as any).harness,p=await h.cache.published(),generation=crypto.randomUUID();await h.cache.clone(p.generation,generation);await h.cache.publish({...p,generation,cursor:'0'},p);});const prior=await read(page);
 await page.route('**/api/v1/protocol-content/**',async route=>{const r=await route.fetch(),b=await r.body();b[b.length-2]^=1;await route.fulfill({response:r,body:b});});
 expect(await page.evaluate(async()=>{try{await (window as any).harness.client.recover();return false;}catch{return true;}})).toBe(true);expect(await read(page)).toEqual(prior);
 await page.unroute('**/api/v1/protocol-content/**');await recover(page);expect((await read(page)).document).toEqual(d);
});

test('browser draft owner fences late preparation and lost receipt retries the same durable UI identity',async({page})=>{
 const f=await fixture();await start(page,f.f.root);
 await page.evaluate(async ref=>{
  const h=(window as any).harness,w=window as any;
  const text='latest draft 🦋',bytes=new TextEncoder().encode(text),sha256='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join(''),stagingId=crypto.randomUUID();
  const headers={'Content-Type':'application/json','X-App-Csrf':h.session.csrfToken};
  const created=await h.transport('/api/v1/assets/staging',{method:'POST',headers,body:JSON.stringify({protocolVersion:1,stagingId,purpose:'caption',expectedBytes:String(bytes.length),sha256,mediaType:'text/plain'})});if(created.status!==201)throw Error('Caption stage failed');
  const put=await h.transport('/api/v1/assets/staging/'+stagingId,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0','X-App-Csrf':h.session.csrfToken},body:bytes});if(!put.ok)throw Error('Caption bytes failed');
  const c={protocolVersion:1,command:{schemaVersion:1,commandId:crypto.randomUUID(),clientId:h.session.clientId,sessionId:'draft-ui',correlationId:'draft',causationId:null,transactionId:crypto.randomUUID(),documentId:null,expectedDocumentRevision:null,expectedEntityVersions:ref,issuedAt:new Date().toISOString(),body:{type:'FinalizeStaging',stagingId,expectedSha256:sha256}}};
  let r=await h.send(c);while(r.value.kind==='pending'){await new Promise(r=>setTimeout(r,5));r={value:await(await h.transport('/api/v1/commands/'+c.command.commandId)).json()};}
  const events=await(await h.transport('/api/v1/events?after='+(BigInt(r.value.receipt.fromSeq)-1n))).json();w.draftAsset=events.batches[0].events[0].payload.asset.id;
  w.drafts=new h.DraftPersistence('draft-ui',h.transport,()=>h.session.csrfToken);await w.drafts.restore();
  w.baseDraft={id:'prompt',kind:'prompt',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'2',composing:false,text};
  w.drafts.change(w.baseDraft);
  let release:any;const prepare=new Promise<string>(r=>release=r);w.releaseDraft=()=>release(w.draftAsset);w.oldSave=w.drafts.save('prompt',()=>prepare);
 },f.f.ref);
 expect(await page.evaluate(()=>(window as any).drafts.drafts.get('prompt').pending)).toBe(true);
 await page.evaluate(()=>{const w=window as any;w.drafts.change(w.baseDraft);w.releaseDraft();return w.oldSave;});
 expect(await page.evaluate(()=>(window as any).drafts.checkpoint.uiSeq)).toBe('0');
 expect(await page.evaluate(()=>(window as any).drafts.drafts.get('prompt').savedGeneration)).toBeNull();
 await page.route('**/api/v1/ui/draft-ui',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort();}else await route.continue();});
 expect(await page.evaluate(async()=>{const w=window as any;try{await w.drafts.save('prompt',async()=>w.draftAsset);return false;}catch{return true;}})).toBe(true);
 const requestId=await page.evaluate(()=>(window as any).drafts.pendingRequests()[0]);expect(requestId).toBeTruthy();
 expect(await page.evaluate(()=>(window as any).drafts.drafts.get('prompt').savedGeneration)).toBeNull();
 await page.unroute('**/api/v1/ui/draft-ui');const receipt=await page.evaluate(id=>(window as any).drafts.retry(id),requestId);
 expect(receipt.status).toBe('accepted');expect(receipt.uiSeq).toBe('1');expect(await page.evaluate(()=>(window as any).drafts.drafts.get('prompt').savedGeneration)).toBe('2');
 expect(await page.evaluate(async()=>{const h=(window as any).harness,d=new h.DraftPersistence('draft-ui',h.transport,()=>h.session.csrfToken);await d.restore();await d.restoreDraft('prompt',async(id:string)=>{const r=await h.transport('/api/v1/assets/'+id+'/content');return r.text();});return d.drafts.get('prompt').text;})).toBe('latest draft 🦋');
});
