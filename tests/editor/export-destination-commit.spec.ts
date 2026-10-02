import {specReceipt} from './receipt-path.js';
import {confirmImageImports} from './image-import-flow.js';
import {test,expect,type Response} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverProcess} from './process.js';
import {ownedOPFS} from './owned-opfs.js';
import {publicReadRequest} from '../request/persistence-witness.js';

// This exercises the real shell and destination adapter with a native OPFS
// stream. Only picker selection and the acknowledgement after close are
// controlled; the fixture does not qualify an operating-system save dialog.
test('J6 a lost native close acknowledgement is failed and unconfirmed after destination commit',async({playwright,browserName})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-export-commit-')),profile=join(directory,'browser'),server=await serverProcess(join(directory,'private'));
 const context=await playwright[browserName].launchPersistentContext(profile,{viewport:{width:1440,height:1000}});
 await Promise.all(context.pages().map(page=>page.close()));
 const guard=await ownedOPFS(context,profile),page=await context.newPage(),errors:string[]=[],commands:any[]=[],assetReads:string[]=[],external:string[]=[],previews:Response[]=[];
 const prior=[9,8,7,6],destinationName='committed-export.png';let result:unknown;
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{const url=new URL(response.url());if(url.origin===server.origin&&/^\/api\/v1\/assets\/[^/]+\/display$/.test(url.pathname)&&url.searchParams.get('basis')==='encoded')previews.push(response);});
 page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server.origin)external.push(url.origin);if(url.pathname==='/api/v1/commands'&&request.method()==='POST')commands.push(request.postDataJSON().command);if(/^\/api\/v1\/assets\/[^/]+\/content$/.test(url.pathname)&&request.method()==='GET')assetReads.push(url.pathname);});
 await context.addInitScript(({prior,destinationName})=>{
  const probe={closeStarted:false,closeFinished:false,abortCalls:0,writes:0,releaseClose:null as (()=>void)|null};
  (window as any).__exportCommitProbe=probe;
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>{
   const root=await navigator.storage.getDirectory(),file=await root.getFileHandle(destinationName,{create:true}),seed=await file.createWritable();
   await seed.write(new Uint8Array(prior));await seed.close();
   return {createWritable:async()=>{
    const writer=await file.createWritable();return {
     write:async(data:ArrayBuffer)=>{probe.writes++;await writer.write(data);},
     close:async()=>{probe.closeStarted=true;await new Promise<void>(resolve=>{probe.releaseClose=resolve;});await writer.close();probe.closeFinished=true;throw new DOMException('Native close acknowledgement was lost','AbortError');},
     abort:async()=>{probe.abortCalls++;if(!probe.closeFinished)await writer.abort();}
    };
   }};
  }});
 },{prior,destinationName});
 try{
  await guard.admit(page,server.origin);await page.goto(await server.pair());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Import image',exact:true}).click();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeHidden();
  await page.getByRole('button',{name:'Export image',exact:true}).click();const previewStart=previews.length,previewContentStart=assetReads.length;
  await page.getByRole('button',{name:'Prepare export preview',exact:true}).click();await expect(page.getByRole('button',{name:'Confirm reviewed export',exact:true})).toBeEnabled();
  const previewResponses=previews.slice(previewStart);expect(previewResponses).toHaveLength(1);
  const previewResponse=previewResponses[0],previewURL=new URL(previewResponse.url()),match=/^\/api\/v1\/assets\/([A-Za-z0-9_-]{1,128})\/display$/.exec(previewURL.pathname);
  expect(previewResponse.status()).toBe(200);expect(previewURL.origin).toBe(server.origin);expect(match).not.toBeNull();
  const identity=previewURL.searchParams.get('identity');expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect([...previewURL.searchParams].sort()).toEqual([['basis','encoded'],['edge','1024'],['identity',identity]]);
  expect(previewResponse.headers()).toMatchObject({'content-type':'image/png','x-display-profile':'cp1-display-v1','x-display-source':identity,'x-display-basis':'encoded','x-display-width':'3','x-display-height':'2','x-display-source-width':'3','x-display-source-height':'2','x-display-lod':'0'});
  const assetPath='/api/v1/assets/'+match![1]+'/content';
  expect(assetReads.slice(previewContentStart)).toEqual([]); // Preview owns its display derivative, not an original-content fetch.
  const readLocal=()=>page.evaluate(async request=>{
   const response=await fetch(request.path,request.init),length=Number(response.headers.get('content-length'));
   if(response.status!==200||!Number.isSafeInteger(length)||length<1||length>65536)throw Error('BOUNDED_PREPARED_EXPORT_REQUIRED');
   const body=[...new Uint8Array(await response.arrayBuffer())];if(body.length!==length)throw Error('PREPARED_EXPORT_LENGTH');
   return {status:response.status,etag:response.headers.get('etag'),bytes:response.headers.get('content-length'),mediaType:response.headers.get('content-type'),body};
  },publicReadRequest(assetPath));
  const localBefore=await readLocal(),encoded=Buffer.from(localBefore.body),hash='sha256:'+createHash('sha256').update(encoded).digest('hex');expect(hash).toBe(identity);
  expect(localBefore).toEqual({status:200,etag:'"'+hash+'"',bytes:String(encoded.length),mediaType:'image/png',body:[...encoded]});
  // Decode the original authenticated bytes independently through the browser's
  // image API. Both images then use identical canvas alpha/color semantics;
  // hidden RGB under alpha zero is not compared to unpremultiplied file bytes.
  const previewPixels=await page.locator('#export-preview').evaluate(async(node,input)=>{
   const displayed=node as HTMLImageElement,source=displayed.currentSrc;
   if(!source.startsWith('blob:')||input.bytes.length>65536)throw Error('BOUNDED_EXPORT_PREVIEW_REQUIRED');
   await displayed.decode();
   const reference=new Image(),url=URL.createObjectURL(new Blob([Uint8Array.from(input.bytes)],{type:input.mediaType}));
   const pixels=(image:HTMLImageElement)=>{
    if(!image.complete||image.naturalWidth!==input.width||image.naturalHeight!==input.height)throw Error('EXPORT_PREVIEW_DIMENSIONS');
    const canvas=document.createElement('canvas');canvas.width=input.width;canvas.height=input.height;
    try{const context=canvas.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});if(!context)throw Error('CANVAS_UNAVAILABLE');context.drawImage(image,0,0);return [...context.getImageData(0,0,input.width,input.height).data];}
    finally{canvas.width=0;canvas.height=0;canvas.remove();}
   };
   try{reference.src=url;await reference.decode();if(displayed.currentSrc!==source)throw Error('EXPORT_PREVIEW_CHANGED');return {width:input.width,height:input.height,displayed:pixels(displayed),original:pixels(reference)};}
   finally{reference.removeAttribute('src');reference.remove();URL.revokeObjectURL(url);}
  },{bytes:[...encoded],mediaType:'image/png',width:3,height:2});
  expect(previewPixels.displayed).toEqual(previewPixels.original);
  await page.getByRole('button',{name:'Confirm reviewed export',exact:true}).click();await expect(page.getByRole('dialog',{name:'Export image',exact:true})).toBeHidden();
  const prepared=page.getByRole('region',{name:'Prepared file'}),commandCount=commands.length,destinationReadStart=assetReads.length;
  await expect(prepared).toContainText('Ready — destination unconfirmed');await prepared.getByRole('button',{name:'Choose destination and save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__exportCommitProbe.closeStarted)).toBe(true);
  await expect(prepared.getByRole('button',{name:'Cancel destination write',exact:true})).toBeDisabled();await expect(prepared).toContainText('Committing the destination file; cancellation is no longer available.');
  const readDestination=()=>page.evaluate(async name=>[...new Uint8Array(await(await(await navigator.storage.getDirectory()).getFileHandle(name)).getFile().then(file=>file.arrayBuffer()))],destinationName);
  expect(await readDestination()).toEqual(prior);
  await page.evaluate(()=>{const probe=(window as any).__exportCommitProbe;if(!probe.releaseClose)throw Error('Native close was not reached');probe.releaseClose();});
  await expect(prepared).toContainText('Destination write failed; local bytes retained');
  await expect(page.getByText('Destination commit was not confirmed. Prepared local bytes remain available; inspect the chosen destination before retrying.',{exact:true})).toBeVisible();
  await expect(page.getByText('Destination write canceled. Prepared bytes and previous destination files are retained.',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Saved to destination: browser write completed.',{exact:true})).toHaveCount(0);await expect(prepared.getByRole('button',{name:'Choose destination and save',exact:true})).toBeEnabled();
  const saved=await readDestination();expect(saved).toEqual([...encoded]);expect(saved).not.toEqual(prior);expect(assetReads.slice(destinationReadStart)).toEqual([assetPath]);expect(commands).toHaveLength(commandCount);
  expect(await readLocal()).toEqual(localBefore);
  const native=await page.evaluate(()=>{const {releaseClose:_,...probe}=(window as any).__exportCommitProbe;return probe;});expect(native).toEqual({closeStarted:true,closeFinished:true,abortCalls:1,writes:expect.any(Number)});expect(native.writes).toBeGreaterThan(0);
  expect(errors).toEqual([]);expect(external).toEqual([]);expect(Object.values(await server.effects())).toEqual(Array(8).fill(0));
  result={browserName,assetPath,hash,bytes:encoded.length,preview:{path:previewURL.pathname+previewURL.search,width:previewPixels.width,height:previewPixels.height,displayedMatchesNativeOriginal:true},native,actualDestinationMatchesPrepared:true,previousDestinationChanged:true,localBytesRetained:true,ui:'failed; destination commit unconfirmed',commandsDuringWrite:commands.length-commandCount,providerEffects:await server.effects(),limits:'Actual shell, authenticated asset read and native OPFS close. Controlled picker and lost close acknowledgement; no OS-dialog qualification.'};
 }finally{
  try{await guard.cleanup();guard.verify();}finally{await context.close();await server.close();await rm(directory,{recursive:true,force:true});const receipt=specReceipt(import.meta.url,'artifacts/p1b7/current');await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'export-destination-commit-'+browserName+'.json'),JSON.stringify({result,errors,external,ledger:guard.ledger},null,2));}
 }
});
