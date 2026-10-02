import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import {uiModelOwnerURL,ownFixtureJSON} from '../ui-model-module.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {nothing} from 'lit';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const adapter=data((await transformWithOxc(await readFile('src/ui/adapters.ts','utf8'),'adapter.ts')).code);
let code=(await transformWithOxc(await readFile('src/ui/deletion.ts','utf8'),'deletion.ts')).code;
for(const [name,url] of Object.entries({'lit':import.meta.resolve('lit'),'./adapters.js':adapter,'./model-owner.js':uiModelOwnerURL}))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
const {DocumentDeletion}=await import(data(code));

// Inspect the real controller's Lit TemplateResult. Only the editor boundary and
// event host are fixtures; no controller, adapter or render behavior is replaced.
export function rendered(flow){
 const slots=[];
 const html=value=>{
  if(value===nothing||value===null||value===undefined)return '';
  if(Array.isArray(value))return value.map(html).join('');
  if(value?.strings)return value.strings.reduce((out,s,i)=>out+s+(i<value.values.length?html(value.values[i]):''),'');
  const index=slots.push(value)-1;return '__slot'+index+'__';
 };
 const markup=html(flow.render()),resolve=s=>s.replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)]));
 const buttons=[...markup.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([,attributes,label])=>{
  const disabled=/\?disabled=__slot(\d+)__/.exec(attributes),click=/@click=__slot(\d+)__/.exec(attributes);
  return {name:resolve(label).trim(),disabled:disabled?Boolean(slots[Number(disabled[1])]):false,click:click?slots[Number(click[1])]:undefined};
 });
 const busy=/aria-busy=__slot(\d+)__/.exec(markup);
 return {buttons,busy:busy?slots[Number(busy[1])]:undefined,text:resolve(markup.replace(/<[^>]+>/g,''))};
}
export async function until(predicate){const end=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<end,'Controller did not reach the required observable state');await new Promise(setImmediate);}}
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export function fixture(){
 const commands=[],hold=deferred(),receipt={documentId:'deleted_doc',planId:'plan',accepted:true,status:'cleanup-pending',actualFreedBytes:'0',pendingBytes:'8',retainedBytes:'3',estimatedEligibleBytes:'8',generation:'root'},job={id:'job',version:'7',attempts:[{id:'attempt',state:'submission-uncertain',hold:true}]};
 let identity='client',updates=0;
 const editor={session:{identity:()=>identity},view:{document:null,busy:false},draftOwner:{drafts:new Map()},command:async body=>{commands.push(body);if(body.type==='CollectDocumentGarbage'){await hold.promise;receipt.status='cleanup-complete';receipt.actualFreedBytes='8';receipt.pendingBytes='0';}},json:async path=>path.startsWith('/api/v1/deletions?')?{items:[receipt],next:'next_receipt'}:{receipt,jobs:[job],next:'next_job'},copy:async()=>{}};
 const flow=new DocumentDeletion({requestUpdate(){updates++;}},ownFixtureCommands(ownFixtureJSON(editor)));
 const button=name=>{const b=rendered(flow).buttons.find(b=>b.name===name);assert.ok(b,'Rendered button '+name);return b;};
 const event=()=>{const host={isConnected:true};return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false};};
 const click=(name,e=event())=>{const b=button(name);assert.equal(b.disabled,false,'Public action must be enabled: '+name);b.click(e);return e;};
 const settled=()=>until(()=>!button('Review pending document cleanup').disabled);
 async function open(){click('Review pending document cleanup');await until(()=>rendered(flow).buttons.some(b=>b.name==='Inspect cleanup for deleted_doc'));await settled();click('Inspect cleanup for deleted_doc');await until(()=>rendered(flow).buttons.some(b=>b.name==='Review possible overlap for deleted request'));await settled();}
 async function collect(){click('Check and reclaim eligible bytes');await until(()=>commands.some(c=>c.type==='CollectDocumentGarbage')&&button('Review pending document cleanup').disabled);}
 return {flow,editor,commands,receipt,job,hold,button,click,event,settled,open,collect,setIdentity:v=>identity=v,updates:()=>updates};
}
