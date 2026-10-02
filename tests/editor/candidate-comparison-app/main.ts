// Copy this fixture to tests/editor when assembling this staged packet.
import {LitElement,html,nothing} from 'lit';
import {createElementScope} from '@en-reve/elements/element-scope.js';
import {buttonDefinition} from '@en-reve/elements/definitions/button.js';
import {numberFieldDefinition} from '@en-reve/elements/definitions/number-field.js';
import {selectDefinition} from '@en-reve/elements/definitions/select.js';
import {selectOptionDefinition} from '@en-reve/elements/definitions/select-option.js';
import {toolbarDefinition} from '@en-reve/elements/definitions/toolbar.js';
import {CandidateComparison,type CandidateComparisonInput} from '../../../src/ui/candidate-comparison.js';
import {createDisplayPreviewURL,displayPreviewOwnership,revokeDisplayPreviewURL} from '../../../src/observability/display-preview.js';
import {DISPLAY_HEADERS,DISPLAY_PROFILE,displayPath} from '../../../src/protocol/display.js';
import {allocationLedger} from '../../../src/observability/allocations.js';
const scope=createElementScope({document,registry:'auto'});scope.register([buttonDefinition,numberFieldDefinition,selectDefinition,selectOptionDefinition,toolbarDefinition]);
class ComparisonFixture extends LitElement {
 comparison=new CandidateComparison(this);input:CandidateComparisonInput|null=null;urls:string[]=[];reads:string[]=[];live=true;
 constructor(){super();this.renderOptions.creationScope=scope.creationScope;}
 protected createRenderRoot(){return this;}
 render(){return html`<main>${this.input?this.comparison.render('fixture',this.input,()=>this.live):nothing}</main>`;}
 snapshot(){const ledger=allocationLedger.snapshot();return {ownership:displayPreviewOwnership(),ledger:{cpuBytes:ledger.cpuBytes,gpuBytes:ledger.gpuBytes,handles:ledger.handles,activeRecords:ledger.activeRecords},reads:[...this.reads],lifecycle:this.comparison.lifecycle,boxes:[...this.querySelectorAll('svg[data-comparison-side]')].map(svg=>({side:svg.getAttribute('data-comparison-side'),box:svg.getAttribute('viewBox')}))};}
 async prepare(png:{bytes:number[];hash:string;identity:string}){
  if(this.input)throw Error('FIXTURE_ALREADY_PREPARED');
  for(const id of ['source','candidate']){
   const source={assetId:id,basis:'pixels' as const,identity:png.identity,width:4000,height:3000},path=displayPath(id,{kind:'preview',edge:1024,basis:source.basis,identity:source.identity});
   // Only transport is substituted. Production SHA validation, native bounded
   // decoding, Blob ownership, comparison and SVG consumer lifetimes remain real.
   this.urls.push(await createDisplayPreviewURL(async actual=>{if(actual!==path)throw Error('UNEXPECTED_PREVIEW_ROUTE');this.reads.push(actual);return new Response(Uint8Array.from(png.bytes),{headers:{'Content-Type':'image/png','Content-Length':String(png.bytes.length),ETag:'"'+png.hash+'"',[DISPLAY_HEADERS.profile]:DISPLAY_PROFILE,[DISPLAY_HEADERS.source]:source.identity,[DISPLAY_HEADERS.basis]:'pixels',[DISPLAY_HEADERS.width]:'1024',[DISPLAY_HEADERS.height]:'768',[DISPLAY_HEADERS.sourceWidth]:'4000',[DISPLAY_HEADERS.sourceHeight]:'3000',[DISPLAY_HEADERS.lod]:'0'}});},source,{owner:'comparison-browser-fixture',edge:1024}));
  }
  this.input={sourceURL:this.urls[0]!,preparedURL:this.urls[1]!,beforeURL:this.urls[0]!,afterURL:this.urls[1]!,width:4000,height:3000,documentWidth:4000,documentHeight:3000,placement:'current-document',newDocSameGrid:true};this.requestUpdate();await this.updateComplete;return this.snapshot();
 }
 async refresh(){this.requestUpdate();await this.updateComplete;return this.snapshot();}
 async clear(){this.live=false;this.input=null;this.requestUpdate();await this.updateComplete;await this.comparison.dispose();for(const url of this.urls)revokeDisplayPreviewURL(url);this.urls=[];return this.snapshot();}
}
scope.register([{tagName:'candidate-comparison-fixture',elementClass:ComparisonFixture}]);const fixture=scope.createElement('candidate-comparison-fixture') as ComparisonFixture;document.body.append(fixture);
declare global{interface Window{candidateComparisonFixture:ComparisonFixture;}}
window.candidateComparisonFixture=fixture;
