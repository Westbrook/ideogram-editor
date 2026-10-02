import {html,svg,nothing} from 'lit';
import {displayImage} from './display-image.js';
import {comparisonViewBox,type ComparisonView} from './comparison-viewport.js';

export type ComparisonPicture=Readonly<{url:string;width:number;height:number;name:string;transparent?:boolean}>;
export type ComparisonPair=Readonly<{id:string;heading:string;label:string;a:ComparisonPicture;b:ComparisonPicture;allowOverlay:boolean}>;
export type ComparisonMode='a'|'b'|'reveal'|'side-by-side';
export type ComparisonPairView={mode:ComparisonMode;value:string;percentage:number;error:string;zoomValue:string;xValue:string;yValue:string;view:ComparisonView};
export type ComparisonActions={
 mode:(event:Event,mode?:ComparisonMode)=>void;
 reveal:(event:Event,value?:number)=>void;
 field:(event:Event,field:'zoomValue'|'xValue'|'yValue')=>void;
 apply:(event:Event)=>void;fit:(event:Event)=>void;
 pan:(event:Event,direction:'left'|'right'|'up'|'down')=>void;
};
const valid=(picture:ComparisonPicture)=>Number.isSafeInteger(picture.width)&&picture.width>0&&picture.width<=8192&&Number.isSafeInteger(picture.height)&&picture.height>0&&picture.height<=8192&&picture.width*picture.height<=25000000;
export function pairFrame(pair:ComparisonPair){return {width:Math.max(pair.a.width,pair.b.width),height:Math.max(pair.a.height,pair.b.height)};}
export function pairCanReveal(pair:ComparisonPair){return pair.allowOverlay&&valid(pair.a)&&valid(pair.b)&&pair.a.width===pair.b.width&&pair.a.height===pair.b.height&&(!!pair.a.url||pair.a.transparent===true)&&(!!pair.b.url||pair.b.transparent===true);}
const image=(picture:ComparisonPicture,clip?:string)=>picture.url?svg`<image href=${displayImage(picture.url)} x="0" y="0" width=${picture.width} height=${picture.height} preserveAspectRatio="xMinYMin meet" clip-path=${clip?`url(#${clip})`:nothing}></image>`:nothing;

/** Stateless presentation: its caller owns state, input strings and callbacks.
 * Every alias still passes through displayImage before native image decoding. */
export function renderComparisonPair(id:string,clipId:string,pair:ComparisonPair,current:ComparisonPairView,enabled:boolean,actions:ComparisonActions){
 if(!valid(pair.a)||!valid(pair.b))return html`<section class="candidate-comparison-pair" aria-label=${pair.heading}><h5>${pair.heading}</h5><p>Original dimensions are unavailable. Inspect the retained candidate again.</p></section>`;
 const frame=pairFrame(pair),box=comparisonViewBox(frame,current.view),sameGrid=pairCanReveal(pair),mode=current.mode==='reveal'&&!sameGrid?'side-by-side':current.mode;
 const split=pair.a.width*current.percentage/100;
 const picture=(side:'a'|'b')=>{const p=pair[side];return html`<figure><figcaption>${side.toUpperCase()}: ${p.name} · ${p.width} × ${p.height} original pixels</figcaption><svg class="candidate-comparison-stage" data-comparison-side=${side} viewBox=${box} width=${frame.width} height=${frame.height} role="img" aria-label=${p.name} preserveAspectRatio="xMidYMid meet">${image(p)}</svg>${!p.url?html`<p>${p.transparent?'Empty transparent document.':'No retained image for this view.'}</p>`:nothing}</figure>`;};
 return html`<section class="candidate-comparison-pair" data-comparison-pair=${pair.id} aria-label=${pair.heading}>
  <h5>${pair.heading}</h5>
  <p class="candidate-comparison-grid-status">${sameGrid?`Matched original coordinates: ${pair.a.width} × ${pair.a.height} pixels.`:'Different original grids. Side-by-side uses a shared display scale without stretching; coordinate equivalence and reveal are unavailable.'} Display previews remain bounded; zoom does not change retained source or output dimensions.</p>
  <div class="candidate-comparison-controls">
   <en-select id=${id+'-mode'} label=${pair.label+' comparison mode'} .value=${mode} ?disabled=${!enabled} @en-change=${(event:Event)=>actions.mode(event)}>
    <en-select-option value="side-by-side">Side by side</en-select-option><en-select-option value="a">A: ${pair.a.name}</en-select-option><en-select-option value="b">B: ${pair.b.name}</en-select-option>${sameGrid?html`<en-select-option value="reveal">Reveal B beside A</en-select-option>`:nothing}
   </en-select>
   <en-number-field id=${id+'-reveal'} label=${pair.label+' reveal percentage'} min="0" max="100" step="1" .value=${current.value} ?disabled=${!enabled||!sameGrid} @en-input=${(event:Event)=>actions.reveal(event)} @en-change=${(event:Event)=>actions.reveal(event)}></en-number-field>
  </div>
  <en-toolbar label=${pair.label+' comparison buttons'} keyboard-navigation="tab">
   <en-button ?disabled=${!enabled} aria-pressed=${String(mode==='a')} @click=${(event:Event)=>actions.mode(event,'a')}>Show A: ${pair.a.name}</en-button>
   <en-button ?disabled=${!enabled} aria-pressed=${String(mode==='b')} @click=${(event:Event)=>actions.mode(event,'b')}>Show B: ${pair.b.name}</en-button>
   <en-button ?disabled=${!enabled} aria-pressed=${String(mode==='side-by-side')} @click=${(event:Event)=>actions.mode(event,'side-by-side')}>Show side by side</en-button>
   <en-button ?disabled=${!enabled||!sameGrid} @click=${(event:Event)=>actions.reveal(event,25)}>Reveal 25%</en-button><en-button ?disabled=${!enabled||!sameGrid} @click=${(event:Event)=>actions.reveal(event,50)}>Reveal 50%</en-button><en-button ?disabled=${!enabled||!sameGrid} @click=${(event:Event)=>actions.reveal(event,75)}>Reveal 75%</en-button>
  </en-toolbar>
  <fieldset class="candidate-comparison-viewport"><legend>${pair.label} shared view</legend>
   <div class="candidate-comparison-controls"><en-number-field label=${pair.label+' shared zoom (% of fit)'} min="25" max="1600" step="25" .value=${current.zoomValue} ?disabled=${!enabled} @en-input=${(event:Event)=>actions.field(event,'zoomValue')} @en-change=${(event:Event)=>actions.field(event,'zoomValue')}></en-number-field><en-number-field label=${pair.label+' horizontal offset (original px)'} .value=${current.xValue} ?disabled=${!enabled} @en-input=${(event:Event)=>actions.field(event,'xValue')} @en-change=${(event:Event)=>actions.field(event,'xValue')}></en-number-field><en-number-field label=${pair.label+' vertical offset (original px)'} .value=${current.yValue} ?disabled=${!enabled} @en-input=${(event:Event)=>actions.field(event,'yValue')} @en-change=${(event:Event)=>actions.field(event,'yValue')}></en-number-field></div>
   <en-toolbar label=${pair.label+' shared view actions'} keyboard-navigation="tab"><en-button ?disabled=${!enabled} @click=${actions.apply}>Apply shared view</en-button><en-button ?disabled=${!enabled} @click=${actions.fit}>Fit both views</en-button><en-button ?disabled=${!enabled} @click=${(event:Event)=>actions.pan(event,'left')}>Pan both left</en-button><en-button ?disabled=${!enabled} @click=${(event:Event)=>actions.pan(event,'right')}>Pan both right</en-button><en-button ?disabled=${!enabled} @click=${(event:Event)=>actions.pan(event,'up')}>Pan both up</en-button><en-button ?disabled=${!enabled} @click=${(event:Event)=>actions.pan(event,'down')}>Pan both down</en-button></en-toolbar>
  </fieldset>
  ${current.error?html`<p role="alert">${current.error}</p>`:nothing}
  <p id=${id+'-status'} role="status">${mode==='side-by-side'?'A and B side by side':mode==='a'?'A: '+pair.a.name:mode==='b'?'B: '+pair.b.name:`Reveal ${current.percentage}% B on the left and A on the right`}. Shared zoom ${current.view.zoom}% of fit; offset ${current.view.x}, ${current.view.y} original pixels.</p>
  ${mode==='side-by-side'?html`<div class="candidate-comparison-separate">${picture('a')}${picture('b')}</div>`:mode==='a'?picture('a'):mode==='b'?picture('b'):html`<svg class="candidate-comparison-stage" data-comparison-side="reveal" viewBox=${box} width=${frame.width} height=${frame.height} role="img" aria-label=${pair.heading+': shared-coordinate reveal'} preserveAspectRatio="xMidYMid meet"><defs><clipPath id=${clipId+'-a'} clipPathUnits="userSpaceOnUse"><rect x=${split} y="0" width=${pair.a.width-split} height=${pair.a.height}></rect></clipPath><clipPath id=${clipId+'-b'} clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width=${split} height=${pair.b.height}></rect></clipPath></defs>${image(pair.a,clipId+'-a')}${image(pair.b,clipId+'-b')}<line class="candidate-comparison-divider" x1=${split} x2=${split} y1="0" y2=${pair.a.height} aria-hidden="true"></line></svg>`}
 </section>`;
}
