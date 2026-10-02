import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,realpath,readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {serverProcess} from './process.js';
import {confirmImageImports,importReviewedImage} from './image-import-flow.js';
import {specReceipt} from './receipt-path.js';

const image='tests/raster/fixtures/hidden-alpha.png';
const storage=(page:Page)=>page.getByRole('dialog',{name:'Storage library',exact:true});
// Slotted content belongs to the public host, outside the native dialog's DOM subtree.
const storageHost=(page:Page)=>page.locator('en-dialog#editor-dialog');
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
function authoritative(root:string){
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});db.exec('BEGIN');
 try{return {documents:db.prepare('SELECT id,json FROM documents ORDER BY id').all(),history:db.prepare('SELECT id,json FROM history ORDER BY id').all(),assets:db.prepare('SELECT id,json FROM assets ORDER BY id').all(),highWater:db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value,events:db.prepare('SELECT count(*) AS count FROM events_v2').get()!.count};}
 finally{db.exec('ROLLBACK');db.close();}
}
async function setup(page:Page,name:string){
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-storage-'+name+'-')),root=join(directory,'private'),out=join(specReceipt(import.meta.url),name);await mkdir(out,{recursive:true});
 let server=await serverProcess(root);const errors:string[]=[],posts:{path:string;body:unknown}[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/v1/storage/'))posts.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
 const connect=async()=>{await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();};
 try{await connect();}catch(error){try{await server.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Storage fixture acquisition and cleanup failed');}throw error;}
 return {root,directory,out,posts,async restart(change:()=>Promise<unknown>){await page.goto('about:blank');const effects=await server.effects();expect(Object.keys(effects)).toHaveLength(8);expect(Object.values(effects).every(value=>value===0)).toBe(true);await server.close();await change();server=await serverProcess(root);await connect();},async finish(){try{await writeFile(join(out,'observations.json'),JSON.stringify({root,posts,pageErrors:errors},null,2));expect(errors).toEqual([]);const effects=await server.effects();expect(Object.keys(effects)).toHaveLength(8);expect(Object.values(effects).every(value=>value===0)).toBe(true);}finally{await page.goto('about:blank').catch(()=>{});await server.close();}}};
}
async function openStorage(page:Page){await click(page,'Storage library');await expect(storage(page)).toBeVisible();await expect(storageHost(page).getByRole('table',{name:'Known content by category',exact:true})).toBeVisible();}
async function inspect(page:Page,assetId:string){await openStorage(page);await storageHost(page).getByRole('button',{name:'Inspect Encoded originals',exact:true}).click();await storageHost(page).getByRole('button',{name:'Inspect dependencies for '+assetId,exact:true}).click();await expect(storageHost(page).getByRole('region',{name:'Asset dependencies',exact:true})).toBeVisible();}

// These use the real local service and public En Reve controls. They are
// correctness/reflow cases, not resource or physical-performance qualification.
test('storage library exposes bounded categories, safe preview clearing and explicit existing recovery handoffs',async({page})=>{
 const f=await setup(page,'inventory');try{
  await openStorage(page);await expect(storageHost(page)).toContainText('Physical app disk usage is not measured');await expect(storageHost(page)).toContainText('Categories can overlap');
  for(const width of [320,720,1440]){await page.setViewportSize({width,height:1000});for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});const region=storageHost(page).getByRole('region',{name:'Known content by category',exact:true});await region.focus();await expect(region).toBeFocused();const box=await region.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(-1);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}}
  await storageHost(page).getByRole('button',{name:'Restore copy as a new project',exact:true}).click();await expect(page.getByRole('dialog',{name:'Open document',exact:true})).toBeVisible();await expect(page.locator('en-file-upload[label="Open portable project"] input')).toBeAttached();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await openStorage(page);await storageHost(page).getByRole('button',{name:'Import as a new asset',exact:true}).click();const importing=page.getByRole('dialog',{name:'Import image',exact:true});await expect(importing).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles(image);await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',openIndex:0});
  await page.locator('#close-document').click();await expect(page.getByText('No document open',{exact:true})).toBeVisible();const before=authoritative(f.root);await openStorage(page);
  const clear=storageHost(page).getByRole('button',{name:'Clear unpinned previews',exact:true});await expect(clear).toBeEnabled();const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/storage/preview-cache/clear'&&r.request().method()==='POST');await clear.click();const result=await response;expect(result.status()).toBe(200);const body=await result.json();expect(body.removedEntries).toBeGreaterThan(0);expect(BigInt(body.freedLogicalBytes)).toBeGreaterThan(0n);await expect(storageHost(page)).toContainText('Untracked files were retained');expect(authoritative(f.root)).toEqual(before);
  expect(f.posts).toHaveLength(1);expect(f.posts[0].body).toEqual({protocolVersion:1,scope:'registered-unpinned-display-derivatives'});
 }finally{await f.finish();}
});

for(const condition of ['missing','corrupt'] as const)test('public exact repair restores '+condition+' original bytes without changing authoritative asset or history identity',async({page})=>{
 const f=await setup(page,condition),bytes=await readFile(image),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');try{
  await importReviewedImage(page,image);await page.locator('#close-document').click();await expect(page.getByText('No document open',{exact:true})).toBeVisible();
  const before=authoritative(f.root),assets=before.assets.map(row=>JSON.parse(String(row.json))),original=assets.find(asset=>asset.purpose==='image'&&asset.qualification==='pending-decoder'&&asset.blob.hash===hash);expect(original).toBeDefined();const path=join(f.root,'objects','sha256',hash.slice(7,9),hash.slice(7));expect(await readFile(path)).toEqual(bytes);
  await f.restart(async()=>{if(condition==='missing')await unlink(path);else{const corrupt=Buffer.from(bytes);corrupt[0]=corrupt[0]!^1;await writeFile(path,corrupt,{mode:0o600});}});
  await inspect(page,original.id);await storageHost(page).getByRole('button',{name:'Review exact repair '+hash,exact:true}).first().click();const repair=storageHost(page).getByRole('region',{name:'Exact file repair',exact:true});await expect(repair.getByRole('heading',{name:'Exact file repair: '+condition,exact:true})).toBeVisible();
  await repair.locator('en-file-upload[label="Exact repair file"] input').setInputFiles({name:'exact-original.png',mimeType:'image/png',buffer:bytes});await repair.getByRole('button',{name:'Relink exact file',exact:true}).click();await expect(storageHost(page).getByRole('status').filter({hasText:'Restored: '+original.id})).toBeVisible();expect(await readFile(path)).toEqual(bytes);expect(authoritative(f.root)).toEqual(before);expect(f.posts).toHaveLength(1);expect(f.posts[0].path).toBe('/api/v1/storage/assets/'+original.id+'/relink');
  await storageHost(page).getByRole('button',{name:'Close',exact:true}).click();await f.restart(async()=>{});expect(await readFile(path)).toEqual(bytes);expect(authoritative(f.root)).toEqual(before);
  await inspect(page,original.id);await storageHost(page).getByRole('button',{name:'Review exact repair '+hash,exact:true}).first().click();await expect(storageHost(page).getByRole('heading',{name:'Exact file repair: available',exact:true})).toBeVisible();await expect(storageHost(page).getByRole('button',{name:'Relink exact file',exact:true})).toHaveCount(0);expect(f.posts).toHaveLength(1);
 }finally{await f.finish();}
});
