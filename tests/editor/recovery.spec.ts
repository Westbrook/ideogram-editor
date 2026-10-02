import {confirmImageImports} from './image-import-flow.js';
import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {mkdtemp,realpath,readFile,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {serverProcess} from './process.js';
// @ts-ignore
import {call,exchange} from '../session/helpers.mjs';
// @ts-ignore
import {command} from '../store/helpers.mjs';
const empty={kind:'empty',byteLength:'0'};
const click=(p:Page,n:string)=>p.getByRole('button',{name:n,exact:true}).click();
async function setup(page:Page,context:BrowserContext){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-recovery-ui-')),root=join(dir,'private'),server=await serverProcess(root);let last:any,csrf='';
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST'){last=JSON.parse(r.postData()!);csrf=r.headers()['x-app-csrf'];}});
 await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeHidden();
 const cookie=(await context.cookies()).map(x=>x.name+'='+x.value).join(';');
 return {root,server,get last(){return last;},headers:()=>({Origin:server.origin,Cookie:cookie,'X-App-CSRF':csrf}),read:(path:string)=>call(server.origin,path,{headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','X-App-Client':'LP-1'}})};
}
test('history receipt probes stay serial and one action waits for exact accepted result proof',async({page,context})=>{
 const f=await setup(page,context);let releaseReceipt=()=>{},releaseProof=()=>{};
 try{
 const original=await page.locator('canvas').getAttribute('data-asset');await page.getByRole('treeitem').click();await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('.5');await click(page,'Apply properties');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
 let id='',pending:any,lookups=0,active=0,maxActive=0;const wires:string[]=[];
 const receiptGate=new Promise<void>(r=>releaseReceipt=r),proofGate=new Promise<void>(r=>releaseProof=r);let receiptHit=()=>{},proofHit=()=>{};
 const heldReceipt=new Promise<void>(r=>receiptHit=r),heldProof=new Promise<void>(r=>proofHit=r);
 await page.route('**/api/v1/commands',async route=>{
  if(route.request().method()!=='POST'||JSON.parse(route.request().postData()!).command.body.type!=='Undo'){await route.continue();return;}
  wires.push(route.request().postData()!);id=JSON.parse(wires[0]).command.commandId;const response=await route.fetch();pending=await response.json();expect(pending.kind).toBe('pending');await route.fulfill({response});
 });
 await page.route('**/api/v1/commands/*',async route=>{
  if(new URL(route.request().url()).pathname!=='/api/v1/commands/'+id){await route.continue();return;}
  active++;maxActive=Math.max(maxActive,active);lookups++;
  try{
   // Replay delayed, real pending observations, then hold one receipt read.
   // This is a delivery fault oracle, not a timing specimen or synthetic receipt.
   if(lookups<=2){await route.fulfill({status:202,json:pending});return;}
   receiptHit();await receiptGate;await route.continue();
  }finally{active--;}
 });
 await page.route('**/api/v1/commands/*/result',async route=>{
  if(new URL(route.request().url()).pathname!=='/api/v1/commands/'+id+'/result'){await route.continue();return;}
  // Node-side route.fetch omits Chromium's browser-supplied Fetch Metadata.
  // Bind this fault-injection read to the already paired test origin; normal
  // browser authorization remains covered by the unchanged boundary tests.
  const response=await route.fetch({headers:{...route.request().headers(),Origin:f.server.origin}});expect(response.status()).toBe(200);proofHit();await proofGate;await route.fulfill({response});
 });
 await click(page,'Undo');await heldReceipt;await expect(page.getByRole('region',{name:'Operation status'})).toHaveAttribute('aria-busy','true');expect(wires).toHaveLength(1);expect(lookups).toBe(3);expect(maxActive).toBe(1);await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toHaveCount(0);
 releaseReceipt();await heldProof;await expect(page.getByRole('region',{name:'Operation status'})).toHaveAttribute('aria-busy','true');await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toHaveCount(0);
 releaseProof();await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Operation status'})).toHaveAttribute('aria-busy','false');await expect(page.locator('canvas')).toHaveAttribute('data-asset',original!);expect(wires).toHaveLength(1);expect((await f.read('/api/v1/commands/'+id+'/original')).text).toBe(wires[0]);expect(Object.values(await f.server.effects()).every(x=>x===0)).toBe(true);
 }finally{releaseReceipt();releaseProof();await page.unrouteAll({behavior:'wait'});await f.server.close();}
});

test('history completion retries complete recovery when another tab replaces the staged base',async({page,context})=>{
 const f=await setup(page,context);let release=()=>{};try{
 await expect(page.locator('canvas')).not.toHaveAttribute('data-asset','');const original=await page.locator('canvas').getAttribute('data-asset');await page.getByRole('treeitem').click();await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('.5');await click(page,'Apply properties');await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
 const other=await context.newPage();await other.goto(f.server.origin);await expect(other.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
 let entered=()=>{},held=false,reads=0;const hit=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const wires:string[]=[];
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST'&&JSON.parse(r.postData()!).command.body.type==='Undo')wires.push(r.postData()!);});
 await page.route('**/api/v1/events?*',async route=>{
  if(new URL(route.request().url()).searchParams.has('recoveryId')){await route.continue();return;}
  reads++;if(held){await route.continue();return;}held=true;
  const response=await route.fetch({headers:{...route.request().headers(),Origin:f.server.origin}});expect(response.status()).toBe(200);entered();await gate;await route.fulfill({response});
 });
 await click(page,'Undo');await hit;
 // A full other-tab recovery replaces/discards the old shared generation even
 // if its cursor already includes Undo. The held reader must restart its proof.
 await other.reload();await expect(other.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();release();
 await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Operation status'})).toHaveAttribute('aria-busy','false');await expect(page.locator('canvas')).toHaveAttribute('data-asset',original!);await expect(page.locator('.document-name')).toHaveText(await other.locator('.document-name').textContent()??'');expect(reads).toBeGreaterThan(1);expect(wires).toHaveLength(1);expect(Object.values(await f.server.effects()).every(x=>x===0)).toBe(true);await other.close();
 }finally{release();await page.unrouteAll({behavior:'wait'});await f.server.close();}
});

test('autosave receipt completion keeps the native Apply target stable during a held pointer press',async({page,context})=>{
 const f=await setup(page,context);let release=()=>{},pressed=false;try{
 await page.getByRole('treeitem').click();let id='';const edits:string[]=[];
 page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/commands'){const c=JSON.parse(r.postData()!).command;if(c.body.type==='FinalizeStaging')id=c.commandId;if(c.body.type==='SetLayerProperties')edits.push(r.postData()!);}});
 let entered=()=>{};const hit=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 await page.route('**/api/v1/commands/*',async route=>{
  if(!id||new URL(route.request().url()).pathname!=='/api/v1/commands/'+id){await route.continue();return;}
  const response=await route.fetch({headers:{...route.request().headers(),Origin:f.server.origin}});if(response.status()===202){await route.fulfill({response});return;}expect(response.status()).toBe(200);entered();await gate;await route.fulfill({response});
 });
 await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Stable native Apply');await page.getByRole('textbox',{name:'Layer name',exact:true}).blur();await hit;
 const apply=page.getByRole('button',{name:'Apply properties',exact:true});await apply.scrollIntoViewIfNeeded();await expect(apply).toBeEnabled();
 const node=await apply.elementHandle(),before=await apply.boundingBox();expect(node).toBeTruthy();expect(before).toBeTruthy();
 // The public native button scales while pressed; that paint transition does not
 // change layout. Compare exact host/native layout and the original hit target,
 // without waiting for, disabling, or tolerating movement in the press animation.
 const layout=()=>node!.evaluate(n=>{if(!(n instanceof HTMLButtonElement))throw Error('Expected original native Apply button');const root=n.getRootNode();if(!(root instanceof ShadowRoot)||root.host.localName!=='en-button')throw Error('Expected public en-button host');const r=root.host.getBoundingClientRect();return {host:{x:r.x,y:r.y,width:r.width,height:r.height},native:{x:n.offsetLeft,y:n.offsetTop,width:n.offsetWidth,height:n.offsetHeight}};});
 const beforeLayout=await layout(),point={x:before!.x+before!.width/2,y:before!.y+before!.height/2};await page.mouse.move(point.x,point.y);await page.mouse.down();pressed=true;
 release();await expect(page.locator('.operation-status .pending')).toHaveCount(0);await expect(page.getByRole('contentinfo').getByText('Accepted edits saved locally · Draft saved locally; not applied to the document',{exact:true})).toBeVisible();
 expect(await layout()).toEqual(beforeLayout);expect(await apply.evaluate((n,original)=>n===original,node!)).toBe(true);
 expect(await node!.evaluate((n,p)=>{
  // Native controls can be hit through slotted light-DOM labels. Follow the
  // composed hit ancestry, with the same root/retarget handling as Playwright's
  // pinned hit test, rather than requiring ordinary DOM contains across slots.
  const parent=(el:Element):Element|null=>el.parentElement??(el.parentNode instanceof ShadowRoot?el.parentNode.host:null);
  const roots:(Document|ShadowRoot)[]=[];let root=n.getRootNode();
  while(root instanceof Document||root instanceof ShadowRoot){roots.push(root);if(root instanceof Document)break;root=root.host.getRootNode();}
  let hit:Element|undefined;
  for(let index=roots.length-1;index>=0;index--){
   const root=roots[index],elements=root.elementsFromPoint(p.x,p.y),single=root.elementFromPoint(p.x,p.y);
   if(single&&elements[0]&&parent(single)===elements[0]&&getComputedStyle(single).display==='contents')elements.unshift(single);
   if(elements[0]?.shadowRoot===root&&elements[1]===single)elements.shift();
   hit=elements[0];if(!hit||(index>0&&hit!==(roots[index-1] as ShadowRoot).host))break;
  }
  while(hit&&hit!==n)hit=hit.assignedSlot??parent(hit)??undefined;
  return {connected:n.isConnected,active:n.matches(':active'),hitTarget:hit===n};
 },point)).toEqual({connected:true,active:true,hitTarget:true});
 await page.mouse.up();pressed=false;
 expect(await node!.evaluate(n=>n.isConnected)).toBe(true);await expect(page.getByRole('treeitem',{name:'Image · Stable native Apply · visible',exact:true})).toBeVisible();expect(edits).toHaveLength(1);expect((await f.read('/api/v1/commands/'+JSON.parse(edits[0]).command.commandId+'/original')).text).toBe(edits[0]);
 }finally{release();if(pressed)await page.mouse.up();await page.unrouteAll({behavior:'wait'});await f.server.close();}
});

test('lost draft receipt survives reload with exact original request; cleared draft does not return',async({page,context})=>{
 const f=await setup(page,context);try{
 await page.getByRole('treeitem').click();let wire='';let dropped=false;const sent:string[]=[];
 await page.route('**/api/v1/ui/*',async route=>{const r=route.request();if(r.method()==='POST'&&JSON.parse(r.postData()!).body.type==='SaveDraft'){sent.push(r.postData()!);if(!dropped){wire=r.postData()!;dropped=true;await route.fetch();await route.abort();return;}}await route.continue();});
 await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Lost receipt 日本語');await page.getByRole('textbox',{name:'Layer name',exact:true}).blur();await expect(page.getByRole('button',{name:'Retry original draft delivery',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('button',{name:'Retry original draft delivery',exact:true})).toBeVisible();await click(page,'Retry original draft delivery');await expect.poll(()=>sent).toEqual([wire,wire]);await expect(page.getByRole('textbox',{name:'Layer name',exact:true})).toHaveValue('Lost receipt 日本語');
 await click(page,'Cancel changes');await expect(page.getByRole('textbox',{name:'Layer name',exact:true})).toHaveValue('hidden-alpha.png');await expect.poll(()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const row=db.prepare('SELECT json FROM ui_checkpoints WHERE session_id=?').get(JSON.parse(wire).sessionId) as {json:string};db.close();return JSON.parse(row.json).drafts.some((d:any)=>d.id===JSON.parse(wire).body.draft.id);}).toBe(false);
 await page.reload();await expect(page.getByRole('textbox',{name:'Layer name',exact:true})).toHaveValue('hidden-alpha.png');
 }finally{await f.server.close();}
});

test('missing retained raster bytes block full copy visibly and remain recoverable',async({page,context})=>{
 const f=await setup(page,context);let path='',bytes:Buffer|undefined;try{
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const rows=db.prepare('SELECT json FROM assets').all() as {json:string}[];db.close();const asset=rows.map(x=>JSON.parse(x.json)).find(x=>x.qualification==='canonical-raster');expect(asset).toBeTruthy();path=join(f.root,'objects','sha256',asset.raster.pixels.hash.slice(7,9),asset.raster.pixels.hash.slice(7));bytes=await readFile(path);await unlink(path);
 await click(page,'Save copy');await click(page,'Prepare complete copy');await expect(page.getByText(/Content unavailable or missing/)).toBeVisible();await expect(page.getByRole('region',{name:'Prepared file'})).toHaveCount(0);await writeFile(path,bytes,{mode:0o600});bytes=undefined;await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Full-history copy');
 }finally{if(bytes)await writeFile(path,bytes,{mode:0o600});await f.server.close();}
});

test('real snapshot gap recovery publishes the complete current document after offline browser interval',async({page,context})=>{
 test.setTimeout(120000);const f=await setup(page,context);try{
 const id=f.last.command.documentId,clientId=f.last.command.clientId;const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const document=JSON.parse((db.prepare('SELECT json FROM documents WHERE id=?').get(id) as {json:string}).json);db.close();await page.goto('about:blank');
 let revision=BigInt(document.document?.revision??document.revision);for(let i=0;i<251;i++){const c=command(f.last.command.expectedEntityVersions,{clientId,documentId:id,expectedDocumentRevision:String(revision),body:{type:'SaveCheckpoint',name:'gap '+i}});let r=await call(f.server.origin,'/api/v1/commands',{method:'POST',body:c,headers:f.headers()});for(let n=0;r.status===202&&n<1000;n++){await new Promise(r=>setTimeout(r,5));r=await f.read('/api/v1/commands/'+c.command.commandId);}expect(r.json.receipt?.status,r.text).toBe('accepted');revision++;}
 const gaps:string[]=[];page.on('response',r=>{if(r.url().includes('/api/v1/events')&&r.status()===410)gaps.push(r.url().split('?')[0]);});
 await page.goto(f.server.origin);await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.locator('.document-name')).toContainText('revision '+revision);await expect(page.getByRole('treeitem')).toHaveCount(1);expect(gaps.length).toBeGreaterThan(0);await expect(page.locator('canvas')).not.toHaveAttribute('data-asset','');await expect(page.getByText(/Updates interrupted/)).toHaveCount(0);
 }finally{await f.server.close();}
});

test('new-port restart discovers owned pending commands with exact original bytes before same-ID receipt recovery',async({page,context},testInfo)=>{
 const f=await setup(page,context),holds:any[]=[],originals=new Map<string,string>(),failures:unknown[]=[];let restarted:Awaited<ReturnType<typeof serverProcess>>|undefined,originalPath='',originalHash='',originalLength='',originalBytes:Buffer|undefined;
 // Case-local public response evidence; never retain headers, sessions or full payloads.
 const retryEvidence:{expectedCommandId:string;expectedTransactionId:string;expectedWireHash:string;expectedWireBytes:number;cohortCommandIds:string[];observations:Record<string,string|number|boolean|null>[];dropped:number;oversized:number;invalidLength:number;parseFailures:number;bodyReadFailures:number;truncatedFields:number}={expectedCommandId:'',expectedTransactionId:'',expectedWireHash:'',expectedWireBytes:0,cohortCommandIds:[],observations:[],dropped:0,oversized:0,invalidLength:0,parseFailures:0,bodyReadFailures:0,truncatedFields:0};
 const captureReads:Promise<void>[]=[],captureLimit=64,bodyLimit=65536;
 let stopRetryCapture=()=>{};
 const scalar=(value:unknown):string|number|boolean|null=>{if(typeof value==='string'){if(value.length>256)retryEvidence.truncatedFields++;return value.slice(0,256);}return typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'?value as number|boolean:null;};
 const startRetryCapture=(origin:string)=>{
  const observed=new Map<import('@playwright/test').Request,Record<string,string|number|boolean|null>>();
  const onRequest=(request:import('@playwright/test').Request)=>{
   const url=new URL(request.url()),method=request.method();
   if(url.origin!==origin||!(method==='POST'&&url.pathname==='/api/v1/commands'||method==='GET'&&/^\/api\/v1\/commands\/[^/]+$/.test(url.pathname)))return;
   if(retryEvidence.observations.length>=captureLimit){retryEvidence.dropped++;return;}
   const row:Record<string,string|number|boolean|null>={ordinal:retryEvidence.observations.length,method,path:scalar(url.pathname),responseObserved:false};
   retryEvidence.observations.push(row);observed.set(request,row);
   if(method==='GET'){row.lookupCommandId=scalar(url.pathname.slice('/api/v1/commands/'.length));return;}
   const wire=request.postData();if(wire===null){retryEvidence.parseFailures++;return;}
   row.wireBytes=Buffer.byteLength(wire);row.wireHash='sha256:'+createHash('sha256').update(wire).digest('hex');
   if(Number(row.wireBytes)>bodyLimit){retryEvidence.oversized++;return;}
   try{const command=JSON.parse(wire)?.command;row.commandId=scalar(command?.commandId);row.transactionId=scalar(command?.transactionId);row.commandType=scalar(command?.body?.type);}catch{retryEvidence.parseFailures++;}
  };
  const onResponse=(response:import('@playwright/test').Response)=>{
   const row=observed.get(response.request());if(!row)return;
   row.responseObserved=true;row.httpStatus=response.status();
   const read=(async()=>{
    const length=response.headers()['content-length'];if(!/^(0|[1-9][0-9]*)$/.test(length??'')){retryEvidence.invalidLength++;return;}
    if(Number(length)>bodyLimit){retryEvidence.oversized++;return;}
    let bytes:Buffer;try{bytes=await response.body();}catch{retryEvidence.bodyReadFailures++;return;}
    row.responseBytes=bytes.length;if(bytes.length>bodyLimit){retryEvidence.oversized++;return;}
    try{const result=JSON.parse(bytes.toString('utf8')),receipt=result?.receipt;row.protocolVersion=scalar(result?.protocolVersion);row.kind=scalar(result?.kind);row.resultCommandId=scalar(result?.commandId);row.phase=scalar(result?.phase);row.operationId=scalar(result?.operationId);row.receiptStatus=scalar(receipt?.status);row.receiptCommandId=scalar(receipt?.commandId);row.receiptTransactionId=scalar(receipt?.transactionId);row.fromSeq=scalar(receipt?.fromSeq);row.toSeq=scalar(receipt?.toSeq);row.code=scalar(receipt?.code??result?.error?.code??result?.code);}catch{retryEvidence.parseFailures++;}
   })();void read.catch(()=>{});captureReads.push(read);
  };
  page.on('request',onRequest);page.on('response',onResponse);
  stopRetryCapture=()=>{page.off('request',onRequest);page.off('response',onResponse);};
 };
 const restoreOriginal=async()=>{if(!originalBytes)return;expect('sha256:'+createHash('sha256').update(originalBytes).digest('hex')).toBe(originalHash);expect(String(originalBytes.length)).toBe(originalLength);await writeFile(originalPath,originalBytes,{mode:0o600});expect(await readFile(originalPath)).toEqual(originalBytes);originalBytes=undefined;};
 const readCohort=()=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{db.exec('BEGIN');return {pending:db.prepare('SELECT id,hash,canonical,original,phase FROM raster_preparations ORDER BY id').all() as {id:string;hash:string;canonical:string;original:string;phase:string}[],receipts:db.prepare('SELECT id FROM commands ORDER BY id').all().filter(row=>originals.has(String(row.id)))};}finally{db.close();}};
 const assertCohort=(phase:'preparing'|'waiting-for-resources')=>{
  const cohort=readCohort();expect(originals.size).toBe(40);expect(cohort.pending.map(row=>row.id)).toEqual([...originals.keys()].sort());expect(cohort.pending.map(row=>row.phase)).toEqual(Array(40).fill(phase));expect(cohort.receipts).toEqual([]);
  for(const row of cohort.pending){expect(row.original).toBe(originals.get(row.id));const request=JSON.parse(row.original);expect(request.command.commandId).toBe(row.id);expect(request.command.clientId).toBe(f.last.command.clientId);expect(JSON.parse(row.canonical)).toEqual(request);expect(row.hash).toBe('sha256:'+createHash('sha256').update(row.canonical).digest('hex'));}
 };
 try{
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const rows=db.prepare('SELECT json FROM assets').all() as {json:string}[];db.close();const assets=rows.map(x=>JSON.parse(x.json)),original=assets.find(x=>x.qualification==='pending-decoder');expect(original).toBeTruthy();
 // The restart fault must leave the actual displayed canonical content intact.
 const displayedId=await page.locator('canvas[data-asset]').getAttribute('data-asset'),displayed=assets.find(asset=>asset.id===displayedId);expect(displayed?.qualification).toBe('canonical-raster');
 for(const ref of [displayed.blob,displayed.raster.manifest,displayed.raster.pixels])expect(original.blob.hash).not.toBe(ref.hash);
 for(let i=0;i<2;i++){const stagingId=randomUUID();expect((await call(f.server.origin,'/api/v1/assets/staging',{method:'POST',body:{protocolVersion:1,stagingId,purpose:'caption',expectedBytes:'1',sha256:'sha256:'+createHash('sha256').update('x').digest('hex'),mediaType:'text/plain'},headers:f.headers()})).status).toBe(201);const h=exchange(f.server.origin,'/api/v1/assets/staging/'+stagingId,{method:'PUT',defer:true,headers:{...f.headers(),'Content-Type':'application/octet-stream','Content-Length':'1','Upload-Offset':'0'}});h.response.catch(()=>{});h.request.flushHeaders();holds.push(h);}
 await page.waitForTimeout(30);
 for(let i=0;i<40;i++){const c=command(f.last.command.expectedEntityVersions,{clientId:f.last.command.clientId,documentId:null,expectedDocumentRevision:null,body:{type:'PrepareRaster',assetId:original.id}}),wire=JSON.stringify(c,null,2);originals.set(c.command.commandId,wire);expect((await call(f.server.origin,'/api/v1/commands',{method:'POST',raw:Buffer.from(wire),headers:f.headers()})).status).toBe(202);}
 // The exact durable cohort, not the earlier upload delay or HTTP 202, is the
 // precondition. Recheck after the old writer exits so no receipt can race it.
 assertCohort('preparing');const old=f.server.origin;await f.server.kill();holds.forEach(h=>h.request.destroy());assertCohort('preparing');
 // Missing encoded bytes survive restart. Every preparing row must fail its
 // real source proof in this new epoch and pause before restoring those bytes.
 originalPath=join(f.root,'objects','sha256',original.blob.hash.slice(7,9),original.blob.hash.slice(7));originalHash=original.blob.hash;originalLength=original.blob.byteLength;const backup=await readFile(originalPath);expect('sha256:'+createHash('sha256').update(backup).digest('hex')).toBe(originalHash);expect(String(backup.length)).toBe(originalLength);originalBytes=backup;await unlink(originalPath);
 restarted=await serverProcess(f.root);expect(restarted.origin).not.toBe(old);await expect.poll(()=>readCohort().pending.map(row=>row.phase)).toEqual(Array(40).fill('waiting-for-resources'));assertCohort('waiting-for-resources');
 const reads:Promise<void>[]=[],readIds=new Set<string>();page.on('response',r=>{const match=new URL(r.url()).pathname.match(/commands\/([^/]+)\/original$/);if(match&&originals.has(match[1])){readIds.add(match[1]);const read=r.text().then(text=>{expect(text).toBe(originals.get(match[1]));});void read.catch(()=>{});reads.push(read);}});
 await page.goto(await restarted.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect.poll(()=>readIds.size).toBe(40);await Promise.all(reads);expect([...readIds].sort()).toEqual([...originals.keys()].sort());
 const pending=page.getByRole('group',{name:'Pending operations',exact:true}),retry=pending.getByRole('button',{name:'Check and retry original',exact:true}),first=pending.getByRole('button',{name:'First pending page',exact:true}),previous=pending.getByRole('button',{name:'Previous pending page',exact:true}),next=pending.getByRole('button',{name:'Next pending page',exact:true});
 const pageRows=async(count:number)=>{await expect(retry).toHaveCount(count);await expect(pending.getByRole('status')).toHaveText(count+' pending operations on this page. Original requests remain saved locally.');await expect(page.getByRole('region',{name:'Operation status',exact:true})).toHaveAttribute('aria-busy','false');};
 await pageRows(32);await expect(first).toBeDisabled();await expect(previous).toBeDisabled();await expect(next).toBeEnabled();
 await next.click();await pageRows(8);await expect(first).toBeEnabled();await expect(previous).toBeEnabled();await expect(next).toBeDisabled();
 await previous.click();await pageRows(32);await expect(first).toBeDisabled();await expect(previous).toBeDisabled();
 await next.click();await pageRows(8);await first.click();await pageRows(32);await next.click();await pageRows(8);
 const retryId=[...originals.keys()].sort()[32],retryWires:string[]=[];retryEvidence.expectedCommandId=retryId;retryEvidence.expectedTransactionId=JSON.parse(originals.get(retryId)!).command.transactionId;retryEvidence.expectedWireHash='sha256:'+createHash('sha256').update(originals.get(retryId)!).digest('hex');retryEvidence.expectedWireBytes=Buffer.byteLength(originals.get(retryId)!);retryEvidence.cohortCommandIds=[...originals.keys()].sort();startRetryCapture(restarted.origin);page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST')retryWires.push(r.postData()!);});
 // Exact-byte restoration does not itself release any new-epoch paused ID.
 await restoreOriginal();assertCohort('waiting-for-resources');
 await retry.first().click();await expect(page.getByText('PrepareRaster accepted and saved locally.',{exact:true})).toBeVisible();expect(retryWires).toEqual([originals.get(retryId)]);expect(JSON.parse(retryWires[0]).command.commandId).toBe(retryId);await pageRows(7);await expect(next).toBeDisabled();await first.click();await pageRows(32);await next.click();await pageRows(7);expect(Object.values(await restarted.effects()).every(x=>x===0)).toBe(true);
 }catch(error){failures.push(error);}finally{
  try{stopRetryCapture();}catch(error){failures.push(error);}
  for(const result of await Promise.allSettled(captureReads))if(result.status==='rejected')failures.push(result.reason);
  try{await testInfo.attach('same-id-raster-retry-responses',{body:JSON.stringify(retryEvidence,null,2),contentType:'application/json'});}catch(error){failures.push(error);}
  try{await restoreOriginal();}catch(error){failures.push(error);}
  for(const hold of holds)try{hold.request.destroy();}catch(error){failures.push(error);}
  // kill() already owns the original process's one shutdown path. Attempt
  // every still-open owner even when another owner's cleanup has failed.
  for(const server of [f.server,restarted])try{if(server&&!server.shutdown)await server.close();}catch(error){failures.push(error);}
 }
 if(failures.length===1)throw failures[0];
 if(failures.length)throw new AggregateError(failures,'Restart recovery and owned cleanup failed');
});

test('actual SQLite FULL pauses a browser command and exact original delivery succeeds after capacity returns',async({page})=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-browser-sqlite-full-')),root=join(dir,'private'),server=await serverProcess(root,512);const wires:string[]=[];
 try{
 await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
 // Test-only disposable database fault: force an actual SQLite allocation above
 // the writer connection's 512-page limit during its real command transaction.
 const db=new DatabaseSync(join(root,'metadata.sqlite'));db.exec('CREATE TABLE browser_fault_fill(bytes BLOB); CREATE TRIGGER browser_fault_full BEFORE INSERT ON commands BEGIN INSERT INTO browser_fault_fill VALUES(zeroblob(8388608)); END;');db.close();
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST')wires.push(r.postData()!);});await click(page,'New');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeVisible();await expect(page.locator('en-dialog#editor-dialog').getByRole('region',{name:'New document needs attention',exact:true})).toContainText(/Storage paused/);await expect(page.getByText('No document open',{exact:true})).toBeVisible();const read=new DatabaseSync(join(root,'metadata.sqlite'));expect(read.prepare('SELECT count(*) n FROM commands').get()!.n).toBe(0);expect(read.prepare('SELECT count(*) n FROM documents').get()!.n).toBe(0);read.exec('DROP TRIGGER browser_fault_full; DROP TABLE browser_fault_fill;');read.close();
 await click(page,'Cancel');
 for(const viewport of [{width:320,height:700},{width:720,height:500}]){
  await page.setViewportSize(viewport);const status=page.getByRole('region',{name:'Operation status',exact:true}),retry=page.getByRole('button',{name:'Check and retry original',exact:true});await status.focus();await page.keyboard.press('End');await expect.poll(()=>status.evaluate(n=>n.scrollTop)).toBeGreaterThan(0);await page.keyboard.press('Home');await expect.poll(()=>status.evaluate(n=>n.scrollTop)).toBe(0);await page.keyboard.press('End');await expect.poll(()=>status.evaluate(n=>n.scrollTop)).toBeGreaterThan(0);
  for(let n=0;n<5&&!await retry.evaluate(n=>(n.getRootNode() as Document|ShadowRoot).activeElement===n);n++)await page.keyboard.press('Tab');await expect(retry).toBeFocused();await expect(retry).toBeInViewport({ratio:1});
  const area=await status.boundingBox(),target=await retry.boundingBox();expect(target!.y).toBeGreaterThanOrEqual(area!.y);expect(target!.y+target!.height).toBeLessThanOrEqual(area!.y+area!.height);expect(await status.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
 }
 // Guard checks follow the unchanged native 320→720 navigation sequence.
 // Synthetic keys establish handler ownership only, not native IME qualification.
 const status=page.getByRole('region',{name:'Operation status',exact:true}),retry=page.getByRole('button',{name:'Check and retry original',exact:true});
 const excluded=await status.evaluate(region=>{
  const before=region.scrollTop,focused=document.activeElement!;
  return [region,focused].map(target=>{const e=new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true});target.dispatchEvent(e);return {prevented:e.defaultPrevented,unchanged:region.scrollTop===before};});
 });expect(excluded).toEqual([{prevented:false,unchanged:true},{prevented:false,unchanged:true}]);
 await status.focus();
 const guards=await status.evaluate(region=>{
  if(document.activeElement!==region)throw Error('Guard precondition: region must own focus');
  const cases=[{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{isComposing:true},{key:'ArrowLeft'},{key:'Tab'},{key:'Enter'}];const before=region.scrollTop;
  const results=cases.map(flags=>{const e=new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true,...flags});region.dispatchEvent(e);return {prevented:e.defaultPrevented,unchanged:region.scrollTop===before};});
  const vetoed=new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true});vetoed.preventDefault();region.dispatchEvent(vetoed);const vetoPreserved=vetoed.defaultPrevented&&region.scrollTop===before;
  let propagated=false;const observe=(e:Event)=>{if(e===accepted)propagated=true;};const accepted=new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true});document.addEventListener('keydown',observe);region.dispatchEvent(accepted);document.removeEventListener('keydown',observe);
  return {results,vetoPreserved,accepted:accepted.defaultPrevented,propagated};
 });expect(guards).toEqual({results:Array.from({length:8},()=>({prevented:false,unchanged:true})),vetoPreserved:true,accepted:true,propagated:true});
 await page.keyboard.press('Shift+Tab');expect(await status.evaluate(n=>n.contains(document.activeElement))).toBe(false);
 await status.focus();await page.keyboard.press('End');for(let n=0;n<5&&!await retry.evaluate(n=>(n.getRootNode() as Document|ShadowRoot).activeElement===n);n++)await page.keyboard.press('Tab');await expect(retry).toBeFocused();await expect(retry).toBeInViewport({ratio:1});
 await page.keyboard.press('Enter');await expect(page.getByText('CreateDocument accepted and saved locally.',{exact:true})).toBeVisible();expect(wires.length).toBe(2);expect(wires[1]).toBe(wires[0]);expect(Object.values(await server.effects()).every(x=>x===0)).toBe(true);
 }finally{await server.close();}
});

