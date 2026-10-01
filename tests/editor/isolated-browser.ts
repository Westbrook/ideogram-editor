import {test as base, type Browser} from '@playwright/test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Share only the browser process in development batches. Contexts, mutable
// storage and WebKit persistent profiles remain owned by individual tests.
export const isolatedBrowserTest=base.extend<{}, {sharedBrowser:Browser|undefined}>({
 sharedBrowser:[async({playwright,browserName},use)=>{
  const browser=process.env.IE_VALIDATION_BATCH==='1'&&browserName!=='webkit'?await playwright[browserName].launch():undefined;
  try{await use(browser);}finally{await browser?.close();}
 },{scope:'worker'}],
 context:async({playwright,browserName,contextOptions,viewport,sharedBrowser},use)=>{
  const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-editor-webkit-')):undefined;
  let browser:Browser|undefined,context;
  try{
   browser=profile?undefined:sharedBrowser??await playwright[browserName].launch();
   context=profile?await playwright.webkit.launchPersistentContext(profile,{...contextOptions,viewport}):await browser!.newContext({...contextOptions,viewport});
   await Promise.all(context.pages().map(page=>page.close()));
   await use(context);
  }finally{
   try{await context?.close();}finally{
    try{if(browser!==sharedBrowser)await browser?.close();}finally{if(profile)await rm(profile,{recursive:true,force:true});}
   }
  }
 }
});
