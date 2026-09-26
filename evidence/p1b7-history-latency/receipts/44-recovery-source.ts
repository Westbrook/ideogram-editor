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
 await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await click(page,'Apply reviewed result');await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
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
 const node=await apply.elementHandle(),before=await apply.boundingBox();expect(before).toBeTruthy();await page.mouse.move(before!.x+before!.width/2,before!.y+before!.height/2);await page.mouse.down();pressed=true;
 release();await expect(page.locator('.operation-status .pending')).toHaveCount(0);await expect(page.getByText('Draft saved locally; not applied to the document',{exact:true})).toBeVisible();
 const after=await apply.boundingBox();await page.mouse.up();pressed=false;
 expect(await node!.evaluate(n=>n.isConnected)).toBe(true);expect(after).toEqual(before);await expect(page.getByRole('treeitem',{name:'Stable native Apply · visible',exact:true})).toBeVisible();expect(edits).toHaveLength(1);expect((await f.read('/api/v1/commands/'+JSON.parse(edits[0]).command.commandId+'/original')).text).toBe(edits[0]);
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

test('new-port restart discovers owned pending commands with exact original bytes before same-ID receipt recovery',async({page,context})=>{
 const f=await setup(page,context),holds:any[]=[],originals=new Map<string,string>();let restarted:Awaited<ReturnType<typeof serverProcess>>|undefined;
 try{
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const rows=db.prepare('SELECT json FROM assets').all() as {json:string}[];db.close();const original=rows.map(x=>JSON.parse(x.json)).find(x=>x.qualification==='pending-decoder');expect(original).toBeTruthy();
 for(let i=0;i<2;i++){const stagingId=randomUUID();expect((await call(f.server.origin,'/api/v1/assets/staging',{method:'POST',body:{protocolVersion:1,stagingId,purpose:'caption',expectedBytes:'1',sha256:'sha256:'+createHash('sha256').update('x').digest('hex'),mediaType:'text/plain'},headers:f.headers()})).status).toBe(201);const h=exchange(f.server.origin,'/api/v1/assets/staging/'+stagingId,{method:'PUT',defer:true,headers:{...f.headers(),'Content-Type':'application/octet-stream','Content-Length':'1','Upload-Offset':'0'}});h.response.catch(()=>{});h.request.flushHeaders();holds.push(h);}
 await page.waitForTimeout(30);
 for(let i=0;i<40;i++){const c=command(f.last.command.expectedEntityVersions,{clientId:f.last.command.clientId,documentId:null,expectedDocumentRevision:null,body:{type:'PrepareRaster',assetId:original.id}}),wire=JSON.stringify(c,null,2);originals.set(c.command.commandId,wire);expect((await call(f.server.origin,'/api/v1/commands',{method:'POST',raw:Buffer.from(wire),headers:f.headers()})).status).toBe(202);}
 const old=f.server.origin;await f.server.kill();holds.forEach(h=>h.request.destroy());restarted=await serverProcess(f.root);expect(restarted.origin).not.toBe(old);const reads:Promise<void>[]=[];page.on('response',r=>{const match=new URL(r.url()).pathname.match(/commands\/([^/]+)\/original$/);if(match&&originals.has(match[1]))reads.push(r.text().then(text=>{expect(text).toBe(originals.get(match[1]));}));});await page.goto(await restarted.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Check and retry original',exact:true}).first()).toBeVisible();expect(reads.length).toBeGreaterThan(0);await Promise.all(reads);await page.getByRole('button',{name:'Check and retry original',exact:true}).first().click();await expect(page.getByText('PrepareRaster accepted and saved locally.',{exact:true})).toBeVisible();expect(Object.values(await restarted.effects()).every(x=>x===0)).toBe(true);
 }finally{holds.forEach(h=>h.request.destroy());await f.server.close();await restarted?.close();}
});

test('actual SQLite FULL pauses a browser command and exact original delivery succeeds after capacity returns',async({page})=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'ie-browser-sqlite-full-')),root=join(dir,'private'),server=await serverProcess(root,512);const wires:string[]=[];
 try{
 await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
 // Test-only disposable database fault: force an actual SQLite allocation above
 // the writer connection's 512-page limit during its real command transaction.
 const db=new DatabaseSync(join(root,'metadata.sqlite'));db.exec('CREATE TABLE browser_fault_fill(bytes BLOB); CREATE TRIGGER browser_fault_full BEFORE INSERT ON commands BEGIN INSERT INTO browser_fault_fill VALUES(zeroblob(8388608)); END;');db.close();
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST')wires.push(r.postData()!);});await click(page,'New');await click(page,'Create');await expect(page.getByText(/Storage paused/)).toBeVisible();await expect(page.getByText('No document open',{exact:true})).toBeVisible();const read=new DatabaseSync(join(root,'metadata.sqlite'));expect(read.prepare('SELECT count(*) n FROM commands').get()!.n).toBe(0);expect(read.prepare('SELECT count(*) n FROM documents').get()!.n).toBe(0);read.exec('DROP TRIGGER browser_fault_full; DROP TABLE browser_fault_fill;');read.close();
 await click(page,'Cancel');
 for(const viewport of [{width:320,height:700},{width:720,height:500}]){
  await page.setViewportSize(viewport);const status=page.getByRole('region',{name:'Operation status',exact:true}),retry=page.getByRole('button',{name:'Check and retry original',exact:true});await status.focus();await page.keyboard.press('End');await expect.poll(()=>status.evaluate(n=>n.scrollTop)).toBeGreaterThan(0);
  for(let n=0;n<5&&!await retry.evaluate(n=>n.getRootNode().activeElement===n);n++)await page.keyboard.press('Tab');await expect(retry).toBeFocused();
  const area=await status.boundingBox(),target=await retry.boundingBox();expect(target!.y).toBeGreaterThanOrEqual(area!.y);expect(target!.y+target!.height).toBeLessThanOrEqual(area!.y+area!.height);expect(await status.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
 }
 await page.keyboard.press('Enter');await expect(page.getByText('NewDocument accepted and saved locally.',{exact:true})).toBeVisible();expect(wires.length).toBe(2);expect(wires[1]).toBe(wires[0]);expect(Object.values(await server.effects()).every(x=>x===0)).toBe(true);
 }finally{await server.close();}
});