test('late canvas bytes from another document cannot replace the reopened current raster',async({page,context})=>{
 const f=await setup(page,context);let release=()=>{};try{
 const first=await page.locator('canvas').getAttribute('data-asset');await click(page,'New');await page.getByRole('spinbutton',{name:'Width (px)',exact:true}).fill('2');await page.getByRole('spinbutton',{name:'Height (px)',exact:true}).fill('2');await click(page,'Create');await expect(page.locator('.document-name')).toContainText('2 × 2');await click(page,'Import image');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/white.png');await confirmImageImports(page,{names:['white.png'],destination:'current'});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.locator('canvas')).not.toHaveAttribute('data-asset',first!);const second=await page.locator('canvas').getAttribute('data-asset');
 const open=async(size:string)=>{await click(page,'Open');await page.getByRole('button',{name:new RegExp(' · '+size+' · revision')}).click();};await open('3 × 2');await expect(page.locator('canvas')).toHaveAttribute('data-asset',first!);
 // Bind the held canvas tile to the retained second raster, not its encoded original.
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});let secondAsset:any;
 try{const row=db.prepare('SELECT json FROM assets WHERE id=?').get(second!) as {json:string}|undefined;expect(row).toBeDefined();secondAsset=JSON.parse(row!.json);}finally{db.close();}
 expect(secondAsset.id).toBe(second);expect(secondAsset.raster.width).toBe(2);expect(secondAsset.raster.height).toBe(2);expect(secondAsset.raster.pixelIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
 const tileURL=f.server.origin+'/api/v1/assets/'+encodeURIComponent(second!)+'/display-tile?'+new URLSearchParams({identity:secondAsset.raster.pixelIdentity,basis:'pixels',lod:'0',x:'0',y:'0'});
 let entered=()=>{};const hit=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);await page.route(url=>url.href===tileURL,async route=>{
  const request=route.request();expect(request.method()).toBe('GET');expect(request.url()).toBe(tileURL);expect(request.frame()).toBe(page.mainFrame());
  // Node-side delivery fault uses the original browser headers and paired Origin.
  const response=await route.fetch({headers:{...request.headers(),Origin:f.server.origin}});expect(response.status()).toBe(200);expect(response.headers()['x-display-source']).toBe(secondAsset.raster.pixelIdentity);expect(response.headers()['x-display-basis']).toBe('pixels');expect(response.headers()['x-display-width']).toBe('2');expect(response.headers()['x-display-height']).toBe('2');expect(response.headers()['x-display-lod']).toBe('0');expect(response.headers()['content-type']).toBe('application/x-ideogram-rgba8');expect(response.headers()['content-length']).toBe('16');entered();await gate;await route.fulfill({response});
 });await open('2 × 2');await hit;await open('3 × 2');await expect(page.locator('.document-name')).toContainText('3 × 2');release();await click(page,'100%');await expect(page.locator('canvas')).toHaveAttribute('data-asset',first!);await page.waitForTimeout(50);await click(page,'100%');await expect(page.locator('canvas')).toHaveAttribute('data-asset',first!);
 }finally{release();await f.server.close();}
});

