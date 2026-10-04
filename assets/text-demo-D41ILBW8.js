import{o as e,r as t}from"./lit-tfDubpWu.js";import{a as n,i as r,n as i,o as a,r as o,s,t as c}from"./density-b6s3w18k.js";import{K as l,y as u}from"./controls-DTIvEShr.js";import{A as ee,D as d,E as te,O as f,S as p,_ as m,a as h,b as g,c as _,h as v,i as ne,j as re,l as y,n as b,o as x,r as S,s as ie,t as C,x as w,y as T}from"./native-text-preview-Bo9Sxpnz.js";import{t as ae}from"./adapters-CoFyKvlB.js";import{r as E}from"./allocations-BPOIe_aM.js";var D=Object.assign({"../../vendor/text/fonts/NotoSans-Regular.ttf":h,"../../vendor/text/fonts/NotoSansArabic-Regular.ttf":ne,"../../vendor/text/fonts/NotoSansCJKsc-Regular.otf":S,"../../vendor/text/fonts/NotoSansSymbols2-Regular.ttf":b}),O=g(v.fonts.map(e=>({id:e.id,hash:`sha256:`+e.sha256,bytes:e.bytes}))),k=new Map,A=new Map;async function j(e,t){let n=k.get(e);if(n)return n;let r=A.get(e);if(r)return r;let i=v.fonts.find(t=>t.id===e);i||T(`FONT_NOT_BUNDLED`);let a=y.reserve(5*i.bytes),o=(async()=>{try{let n=new URL(D[`../../vendor/text/`+i.file],location.href);n.origin!==location.origin&&T(`FONT_ORIGIN`);let r=await p(n,i.bytes,t);(r.size!==i.bytes||await w(r)!==`sha256:`+i.sha256)&&T(`FONT_HASH`);let o=g({hash:`sha256:`+i.sha256,bytes:r,faceIndex:0,origin:`bundled`,license:{hash:i.licenseHash,embedding:`permitted`}});return a.release(),y.reserve(r.size),ie(r),k.set(e,o),o}finally{a.release(),A.delete(e)}})();return A.set(e,o),o}var M=2048,N=Object.freeze({text:`A little room
to create.`,font:`NotoSans`,size:`96`,color:`#194ECA`,align:`start`,direction:`auto`}),oe=Object.freeze({NotoSans:`Noto Sans`,NotoSansArabic:`Noto Sans Arabic`,NotoSansSymbols2:`Noto Sans Symbols 2`,NotoSansCJKsc:`Noto Sans CJK SC`}),P=Object.freeze(O.map(e=>Object.freeze({id:e.id,label:oe[e.id]??e.id})));function F(e){if(!e.text.trim())throw Error(`Enter some text before rendering.`);if(e.text.length>2048)throw Error(`Keep this preview to ${M.toLocaleString(`en-US`)} characters. Your text has not been shortened.`);let t=1;for(let n of e.text)n===`
`&&t++;if(t>16)throw Error(`Use at most 16 lines in this preview. Your text has not been shortened.`);if(!P.some(t=>t.id===e.font))throw Error(`Choose a bundled font.`);if(!e.size.trim()||!Number.isFinite(Number(e.size))||Number(e.size)<12||Number(e.size)>160)throw Error(`Enter a font size from 12 to 160 pixels.`);if(!/^#[0-9a-f]{6}$/i.test(e.color))throw Error(`Enter a text color as six hexadecimal digits, for example #194ECA.`);if(![`left`,`center`,`right`,`start`,`end`].includes(e.align)||![`auto`,`ltr`,`rtl`].includes(e.direction))throw Error(`Choose an available alignment and direction.`);return{size:Number(e.size),fill:[1,3,5].map(t=>Number.parseInt(e.color.slice(t,t+2),16)).concat(255)}}function I(e){if(!(e instanceof m))return e instanceof Error?e.message:`Rendering failed. Your text is unchanged.`;if(e.code===`TEXT_MISSING_GLYPHS`){let t=e.details;return`The selected fonts do not contain ${(Array.isArray(t?.codepoints)?t.codepoints.filter(e=>Number.isInteger(e)&&e>=0&&e<=1114111).slice(0,8):[]).map(e=>`U+`+e.toString(16).toUpperCase().padStart(4,`0`)).join(`, `)||`one or more characters`}. Choose another bundled font or revise the text. No replacement glyphs were accepted. (${e.code})`}return`${{TEXT_MEMORY_BUDGET:`This text and font combination exceeds the renderer’s memory allowance. Try shorter text or a smaller font. Your text is unchanged.`,TEXT_DEADLINE:`Rendering took too long. Try shorter text, then render again.`,TEXT_REQUIRES_REVIEWED_LF_CONVERSION:`This text contains carriage returns. Replace them with ordinary line breaks before rendering.`,TEXT_SURROGATE:`This text contains an incomplete Unicode character. Revise it before rendering.`,TEXT_ASSET_LOAD:`A required local font or renderer asset could not load. Reload the page and try again.`,TEXT_ENGINE_HASH:`The renderer asset failed its integrity check. Reload the page before trying again.`,FONT_HASH:`The font failed its integrity check. Reload the page before trying again.`,TEXT_TERMINATION_FAILED:`The previous text worker could not be stopped. Reload this tab before rendering again.`}[e.code]??`The renderer could not accept this preview. Your text is unchanged.`} (${e.code})`}var L=class{canvas;changed;#e=N;#t=0;#n=null;#r=null;#i=null;#a=null;#o=null;#s=!1;#c=`Ready when you are. Render text to create the preview.`;#l=``;#u=crypto.randomUUID();constructor(e,t){this.canvas=e,this.changed=t}get draft(){return this.#e}get state(){return Object.freeze({busy:!!this.#n||!!this.#r,rendering:!!this.#n,exporting:!!this.#r,unavailable:this.#s||!!this.#o,hasImage:!!this.#i,current:this.#i?.generation===this.#t,overflow:this.#i?.overflow??!1,renderedText:this.#i?.text??``,message:this.#c,error:this.#o?I(new m(`TEXT_TERMINATION_FAILED`)):this.#l})}setDraft(e){Object.keys(N).every(t=>e[t]===this.#e[t])||(this.#d(),this.#e=Object.freeze({...e}),this.#l=``,this.#c=this.#i?`Draft changed. Render text to update the canvas.`:`Draft changed. Render text to create the preview.`,this.changed())}#d(){this.#t++,this.#n?.abort.abort(),this.#n?.renderer?.cancel(),this.#g()}#f(e){return e.generation===this.#t&&!this.#s&&!this.#o}#p(e){if(!this.#f(e)||e.abort.signal.aborted)throw new m(`TEXT_CANCELLED`)}#m(e){--e.references||(e.pixels=new Uint8ClampedArray,e.pixelLease.release(),e.surfaceLease.release())}#h(){this.canvas.width=0,this.canvas.height=0;let e=this.#i;this.#i=null,e&&this.#m(e)}#g(){this.#a&&=(URL.revokeObjectURL(this.#a.url),this.#a.lease.release(),null)}cancel(){this.#d(),this.#l=``,this.#c=`Cancelled. Your text is unchanged; render it again when ready.`,this.changed()}reset(){this.#d(),this.#h(),this.#e=N,this.#l=``,this.#c=`Preview reset. Render text to start again.`,this.changed()}async render(){if(this.state.busy||this.state.unavailable)return;let e;try{e=F(this.#e)}catch(e){this.#l=I(e),this.changed();return}this.#d();let t={generation:this.#t,abort:new AbortController},n=this.#e;this.#n=t,this.#l=``,this.#c=`Loading the selected font and rendering text…`,this.changed();let r,i,a,o;try{o=y.reserve(81920);let s=await j(n.font,t.abort.signal);this.#p(t);let c=[s];n.font!==`NotoSans`&&(c.push(await j(`NotoSans`,t.abort.signal)),this.#p(t)),t.renderer=new x,r=await t.renderer.prepare({token:{documentId:`public-preview`,documentRevision:`0`,layerId:`preview-text`,layerVersion:`0`,sessionId:this.#u,generation:t.generation},text:n.text,fonts:c,frame:{width:960,height:540},style:{primaryFont:s.hash,explicitFallbacks:c.slice(1).map(e=>e.hash),sizePx:e.size,lineHeightMultiplier:1.15,fill:e.fill,align:n.align,direction:n.direction}}),this.#p(t);let l=2073600;if(r.width!==960||r.height!==540||r.rgba.size!==l)throw new m(`TEXT_RESULT_BUDGET`);i=y.reserve(6224896),a=E.reserve({owner:`pages-text-preview`,kind:`canvas`,gpuBytes:l,previewCacheBytes:l,handles:1});let u=new Uint8ClampedArray(await r.rgba.arrayBuffer());if(this.#p(t),await w(u)!==r.rasterHash)throw new m(`TEXT_RESULT_HASH`);this.#p(t),this.#h();try{C(this.canvas,{width:960,height:540,pixels:u})}catch(e){throw this.canvas.width=0,this.canvas.height=0,e}this.#i={pixels:u,pixelLease:i,surfaceLease:a,generation:t.generation,text:n.text,overflow:r.overflow,references:1},i=void 0,a=void 0,this.#c=r.overflow?`Rendered. Some text extends beyond the frame; reduce its size or shorten it to show everything.`:`Rendered. The canvas matches your current text and settings.`}catch(e){this.#f(t)&&(this.#l=I(e),this.#c=`The new preview was not accepted. Your text is unchanged.`)}finally{i?.release(),a?.release(),r&&_(r),o?.release();try{t.renderer?.dispose()}catch(e){this.#o=t.renderer,this.#l=I(e)}this.#n===t&&(this.#n=null),this.changed()}}async download(){let e=this.#i;if(!e||e.generation!==this.#t||this.state.busy||this.state.unavailable)return;let t={generation:this.#t},n,r;e.references++,this.#r=t,this.#l=``,this.#c=`Preparing the displayed canvas as a PNG…`,this.changed();try{n=y.reserve(6351872);let e=await new Promise((e,t)=>{this.canvas.toBlob(n=>n?e(n):t(Error(`The browser could not encode this canvas.`)),`image/png`)});if(!this.#f(t))return;if(e.type!==`image/png`||e.size<=0||e.size>4212736)throw Error(`The PNG exceeded this preview’s download limit.`);n=y.replace(n,e.size+4096),this.#g(),r=URL.createObjectURL(e);let i=document.createElement(`a`);i.href=r,i.download=`ideogram-text-preview.png`,i.hidden=!0,document.body.append(i);try{i.click()}finally{i.remove()}this.#a={url:r,lease:n},r=void 0,n=void 0,this.#c=`PNG download started: 960 × 540 pixels with a transparent background.`}catch(e){this.#f(t)&&(this.#l=I(e))}finally{r&&URL.revokeObjectURL(r),n?.release(),this.#m(e),this.#r===t&&(this.#r=null),this.changed()}}dispose(){this.#s=!0,this.#d(),this.#h(),this.#c=`Preview paused. Your text remains in this tab.`,this.changed()}resume(){this.#s=!1,this.#c=`Preview resumed. Render your text again.`,this.changed()}};a(),o();var R=`4e32c38e27fa4c1de92dfb5bc9d23bfabeb44860`,z=`2026-10-04T09:44:15.987Z`;if(!/^[a-f0-9]{40}$/.test(R)||!Number.isFinite(Date.parse(z)))throw Error(`The preview build metadata is unavailable.`);var B=`https://github.com/Westbrook/ideogram-editor`,V=l({document,registry:`auto`});V.register([u,ee,re,f,d,te]);var H=document.querySelector(`#preview-app`);if(!H)throw Error(`The preview container is unavailable.`);var U=V.createElement(`div`);U.className=`pages-preview`,H.append(U);var W=new ae,G=new Set,K;function q(e,t){if(e.composedPath()[0]!==e.currentTarget)return;let n=e;typeof n.detail?.value==`string`&&(n.detail.isComposing?G.add(e.currentTarget):G.delete(e.currentTarget),K.setDraft({...K.draft,[t]:n.detail.value}),$())}function J(e,t){let n=e.currentTarget;W.settled(e,()=>n.value,e=>K.setDraft({...K.draft,[t]:e}))}function Y(e,t){W.action(e,t)}function se(){if(!G.size){W.invalidate(),K.reset();for(let e of[`text`,`font`,`size`,`color`,`align`,`direction`]){let t=U.querySelector(`[data-testid="preview-`+e+`"]`);t&&W.write(t,`value`,N[e])}$()}}t(e`
  <a class="preview-skip" href="#text-controls">Skip to text controls</a>
  <header class="preview-header">
    <a data-testid="preview-full-editor" href="./">Full editor preview</a>
    <a class="preview-brand" href=${B} aria-label="Ideogram Editor source repository">
      <span class="preview-monogram" aria-hidden="true">ie</span>
      <span>Ideogram <span class="preview-brand-secondary">Editor</span><small>PUBLIC PREVIEW</small></span>
    </a>
    <div class="preview-preferences" role="group" aria-label="Interface preferences">
      <en-select data-testid="appearance" label="Appearance" .value=${document.documentElement.dataset.enAppearance??`auto`}
        @en-change=${e=>{let t=e.currentTarget;W.settled(e,()=>t.value,e=>{n(e)&&s(e)})}}>
        <en-select-option value="auto">System</en-select-option>
        <en-select-option value="light">Light</en-select-option>
        <en-select-option value="dark">Dark</en-select-option>
      </en-select>
      <en-select data-testid="density" label="Density" .value=${c()}
        @en-change=${e=>{let t=e.currentTarget;W.settled(e,()=>t.value,e=>{i(e)&&r(e)})}}>
        <en-select-option value="comfortable">Comfortable</en-select-option>
        <en-select-option value="compact">Compact</en-select-option>
        <en-select-option value="spacious">Spacious</en-select-option>
      </en-select>
    </div>
  </header>
  <section class="preview-introduction" aria-labelledby="preview-title">
    <div>
      <span class="eyebrow">A LITTLE ROOM TO CREATE</span>
      <h1 id="preview-title">Put your words in the picture.</h1>
      <p>Try the editor’s native text renderer and Spectrum-inspired En Reve controls.</p>
    </div>
    <aside class="preview-notice" aria-label="Public preview limitations">
      <strong>Public preview — edits stay in this tab.</strong>
      <p>Full documents and image-generation workflows run in the local editor. Reloading clears this text preview; only appearance and density preferences are remembered.</p>
      <a data-testid="local-setup" href=${B+`/blob/`+R+`/docs/PAGES.md#run-the-local-editor`}>Run the local editor <span aria-hidden="true">↗</span></a>
    </aside>
  </section>
  <main class="preview-workspace" aria-label="Text preview workspace">
    <section id="text-controls" class="preview-controls" aria-labelledby="controls-title" tabindex="-1">
      <div class="preview-panel-heading"><h2 id="controls-title">Text & style</h2><span class="preview-chip">IN THIS TAB</span></div>
      <en-textarea data-testid="preview-text" label="Text" .value=${N.text} .rows=${5} .maxLength=${M}
        description="Up to 2,048 characters and 16 lines. Enter adds a line break."
        @en-input=${e=>q(e,`text`)} @en-change=${e=>J(e,`text`)}></en-textarea>
      <en-select data-testid="preview-font" label="Font" .value=${N.font}
        description="Bundled regular faces. Noto Sans fills supported Latin characters when another face is selected."
        @en-change=${e=>J(e,`font`)}>
        ${P.map(t=>e`<en-select-option value=${t.id}>${t.label}</en-select-option>`)}
      </en-select>
      <div class="preview-field-pair">
        <en-number-field data-testid="preview-size" label="Font size" .value=${N.size} .min=${12} .max=${160} .step=${1}
          description="12–160 pixels"
          @en-input=${e=>q(e,`size`)} @en-change=${e=>J(e,`size`)}></en-number-field>
        <en-text-field data-testid="preview-color" label="Text color" .value=${N.color} .maxLength=${7}
          description="Six-digit hex, e.g. #194ECA" autocomplete="off" spellcheck="false"
          @en-input=${e=>q(e,`color`)} @en-change=${e=>J(e,`color`)}></en-text-field>
      </div>
      <div class="preview-field-pair">
        <en-select data-testid="preview-align" label="Alignment" .value=${N.align}
          @en-change=${e=>J(e,`align`)}>
          <en-select-option value="start">Start</en-select-option>
          <en-select-option value="center">Center</en-select-option>
          <en-select-option value="end">End</en-select-option>
          <en-select-option value="left">Left</en-select-option>
          <en-select-option value="right">Right</en-select-option>
        </en-select>
        <en-select data-testid="preview-direction" label="Direction" .value=${N.direction}
          @en-change=${e=>J(e,`direction`)}>
          <en-select-option value="auto">Automatic</en-select-option>
          <en-select-option value="ltr">Left to right</en-select-option>
          <en-select-option value="rtl">Right to left</en-select-option>
        </en-select>
      </div>
      <div class="preview-render-actions">
        <en-button data-testid="render-text" @click=${e=>Y(e,()=>{G.size||K.render()})}>Render text</en-button>
        <en-button data-testid="cancel-render" variant="secondary" disabled
          @click=${e=>Y(e,()=>K.cancel())}>Cancel render</en-button>
        <en-button data-testid="reset-preview" variant="ghost" @click=${e=>Y(e,se)}>Reset preview</en-button>
      </div>
      <p class="preview-hint">Controls change the draft. Render text updates the canvas. Finish composing a character before rendering or resetting.</p>
    </section>
    <section class="preview-canvas-panel" aria-labelledby="canvas-title">
      <div class="preview-panel-heading"><h2 id="canvas-title">Canvas</h2><span class="preview-chip">960 × 540</span></div>
      <div class="preview-stage" data-testid="preview-stage" aria-busy="false">
        <canvas width="0" height="0" data-testid="preview-canvas" role="img" aria-label="Rendered text canvas" aria-describedby="rendered-text" hidden></canvas>
        <div class="preview-empty" data-testid="preview-empty"><span aria-hidden="true">Aa</span><h3>Make room for your words.</h3><p>Edit the text and choose Render text.</p></div>
      </div>
      <div class="preview-canvas-footer">
        <p>Transparent background · The display may be scaled.</p>
        <en-button data-testid="download-png" variant="secondary" disabled
          @click=${e=>Y(e,()=>{K.download()})}>Download PNG</en-button>
      </div>
      <div class="preview-feedback">
        <p data-testid="preview-status" role="status" aria-live="polite" aria-atomic="true">Ready when you are. Render text to create the preview.</p>
        <p data-testid="preview-error" role="alert" hidden></p>
        <details data-testid="rendered-description" hidden><summary>Text in the rendered canvas</summary><p id="rendered-text" class="preview-rendered-text"></p></details>
      </div>
    </section>
  </main>
  <footer class="preview-footer">
    <p>Text rendering runs in your browser. This preview has no upload or image-generation service.</p>
    <div><a data-testid="source-commit" href=${B+`/commit/`+R}>Source ${R.slice(0,8)}</a>
      <span>Built <time datetime=${z}>${z.slice(0,10)}</time></span>
      <a href=${`/ideogram-editor/notices/index.txt`}>Third-party notices</a></div>
  </footer>
`,U,{creationScope:V.creationScope});function X(e){let t=U.querySelector(e);if(!t)throw Error(`A preview control is unavailable.`);return t}var Z=X(`[data-testid="preview-canvas"]`),ce=X(`[data-testid="preview-status"]`),Q=X(`[data-testid="preview-error"]`),le=X(`[data-testid="preview-stage"]`),ue=X(`[data-testid="preview-empty"]`),de=X(`#rendered-text`),fe=X(`[data-testid="rendered-description"]`),pe=X(`[data-testid="render-text"]`),me=X(`[data-testid="cancel-render"]`),he=X(`[data-testid="reset-preview"]`),ge=X(`[data-testid="download-png"]`);function $(){if(!K)return;let e=K.state;ce.textContent=e.message,Q.textContent=e.error,Q.hidden=!e.error,le.setAttribute(`aria-busy`,String(e.busy)),Z.hidden=!e.hasImage,ue.hidden=e.hasImage,de.textContent=e.renderedText,fe.hidden=!e.hasImage,pe.disabled=e.busy||e.unavailable||!!G.size,me.disabled=!e.busy,he.disabled=!!G.size,ge.disabled=e.busy||e.unavailable||!e.current||!!G.size}K=new L(Z,$),$(),U.addEventListener(`compositionstart`,e=>{e.target&&G.add(e.target),$()}),U.addEventListener(`compositionend`,e=>{e.target&&G.delete(e.target),$()}),window.addEventListener(`pagehide`,()=>{W.invalidate(),G.clear(),K.dispose()}),window.addEventListener(`pageshow`,e=>{e.persisted&&(G.clear(),K.resume())}),document.querySelector(`#startup`)?.remove();