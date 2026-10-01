import {displayPreviewURL} from '../display-module.mjs';
import {allocationsURL,ownedPreviewURL,promptMemoryURL} from '../owned-preview-module.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {nothing} from 'lit';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const adapter=data((await transformWithOxc(await readFile('src/ui/adapters.ts','utf8'),'adapters.ts')).code);
const imports={'./display-image.js':data('export const displayImage=value=>value;'),'../observability/display-preview.js':displayPreviewURL,'../observability/prompt-memory.js':promptMemoryURL,'../observability/owned-preview.js':ownedPreviewURL,'../observability/allocations.js':allocationsURL,'lit':import.meta.resolve('lit'),'lit/directives/repeat.js':data('export const repeat=(items,key,render)=>Array.from(items,render);'),'./adapters.js':adapter,...Object.fromEntries(['request/core','request/raster-plan','protocol/json','composition/core','raster/mask','raster/mapping','adapters/profile'].map(n=>['../'+n+'.js',pathToFileURL(resolve('dist/local/src/'+n+'.js')).href]))};
async function controllerModule(name,dependencies={}){let code=(await transformWithOxc(await readFile('src/ui/'+name+'.ts','utf8'),name+'.ts')).code;code=code.replace(/import\s+["']\.\/(?:request-edits|candidate-comparison)\.css["'];?/g,'');for(const [specifier,url]of Object.entries({...imports,...dependencies}))code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(url)).replaceAll("'"+specifier+"'",JSON.stringify(url));return data(code);}
const adapterLibrary=await controllerModule('adapter-library'),candidateComparison=await controllerModule('candidate-comparison'),requestEdits=await controllerModule('request-edits',{'./candidate-comparison.js':candidateComparison});
const {RequestEditing}=await import(await controllerModule('request',{'./adapter-library.js':adapterLibrary,'./request-edits.js':requestEdits}));
export function rendered(flow){
 const slots=[];const html=v=>{if(v===nothing||v===null||v===undefined)return '';if(Array.isArray(v))return v.map(html).join('');if(v?.strings)return v.strings.reduce((s,t,i)=>s+t+(i<v.values.length?html(v.values[i]):''),'');return '__slot'+(slots.push(v)-1)+'__';};
 const markup=html(flow.render()),resolve=s=>s.replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)]));
 const buttons=[...markup.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([,a,label])=>{const disabled=/\?disabled=__slot(\d+)__/.exec(a),click=/@click=__slot(\d+)__/.exec(a);return {name:resolve(label).trim(),disabled:disabled?Boolean(slots[Number(disabled[1])]):false,click:click?slots[Number(click[1])]:undefined};});
 const busy=/<en-card id="durable-queue"[^>]*aria-busy=__slot(\d+)__/.exec(markup);const validation=/<en-validation-summary[^>]*\.items=([^ >]+)/.exec(markup),errors=validation?[...validation[1].matchAll(/__slot(\d+)__/g)].map(m=>slots[Number(m[1])].message):[];const fields=[...markup.matchAll(/<en-textarea\b([^>]*)>/g)].map(([,a])=>{const id=/id="([^"]+)"/.exec(a),input=/@en-input=__slot(\d+)__/.exec(a);return {id:id?.[1],input:input?slots[Number(input[1])]:undefined};});return {fields,buttons,busy:busy?slots[Number(busy[1])]:undefined,text:resolve(markup.replace(/<[^>]+>/g,'')),errors};
}
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export async function until(fn){const end=Date.now()+2000;while(!fn()){assert.ok(Date.now()<end,'Expected observable controller state');await new Promise(setImmediate);}}
export const turn=async()=>{await new Promise(r=>setTimeout(r,0));await new Promise(setImmediate);};
export const recover='Check existing request attempt',cancel='Request cancellation attempt';
export async function fixture(t){
 let identity='client',updates=0,candidates={items:[],requestedCount:1,actualCount:null};const commands=[],recovery=deferred(),cancellation=deferred();
 const attempt={id:'attempt',state:'acknowledged',requestId:'known',count:'dispatched',spendSessionId:'spend',hold:true,recoveryRequired:true,estimate:{rate:0.015,unit:'megapixel',count:1,source:'fixture',unknown:[]}};
 const job={id:'job',documentId:'doc',version:'5',local:'ready-to-dispatch',disposition:'eligible',attempts:[attempt]};let queue={session:{id:'spend',version:'1',cap:null},counts:{reserved:0,dispatched:1,remaining:null,active:1},jobs:[job],nextCursor:null};
 const editor={view:{ready:true,document:{id:'doc',revision:'1'},selected:[]},sessionId:'session',session:{identity:()=>identity},draftOwner:{drafts:new Map()},ui:{drafts:[]},changeDraft(){},flushDrafts:async()=>{},json:async path=>path.startsWith('/api/v1/queue')?structuredClone(queue):path.includes('/candidates')?structuredClone(candidates): {items:[]},command:async body=>{commands.push(body);if(body.type==='RecoverJob')await recovery.promise;if(body.type==='CancelJob')await cancellation.promise;return [];} };
 let flow;const host={requestUpdate(){updates++;},updateComplete:Promise.resolve(),querySelector(){return {focus(){}};}};flow=new RequestEditing(host,editor);t.after(()=>flow.dispose());
 const event=()=>{const h={isConnected:true};return {currentTarget:h,composedPath:()=>[h],defaultPrevented:false};};
 const button=name=>{const b=rendered(flow).buttons.find(b=>b.name===name);assert.ok(b,'Public button '+name);return b;};
 const click=(name,e=event())=>{const b=button(name);assert.equal(b.disabled,false,'Public action enabled '+name);b.click(e);return e;};
 await flow.sync();click('Refresh durable queue');await until(()=>rendered(flow).buttons.some(b=>b.name===cancel));
 return {flow,editor,commands,recovery,cancellation,button,click,event,job,attempt,render:()=>rendered(flow),updates:()=>updates,setIdentity:v=>identity=v,setCandidates:v=>candidates=v,setQueue:q=>queue=q,getQueue:()=>structuredClone(queue),async heldRecovery(){click(recover);await until(()=>commands.some(c=>c.type==='RecoverJob'));},async refreshedRecovery(){queue=structuredClone(queue);queue.jobs[0].version='6';queue.jobs[0].attempts[0].recoveryRequired=false;click('Refresh durable queue');await until(()=>!rendered(flow).text.includes('Recovery is paused after restart'));}};
}
