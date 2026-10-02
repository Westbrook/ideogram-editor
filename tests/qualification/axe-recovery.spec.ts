import {test,expect,type Page,type Browser,type BrowserContext,type Request} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rename,realpath,rm,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {serverProcess} from '../editor/process.js';
import {ownedOPFS} from '../editor/owned-opfs.js';
import {axeEvidence} from './axe.js';

const engine=process.env.QUALIFICATION_BROWSER??'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw Error('Unsupported qualification browser');
const planned=['missing-exact-font','missing-font-preview-error','copy-missing-dependency','exact-font-relinked','copy-after-exact-recovery'] as const;
const limitations=[
  'The failure is a real missing immutable font file in this owned disposable root. No response or successful state is mocked, and no application private state is read or written.',
  'This covers a missing exact dependency during full-history copy. OS destination permission failures and physical native file-picker behavior require separate platform evidence.',
  'Every axe incomplete result remains queued for manual adjudication; native AT speech and physical IME are not claimed.',
  'Training states belong to the separately deferred P4 implementation and are not represented by adapter import controls.',
];
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
const number=async(page:Page,name:string,value:string)=>{const field=page.getByRole('spinbutton',{name,exact:true});await field.fill(value);await field.press('Tab');};

test('AX01 real missing-font and full-history copy failure recover through exact relink',async({playwright},info)=>{
  const out=resolve(process.env.QUALIFICATION_AXE_OUTPUT??'artifacts/qualification-axe','recovery',engine);
  await mkdir(out,{recursive:true});
  const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-axe-recovery-')),root=join(directory,'private');
  const profile=engine==='webkit'?join(directory,'browser-profile'):undefined;
  let ownedBrowser:Browser|undefined,ownedContext:BrowserContext|undefined,ownedPage:Page|undefined;
  let ownedServer:Awaited<ReturnType<typeof serverProcess>>|undefined,ownedGuard:Awaited<ReturnType<typeof ownedOPFS>>|undefined;
  type RequestFact={id:number;url:string;method:string;phase:string;duringFault:boolean};
  const events:{kind:string;text:string;url:string;phase:string;expected?:boolean;matchingRequestIds?:number[]}[]=[],http:(RequestFact&{status:number})[]=[],faults:unknown[]=[];
  const unexpectedErrors:unknown[]=[],failures:unknown[]=[],requests=new WeakMap<Request,RequestFact>();
  let phase='setup',fontURL='',faultURL='',faultActive=false,nextRequest=0,held:string|undefined,original:string|undefined,completed=false;
  const safeURL=(url:string)=>{try{const value=new URL(url);return value.origin+value.pathname;}catch{return url;}};
  try{
    const browser=ownedBrowser=profile?undefined:await playwright[engine as 'chromium'|'firefox'].launch();
    const context=ownedContext=profile?await playwright.webkit.launchPersistentContext(profile,{viewport:{width:1440,height:1000}}):await browser!.newContext({viewport:{width:1440,height:1000}});
    const server=ownedServer=await serverProcess(root),guard=ownedGuard=await ownedOPFS(context,'axe-exact-dependency-recovery');
    await Promise.all(context.pages().map(page=>page.close()));
    const page=ownedPage=await context.newPage();page.setDefaultTimeout(10_000);
    page.on('request',request=>{
      requests.set(request,{id:++nextRequest,url:safeURL(request.url()),method:request.method(),phase,duringFault:faultActive});
      if(request.method()==='HEAD'&&new URL(request.url()).pathname.startsWith('/api/v1/assets/'))fontURL=request.url();
    });
    page.on('response',response=>{const request=requests.get(response.request());if(!request)unexpectedErrors.push({kind:'unobserved-response',url:safeURL(response.url())});else http.push({...request,status:response.status()});});
    page.on('requestfailed',request=>{if(safeURL(request.url())===faultURL)unexpectedErrors.push({kind:'font-transport-failed',...requests.get(request),failure:request.failure()});});
    page.on('pageerror',error=>unexpectedErrors.push({kind:'pageerror',name:error.name,message:error.message,phase}));
    page.on('console',message=>{if(message.type()==='error')events.push({kind:'console',text:message.text(),url:safeURL(message.location().url),phase});});
    await context.exposeBinding('qualificationCSP',(_source,value)=>unexpectedErrors.push({kind:'csp',value}));
    await context.addInitScript(()=>addEventListener('securitypolicyviolation',event=>(window as unknown as {qualificationCSP:(value:unknown)=>void}).qualificationCSP({directive:event.effectiveDirective,blocked:event.blockedURI})));
    await guard.admit(page,server.origin);await page.goto(await server.pair());
    await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
    const evidence=await axeEvidence(page,info,out,planned,limitations);
    await click(page,'New');await number(page,'Width (px)','360');await number(page,'Height (px)','200');await click(page,'Create');
    await click(page,'Text');const text=page.getByRole('textbox',{name:'Edit text — Text',exact:true});
    await text.fill('Retained exact font\nAccepted appearance survives.');await click(page,'Preview text');
    await expect(page.getByText('Text preview ready. Accepted appearance is unchanged.',{exact:true})).toBeVisible();await click(page,'Apply text');
    await expect(text).toBeHidden();await expect(page.getByRole('treeitem')).toContainText('Text · Text');
    await expect.poll(()=>fontURL,{message:'Actual public HEAD check identifies the font resource'}).toContain('/api/v1/assets/');
    const profileData=JSON.parse(await readFile('src/text/profile.json','utf8'));
    const font=profileData.fonts.find((value:{id:string})=>value.id==='NotoSans');expect(font).toBeTruthy();
    original=join(root,'objects','sha256',font.sha256.slice(0,2),font.sha256);held=join(directory,'exact-font-held');
    const bytes=await readFile(original);expect(createHash('sha256').update(bytes).digest('hex')).toBe(font.sha256);
    phase='exact-font-removed';faultURL=safeURL(fontURL);await rename(original,held);faultActive=true;
    faults.push({phase,kind:'rename-owned-immutable-file',sha256:font.sha256,byteLength:bytes.byteLength,heldOutsidePrivateObjectStore:true});
    await click(page,'Edit text');await expect(text).toHaveValue('Retained exact font\nAccepted appearance survives.');
    await expect(page.getByText('Missing exact font bytes. Frozen appearance is retained when available. Relink or preview a substitution before reflow.',{exact:true})).toBeVisible();
    await evidence.scan('missing-exact-font');
    const fontFailure='Text: Missing exact font bytes. Draft and accepted appearance are retained; relink the exact font or preview a substitution.';
    await click(page,'Preview text');await expect(page.locator('#native-text-error')).toHaveText(fontFailure);await expect(page.getByRole('region',{name:'Operation status',exact:true}).getByText(fontFailure,{exact:true})).toBeVisible();
    await expect(text).toHaveAttribute('aria-invalid','true');await expect(text).toHaveAttribute('aria-errormessage','native-text-error');
    await expect(text).toHaveAccessibleDescription(/Text: Missing exact font bytes.*relink the exact font or preview a substitution/);
    await expect(text).toHaveValue('Retained exact font\nAccepted appearance survives.');
    await evidence.scan('missing-font-preview-error');await click(page,'Cancel text edit');
    phase='copy-with-missing-exact-dependency';await click(page,'Save copy');await click(page,'Prepare complete copy');
    const copyDialog=page.getByRole('dialog',{name:'Save project copy',exact:true});await expect(copyDialog).toBeVisible();
    const copyContent=page.locator('#editor-dialog');
    await expect(copyContent.getByRole('region',{name:'Action needs attention',exact:true})).toBeVisible();
    await expect(copyContent.getByRole('region',{name:'Action needs attention',exact:true})).toBeFocused();
    await expect(copyContent).toContainText('Content unavailable or missing. Accepted records are retained; restore the exact resource, then reconnect.');
    await expect(page.getByRole('region',{name:'Prepared file',exact:true})).toHaveCount(0);
    await evidence.scan('copy-missing-dependency');await page.keyboard.press('Escape');
    // Relink through the real font upload/finalize/import path. Merely moving
    // the held file back would not exercise the product's recovery action.
    phase='exact-relink';await click(page,'Edit text');await click(page,'Local font import and exact relink');
    await page.getByLabel('Font file',{exact:true}).setInputFiles('vendor/text/fonts/NotoSans-Regular.ttf');
    await page.getByLabel('Font license record',{exact:true}).setInputFiles('vendor/text/notices/Noto-OFL.txt');
    await click(page,'Relink exact font');await expect(page.getByText('Exact font relinked. Prepare a fresh text preview.',{exact:true})).toBeVisible();
    await expect.poll(async()=>createHash('sha256').update(await readFile(original!)).digest('hex')).toBe(font.sha256);
    faultActive=false;
    await expect(text).toHaveValue('Retained exact font\nAccepted appearance survives.');await evidence.scan('exact-font-relinked');
    await click(page,'Preview text');await expect(page.getByText('Text preview ready. Accepted appearance is unchanged.',{exact:true})).toBeVisible();await expect(page.locator('#native-text-error')).toHaveCount(0);await expect(text).toHaveAttribute('aria-invalid','false');await expect(text).not.toHaveAttribute('aria-errormessage');await expect(text).toHaveAttribute('aria-describedby','native-text-policy');await click(page,'Cancel text edit');
    phase='copy-after-exact-recovery';await click(page,'Save copy');await click(page,'Prepare complete copy');
    await expect(page.getByRole('region',{name:'Prepared file',exact:true})).toContainText('Full-history copy');await expect(copyDialog).toBeHidden();
    await evidence.scan('copy-after-exact-recovery');await evidence.finish();
    expect(Object.values(await server.effects())).toEqual(Array(8).fill(0));completed=true;
  }catch(error){failures.push(error);
  }finally{
    // The fault never leaves the writer with a missing resource at shutdown,
    // even when a preceding accessibility assertion fails.
    const cleanup=async(label:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){failures.push(new Error(label,{cause:error}));}};
    await cleanup('restore-exact-font',async()=>{if(held&&original){try{await access(original);}catch{await rename(held,original);held=undefined;}}});
    const browserVersion=(ownedBrowser??ownedContext?.browser())?.version();
    if(ownedPage)await cleanup('close-page',()=>ownedPage!.close());
    if(ownedGuard)await cleanup('owned-opfs-cleanup',async()=>{await ownedGuard!.cleanup();ownedGuard!.verify();});
    if(ownedServer)await cleanup('close-server',()=>ownedServer!.close());
    if(ownedContext)await cleanup('close-context',()=>ownedContext!.close());
    if(ownedBrowser)await cleanup('close-browser',()=>ownedBrowser!.close());
    const expected=(row:typeof http[number])=>row.duringFault&&row.url===faultURL&&row.status===404&&['GET','HEAD'].includes(row.method);
    for(const row of http)if(row.status>=400&&!expected(row))unexpectedErrors.push({kind:'unexpected-http-error',...row});
    // Console callbacks and response callbacks have no guaranteed order. Only
    // classify after page/context closure; correlate against exact observed
    // fault-period 404 requests, retaining all candidate request identities.
    for(const event of events){event.matchingRequestIds=http.filter(row=>expected(row)&&row.url===event.url).map(row=>row.id);event.expected=/^Failed to load resource:/.test(event.text)&&event.matchingRequestIds.length>0;if(!event.expected)unexpectedErrors.push(event);}
    if(unexpectedErrors.length)failures.push(new Error('Unexpected browser or HTTP errors: '+JSON.stringify(unexpectedErrors)));
    const passed=completed&&info.errors.length===0&&failures.length===0;
    await cleanup('write-fault-receipt',()=>writeFile(join(out,'fault-receipt.json'),JSON.stringify({engine,browserVersion,planned,limitations,phase,passed,faults,events,http,unexpectedErrors,root,failures:failures.map(error=>error instanceof Error?{message:error.message,stack:error.stack,cause:String(error.cause??'')}:String(error)),softErrors:info.errors},null,2)));
    if(passed&&!failures.length)await cleanup('remove-owned-success-root',()=>rm(directory,{recursive:true}));
  }
  if(failures.length)throw new AggregateError(failures,'Accessibility exact-resource recovery failed');
});
