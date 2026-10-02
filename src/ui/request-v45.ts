import {html,nothing} from 'lit';
import {V45_GENERATION_QUALITIES,V45_GENERATION_PRESETS,V45_GENERATION_PRESET_DIMENSIONS,V45_GENERATION_SIZES} from '../request/v45.js';
import type {V45GenerateFields} from '../request/v45.js';

export type V45GenerationControlOptions={
 disabled:boolean;
 error?:(field:string)=>string;
 /** The owning controller settles the public control event and applies the patch atomically. */
 change:(event:Event,patch:(value:string)=>Partial<V45GenerateFields>)=>void;
};
const dimensionValue=(width:number|string,height:number|string)=>width+'x'+height;
const sizeLabel=(width:number|string,height:number|string)=>width+' × '+height;

/** Generation-only controls. V4 drafts, edit inputs and approvals do not enter this form. */
export function renderV45Generation(fields:V45GenerateFields,options:V45GenerationControlOptions){
 const change=(key:keyof V45GenerateFields)=>(event:Event)=>{if(!options.disabled)options.change(event,value=>({[key]:value}));};
 const dimensions=dimensionValue(fields.width,fields.height),knownDimensions=V45_GENERATION_SIZES.some(([w,h])=>dimensions===dimensionValue(w,h));
 const dimensionsChanged=(event:Event)=>{if(options.disabled)return;options.change(event,value=>{const match=V45_GENERATION_SIZES.find(([w,h])=>value===dimensionValue(w,h));if(!match)throw Error('Choose one of the supported v4.5 output sizes.');return {width:String(match[0]),height:String(match[1])};});};
 return html`<section aria-label="Ideogram v4.5 generation settings" id="request-v45-settings">
  <p>Ideogram v4.5 · text to image. These settings belong to this operation.</p>
  <en-select id="request-quality" label="Quality" .value=${fields.quality} ?disabled=${options.disabled} @en-change=${change('quality')}>${V45_GENERATION_QUALITIES.map(value=>html`<en-select-option value=${value}>${value}</en-select-option>`)}</en-select>
  <en-select id="request-promptExpansion" label="Prompt expansion" .value=${fields.promptExpansion} ?disabled=${options.disabled} @en-change=${change('promptExpansion')}><en-select-option value="enabled">Enabled</en-select-option><en-select-option value="disabled">Disabled</en-select-option></en-select>
  <p>Expansion can rewrite the prompt. Requested and submitted text remain retained; this endpoint contract does not declare a returned prompt.</p>
  <en-number-field id="request-count" label="Output count" .value=${fields.count} .error=${options.error?.('count')??''} ?disabled=${options.disabled} @en-input=${change('count')} @en-change=${change('count')}></en-number-field><p>This application admits 1–4 outputs per request.</p>
  <en-text-field id="request-seed" label="Exact seed (empty means Random)" .value=${fields.seed} .error=${options.error?.('seed')??''} ?disabled=${options.disabled} @en-input=${change('seed')}></en-text-field>
  <en-select id="request-size" label="Request size" .value=${fields.size} .error=${options.error?.('size')??''} ?disabled=${options.disabled} @en-change=${change('size')}>${V45_GENERATION_PRESETS.map(value=>{const [width,height]=V45_GENERATION_PRESET_DIMENSIONS[value];return html`<en-select-option value=${value}>${value} · ${sizeLabel(width,height)}${value==='square'?' (promoted to square_hd)':''}</en-select-option>`;})}<en-select-option value="custom">Choose supported dimensions</en-select-option></en-select>
  ${fields.size==='custom'?html`<en-select id="request-dimensions" label="Supported output dimensions" .value=${dimensions} .error=${options.error?.('dimensions')??''} ?disabled=${options.disabled} @en-change=${dimensionsChanged}>${!knownDimensions?html`<en-select-option value=${dimensions}>Unsupported saved dimensions: ${sizeLabel(fields.width,fields.height)}</en-select-option>`:nothing}${V45_GENERATION_SIZES.map(([width,height])=>html`<en-select-option value=${dimensionValue(width,height)}>${sizeLabel(width,height)}</en-select-option>`)}</en-select><p>Choose one of the 36 exact supported sizes. Dimensions are not rounded.</p>`:nothing}
  <p>Output format is controlled by the provider. Actual format, dimensions and returned count are recorded only when available; requested dimensions do not prove returned geometry.</p>
  <en-alert id="request-v45-safety" announcement="none">Safety admission is not qualified for this endpoint. Returned images remain withheld from ordinary display, adoption and export.</en-alert>
 </section>`;
}

export function renderV45GenerationReview(request:import('../request/family.js').V45GenerateModel,seed:import('../request/core.js').Seed){
 return html`<section aria-label="Ideogram v4.5 request contract" id="request-v45-review-contract">
  <p>Requested ${sizeLabel(request.requested.width,request.requested.height)} · ${request.body.num_images} output(s) · ${request.body.quality} quality. Prompt expansion ${request.body.enable_prompt_expansion?'enabled':'disabled'}.</p>
  <p>Seed: ${seed.kind==='integer'?seed.decimal:'Random'}. Asynchronous delivery (sync_mode false).</p>
  <p>Output format is provider-controlled. Returned prompt and timings are not provided by this endpoint contract.</p>
  <p>Safety admission remains unqualified. A completed request does not authorize image display, adoption or export.</p>
  <p>Published ${request.estimate.rateDate} estimate: USD ${(request.estimate.cents/100).toFixed(2)} for this request. Actual charge is unavailable; cancellation does not guarantee a refund. Rate source: ${request.estimate.rateSource}.</p>
 </section>`;
}

export function renderV45UnavailableResultMetadata(){
 return html`<p id="result-v45-metadata">This endpoint contract does not declare a returned prompt, timings or image dimensions. Requested settings and reported response metadata remain separate from measured image properties.</p>`;
}

/** Pricing disclosures follow the recorded family, including for recovered queue history. */
export function renderRequestEstimate(estimate:ReturnType<typeof import('../request/family.js').estimate>){
 if('cents' in estimate)return html`<p>Published ${estimate.rateDate} estimate: USD ${(estimate.cents/100).toFixed(2)} for this request. Rate source: ${estimate.rateSource}. Actual charge is unavailable; cancellation does not guarantee a refund.</p>`;
 return html`<p>Published ${estimate.source}: USD ${estimate.rate} per ${estimate.unit}, count ${estimate.count}. Total and actual spend are unknown. Unknown estimate components: ${estimate.unknown.join(', ')}.</p>`;
}
