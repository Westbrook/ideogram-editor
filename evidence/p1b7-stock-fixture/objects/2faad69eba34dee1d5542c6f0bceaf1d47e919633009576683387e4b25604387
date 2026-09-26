import {test as base,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import sharp from 'sharp';
import {serverProcess} from './process.js';
import {recordDOMErrors} from './error-monitor.js';
import {ownedOPFS} from './owned-opfs.js';
import {expectedShutdownConsole,expectedShutdownPageError} from './shutdown-console.js';
// Test archive reader is independent of the browser adapter; small fixture only.
// @ts-ignore
import {unpack,records} from '../portable/archive-fixture.mjs';
// WebKit's ephemeral contexts do not expose OPFS. Only this durable portable
// journey uses a fresh profile AND verified empty native OPFS per origin.
// Profile directories alone do not isolate WebKit OPFS; other tests keep ephemeral coverage.
const profiles=new WeakMap<object,string>();
const test=base.extend<{e1Errors:{domErrors:unknown[];finish:()=>Promise<void>};e1Storage:Awaited<ReturnType<typeof ownedOPFS>>}>({context:async({playwright,browserName,contextOptions,viewport},use)=>{
 const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-webkit-e1-')):undefined;
 const browser=profile?undefined:await playwright[browserName].launch();
 const context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
 profiles.set(context,profile??browserName+' ephemeral context');
 // Close the persistent launcher's unused blank page. The ordinary page fixture
 // owns the workflow page; all observers are installed before app navigation.
 await Promise.all(context.pages().map(page=>page.close()));
 try{await use(context);}finally{await context.close();await browser?.close();if(profile)await rm(profile,{recursive:true,force:true});}
},e1Errors:async({context},use)=>{
 const monitor={domErrors:await recordDOMErrors(context),finish:async()=>{}};
 try{await use(monitor);}finally{await context.close();await monitor.finish();expect(monitor.domErrors).toEqual([]);}
},e1Storage:async({context,e1Errors,browserName},use)=>{
 void e1Errors;const storage=await ownedOPFS(context,profiles.get(context)??browserName+' ephemeral context');
 try{await use(storage);}finally{try{await storage.cleanup();storage.verify();}finally{await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'e1-storage.json'),JSON.stringify({run:storage.run,ledger:storage.ledger},null,2));}}
}});
const accepted=(page:Page,type:string)=>expect(page.getByText(type+' accepted and saved locally.',{exact:true})).toBeVisible();
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
async function download(page:Page,path:string){const received=page.waitForEvent('download');await click(page,'Download prepared file');await (await received).saveAs(path);await expect(page.getByText(/External destination remains unconfirmed/)).toBeVisible();await mkdir(receipt,{recursive:true});await copyFile(path,join(receipt,basename(path)));}
test('E1 browser copy, actual process restart/new port, reviewed reopen and exact downloaded PNG',async({page,context,browserName,e1Errors,e1Storage})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-browser-e1-')),root=join(directory,'private');let server=await serverProcess(root);const errors:string[]=[],requests:string[]=[],expectedFailures:string[]=[];let disrupting=false,succeeded=false;const retiredOrigins=new Set<string>();const consoleObservations:{text:string;url:string;disrupting:boolean;retiredOrigin:boolean;expected:boolean}[]=[];
 const pageErrors:{name:string;message:string;stack:string;disrupting:boolean;expected:boolean}[]=[],domErrors=e1Errors.domErrors;
 await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
 page.on('pageerror',e=>{const observation={browser:browserName,name:e.name,message:e.message,stack:e.stack??'',disrupting,retiredOrigins},expected=expectedShutdownPageError(observation);pageErrors.push({name:e.name,message:e.message,stack:e.stack??'',disrupting,expected});if(!expected)errors.push(e.message);});page.on('console',m=>{if(m.type()==='error'){const url=m.location().url,expected=expectedShutdownConsole({browser:browserName,text:m.text(),url,disrupting,retiredOrigins});let safeUrl='',retiredOrigin=false;try{const parsed=new URL(url);safeUrl=parsed.origin+parsed.pathname;retiredOrigin=retiredOrigins.has(parsed.origin);}catch{}consoleObservations.push({text:m.text(),url:safeUrl,disrupting,retiredOrigin,expected});if(expected)expectedFailures.push(m.text());else errors.push(m.text());}});
 e1Errors.finish=async()=>{await writeFile(join(receipt,'e1-console.json'),JSON.stringify({browser:browserName,retiredOrigins:[...retiredOrigins],observations:consoleObservations,pageErrors,domErrors},null,2));expect(errors).toEqual([]);};
 page.on('request',r=>{const u=new URL(r.url());if(u.protocol!=='blob:'){requests.push(u.pathname);expect(u.hostname).toBe('127.0.0.1');}});
 try{
 await e1Storage.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
 await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await expect(page.getByRole('dialog',{name:'Review image conversion'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportAsset');
 await page.getByRole('treeitem').first().click();await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('0.5');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');await click(page,'Undo');await accepted(page,'Undo');
 await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('日本語 🌿 retained unapplied prompt');await page.getByRole('textbox',{name:'Prompt',exact:true}).blur();await expect(page.getByText('Draft saved locally; not applied to the document').first()).toBeVisible();
 await page.getByRole('textbox',{name:'Checkpoint name',exact:true}).fill('Before copy');await click(page,'Save checkpoint');await accepted(page,'SaveCheckpoint');
 await click(page,'Save copy');await click(page,'Prepare complete copy');await expect(page.getByRole('region',{name:'Prepared file'})).toBeVisible();
 const bundlePath=join(directory,'project.ideogram-project');await download(page,bundlePath);const entries=await unpack(directory,await readFile(bundlePath)),all=records(entries).values;
 const events=records(entries,'events').values.map((x:any)=>x.event);expect(events.some((e:any)=>e.type==='HistoryNavigated')).toBe(true);expect(events.some((e:any)=>e.type==='CheckpointSaved')).toBe(true);
 const entities=all.filter((x:any)=>x.kind==='entity').map((x:any)=>({kind:x.entityType,value:JSON.parse(entries.get('objects/'+x.payloadRef.hash.slice(7)))}));
 expect(entities.filter((x:any)=>x.kind==='history').length).toBe(3);expect(entities.filter((x:any)=>x.kind==='checkpoint').length).toBe(1);expect(entities.some((x:any)=>x.kind==='draft')).toBe(true);
 const originalPixels=await sharp('tests/raster/fixtures/hidden-alpha.png').ensureAlpha().raw().toBuffer();
 const effects=await server.effects();expect(Object.values(effects).every(v=>v===0)).toBe(true);const oldOrigin=server.origin,oldPid=server.pid;disrupting=true;retiredOrigins.add(server.origin);await server.kill();
 server=await serverProcess(root);expect(server.pid).not.toBe(oldPid);expect(server.origin).not.toBe(oldOrigin);await e1Storage.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
 expect(await page.evaluate(async()=> (await indexedDB.databases()).filter(d=>d.name?.startsWith('ie-delivery-')).length)).toBe(1);
 await click(page,'Open');await page.getByRole('button',{name:/^Restore ui_/}).click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
 await click(page,'Open');await page.locator('en-file-upload').filter({has:page.getByText('Open portable project',{exact:true})}).locator('input[type=file]').setInputFiles(bundlePath);
 await expect(page.getByRole('dialog',{name:'Review portable project'})).toBeVisible();await click(page,'Apply reviewed result');await accepted(page,'ImportBundle');
 await click(page,'Export image');await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('Exact PNG');const pngPath=join(directory,'image.png');await download(page,pngPath);expect(await sharp(pngPath).ensureAlpha().raw().toBuffer()).toEqual(originalPixels);
 disrupting=true;retiredOrigins.add(server.origin);await server.kill();server=await serverProcess(root);await e1Storage.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();disrupting=false;
 await click(page,'Open');const mapped=page.getByRole('button',{name:/^Restore p_/});await expect(mapped).not.toHaveCount(0);
 await mapped.click();await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('日本語 🌿 retained unapplied prompt');
 await click(page,'Save copy');await click(page,'Prepare complete copy');const nestedPath=join(directory,'nested.ideogram-project');await download(page,nestedPath);const nested=await readFile(nestedPath);expect(nested.includes(await readFile(bundlePath))).toBe(true);
 // New drafts on mapped IDs must obey the same bounded ID contract. Existing
 // mapped saved drafts retain their original identities and exact text.
 const newDrafts:any[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/ui/')&&r.method()==='POST'){const b=JSON.parse(r.postData()!).body;if(b.type==='SaveDraft'&&b.draft.kind==='inspector')newDrafts.push(b.draft);}});
 await page.getByRole('treeitem').first().click();await page.getByRole('textbox',{name:'Layer name',exact:true}).fill('Editable after portable reopen');await click(page,'Apply properties');await accepted(page,'SetLayerProperties');expect(newDrafts.length).toBeGreaterThan(0);expect(newDrafts.every(d=>d.id.length<=128&&d.documentId.startsWith('p_')&&d.targetLayerId.startsWith('p_'))).toBe(true);await page.reload();await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('treeitem',{name:'Editable after portable reopen · visible'})).toBeVisible();
 await expect(page.getByText(/Updates interrupted/)).toHaveCount(0);expect(errors).toEqual([]);expect(domErrors).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);
 await writeFile(join(receipt,'e1.json'),JSON.stringify({browserContext:browserName==='webkit'?'fresh profile plus verified empty native OPFS at every origin':'ephemeral',expectedFailures,oldPid,newPid:server.pid,oldOrigin,newOrigin:server.origin,networkPaths:[...new Set(requests)],providerEffects:effects,downloadedBundleBytes:(await readFile(bundlePath)).length,sourceEvents:events.length,sourceEntities:entities.length,exactPixels:true,externalDestination:'unconfirmed',osPicker:'not exercised; real browser fallback download tested'},null,2));
 succeeded=true;
 // Successful rail screenshots are captured separately: WebKit screenshot
 // tooling injects inline styles. Keep this error oracle strict through teardown.
 }finally{await page.close();await server.close();if(succeeded)await rm(directory,{recursive:true});else{await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'e1-incomplete-root.json'),JSON.stringify({directory,cleanup:'retained failed workflow evidence; not complete'}));}}
});
