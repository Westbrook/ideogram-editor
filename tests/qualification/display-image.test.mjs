import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=Symbol.for("fixture-nothing");');
// Lifecycle notifications are a unit fixture for Lit's documented directive
// API. Actual DOM/native backing is verified separately by browser tests.
const asyncDirective=data('export class AsyncDirective{isConnected=true;setValue(value){this.value=value;this.commit?.(value);}} export const PartType={ATTRIBUTE:1};export const directive=C=>(...args)=>({C,args});');
const helper=data(`export const events=[],owners=new Set(),urls=new Set(['blob:a','blob:b']);export let refuse=false;export function refusal(value){refuse=value;}
export function displayPreviewInfo(url){return urls.has(url)?{}:undefined;}
export function acquireDisplayPreviewConsumer(url,detach){if(refuse)throw Error('ALLOCATION_BUDGET');const owner={url,release(){if(!owners.has(owner))return;detach();events.push('release:'+url);owners.delete(owner);}};events.push('reserve:'+url);owners.add(owner);return owner;}`);
let code=(await transformWithOxc(await readFile('src/ui/display-image.ts','utf8'),'display-image.ts')).code;
for(const [name,url]of Object.entries({'lit':lit,'lit/async-directive.js':asyncDirective,'../observability/display-preview.js':helper}))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
const {DisplayImageDirective}=await import(data(code)),state=await import(helper),{nothing}=await import(lit);
function element(){const attrs=new Map(),events=[];return {events,getAttribute:name=>attrs.get(name)??null,setAttribute(name,value){attrs.set(name,value);state.events.push('assign:'+value);},removeAttribute(name){attrs.delete(name);state.events.push('detach:'+name);},dispatchEvent:event=>events.push(event)};}
const make=(node=element(),name='src',tagName='IMG')=>{const directive=new DisplayImageDirective({type:1,name,tagName});let committed=Symbol('unset');const apply=value=>{if(value===committed)return;committed=value;if(value===nothing)node.removeAttribute(name);else node.setAttribute(name,value);};directive.commit=apply;return {node,part:{element:node,name},directive,apply};};
const commit=(fixture,url)=>{const value=fixture.directive.update(fixture.part,[url]);fixture.apply(value);return value;};

test('each image alias admits its own surface before its resource attribute is assigned',()=>{
 state.events.length=0;const first=make(),second=make();commit(first,'blob:a');commit(second,'blob:a');assert.equal(state.owners.size,2);assert.deepEqual(state.events,['reserve:blob:a','assign:blob:a','reserve:blob:a','assign:blob:a']);
 commit(first,'blob:a');assert.equal(state.owners.size,2);first.directive.disconnected();assert.equal(first.node.getAttribute('src'),null);assert.equal(state.owners.size,1);second.directive.disconnected();assert.equal(state.owners.size,0);
});
test('replacement detaches the old resource, and disconnected updates wait for re-admission',()=>{
 const fixture=make();commit(fixture,'blob:a');state.events.length=0;commit(fixture,'blob:b');assert.deepEqual(state.events,['detach:src','release:blob:a','reserve:blob:b','assign:blob:b']);
 fixture.directive.isConnected=false;fixture.directive.disconnected();assert.equal(state.owners.size,0);assert.equal(commit(fixture,'blob:a'),nothing);assert.equal(state.owners.size,0);
 fixture.directive.isConnected=true;fixture.directive.reconnected();assert.equal(fixture.directive.value,'blob:a');assert.equal(state.owners.size,1);fixture.directive.disconnected();assert.equal(state.owners.size,0);
});
test('SVG image href uses the same owner lifecycle and a retired URL cannot reconnect',()=>{
 const fixture=make(element(),'href','image');commit(fixture,'blob:a');fixture.directive.isConnected=false;fixture.directive.disconnected();state.urls.delete('blob:a');fixture.directive.isConnected=true;fixture.directive.reconnected();assert.equal(fixture.directive.value,nothing);assert.equal(state.owners.size,0);state.urls.add('blob:a');
 assert.throws(()=>new DisplayImageDirective({type:1,name:'href',tagName:'A'}),/DISPLAY_IMAGE_ATTRIBUTE/);
});
test('same-URL reconnect invalidates the committed attribute value before restoring the resource',()=>{
 const fixture=make();commit(fixture,'blob:a');fixture.directive.isConnected=false;fixture.directive.disconnected();assert.equal(fixture.node.getAttribute('src'),null);assert.equal(state.owners.size,0);
 fixture.directive.isConnected=true;fixture.directive.reconnected();assert.equal(fixture.node.getAttribute('src'),'blob:a','Reconnection must update the DOM even though its logical URL is unchanged');assert.equal(state.owners.size,1);fixture.directive.disconnected();assert.equal(state.owners.size,0);
});
test('refused admission leaves src unset and reports one visible failure without an automatic retry loop',async()=>{
 const previous=globalThis.CustomEvent;globalThis.CustomEvent=class{constructor(type,options){Object.assign(this,{type,...options});}};state.refusal(true);const fixture=make();
 try{assert.equal(commit(fixture,'blob:a'),nothing);assert.equal(commit(fixture,'blob:a'),nothing);await Promise.resolve();assert.equal(fixture.node.getAttribute('src'),null);assert.equal(state.owners.size,0);assert.equal(fixture.node.events.length,1);assert.equal(fixture.node.events[0].type,'ie-display-error');assert.match(fixture.node.events[0].detail.message,/ALLOCATION_BUDGET/);}finally{state.refusal(false);globalThis.CustomEvent=previous;}
});
