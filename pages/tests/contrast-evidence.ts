import type {AxeResults} from 'axe-core';
import type {Page,TestInfo} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {captureWebKitContrast,type ContrastScreencastMetadata} from '../../tests/qualification/contrast-screencast.mjs';

// Pages-only supplement adapted from the existing bounded axe.ts collector.
// Fixed 4/8 editor targets and 1 preview target address the retained 99 gaps.
// No new scan, input, focus change, rule override or numeric verdict.
// The optional fixed narrow exposure observes one target after the caller scrolls it.
// DOM and screenshot are sequential; phase drift/occlusion remain explicit.
export async function capturePagesContrast(page:Page,info:TestInfo,state:string,results:Pick<AxeResults,'incomplete'>,reportPath:string,scope:'editor'|'preview',exposure?:'zoom'|'pan-x'|'pan-y'|'activity'){
  if(!/^[a-z0-9-]{1,64}$/.test(state))throw Error('Invalid Pages contrast state');
  const maximumBytes=4*1024*1024,maximumTargets=8;
  const reportStat=await stat(reportPath);if(!reportStat.isFile()||reportStat.size>maximumBytes)throw Error('Bounded original Pages axe report required');
  const report=await readFile(reportPath),resultSha256=createHash('sha256').update(report).digest('hex');
  const originalTargets=results.incomplete.flatMap((rule,ruleIndex)=>rule.id==='color-contrast'?rule.nodes.map((node,nodeIndex)=>({ruleIndex,nodeIndex,target:node.target as unknown})):[]);
  const minus='[part="decrement"] > span[aria-hidden="true"]';
  const paths=scope==='preview'?[[ '[data-testid="preview-size"]',minus ]]:[
    ['#zoom',minus],['#pan-x',minus],['#pan-y',minus],['en-accordion-item[label="Activity"]','span[part="indicator"][aria-hidden="true"]'],
    ...(state==='help'?[2,3,5,6].map(n=>['#help-drawer > p:nth-child('+n+')']):[]),
  ];
  const exposureIndex=exposure?['zoom','pan-x','pan-y','activity'].indexOf(exposure):-1;
  if(exposure&&(scope!=='editor'||state!=='narrow-panels-post-scroll-'+exposure||exposureIndex<0))throw Error('Invalid fixed narrow exposure');
  const targets=(exposure?[paths[exposureIndex]!]:paths).map(path=>({target:[path]}));
  const webkit=page.context().browser()?.browserType().name()==='webkit';
  const capturePath=info.outputPath('paint-'+scope+'-'+state+'.json'),screenshotPath=info.outputPath('paint-'+scope+'-'+state+(webkit?'.jpg':'.png'));
  let capture:unknown={status:'unknown',reason:'capture-not-completed'};
  try{
    capture=await page.evaluate(({targets,maximumTargets,originalTargets})=>{
      const started={timeOrigin:performance.timeOrigin,now:performance.now()};let stringsTruncated=false;
      const bounded=(s:string)=>{if(s.length>320)stringsTruncated=true;return s.slice(0,320);};
      const css=(s:string)=>bounded(s.replace(/url\([^)]*\)/gi,'url([redacted])'));
      const parent=(e:Element):Element|null=>e.assignedSlot??e.parentElement??(e.getRootNode() instanceof ShadowRoot?(e.getRootNode() as ShadowRoot).host:null);
      const identity=(e:Element)=>({tag:e.localName,id:bounded(e.id),role:e.getAttribute('role'),part:e.getAttribute('part')});
      // Public DOM label sources, not a guessed accessibility-name algorithm.
      const labelText=(e:Element)=>{const seen=new Set<Node>();let text='',capped=false;
        const visit=(n:Node,depth:number)=>{if(seen.has(n))return;if(seen.size>=64||depth>8){capped=true;return;}seen.add(n);
          if(n.nodeType===Node.TEXT_NODE){text+=n.textContent??'';return;}if(!(n instanceof Element))return;
          if(n.getAttribute('aria-hidden')==='true')return;
          const children=n instanceof HTMLSlotElement?n.assignedNodes({flatten:true}):n.shadowRoot?Array.from(n.shadowRoot.childNodes):Array.from(n.childNodes);
          for(const child of children.length?children:Array.from(n.childNodes))visit(child,depth+1);};visit(e,0);
        return {text:bounded(text.trim()),capped};};
      const semantics=(e:Element)=>{const root=e.getRootNode(),byId=(id:string)=>root instanceof Document||root instanceof ShadowRoot?root.getElementById(id):null;
        const labelledBy=e.getAttribute('aria-labelledby'),describedBy=e.getAttribute('aria-describedby');
        const references=(ids:string|null)=>{const all=(ids??'').trim().split(/\s+/).filter(Boolean);return {count:all.length,capped:all.length>8,
          nodes:all.slice(0,8).map(id=>{const node=byId(id);return {id:bounded(id),found:!!node,text:node?labelText(node):null};})};};
        return {ariaLabel:e.getAttribute('aria-label'),label:e.getAttribute('label'),title:e.getAttribute('title'),
          labelledBy:references(labelledBy),describedBy:references(describedBy),labelText:labelText(e),hidden:e.hasAttribute('hidden')};};
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
      const element=(e:Element)=>({identity:identity(e),semantics:semantics(e),box:rect(e.getBoundingClientRect()),client:{left:e.clientLeft,top:e.clientTop,width:e.clientWidth,height:e.clientHeight},
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
          appearance:document.documentElement.dataset.enAppearance??null,theme:document.documentElement.dataset.enTheme??null};};
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
          const node=resolved.node,originalMatches=originalTargets.slice(0,128).filter(row=>resolve(row.target).node===node),ancestors:Element[]=[];let ancestor=parent(node);while(ancestor&&ancestors.length<24){ancestors.push(ancestor);ancestor=parent(ancestor);}
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
          return {...target,status:'observed-unadjudicated',originalMatches,reasons,connected:node.isConnected,targetElement:element(node),viewportIntersection:intersection(bounds),
            control:control?element(control):null,ancestors:ancestors.map(element),ancestorTruncated:!!ancestor,textRanges:text,totalTextRangeCount:rangeCount,svg,
            descendantNodes:seen.size,descendantsCapped,hitSampleSource:{textRangeIndex:sampleIndex<0?null:sampleIndex,box:rect(sample)},hitSamples:points};
        }catch{return {...target,status:'unknown',reasons:['target-capture-error']};}
      });
      return {status:'observed-unadjudicated',started,before,after:context(),expectedTargets:targets.length,capturedTargets:rows.length,targetCap:maximumTargets,targetCapExceeded:targets.length>maximumTargets,
        stringsTruncated,originalTargetCount:originalTargets.length,originalTargetCapExceeded:originalTargets.length>128,modalHostCount:modalHosts.length,modalCapExceeded:modalHosts.length>16,modals,rows};
    },{targets,maximumTargets,originalTargets});
  }catch{capture={status:'unknown',reason:'page-capture-error',expectedTargets:targets.length};}
  const screenshot={status:'unknown',path:exposure?null:screenshotPath,bytes:0,sha256:null as string|null,startedAt:Date.now(),finishedAt:0,
    method:webkit?'playwright-public-screencast':'playwright-page-screenshot',codec:webkit?'JPEG':'PNG',mimeType:webkit?'image/jpeg':'image/png',
    capture:null as ContrastScreencastMetadata|null};
  let captureCleanupFailed=false;
  try{
    if(exposure){screenshot.status='not-requested-dom-only-exposure';screenshot.method='none';screenshot.codec='none';screenshot.mimeType='none';}
    else if(webkit){
      const viewport=page.viewportSize();
      if(!viewport)screenshot.status='unknown-viewport';
      else{
        const frame=await captureWebKitContrast(page,{...viewport,maximumBytes});
        screenshot.capture=frame.metadata;screenshot.status=frame.metadata.status;captureCleanupFailed=frame.stopFailed;
        if(frame.data){screenshot.bytes=frame.data.byteLength;screenshot.sha256=createHash('sha256').update(frame.data).digest('hex');
          await writeFile(screenshotPath,frame.data);await info.attach('paint-'+scope+'-'+state,{path:screenshotPath,contentType:'image/jpeg'});}
      }
    }else{
      const png=await page.screenshot({fullPage:false,animations:'allow',caret:'initial',scale:'css',timeout:10_000});screenshot.bytes=png.byteLength;
      if(png.byteLength<=maximumBytes){await writeFile(screenshotPath,png);screenshot.sha256=createHash('sha256').update(png).digest('hex');screenshot.status='captured';await info.attach('paint-'+scope+'-'+state,{path:screenshotPath,contentType:'image/png'});}
      else screenshot.status='unknown-screenshot-byte-cap';
    }
  }catch{screenshot.status='unknown-screenshot-error';}finally{screenshot.finishedAt=Date.now();}
  let afterScreenshot:unknown;try{afterScreenshot=await page.evaluate(()=>{let focus:Element|null=document.activeElement,depth=0;while(focus?.shadowRoot?.activeElement&&depth<8){focus=focus.shadowRoot.activeElement;depth++;}return {timeOrigin:performance.timeOrigin,now:performance.now(),viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY,devicePixelRatio},visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null,focus:focus?{tag:focus.localName,id:focus.id.slice(0,320),role:focus.getAttribute('role'),part:focus.getAttribute('part')}:null,focusDepth:depth,appearance:document.documentElement.dataset.enAppearance??null,theme:document.documentElement.dataset.enTheme??null};});}catch{afterScreenshot={status:'unknown'};}
  type Context={timeOrigin?:number;appearance?:string|null;theme?:string|null;viewport?:Record<string,number>;visualViewport?:{width:number;height:number;offsetLeft:number;offsetTop:number;scale:number}|null;focus?:unknown};
  const beforeImage=(capture as {after?:Context}).after,afterImage=afterScreenshot as Context;
  const contextChanges=beforeImage?.viewport&&afterImage.viewport?{navigation:beforeImage.timeOrigin!==afterImage.timeOrigin,appearance:beforeImage.appearance!==afterImage.appearance,theme:beforeImage.theme!==afterImage.theme,viewport:['width','height','scrollX','scrollY','devicePixelRatio'].some(key=>beforeImage.viewport![key]!==afterImage.viewport![key]),focus:JSON.stringify(beforeImage.focus)!==JSON.stringify(afterImage.focus)}:null;
  const requestedSize=screenshot.capture?.requestedSize,domViewportMatchesRequest=!!requestedSize&&!!beforeImage?.viewport&&!!afterImage?.viewport&&
    beforeImage.viewport.width===requestedSize.width&&beforeImage.viewport.height===requestedSize.height&&
    afterImage.viewport.width===requestedSize.width&&afterImage.viewport.height===requestedSize.height;
  const beforeVisual=beforeImage?.visualViewport,afterVisual=afterImage?.visualViewport;
  const visualViewportMatchesRequest=!!requestedSize&&!!beforeVisual&&!!afterVisual&&JSON.stringify(beforeVisual)===JSON.stringify(afterVisual)&&
    beforeVisual.scale===1&&beforeVisual.offsetLeft===0&&beforeVisual.offsetTop===0&&beforeVisual.width===requestedSize.width&&beforeVisual.height===requestedSize.height;
  const dpr=beforeImage?.viewport?.devicePixelRatio;
  const webkitContext=webkit&&!exposure?{before:(capture as {after?:unknown}).after??null,after:afterScreenshot,devicePixelRatio:dpr??null,
    domViewportMatchesRequest,visualViewportMatchesRequest,
    scale:'Encoded-to-CSS ratio applies only with exact stable DOM/requested/visual viewport joins; mismatched, offset or zoomed viewports remain unknown.',
    unchanged:contextChanges?Object.values(contextChanges).every(value=>value===false)&&typeof dpr==='number'&&Number.isFinite(dpr)&&dpr>0&&dpr===afterImage?.viewport?.devicePixelRatio&&domViewportMatchesRequest&&visualViewportMatchesRequest:false}:null;
  if(webkit&&screenshot.status==='captured'&&!webkitContext?.unchanged)screenshot.status='unknown-context-drift';
  const record={kind:'pages-rendered-contrast-evidence-1',scope,state,reportPath,resultSha256,webkitContext,capture,screenshot,afterScreenshot,contextChanges,
    ...(exposure?{observation:{phase:'post-scroll-exposure',target:exposure,sourceAxeState:'narrow-panels',
      relationship:'Original report identifies the target only. This is a later exposed DOM/paint/clip/hit observation after public scroll; no new axe scan or same-state axe PASS, screenshot or physical-frame claim.'}}:{}),
    limits:{maximumBytes,maximumTargets},disposition:'Supplemental sequential rendered evidence only. No contrast pass, visibility proof or incomplete adjudication is inferred. Clipping rectangles and pointer hit tests do not model every painted pixel. Hit samples cover only the first nonempty text range or target box. Native value text, pseudo-only ink, external SVG/use and paint servers are not fully measured; complex/occluded/unsupported cases remain unknown. WebKit JPEG is lossy supplemental visual evidence: no exact RGB, tiny-glyph edge, PNG agreement, atomic axe/DOM/frame or physical-presentation claim.'};
  let raw=JSON.stringify(record);
  if(Buffer.byteLength(raw)>maximumBytes)raw=JSON.stringify({...record,capture:{status:'unknown',reason:'capture-byte-cap',expectedTargets:targets.length,targets:targets.slice(0,maximumTargets),omittedTargets:Math.max(0,targets.length-maximumTargets)}},null,2);
  await writeFile(capturePath,raw);await info.attach('paint-'+scope+'-'+state,{path:capturePath,contentType:'application/json'});
  if(captureCleanupFailed)throw new Error('WebKit supplemental screencast stop failed');
}
