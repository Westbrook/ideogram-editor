import {displayImage} from './display-image.js';
import {html,svg,nothing} from 'lit';
import type {LitElement} from 'lit';
import {ControlAdapter} from './adapters.js';
import './candidate-comparison.css';

export type CandidateComparisonInput={
  sourceURL:string;preparedURL:string;beforeURL:string;afterURL:string;beforeBlank?:boolean;
  width:number;height:number;documentWidth:number;documentHeight:number;
  placement:'current-document'|'new-document';newDocSameGrid:boolean;
  // Callers with a full candidate or a changed grid supply each measured size.
  // Omitted sizes use the explicitly declared shared source/document grid.
  sourceWidth?:number;sourceHeight?:number;preparedWidth?:number;preparedHeight?:number;
  beforeWidth?:number;beforeHeight?:number;afterWidth?:number;afterHeight?:number;
};
type Mode='a'|'b'|'reveal';
type PairState={mode:Mode;value:string;percentage:number;error:string};
type State={signature:string;clipId:string;source:PairState;document:PairState};
type Picture={url:string;width:number;height:number;name:string;transparent?:boolean};
type Pair={kind:'source'|'document';heading:string;label:string;a:Picture;b:Picture;allowOverlay:boolean};
let comparisonIdentity=0;
const initial=():PairState=>({mode:'a',value:'50',percentage:50,error:''});
const validSize=(picture:Picture)=>Number.isSafeInteger(picture.width)&&picture.width>0&&Number.isSafeInteger(picture.height)&&picture.height>0;

