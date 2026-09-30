// Own public Playwright handles as soon as acquisition returns. Never infer a
// browser/process lifetime has ended from an absent persistent-context handle.
function ownBrowser(owner,browser,persistent){
 if(!browser)throw Error('Persistent context has no public browser lifetime handle');
 owner.resources.browser=browser;
 const evidence={persistent,connectedAtAcquisition:browser.isConnected(),contextCloseObserved:false,browserDisconnectedObserved:false,closureEvidence:'Public context close event and Browser disconnected event with isConnected false; no OS PID claim'};
 let disconnected;const ended=new Promise(resolve=>disconnected=resolve);
 owner.resources.browserLifetime={evidence,ended};
 browser.once('disconnected',()=>{evidence.browserDisconnectedObserved=true;evidence.browserDisconnectedAt=Date.now();disconnected();});
 if(!evidence.connectedAtAcquisition)throw Error('Browser lifetime already disconnected at acquisition');
}
function ownContext(owner,context){
 owner.resources.context=context;
 const evidence=owner.resources.browserLifetime?.evidence;
 context.once('close',()=>{if(evidence){evidence.contextCloseObserved=true;evidence.contextClosedAt=Date.now();}});
}
export async function acquireBrowserContext(owner,type,profile,options){
 if(profile!==undefined)return owner.acquire('context',async()=>{
  const context=await type.launchPersistentContext(profile,options);
  owner.resources.context=context;
  ownBrowser(owner,context.browser(),true);ownContext(owner,context);return context;
 });
 await owner.acquire('browser',async()=>{const browser=await type.launch();ownBrowser(owner,browser,false);return browser;});
 return owner.acquire('context',async()=>{const context=await owner.resources.browser.newContext(options);ownContext(owner,context);return context;});
}
export function registerBrowserClosure(owner,limitMs=15000){
 owner.add('context-close',limitMs,()=>Boolean(owner.resources.context),async scope=>{
  await scope(()=>owner.resources.context.close());
  if(!owner.resources.browserLifetime?.evidence.contextCloseObserved)throw Error('Public context close event unavailable');
  owner.state.contextClosed=true;
 },100);
 owner.add('browser-close',limitMs,()=>Boolean(owner.resources.browser&&owner.resources.browserLifetime),async scope=>{
  const browser=owner.resources.browser,life=owner.resources.browserLifetime;
  if(browser.isConnected())await scope(()=>browser.close());
  await scope(()=>life.ended);
  if(!life.evidence.browserDisconnectedObserved||browser.isConnected())throw Error('Browser lifetime closure not verified');
  owner.state.browserClosed=true;
 },100);
}