test('late version probe cannot publish mixed side panels across a concurrent checkpoint or renewed session',async({page,context})=>{
 const f=await setup(page,context);let release=()=>{};try{
 const other=await context.newPage();await other.goto(f.server.origin);await expect(other.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
 const old=await page.locator('.document-name').textContent();let captured=()=>{};const hit=new Promise<void>(r=>captured=r),gate=new Promise<void>(r=>release=r);let held=false;
 await page.route('**/api/v1/documents/*',async route=>{if(route.request().method()==='HEAD'&&!held){held=true;const response=await route.fetch();captured();await gate;await route.fulfill({response});return;}await route.continue();});
 await other.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('First concurrent checkpoint');await click(other,'Save checkpoint');await hit;
 await other.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Second concurrent checkpoint');await click(other,'Save checkpoint');await expect(other.getByRole('button',{name:'Open checkpoint: Second concurrent checkpoint',exact:true})).toBeVisible();
 expect(await page.locator('.document-name').textContent()).toBe(old);await expect(page.getByRole('button',{name:'Open checkpoint: First concurrent checkpoint',exact:true})).toHaveCount(0);
 release();await expect(page.locator('.document-name')).toHaveText(await other.locator('.document-name').textContent()??'');await expect(page.getByRole('button',{name:'Open checkpoint: Second concurrent checkpoint',exact:true})).toBeVisible();await page.unroute('**/api/v1/documents/*');
 // A late malformed response from the prior connection is discarded before
 // status/header interpretation; fresh recovery is independently checked.
 let next=()=>{};const renewHit=new Promise<void>(r=>next=r),renewGate=new Promise<void>(r=>release=r);held=false;
 await page.route('**/api/v1/documents/*',async route=>{if(route.request().method()==='HEAD'&&!held){held=true;await route.fetch();next();await renewGate;await route.fulfill({status:200,headers:{'X-App-Entity-Version':'01'},body:''});return;}await route.continue();});
 await other.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Before renewal');await click(other,'Save checkpoint');await renewHit;await click(page,'Connected locally');await click(page,'Renew connection');await expect(page.getByText('Connected to your local workspace.',{exact:true})).toBeVisible();release();await page.keyboard.press('Escape');await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Open checkpoint: Before renewal',exact:true})).toBeVisible();await expect(page.getByText(/Content unavailable or missing/)).toHaveCount(0);await other.close();
 }finally{release();await f.server.close();}
});