test('late canvas bytes from another document cannot replace the reopened current raster',async({page,context})=>{
 const f=await setup(page,context);let release=()=>{};try{
 const first=await page.locator('canvas').getAttribute('data-asset');await click(page,'New');await page.getByRole('spinbutton',{name:'Width (px)',exact:true}).fill('2');await page.getByRole('spinbutton',{name:'Height (px)',exact:true}).fill('2');await click(page,'Create');await expect(page.locator('.document-name')).toContainText('2 × 2');await click(page,'Import image');await page.locator('en-file-upload[label="Image file"] input[type=file]').setInputFiles('tests/raster/fixtures/white.png');await click(page,'Apply reviewed result');await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.locator('canvas')).not.toHaveAttribute('data-asset',first!);const second=await page.locator('canvas').getAttribute('data-asset');
 const open=async(size:string)=>{await click(page,'Open');await page.getByRole('button',{name:new RegExp(' · '+size+' · revision')}).click();};await open('3 × 2');await expect(page.locator('canvas')).toHaveAttribute('data-asset',first!);
 let entered=()=>{};const hit=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);await page.route('**/api/v1/assets/'+second+'/content',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});});await open('2 × 2');await hit;await open('3 × 2');await expect(page.locator('.document-name')).toContainText('3 × 2');release();await click(page,'100%');await expect(page.locator('canvas')).toHaveAttribute('data-asset',first!);await page.waitForTimeout(50);await click(page,'100%');await expect(page.locator('canvas')).toHaveAttribute('data-asset',first!);
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
 await page.getByRole('treeitem',{name:'Boundary '+size+' · visible',exact:true}).click();await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Edited boundary '+size);await click(page,'Apply properties');await expect(page.getByRole('treeitem',{name:'Edited boundary '+size+' · visible',exact:true})).toBeVisible();
 const draft=observed.find(d=>d.targetLayerId===layerId);expect(draft).toBeTruthy();expect(draft.documentId).toBe(documentId);expect(draft.id.length).toBeLessThanOrEqual(128);if(size<=128)expect(draft.id).toBe('inspector_'+documentId+'_'+layerId);else expect(draft.id).toMatch(/^inspector_[0-9a-f]{64}$/);
 }
 expect(new Set(observed.map(d=>d.id)).size).toBe(3);await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();for(const size of [127,128,129])await expect(page.getByRole('treeitem',{name:'Edited boundary '+size+' · visible',exact:true})).toBeVisible();
 }finally{await f.server.close();}
});