/** Compares bounded display renditions on the retained source coordinate grid. */
export class CandidateComparison {
  private adapter=new ControlAdapter();
  private states=new Map<string,State>();
  constructor(private host:LitElement){}
  dispose(){this.adapter.invalidate();this.states.clear();}
  reset(key?:string){this.adapter.invalidate();if(key===undefined)this.states.clear();else this.states.delete(key);}
  private pairs(input:CandidateComparisonInput):Pair[]{
    const afterWidth=input.placement==='new-document'?input.width:input.documentWidth;
    const afterHeight=input.placement==='new-document'?input.height:input.documentHeight;
    return [
      {kind:'source',heading:'Frozen source and prepared replacement',label:'Source and prepared',allowOverlay:true,
        a:{url:input.sourceURL,width:input.sourceWidth??input.width,height:input.sourceHeight??input.height,name:'Frozen source contribution'},
        b:{url:input.preparedURL,width:input.preparedWidth??input.width,height:input.preparedHeight??input.height,name:'Prepared replacement'}},
      {kind:'document',heading:'Document before and after placement',label:'Document placement',allowOverlay:input.placement==='current-document'||input.newDocSameGrid,
        a:{url:input.beforeURL,width:input.beforeWidth??input.documentWidth,height:input.beforeHeight??input.documentHeight,name:'Current document before placement',transparent:input.beforeBlank===true},
        b:{url:input.afterURL,width:input.afterWidth??afterWidth,height:input.afterHeight??afterHeight,name:input.placement==='new-document'?'New document after placement':'Current document after placement'}},
    ];
  }
  private selection(event:Event,state:PairState,owns:()=>boolean){
    const control=event.currentTarget as HTMLElement&{value:string};
    this.adapter.settled(event,()=>control.value,value=>{
      if(!owns()||!['a','b','reveal'].includes(value))return;
      state.mode=value as Mode;state.error='';this.host.requestUpdate();
    });
  }
  private reveal(event:Event,state:PairState,owns:()=>boolean){
    const control=event.currentTarget as HTMLElement&{value:string};
    this.adapter.settled(event,()=>control.value,value=>{
      if(!owns())return;
      state.value=value;
      const percentage=Number(value);
      if(!value.trim()||!Number.isFinite(percentage)||percentage<0||percentage>100){
        state.error='Enter a reveal percentage from 0 to 100.';
      }else{
        state.percentage=percentage;state.mode='reveal';state.error='';
      }
      this.host.requestUpdate();
    });
  }
  private separate(picture:Picture){
    return html`<figure><figcaption>${picture.name}: ${validSize(picture)?`${picture.width} × ${picture.height} pixels`:'dimensions unavailable'}</figcaption>${picture.url?html`<img src=${displayImage(picture.url)} alt=${picture.name}>`:html`<p>${picture.transparent?'Empty document with transparent pixels.':'No retained image for this view.'}</p>`}</figure>`;
  }
  private pair(key:string,state:State,pair:Pair,owns:()=>boolean){
    const current=state[pair.kind],sameGrid=pair.allowOverlay&&(!!pair.a.url||pair.a.transparent===true)&&(!!pair.b.url||pair.b.transparent===true)&&validSize(pair.a)&&validSize(pair.b)&&pair.a.width===pair.b.width&&pair.a.height===pair.b.height;
    const id=`candidate-comparison-${key}-${pair.kind}`,clipId=`${state.clipId}-${pair.kind}`;
    if(!sameGrid)return html`<section class="candidate-comparison-pair" aria-label=${pair.heading}><h5>${pair.heading}</h5><p class="candidate-comparison-grid-status">${(!pair.a.url&&!pair.a.transparent)||(!pair.b.url&&!pair.b.transparent)?'Both retained images are required for an A/B comparison.':'These views use different pixel grids. Their dimensions are shown separately.'} A shared-coordinate reveal is unavailable.</p><div class="candidate-comparison-separate">${this.separate(pair.a)}${this.separate(pair.b)}</div></section>`;
    const a=pair.a,b=pair.b,split=a.width*current.percentage/100;
    const description=current.mode==='a'?`A: ${a.name}`:current.mode==='b'?`B: ${b.name}`:`Reveal: ${current.percentage}% ${b.name} on the left, ${a.name} on the right`;
    return html`<section class="candidate-comparison-pair" aria-label=${pair.heading}><h5>${pair.heading}</h5>
      <p class="candidate-comparison-grid-status">Same coordinates: ${a.width} × ${a.height} original pixels; display previews may be scaled. A is ${a.name.toLowerCase()}; B is ${b.name.toLowerCase()}.</p>
      <div class="candidate-comparison-controls">
        <en-select id=${id+'-mode'} label=${pair.label+' comparison mode'} .value=${current.mode} ?disabled=${!owns()} @en-change=${(event:Event)=>this.selection(event,current,owns)}>
          <en-select-option value="a">A: ${a.name}</en-select-option><en-select-option value="b">B: ${b.name}</en-select-option><en-select-option value="reveal">Reveal B beside A</en-select-option>
        </en-select>
        <en-number-field id=${id+'-reveal'} label=${pair.label+' reveal percentage'} min="0" max="100" step="1" .value=${current.value} ?disabled=${!owns()} @en-input=${(event:Event)=>this.reveal(event,current,owns)} @en-change=${(event:Event)=>this.reveal(event,current,owns)}></en-number-field>
      </div>
      ${current.error?html`<p role="alert">${current.error}</p>`:nothing}
      <p id=${id+'-status'} role="status">${description}. Both images retain the same origin and scale.</p>
      <svg class="candidate-comparison-stage" viewBox=${`0 0 ${a.width} ${a.height}`} width=${a.width} height=${a.height} role="img" aria-label=${`${pair.heading}: ${description}; ${a.width} by ${a.height} pixel grid`}>
        <defs><clipPath id=${clipId+'-b'} clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width=${split} height=${a.height}></rect></clipPath><clipPath id=${clipId+'-a'} clipPathUnits="userSpaceOnUse"><rect x=${split} y="0" width=${a.width-split} height=${a.height}></rect></clipPath></defs>
        ${current.mode==='a'&&a.url?svg`<image href=${displayImage(a.url)} x="0" y="0" width=${a.width} height=${a.height} preserveAspectRatio="xMinYMin meet"></image>`:nothing}
        ${current.mode==='b'&&b.url?svg`<image href=${displayImage(b.url)} x="0" y="0" width=${b.width} height=${b.height} preserveAspectRatio="xMinYMin meet"></image>`:nothing}
        ${current.mode==='reveal'?svg`${a.url?svg`<image href=${displayImage(a.url)} x="0" y="0" width=${a.width} height=${a.height} preserveAspectRatio="xMinYMin meet" clip-path=${`url(#${clipId}-a)`}></image>`:nothing}${b.url?svg`<image href=${displayImage(b.url)} x="0" y="0" width=${b.width} height=${b.height} preserveAspectRatio="xMinYMin meet" clip-path=${`url(#${clipId}-b)`}></image>`:nothing}<line class="candidate-comparison-divider" x1=${split} x2=${split} y1="0" y2=${a.height} aria-hidden="true"></line>`:nothing}
      </svg>
    </section>`;
  }
  render(key:string,input:CandidateComparisonInput,owns:()=>boolean){
    const pairs=this.pairs(input),signature=JSON.stringify(pairs);
    let state=this.states.get(key);
    if(!state||state.signature!==signature){state={signature,clipId:'candidate-comparison-clip-'+(++comparisonIdentity),source:initial(),document:initial()};this.states.set(key,state);}
    const current=state,stillCurrent=()=>this.states.get(key)===current&&current.signature===signature&&owns();
    return html`<section class="candidate-comparison" aria-label="Compare retained candidate and placement">${pairs.map(pair=>this.pair(key,current,pair,stillCurrent))}</section>`;
  }
}
