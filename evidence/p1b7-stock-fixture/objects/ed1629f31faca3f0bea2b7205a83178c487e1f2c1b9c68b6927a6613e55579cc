import type {BrowserContext} from '@playwright/test';
// Observe every new document before app code. Do not prevent default or modify
// errors; keep the collector outside documents so navigation cannot erase it.
export async function recordDOMErrors(context:BrowserContext):Promise<unknown[]> {
 const errors:unknown[]=[];
 await context.exposeBinding('recordE1DOMError',(_source,value)=>{errors.push(value);});
 await context.addInitScript(()=>{
  addEventListener('error',e=>(window as any).recordE1DOMError({channel:'error',origin:location.origin,name:e.error?.name,message:e.message}));
  addEventListener('unhandledrejection',e=>(window as any).recordE1DOMError({channel:'unhandledrejection',origin:location.origin,name:e.reason?.name,message:e.reason?.message??String(e.reason)}));
 });
 return errors;
}
