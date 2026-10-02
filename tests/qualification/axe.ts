import axe,{type AxeResults} from 'axe-core';
import {expect,type Page,type TestInfo} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const version='4.13.0';
const tags=['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'];
const sources=[
  'https://www.npmjs.com/package/axe-core',
  'https://github.com/dequelabs/axe-core/blob/v4.13.0/doc/API.md',
  'https://playwright.dev/docs/accessibility-testing',
];

// Supplemental rendered evidence only: no contrast verdict, rule override or UI action.
// The DOM read and viewport screenshot are sequential observations, not an atomic frame.
async function contrastEvidence(page:Page,info:TestInfo,directory:string,state:string,results:AxeResults,resultSha256:string){
  const targets=results.incomplete.flatMap((rule,ruleIndex)=>rule.id==='color-contrast'?rule.nodes.map((node,nodeIndex)=>({ruleIndex,nodeIndex,target:node.target as unknown})):[]);
  if(!targets.length)return;
  const maximumBytes=4*1024*1024,maximumTargets=128;
  const capturePath=join(directory,state+'.contrast.json'),screenshotPath=join(directory,state+'.contrast.png');
  let capture:unknown={status:'unknown',reason:'capture-not-completed'};
  try{
    capture=await page.evaluate(({targets,maximumTargets})=>{
      const started={timeOrigin:performance.timeOrigin,now:performance.now()};let stringsTruncated=false;
      const bounded=(s:string)=>{if(s.length>320)stringsTruncated=true;return s.slice(0,320);};
      const css=(s:string)=>bounded(s.replace(/url\([^)]*\)/gi,'url([redacted])'));
      const parent=(e:Element):Element|null=>e.assignedSlot??e.parentElement??(e.getRootNode() instanceof ShadowRoot?(e.getRootNode() as ShadowRoot).host:null);
      const identity=(e:Element)=>({tag:e.localName,id:bounded(e.id),role:e.getAttribute('role')});
      const rect=(r:DOMRect|DOMRectReadOnly)=>({x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height});
      const intersection=(r:DOMRect|DOMRectReadOnly)=>({left:Math.max(0,r.left),top:Math.max(0,r.top),right:Math.min(innerWidth,r.right),bottom:Math.min(innerHeight,r.bottom),empty:r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight||r.width<=0||r.height<=0});
      const paint=(e:Element,pseudo?:string)=>{const s=getComputedStyle(e,pseudo);return {
        color:css(s.color),textFillColor:css(s.getPropertyValue('-webkit-text-fill-color')),backgroundColor:css(s.backgroundColor),backgroundImage:css(s.backgroundImage),
        opacity:s.opacity,display:s.display,visibility:s.visibility,overflowX:s.overflowX,overflowY:s.overflowY,overflowClipMargin:css(s.getPropertyValue('overflow-clip-margin')),
        clip:css(s.clip),clipPath:css(s.clipPath),maskImage:css(s.getPropertyValue('mask-image')),filter:css(s.filter),backdropFilter:css(s.getPropertyValue('backdrop-filter')),
        mixBlendMode:s.mixBlendMode,transform:css(s.transform),borderRadius:css(s.borderRadius),boxShadow:css(s.boxShadow),textShadow:css(s.textShadow),
        fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,fill:css(s.fill),stroke:css(s.stroke),strokeWidth:s.strokeWidth,fillOpacity:s.fillOpacity,strokeOpacity:s.strokeOpacity,
        pointerEvents:s.pointerEvents,position:s.position,zIndex:s.zIndex,contentVisibility:css(s.getPropertyValue('content-visibility')),content:pseudo?css(s.content):null,
      };};
      const element=(e:Element)=>({identity:identity(e),box:rect(e.getBoundingClientRect()),client:{left:e.clientLeft,top:e.clientTop,width:e.clientWidth,height:e.clientHeight},
        scroll:{left:e.scrollLeft,top:e.scrollTop,width:e.scrollWidth,height:e.scrollHeight},paint:paint(e),before:paint(e,'::before'),after:paint(e,'::after'),
        inert:e instanceof HTMLElement&&e.inert,ariaHidden:e.getAttribute('aria-hidden'),ariaDisabled:e.getAttribute('aria-disabled'),ariaExpanded:e.getAttribute('aria-expanded'),
        disabled:e instanceof HTMLButtonElement||e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLTextAreaElement?e.disabled:null,
        readOnly:e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement?e.readOnly:null,
        state:{hover:e.matches(':hover'),active:e.matches(':active'),focus:e.matches(':focus'),focusVisible:e.matches(':focus-visible')},
        animations:e.getAnimations().slice(0,8).map(a=>({playState:a.playState,currentTime:typeof a.currentTime==='number'?a.currentTime:null})),animationCount:e.getAnimations().length});
      const context=()=>{let focus:Element|null=document.activeElement,depth=0;while(focus?.shadowRoot?.activeElement&&depth<8){focus=focus.shadowRoot.activeElement;depth++;}
        return {timeOrigin:performance.timeOrigin,now:performance.now(),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY},
          visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null,
          focus:focus?identity(focus):null,focusDepth:depth,forcedColors:matchMedia('(forced-colors: active)').matches,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
          appearance:document.documentElement.dataset.enAppearance??null};};
      const modalHosts=Array.from(document.querySelectorAll('dialog,en-dialog,en-drawer'));
      const modals=modalHosts.slice(0,16).map(host=>{const list=host instanceof HTMLDialogElement?[host]:Array.from(host.shadowRoot?.querySelectorAll('dialog')??[]);
        return {host:identity(host),nativeCount:list.length,dialogs:list.slice(0,2).map(d=>({identity:identity(d),open:d.open,modal:d.matches(':modal'),box:rect(d.getBoundingClientRect()),paint:paint(d),backdrop:paint(d,'::backdrop')}))};});
      const resolve=(target:unknown):{node:Element|null;reason:string|null}=>{
        if(!Array.isArray(target)||target.length!==1)return {node:null,reason:'unsupported-frame-or-target-path'};
        const path=typeof target[0]==='string'?[target[0]]:target[0];
        if(!Array.isArray(path)||path.length<1||path.length>8||path.some(s=>typeof s!=='string'||s.length>2048))return {node:null,reason:'unsupported-selector-shape-or-cap'};
        let root:Document|ShadowRoot=document,node:Element|null=null;
        for(let i=0;i<path.length;i++){
          const matches:NodeListOf<Element>=root.querySelectorAll(path[i] as string);if(matches.length!==1)return {node:null,reason:'selector-cardinality-'+matches.length};const selected:Element=matches[0]!;node=selected;
          if(i<path.length-1){if(!selected.shadowRoot)return {node:null,reason:'missing-open-shadow-root'};root=selected.shadowRoot;}
        }return {node,reason:null};
      };
      const relation=(target:Element,hit:Element)=>{let e:Element|null=hit;for(let i=0;e&&i<32;i++,e=parent(e))if(e===target)return 'target-or-descendant';
        e=target;for(let i=0;e&&i<32;i++,e=parent(e))if(e===hit)return 'target-ancestor';return 'other';};
      const hit=(target:Element,x:number,y:number)=>{
        if(x<0||y<0||x>=innerWidth||y>=innerHeight)return {x,y,outsideViewport:true,levels:[]};
        const levels:unknown[]=[];let root:Document|ShadowRoot=document;let capped=false;
        for(let depth=0;depth<8;depth++){const stack:Element[]=root.elementsFromPoint(x,y);levels.push({depth,count:stack.length,stack:stack.slice(0,8).map(e=>({identity:identity(e),relation:relation(target,e),pointerEvents:getComputedStyle(e).pointerEvents}))});
          const next:ShadowRoot|null=stack[0]?.shadowRoot??null;if(!next||next===root)break;root=next;if(depth===7)capped=true;}
        return {x,y,outsideViewport:false,levels,capped};
      };
      const before=context();
      const rows=targets.slice(0,maximumTargets).map(target=>{
        try{
          const resolved=resolve(target.target);if(!resolved.node)return {...target,status:'unknown',reasons:[resolved.reason]};
          const node=resolved.node,ancestors:Element[]=[];let ancestor=parent(node);while(ancestor&&ancestors.length<24){ancestors.push(ancestor);ancestor=parent(ancestor);}
          const seen=new Set<Node>(),text:unknown[]=[],svg:unknown[]=[],rangeBoxes:DOMRect[]=[];let descendantsCapped=false,rangeCount=0;
          const visit=(n:Node,depth:number)=>{
            if(seen.has(n))return;if(seen.size>=128||depth>8){descendantsCapped=true;return;}seen.add(n);
            if(n.nodeType===Node.TEXT_NODE){if(!n.textContent?.trim())return;const range=document.createRange();range.selectNodeContents(n);const rs=range.getClientRects();rangeCount+=rs.length;
              const owner=(n as Text).assignedSlot??n.parentElement,ownerPath:Element[]=[];let e:Element|null=owner;while(e&&e!==node&&!ancestors.includes(e)&&ownerPath.length<12){ownerPath.push(e);e=parent(e);}const ownerPathTruncated=!!e&&e!==node&&!ancestors.includes(e);
              for(let i=0;i<rs.length;i++){if(text.length>=32){descendantsCapped=true;break;}const r=rs[i]!;rangeBoxes.push(r);text.push({box:rect(r),viewportIntersection:intersection(r),owner:owner?identity(owner):null,paint:owner?paint(owner):null,ownerPath:ownerPath.map(element),ownerPathTruncated});}range.detach();return;}
            if(!(n instanceof Element))return;
            if(n instanceof SVGElement){if(svg.length<16)svg.push({identity:identity(n),box:rect(n.getBoundingClientRect()),paint:paint(n)});else descendantsCapped=true;}
            const children=n instanceof HTMLSlotElement?n.assignedNodes({flatten:true}):n.shadowRoot?Array.from(n.shadowRoot.childNodes):Array.from(n.childNodes);
            const actual=children.length?children:Array.from(n.childNodes);for(const child of actual)visit(child,depth+1);
          };visit(node,0);
          const bounds=node.getBoundingClientRect(),sampleIndex=rangeBoxes.findIndex(r=>r.width>0&&r.height>0),sample=sampleIndex<0?bounds:rangeBoxes[sampleIndex]!;
          const points=[[.5,.5],[.15,.15],[.85,.15],[.15,.85],[.85,.85]].map(([x,y])=>hit(node,sample.left+sample.width*x!,sample.top+sample.height*y!));
          const control=[node,...ancestors].find(e=>e.matches('button,input,select,textarea,a[href]'));
          const reasons=['sequential-capture-not-atomic','hit-tests-do-not-prove-complete-visibility'];if(ancestor)reasons.push('ancestor-cap');if(descendantsCapped)reasons.push('descendant-or-range-cap');
          return {...target,status:'observed-unadjudicated',reasons,connected:node.isConnected,targetElement:element(node),viewportIntersection:intersection(bounds),
            control:control?element(control):null,ancestors:ancestors.map(element),ancestorTruncated:!!ancestor,textRanges:text,totalTextRangeCount:rangeCount,svg,
            descendantNodes:seen.size,descendantsCapped,hitSampleSource:{textRangeIndex:sampleIndex<0?null:sampleIndex,box:rect(sample)},hitSamples:points};
        }catch{return {...target,status:'unknown',reasons:['target-capture-error']};}
      });
      return {status:'observed-unadjudicated',started,before,after:context(),expectedTargets:targets.length,capturedTargets:rows.length,targetCap:maximumTargets,targetCapExceeded:targets.length>maximumTargets,
        stringsTruncated,modalHostCount:modalHosts.length,modalCapExceeded:modalHosts.length>16,modals,rows};
    },{targets,maximumTargets});
  }catch{capture={status:'unknown',reason:'page-capture-error',expectedTargets:targets.length};}
  const screenshot={status:'unknown',path:screenshotPath,bytes:0,sha256:null as string|null,startedAt:Date.now(),finishedAt:0};
  try{
    const png=await page.screenshot({fullPage:false,animations:'allow',caret:'initial',scale:'css'});screenshot.bytes=png.byteLength;
    if(png.byteLength<=maximumBytes){await writeFile(screenshotPath,png);screenshot.sha256=createHash('sha256').update(png).digest('hex');screenshot.status='captured';await info.attach('contrast-'+state,{path:screenshotPath,contentType:'image/png'});}
    else screenshot.status='unknown-screenshot-byte-cap';
  }catch{screenshot.status='unknown-screenshot-error';}finally{screenshot.finishedAt=Date.now();}
  let afterScreenshot:unknown;try{afterScreenshot=await page.evaluate(()=>{let focus:Element|null=document.activeElement,depth=0;while(focus?.shadowRoot?.activeElement&&depth<8){focus=focus.shadowRoot.activeElement;depth++;}return {timeOrigin:performance.timeOrigin,now:performance.now(),viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY,devicePixelRatio},focus:focus?{tag:focus.localName,id:focus.id.slice(0,320),role:focus.getAttribute('role')}:null,focusDepth:depth};});}catch{afterScreenshot={status:'unknown'};}
  type Context={timeOrigin?:number;viewport?:Record<string,number>;focus?:unknown};
  const beforeImage=(capture as {after?:Context}).after,afterImage=afterScreenshot as Context;
  const contextChanges=beforeImage?.viewport&&afterImage.viewport?{navigation:beforeImage.timeOrigin!==afterImage.timeOrigin,viewport:['width','height','scrollX','scrollY','devicePixelRatio'].some(key=>beforeImage.viewport![key]!==afterImage.viewport![key]),focus:JSON.stringify(beforeImage.focus)!==JSON.stringify(afterImage.focus)}:null;
  const record={kind:'axe-rendered-contrast-evidence-1',state,resultSha256,capture,screenshot,afterScreenshot,contextChanges,
    limits:{maximumBytes,maximumTargets},disposition:'Supplemental sequential rendered evidence only. No contrast pass, visibility proof or incomplete adjudication is inferred. Clipping rectangles and pointer hit tests do not model every painted pixel. Hit samples cover only the first nonempty text range or target box. Native value text, pseudo-only ink, external SVG/use and paint servers are not fully measured; complex/occluded/unsupported cases remain unknown.'};
  let raw=JSON.stringify(record);
  if(Buffer.byteLength(raw)>maximumBytes)raw=JSON.stringify({...record,capture:{status:'unknown',reason:'capture-byte-cap',expectedTargets:targets.length,targets:targets.slice(0,maximumTargets).map(t=>({ruleIndex:t.ruleIndex,nodeIndex:t.nodeIndex})),omittedTargets:Math.max(0,targets.length-maximumTargets)}},null,2);
  await writeFile(capturePath,raw);await info.attach('contrast-'+state,{path:capturePath,contentType:'application/json'});
}