test('missing or malformed current version header withholds side panels and reload recovers',async({page,context})=>{
 const f=await setup(page,context);try{
 for(const headers of [{},{'X-App-Entity-Version':'01'}]){
 await page.route('**/api/v1/documents/*',async route=>{if(route.request().method()==='HEAD'){await route.fulfill({status:200,headers,body:''});return;}await route.continue();});
 await page.reload();await expect(page.getByText(/Content unavailable or missing/)).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(0);await page.unroute('**/api/v1/documents/*');await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem')).toHaveCount(1);
 }
 }finally{await f.server.close();}
});

test('late explicitly requested history page cannot replace a newer complete transaction view',async({page,context})=>{
 const f=await setup(page,context);let release=()=>{};try{
 const other=await context.newPage();await other.goto(f.server.origin);await expect(other.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await other.getByRole('treeitem').click();
 let captured=()=>{};const hit=new Promise<void>(r=>captured=r),gate=new Promise<void>(r=>release=r);let held=false;
 await page.route('**/api/v1/documents/*/history',async route=>{if(!held){held=true;const response=await route.fetch();captured();await gate;await route.fulfill({response});return;}await route.continue();});
 await click(page,'First history page');await hit;await other.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('.4');await click(other,'Apply properties');await expect(other.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.locator('.document-name')).toHaveText(await other.locator('.document-name').textContent()??'');await expect(page.locator('en-activity-feed')).toContainText('SetLayerProperties');release();await expect(page.getByRole('region',{name:'Operation status'})).toHaveAttribute('aria-busy','false');await expect(page.locator('en-activity-feed')).toContainText('SetLayerProperties');await other.close();
 }finally{release();await f.server.close();}
});

test('new inspector drafts preserve valid128-character IDs and distinctly bound longer targets',async({page,context})=>{
 const f=await setup(page,context);try{
 const documentId=f.last.command.documentId,clientId=f.last.command.clientId;const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const assets=db.prepare('SELECT json FROM assets').all() as {json:string}[];db.close();const asset=assets.map(x=>JSON.parse(x.json)).find(x=>x.qualification==='canonical-raster');const observed:any[]=[];
 page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/ui/')&&r.method()==='POST'){const b=JSON.parse(r.postData()!).body;if(b.type==='SaveDraft')observed.push(b.draft);}});
 for(const size of [127,128,129]){
 const layerId=('boundary_'+size+'_').padEnd(size-'inspector_'.length-documentId.length-1,'x');const d=(await f.read('/api/v1/documents/'+documentId)).json.projection.value;
 const c=command(f.last.command.expectedEntityVersions,{clientId,documentId,expectedDocumentRevision:d.revision,body:{type:'ImportAsset',assetId:asset.id,layerId,name:'Boundary '+size,draft:null}});let r=await call(f.server.origin,'/api/v1/commands',{method:'POST',body:c,headers:f.headers()});for(let n=0;r.status===202&&n<1000;n++){await new Promise(r=>setTimeout(r,5));r=await f.read('/api/v1/commands/'+c.command.commandId);}expect(r.json.receipt.status).toBe('accepted');
 await page.getByRole('treeitem',{name:'Image · Boundary '+size+' · visible',exact:true}).click();await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Edited boundary '+size);await click(page,'Apply properties');await expect(page.getByRole('treeitem',{name:'Image · Edited boundary '+size+' · visible',exact:true})).toBeVisible();
 const draft=observed.find(d=>d.targetLayerId===layerId);expect(draft).toBeTruthy();expect(draft.documentId).toBe(documentId);expect(draft.id.length).toBeLessThanOrEqual(128);if(size<=128)expect(draft.id).toBe('inspector_'+documentId+'_'+layerId);else expect(draft.id).toMatch(/^inspector_[0-9a-f]{64}$/);
 }
 expect(new Set(observed.map(d=>d.id)).size).toBe(3);await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();for(const size of [127,128,129])await expect(page.getByRole('treeitem',{name:'Image · Edited boundary '+size+' · visible',exact:true})).toBeVisible();
 }finally{await f.server.close();}
});
