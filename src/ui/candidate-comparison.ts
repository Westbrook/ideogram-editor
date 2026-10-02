import {reserveModelBytes,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import {ControlAdapter} from './adapters.js';
import {comparisonPan,parseComparisonView} from './comparison-viewport.js';
import {renderComparisonPair,pairFrame,pairCanReveal,type ComparisonPair,type ComparisonPairView,type ComparisonMode} from './comparison-view.js';
import './candidate-comparison.css';

export type CandidateComparisonInput={
 sourceURL:string;preparedURL:string;beforeURL:string;afterURL:string;beforeBlank?:boolean;
 width:number;height:number;documentWidth:number;documentHeight:number;
 placement:'current-document'|'new-document';newDocSameGrid:boolean;
 sourceWidth?:number;sourceHeight?:number;preparedWidth?:number;preparedHeight?:number;
 beforeWidth?:number;beforeHeight?:number;afterWidth?:number;afterHeight?:number;
 /** At most two separately admitted, original-coordinate treatment pairs. */
 additionalPairs?:readonly ComparisonPair[];
};
type State={signature:string;clipId:string;pairs:Record<string,ComparisonPairView>};
let comparisonIdentity=0;
const initial=():ComparisonPairView=>({mode:'side-by-side',value:'50',percentage:50,error:'',zoomValue:'100',xValue:'0',yValue:'0',view:{zoom:100,x:0,y:0}});

/** All native consumers use admitted bounded previews. Shared zoom changes the
 * original-coordinate viewBox, never the retained pixels or decode dimensions. */
export class CandidateComparison {
 private adapter=new ControlAdapter();private states=new Map<string,State>();
 private owners=new WeakMap<State,OwnedModel<State>>();private renderOwners=new Map<string,OwnedModel<ComparisonPair[]>>();
 private pending=new Set<Promise<unknown>>();private pendingKeys=new Map<Promise<unknown>,string>();private retired=new Set<OwnedModel<unknown>>();private retiredKeys=new Map<OwnedModel<unknown>,string>();private releasing?:Promise<void>;
 constructor(private host:LitElement){}
 get lifecycle(){return {states:this.states.size,pending:this.pending.size,retired:this.retired.size,renderOwners:this.renderOwners.size};}
 private track<T>(work:Promise<T>,key:string){this.pending.add(work);this.pendingKeys.set(work,key);const done=()=>{this.pending.delete(work);this.pendingKeys.delete(work);};void work.then(done,done);return work;}
 private releaseRetired(model:OwnedModel<unknown>){if(!this.retired.has(model))return;model.release();this.retired.delete(model);this.retiredKeys.delete(model);}
 private retire(model:OwnedModel<unknown>|undefined,key:string,requestUpdate=true){if(!model)return;this.retired.add(model);this.retiredKeys.set(model,key);this.track(Promise.resolve().then(()=>{if(requestUpdate)this.host.requestUpdate();return this.host.updateComplete;}).then(()=>this.releaseRetired(model)),key);}
 private hold(key:string,state:State,workspace:OwnedModel<ComparisonPair[]>){const first=this.owners.get(state)!.pin();let second:()=>void;try{second=workspace.pin();}catch(error){first();throw error;}let done!:()=>void,live=true;this.track(new Promise<void>(resolve=>{done=resolve;}),key);return ()=>{if(live){live=false;first();second();done();}};}
 private create(key:string,signature:string,pairs:readonly ComparisonPair[]){
  if(key.length>128||signature.length>8192||!this.states.has(key)&&this.states.size>=64)throw Error('CANDIDATE_COMPARISON_LIMIT');
  // Charge signature, map key and every bounded editing/error field before
  // creating their retained state. No mutation can grow beyond this allowance.
  const lease=reserveModelBytes('candidate-comparison',signature.length*2+key.length*2+8192);
  try{const metadata:State={signature,clipId:'candidate-comparison-clip-'+(++comparisonIdentity),pairs:{}};for(const pair of pairs)metadata.pairs[pair.id]=initial();const model:OwnedModel<State>={value:metadata,release:()=>lease.release(),pin:()=>lease.pin()};this.owners.set(metadata,model);const prior=this.states.get(key);this.states.set(key,metadata);if(prior)this.retire(this.owners.get(prior),key);return metadata;}catch(error){lease.release();throw error;}
 }
 dispose(){if(this.releasing)return this.releasing;this.reset();this.releasing=(async()=>{const errors:unknown[]=[];try{this.host.requestUpdate();}catch(error){errors.push(error);}while(this.pending.size)await Promise.allSettled([...this.pending]);for(const model of this.retired)try{this.host.requestUpdate();await this.host.updateComplete;this.releaseRetired(model);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'CANDIDATE_COMPARISON_RELEASE');})().finally(()=>{this.releasing=undefined;});void this.releasing.catch(()=>{});return this.releasing;}
 reset(key?:string){this.adapter.invalidate();if(key===undefined){for(const [id,state] of this.states)this.retire(this.owners.get(state),id);for(const [id,model] of this.renderOwners)this.retire(model,id);this.states.clear();this.renderOwners.clear();}else{const state=this.states.get(key);this.states.delete(key);if(state)this.retire(this.owners.get(state),key);const model=this.renderOwners.get(key);this.renderOwners.delete(key);this.retire(model,key);}}
 /** Detach this exact render generation; the caller retains this retryable close
  * operation until its consumer publication and independent model releases finish. */
 retirePairs(key:string):()=>Promise<void>{
  this.adapter.invalidate();const state=this.states.get(key),models=new Set([...this.retired].filter(model=>this.retiredKeys.get(model)===key)),pending=[...this.pending].filter(work=>this.pendingKeys.get(work)===key);this.states.delete(key);
  if(state){const model=this.owners.get(state);if(model)models.add(model);}const render=this.renderOwners.get(key);this.renderOwners.delete(key);if(render)models.add(render);
  for(const model of models){this.retired.add(model);this.retiredKeys.set(model,key);}
  return async()=>{this.host.requestUpdate();await this.host.updateComplete;await Promise.allSettled(pending);const errors:unknown[]=[];for(const model of models)try{this.releaseRetired(model);models.delete(model);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'CANDIDATE_COMPARISON_RELEASE');};
 }
 private pairs(input:CandidateComparisonInput):ComparisonPair[]{
  if((input.additionalPairs?.length??0)>2)throw Error('CANDIDATE_COMPARISON_LIMIT');
  const afterWidth=input.placement==='new-document'?input.width:input.documentWidth,afterHeight=input.placement==='new-document'?input.height:input.documentHeight;
  const pairs:ComparisonPair[]=[
   {id:'source',heading:'Frozen source and prepared replacement',label:'Source and prepared',allowOverlay:true,a:{url:input.sourceURL,width:input.sourceWidth??input.width,height:input.sourceHeight??input.height,name:'Frozen source contribution'},b:{url:input.preparedURL,width:input.preparedWidth??input.width,height:input.preparedHeight??input.height,name:'Prepared replacement'}},
   {id:'document',heading:'Document before and after placement',label:'Document placement',allowOverlay:input.placement==='current-document'||input.newDocSameGrid,a:{url:input.beforeURL,width:input.beforeWidth??input.documentWidth,height:input.beforeHeight??input.documentHeight,name:'Current document before placement',transparent:input.beforeBlank===true},b:{url:input.afterURL,width:input.afterWidth??afterWidth,height:input.afterHeight??afterHeight,name:input.placement==='new-document'?'New document after placement':'Current document after placement'}},
  ];
  for(const pair of input.additionalPairs??[]){if(!/^[a-z][a-z0-9-]{0,63}$/.test(pair.id)||pairs.some(value=>value.id===pair.id)||pair.heading.length>256||pair.label.length>128||pair.a.name.length>256||pair.b.name.length>256)throw Error('CANDIDATE_COMPARISON_PAIR');pairs.push({id:pair.id,heading:pair.heading,label:pair.label,allowOverlay:pair.allowOverlay,a:{...pair.a},b:{...pair.b}});}return pairs;
 }
 private perform(key:string,event:Event,state:State,workspace:OwnedModel<ComparisonPair[]>,owns:()=>boolean,change:()=>void){if(!owns())return;const release=this.hold(key,state,workspace);this.adapter.action(event,()=>{if(owns()){change();this.host.requestUpdate();}});setTimeout(release,0);}
 private settle(key:string,event:Event,state:State,workspace:OwnedModel<ComparisonPair[]>,owns:()=>boolean,change:(value:string,control:HTMLElement&{value:string})=>void){if(!owns())return;const control=event.currentTarget as HTMLElement&{value:string},release=this.hold(key,state,workspace);this.adapter.settled(event,()=>control.value,value=>{if(owns()){change(value,control);this.host.requestUpdate();}});queueMicrotask(release);}
 private pair(key:string,state:State,pair:ComparisonPair,workspace:OwnedModel<ComparisonPair[]>,owns:()=>boolean){
  const current=state.pairs[pair.id]!,perform=(event:Event,change:()=>void)=>this.perform(key,event,state,workspace,owns,change),settle=(event:Event,change:(value:string,control:HTMLElement&{value:string})=>void)=>this.settle(key,event,state,workspace,owns,change);
  const mode=(value:string)=>{if(['a','b','side-by-side','reveal'].includes(value)&&(value!=='reveal'||pairCanReveal(pair))){current.mode=value as ComparisonMode;current.error='';}};
  const reveal=(value:string,control?:HTMLElement&{value:string})=>{if(!pairCanReveal(pair))return;if(value.length>32){if(control)this.adapter.write(control,'value',current.value);current.error='Enter a reveal percentage from 0 to 100.';return;}current.value=value;const percentage=Number(value);if(!value.trim()||!Number.isFinite(percentage)||percentage<0||percentage>100)current.error='Enter a reveal percentage from 0 to 100.';else{current.percentage=percentage;current.mode='reveal';current.error='';}};
  const setView=(view:ComparisonPairView['view'])=>{current.view=view;current.zoomValue=String(view.zoom);current.xValue=String(view.x);current.yValue=String(view.y);current.error='';};
  return renderComparisonPair(`candidate-comparison-${key}-${pair.id}`,`${state.clipId}-${pair.id}`,pair,current,owns(),{
   mode:(event,value)=>value?perform(event,()=>mode(value)):settle(event,value=>mode(value)),
   reveal:(event,value)=>value===undefined?settle(event,reveal):perform(event,()=>reveal(String(value))),
   field:(event,field)=>settle(event,(value,control)=>{if(value.length>32){this.adapter.write(control,'value',current[field]);current.error='Shared view input exceeds the editing allowance.';}else{current[field]=value;current.error='';}}),
   apply:event=>perform(event,()=>{try{setView(parseComparisonView(pairFrame(pair),{zoom:current.zoomValue,x:current.xValue,y:current.yValue}));}catch{current.error='Enter zoom from 25 to 1600 and finite offsets within the original frame dimensions.';}}),
   fit:event=>perform(event,()=>setView({zoom:100,x:0,y:0})),
   pan:(event,direction)=>perform(event,()=>{try{setView(comparisonPan(pairFrame(pair),current.view,direction));}catch{current.error='The shared pan reached the original-frame offset limit.';}}),
  });
 }
 render(key:string,input:CandidateComparisonInput,owns:()=>boolean){return this.renderInput(key,input,()=>this.pairs(input),owns);}
 /** Standalone comparisons retain their own accurate labels and coordinate grids. */
 renderPairs(key:string,pairs:readonly ComparisonPair[],owns:()=>boolean){return this.renderInput(key,pairs,()=>{
  if(!Array.isArray(pairs)||pairs.length<1||pairs.length>4)throw Error('CANDIDATE_COMPARISON_LIMIT');
  const ids=new Set<string>();return pairs.map(pair=>{if(!/^[a-z][a-z0-9-]{0,63}$/.test(pair.id)||ids.has(pair.id)||pair.heading.length>256||pair.label.length>128||pair.a.name.length>256||pair.b.name.length>256)throw Error('CANDIDATE_COMPARISON_PAIR');ids.add(pair.id);return {...pair,a:{...pair.a},b:{...pair.b}};});
 },owns);}
 private renderInput(key:string,input:unknown,build:()=>ComparisonPair[],owns:()=>boolean){
  if(this.releasing)return nothing;const inputBytes=modelPayloadBytes(input);if(inputBytes>8192)throw Error('CANDIDATE_COMPARISON_LIMIT');
  const lease=reserveModelBytes('candidate-comparison-render',inputBytes*3+4096);let adopted=false;
  try{const pairs=build(),workspace:OwnedModel<ComparisonPair[]>={value:pairs,release:()=>lease.release(),pin:()=>lease.pin()},signature=JSON.stringify(pairs);let state=this.states.get(key);if(!state||state.signature!==signature)state=this.create(key,signature,pairs);
   const current=state,stillCurrent=()=>this.states.get(key)===current&&current.signature===signature&&this.renderOwners.get(key)===workspace&&owns();
   const prior=this.renderOwners.get(key);this.renderOwners.set(key,workspace);try{const template=html`<section class="candidate-comparison" aria-label="Compare retained candidate and placement">${pairs.map(pair=>this.pair(key,current,pair,workspace,stillCurrent))}</section>`;adopted=true;this.retire(prior,key,false);return template;}catch(error){if(prior)this.renderOwners.set(key,prior);else this.renderOwners.delete(key);throw error;}
  }finally{if(!adopted)lease.release();}
 }
}
