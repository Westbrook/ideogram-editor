import {specReceipt} from './receipt-path.js';
import {test,expect,type BrowserContext} from '@playwright/test';
import {mkdtemp,realpath,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {serverProcess} from './process.js';
import {confirmImageImports} from './image-import-flow.js';
import {ownedOPFS} from './owned-opfs.js';
// @ts-ignore Independent small-fixture archive reader.
import {unpack,records} from '../portable/archive-fixture.mjs';

test('explicit incomplete recovery consent, actual download, and inspection-only reopen',async({playwright,browserName})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-recovery-copy-')),profile=join(directory,'browser');
 let ownedServer:Awaited<ReturnType<typeof serverProcess>>|undefined,ownedContext:BrowserContext|undefined,ownedGuard:Awaited<ReturnType<typeof ownedOPFS>>|undefined,result:unknown;
 const errors:string[]=[],commands:any[]=[],external:string[]=[],problems:{phase:string;error:unknown}[]=[];
 try{
  const server=ownedServer=await serverProcess(join(directory,'private'));
  const context=ownedContext=await playwright[browserName].launchPersistentContext(profile,{viewport:{width:1440,height:1000}});
  const guard=ownedGuard=await ownedOPFS(context,profile);
  // Keep the persistent context's initial page alive through handoff.
  const page=context.pages().find(page=>!page.isClosed())??await context.newPage();
  await Promise.all(context.pages().filter(other=>other!==page).map(other=>other.close()));
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server.origin)external.push(url.origin);if(url.pathname==='/api/v1/commands'&&request.method()==='POST')commands.push(request.postDataJSON().command);});
 await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Import image',exact:true}).click();await page.locator('en-file-upload[label="Image file"] input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
  const importDialog=page.getByRole('dialog',{name:'Import image',exact:true});await expect(importDialog).toBeVisible();const controls=page.locator('en-dialog#editor-dialog');await controls.getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');await controls.getByRole('button',{name:'Cancel',exact:true}).click();await expect(importDialog).toBeHidden();
  const copy=page.getByRole('button',{name:'Save copy',exact:true}),prepare=page.getByRole('button',{name:'Prepare incomplete recovery copy',exact:true}),ack=page.getByRole('switch',{name:'I understand this is an incomplete sanitized recovery copy',exact:true});
  await copy.click();await expect(prepare).toBeDisabled();await expect(page.getByRole('dialog',{name:'Save project copy'})).toBeVisible();await expect(controls).toContainText('History, checkpoints, drafts, jobs');await expect(controls).toContainText('cannot reopen an editable document');await ack.click();await expect(prepare).toBeEnabled();
  await controls.getByRole('button',{name:'Cancel',exact:true}).click();await copy.click();await expect(ack).not.toBeChecked();await expect(prepare).toBeDisabled();expect(commands.filter(c=>c.body.type==='SaveRecoveryCopy')).toHaveLength(0);
  await ack.click();await prepare.click();const prepared=page.getByRole('region',{name:'Prepared file'});await expect(prepared).toContainText('Incomplete sanitized recovery copy');await expect(prepared).toContainText('Inspection only');await expect(prepared).toContainText('Ready — destination unconfirmed');
  const event=page.waitForEvent('download');await prepared.getByRole('button',{name:'Download prepared file',exact:true}).click();const download=await event,path=join(directory,'download.ideogram-project');expect(download.suggestedFilename()).toBe('project.recovery.ideogram-project');await download.saveAs(path);await expect(prepared).toContainText('Download initiated — destination unconfirmed');
  const bytes=await readFile(path),entries=await unpack(directory,bytes),manifest=JSON.parse(entries.get('manifest.json')),all=records(entries).values;
  expect(manifest.formatVersion).toBe(11);expect(manifest.complete).toBe(false);expect(manifest.recovery.authority).toBe('observation-only');expect(all.some((r:any)=>r.kind==='event'||r.kind==='transaction')).toBe(false);expect(all.filter((r:any)=>r.kind==='entity').every((r:any)=>r.entityType.startsWith('recovery-'))).toBe(true);
  const recoveryCommands=commands.filter(c=>c.body.type==='SaveRecoveryCopy');expect(recoveryCommands).toHaveLength(1);expect(recoveryCommands[0].body.acknowledgementId).toBe(manifest.recovery.acknowledgementId);
  await page.getByRole('button',{name:'Open',exact:true}).click();await page.locator('en-file-upload').filter({has:page.getByText('Open portable project',{exact:true})}).locator('input[type=file]').setInputFiles(path);const review=page.getByRole('dialog',{name:'Review portable project'});await expect(review).toBeVisible();const reviewControls=page.locator('en-dialog#review-dialog');await expect(reviewControls).toContainText('Incomplete sanitized recovery copy');await expect(reviewControls.getByRole('button',{name:'Apply reviewed result',exact:true})).toBeDisabled();expect(commands.some(c=>c.body.type==='ImportBundle')).toBe(false);
  expect(errors).toEqual([]);expect(external).toEqual([]);expect(Object.values(await server.effects()).every(v=>v===0)).toBe(true);result={browserName,bytes:bytes.length,manifest,recoveryCommands:recoveryCommands.length,editableImport:false,providerEffects:await server.effects()};
 }catch(error){problems.push({phase:'workflow',error});}finally{
  const attempt=async(phase:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){problems.push({phase,error});}};
  await attempt('owned-storage',async()=>{if(ownedGuard){await ownedGuard.cleanup();ownedGuard.verify();}});
  await attempt('context-close',async()=>{await ownedContext?.close();});
  await attempt('server-close',async()=>{await ownedServer?.close();});
  await attempt('receipt',async()=>{const output=specReceipt(import.meta.url,'artifacts/p1b7/current');await mkdir(output,{recursive:true});await writeFile(join(output,'recovery-copy-'+browserName+'.json'),JSON.stringify({result,errors,external,ledger:ownedGuard?.ledger??[],failures:problems.map(({phase,error})=>({phase,message:String(error)}))},null,2));});
  if(result&&problems.length===0)await attempt('profile-remove',()=>rm(directory,{recursive:true,force:true}));
 }
 if(problems.length)throw new AggregateError(problems.map(problem=>problem.error),'Recovery copy workflow and independent cleanup failures (all preserved)');
});