/**
 * Whole-document scans, with no excluded panels, disabled rules, severity
 * threshold, rule overrides or automatic incomplete-result adjudication.
 * Actual product states must be opened through public controls before scan().
 */
export async function axeEvidence(page:Page,info:TestInfo,output:string,planned:readonly string[],limitations:readonly string[]){
  expect(axe.version,'Installed engine must match the reviewed exact pin').toBe(version);
  const lock=JSON.parse(await readFile('package-lock.json','utf8'));
  const entry=lock.packages['node_modules/axe-core'];
  expect(entry.version).toBe(version);
  expect(lock.packages[''].devDependencies['axe-core']).toBe(version);
  const directory=join(output,'axe');await mkdir(directory,{recursive:true});
  const identity={version,integrity:entry.integrity,sourceSha256:createHash('sha256').update(axe.source).digest('hex'),sources,tags,context:'document',excludedPanels:[],disabledRules:[]};
  await writeFile(join(directory,'engine.json'),JSON.stringify(identity,null,2));
  // Playwright's documented page evaluation API loads the pinned local engine;
  // no script tag, remote CDN, CSP bypass option or application change is used.
  await page.evaluate(axe.source);
  type State={state:string;violations:number;incomplete:number;passes:number;inapplicable:number;resultSha256:string;manualAdjudication:'required'|'no-incomplete-results';};
  const states:State[]=[],incomplete:{state:string;results:AxeResults['incomplete']}[]=[];
  let completed=false;
  const save=async()=>{
    await writeFile(join(directory,'incomplete-review.json'),JSON.stringify({status:incomplete.length?'manual-adjudication-required':'no-incomplete-results',adjudications:[],states:incomplete},null,2));
    await writeFile(join(directory,'coverage.json'),JSON.stringify({
      identity,planned,states,notScanned:planned.filter(state=>!states.some(s=>s.state===state)),
      executionCompleted:completed,automatedViolations:states.reduce((n,s)=>n+s.violations,0),
      manualAdjudicationRequired:incomplete.length>0,limitations,
      ax01Complete:false,
      disposition:'Automated scan evidence only. Full AX01 requires all specified states and manual adjudication; native AT/IME remain separate.',
    },null,2));
  };
  await save();
  return {
    async scan(state:string){
      if(!planned.includes(state)||states.some(s=>s.state===state))throw Error('Unplanned or duplicate axe scan: '+state);
      await page.evaluate(async()=>{await document.fonts.ready;});
      const results=await page.evaluate(async runTags=>{
        const engine=(window as unknown as {axe:typeof axe}).axe;
        return engine.run(document,{runOnly:{type:'tag',values:runTags},resultTypes:['violations','incomplete','passes','inapplicable']});
      },tags);
      expect(results.testEngine.version).toBe(version);
      const raw=JSON.stringify(results,null,2),file=join(directory,state+'.json');
      await writeFile(file,raw);await info.attach('axe-'+state,{path:file,contentType:'application/json'});
      await writeFile(join(directory,state+'.aria.txt'),await page.locator('body').ariaSnapshot());
      states.push({state,violations:results.violations.length,incomplete:results.incomplete.length,passes:results.passes.length,inapplicable:results.inapplicable.length,resultSha256:createHash('sha256').update(raw).digest('hex'),manualAdjudication:results.incomplete.length?'required':'no-incomplete-results'});
      if(results.incomplete.length)incomplete.push({state,results:results.incomplete});
      await save();
      await contrastEvidence(page,info,directory,state,results,states[states.length-1]!.resultSha256);
      expect.soft(results.violations.map(rule=>({id:rule.id,impact:rule.impact,help:rule.help,helpUrl:rule.helpUrl,nodes:rule.nodes.map(node=>({target:node.target,failureSummary:node.failureSummary}))})),state+': zero unresolved applicable WCAG A/AA violations').toEqual([]);
    },
    async finish(){completed=true;await save();expect(states.map(s=>s.state)).toEqual([...planned]);},
  };
}
