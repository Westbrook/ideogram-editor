import{d as e,l as t,n,o as r,t as i,u as a}from"./lit-tfDubpWu.js";function o(e){let t=new Map,n=new Map,r=[],i=new Set,a=e=>{let r=t.get(e.tagName);if(r&&r.elementClass!==e.elementClass)throw Error(`Conflicting constructors for ${e.tagName}.`);if(t.set(e.tagName,e),i.has(e))return;i.add(e);let o=n.get(e.tagName)??new Set;n.set(e.tagName,o);for(let t of e.dependencies??[])o.add(t.tagName),a(t)};for(let t of e)a(t);let o=new Set,s=new Set,c=e=>{if(!(o.has(e)||s.has(e))){s.add(e);for(let t of n.get(e)??[])c(t);s.delete(e),o.add(e),r.push(t.get(e))}};for(let e of t.keys())c(e);return Object.freeze(r)}function s(e,t){let n=o(t),r=new Map;for(let t of n){let n=r.get(t.elementClass);if(n&&n!==t.tagName)throw Error(`One constructor cannot define both ${n} and ${t.tagName}.`);r.set(t.elementClass,t.tagName);let i=e.get(t.tagName);if(i&&i!==t.elementClass)throw Error(`A different version of ${t.tagName} is already registered.`)}for(let t of n)e.get(t.tagName)||e.define(t.tagName,t.elementClass)}function c(e){let t=e,n=e.getRootNode();return`customElementRegistry`in t?t.customElementRegistry:`customElementRegistry`in n?n.customElementRegistry:e.ownerDocument.defaultView?.customElements}var l=new WeakMap,u=e=>l.get(e)??e.ownerDocument,d=e=>{l.set(e,e.ownerDocument)},f=e=>{l.delete(e)},p=`en-internal-registry-initialized`,ee=new WeakMap;function te(e,t){let n=ee.get(e);n||ee.set(e,n=new Map);let r=n.get(t);return r||(r=new Set,n.set(t,r),ne(e.whenDefined(t),n,t,r)),r}function ne(e,t,n,r){e.then(()=>{t.delete(n);for(let e of r)e.target.deref()?.definitionReady(e.epoch);r.clear()})}var re=class{host;changed;subscriptions=new Map;epoch=0;documents=new Set;queued=!1;attempted=new WeakSet;constructor(e,t){this.host=e,this.changed=t,e.addController(this)}watch(e){let t=new Set,n=new Set;for(let r of e){if(!r.localName.includes(`-`)||r.matches(`:defined`))continue;let e=c(r);if(!e){e===null&&this.host.isConnected&&n.add(r.ownerDocument);continue}if(e.get(r.localName)){this.attempted.has(r)||(this.attempted.add(r),e.upgrade(r));continue}let i=te(e,r.localName);if(t.add(i),!this.subscriptions.has(i)){let e={target:new WeakRef(this),epoch:this.epoch};i.add(e),this.subscriptions.set(i,e)}}for(let[e,n]of this.subscriptions)t.has(e)||(e.delete(n),this.subscriptions.delete(e));for(let e of this.documents)n.has(e)||e.removeEventListener(p,this.initialized,!0);for(let e of n)this.documents.has(e)||e.addEventListener(p,this.initialized,!0);this.documents=n}initialized=()=>{this.definitionReady(this.epoch)};definitionReady(e){e===this.epoch&&this.host.isConnected&&!this.queued&&(this.queued=!0,queueMicrotask(()=>{this.queued=!1,e===this.epoch&&this.host.isConnected&&this.changed()}))}hostConnected(){this.definitionReady(this.epoch)}hostDisconnected(){++this.epoch;for(let e of this.documents)e.removeEventListener(p,this.initialized,!0);this.documents.clear();for(let[e,t]of this.subscriptions)e.delete(t);this.subscriptions.clear(),this.queued=!1}},ie=new WeakMap,ae=new WeakMap,oe=new WeakMap;function m(e){let t=e.defaultView;if(!t?.customElements)throw Error(`Element scopes require a document with a browser window. Supply the owning browser document explicitly.`);return t}function se(e,t){if(t.nodeType!==11)throw Error(`Dormant creation accepts only inert template fragments.`);let n=e.createElement(`template`);n.content.append(t.cloneNode(!0));let r=e.createElement(`div`,{customElementRegistry:null});r.innerHTML=n.innerHTML;let i=e.createDocumentFragment();return i.append(...r.childNodes),i}function ce(e){let t=m(e),n=ie.get(t);if(n)return n;let r={native:!1,importMode:`global`,dormant:!1};try{let n=new t.CustomElementRegistry,i=e.createElement(`div`,{customElementRegistry:n}),a=i.attachShadow({mode:`open`,customElementRegistry:n}),o=`en-registry-capability`,s=t.HTMLElement;class c extends s{}if(i.customElementRegistry!==n||a.customElementRegistry!==n)throw Error(`Registry association unavailable`);if(i.innerHTML=`<${o}></${o}>`,n.define(o,c),n.upgrade(i),!(i.firstElementChild instanceof c))throw Error(`Scoped upgrade unavailable`);let l=e.createElement(`template`);l.innerHTML=`<${o}></${o}>`;let u=`options`;try{let t=e.importNode(l.content,{customElementRegistry:n,selfOnly:!1}),r=e.importNode(l.content,{customElementRegistry:n,selfOnly:!0});if(!(t.firstElementChild instanceof c)||r.childNodes.length)throw Error(`Import options ignored`)}catch{let t=e.implementation.createHTMLDocument();if(n.initialize(t),!(t.importNode(l.content,!0).firstElementChild instanceof c))throw Error(`Scoped import unavailable`);u=`document`}let d=!1;try{let t=se(e,l.content),r=t.firstElementChild,i=e.createElement(`div`,{customElementRegistry:null});i.append(t),d=i.customElementRegistry===null&&r.customElementRegistry===null&&!(r instanceof c),n.initialize(i),n.upgrade(i),d&&=i.customElementRegistry===n&&r instanceof c}catch{}r={native:!0,importMode:u,dormant:d}}catch{}return r=Object.freeze(r),ie.set(t,r),r}function h(e,t){if(t===m(e).customElements)return e;let n=ce(e);if(!n.native)throw Error(`Scoped element construction is unavailable in this document.`);if(t===null){if(!n.dormant)throw Error(`Dormant template construction is unavailable; initialize the root before rendering.`);let t=oe.get(e);return t||(t=e.implementation.createHTMLDocument(),t.importNode=((t,n=!1)=>{if(!n)throw Error(`Dormant template imports must be deep.`);return se(e,t)}),oe.set(e,t)),t}let r=ae.get(e);r||(r=new WeakMap,ae.set(e,r));let i=r.get(t);return i||(i=e.implementation.createHTMLDocument(),n.importMode===`options`?i.importNode=((n,r=!1)=>e.importNode(n,{customElementRegistry:t,selfOnly:!r})):t.initialize(i),r.set(t,i)),i}function le({document:e,registry:t=`auto`}){let n=m(e),r=t===`global`?void 0:ce(e),i=t===`global`?n.customElements:t===`auto`?r.native?new n.CustomElementRegistry:n.customElements:t,a=i!==n.customElements;if(a){if(!r?.native)throw Error(`The explicitly requested registry cannot be used in this document.`);if(e.createElement(`div`,{customElementRegistry:i}).customElementRegistry!==i)throw Error(`The requested registry association was not honored.`)}let o=h(e,i);return Object.freeze({document:e,registry:i,mode:a?`scoped`:`global`,creationScope:o,register:e=>s(i,e),createElement:t=>a?e.createElement(t,{customElementRegistry:i}):e.createElement(t),attachShadow(t,r={mode:`open`}){if(t.ownerDocument!==e)throw Error(`The shadow host belongs to another document.`);if(`customElementRegistry`in r&&r.customElementRegistry!==i)throw Error(`The requested shadow registry conflicts with this scope.`);if(t.shadowRoot){if((`customElementRegistry`in t.shadowRoot?t.shadowRoot.customElementRegistry:n.customElements)!==i)throw Error(`The existing shadow root belongs to another registry; initialize a null root explicitly.`);return t.shadowRoot}return t.attachShadow(a?{...r,customElementRegistry:i}:r)},initialize(t){if(t.ownerDocument!==e)throw Error(`The root belongs to another document.`);if(!(`customElementRegistry`in t)){if(!a)return;throw Error(`Registry initialization is unavailable.`)}if(t.customElementRegistry!==null&&t.customElementRegistry!==i)throw Error(`Cannot rebind a root that already belongs to another registry.`);if(typeof i.initialize!=`function`){if(t.customElementRegistry===i)return;throw Error(`Registry initialization is unavailable.`)}i.initialize(t),t.dispatchEvent(new n.Event(p,{bubbles:!0,composed:!0})),t.isConnected||e.dispatchEvent(new n.Event(p))},get:e=>i.get(e),whenDefined:e=>i.whenDefined(e),upgrade:e=>i.upgrade(e)})}var ue=`data-en-static-styles`,g=new WeakMap,de=new WeakMap;function fe(e){let t=e.constructor;if(g.has(t))return g.get(t);let n=t.elementStyles,r=n.length>0&&n.every(e=>`cssText`in e&&typeof e.cssText==`string`&&!/@(?:import|namespace)\b/i.test(e.cssText))?n:null;return g.set(t,r),r}var pe=class{#e;#t=!1;#n;#r;#i;#a;#o=[];#s=``;constructor(e){this.#e=e,e.addController(this)}hostConnected(){if(this.#i&&this.#i!==this.#e.ownerDocument){this.#l();return}if(this.#t)return;let e=this.#e.shadowRoot,t=e?.firstElementChild;e&&t?.localName===`style`&&t.getAttribute(`data-en-static-styles`)===`v1`&&(this.#r=e,this.#n=t)}hostUpdated(){if(this.#t)return;this.#t=!0;let e=this.#e.renderRoot;if(!this.#n&&e&&`adoptedStyleSheets`in e&&e.adoptedStyleSheets.length){let t=fe(this.#e);t&&(this.#r=e,this.#i=this.#e.ownerDocument,this.#a=t,this.#o=t.map(e=>e.styleSheet).filter(e=>!!e))}this.#e.updateComplete.then(()=>this.#c(),()=>{this.#n=void 0})}#c(){let e=this.#r,n=this.#n;if(this.#n=void 0,!t||!e||e!==this.#e.shadowRoot||!n||n.parentNode!==e||n.getAttribute(`data-en-static-styles`)!==`v1`||!(`adoptedStyleSheets`in e)||[...e.querySelectorAll(`style, link[rel~="stylesheet" i]`)].some(e=>e!==n)||n.getAttributeNames().some(e=>e!==`data-en-static-styles`&&e!==`nonce`)||!n.sheet||n.sheet.disabled)return;let r=fe(this.#e);if(!r)return;let i=[...e.adoptedStyleSheets];try{let t=r.map(e=>e.styleSheet);if(t.some(e=>e===void 0))return;let n=t.filter(e=>!i.includes(e));e.adoptedStyleSheets=[...n,...i],this.#o=n}catch{try{e.adoptedStyleSheets=i}catch{}return}this.#i=this.#e.ownerDocument,this.#a=r,this.#s=n.nonce,n.remove()}#l(){let e=this.#r,t=this.#a;if(!e||e!==this.#e.renderRoot||!t)return;let n=de.get(t);n===void 0&&(n=t.map(e=>e.cssText).join(``),de.set(t,n));let r=this.#e.ownerDocument.createElement(`style`);r.setAttribute(ue,`v1`),this.#s&&(r.nonce=this.#s),r.textContent=n,e.insertBefore(r,e.firstChild);try{e.adoptedStyleSheets=e.adoptedStyleSheets.filter(e=>!this.#o.includes(e))}catch{}this.#i=void 0,this.#a=void 0,this.#o=[]}};function _(e){return e===`inherit`||e===`small`||e===`large`?e:`medium`}var me=class extends i{#e;#t;getRenderRegistry(){return this.constructor.shadowRootOptions.customElementRegistry}attachShadow(e){if(this.#e!==void 0&&`customElementRegistry`in e&&e.customElementRegistry!==this.#e)throw Error(`Conflicting explicit shadow registry options.`);return this.#t=super.attachShadow(this.#e===void 0?e:{...e,customElementRegistry:this.#e})}createRenderRoot(){let e=this.getRenderRegistry(),t=this.shadowRoot,n=t&&`customElementRegistry`in t?t.customElementRegistry:void 0;if(t&&e!==void 0&&e!==(n===void 0?this.ownerDocument?.defaultView?.customElements:n))throw Error(`The explicitly requested render registry conflicts with the existing shadow root.`);let r=t&&n!==void 0?n:e===void 0?c(this):e;r!==void 0&&this.ownerDocument?.defaultView&&(this.renderOptions.creationScope=h(this.ownerDocument,r),this.#e=r);try{return super.createRenderRoot()}catch(e){let t=this.shadowRoot??this.#t,n=this.ownerDocument.defaultView,r=this.constructor.elementStyles;if(e.name!==`NotAllowedError`||!t||!n||n.HTMLElement.prototype.isPrototypeOf(this)||!r.every(e=>`cssText`in e))throw e;let i=this.ownerDocument.createElement(`style`);i.textContent=r.map(e=>`cssText`in e?e.cssText:``).join(``);let a=globalThis.litNonce;return a&&(i.nonce=a),t.append(i),this.renderOptions.renderBefore??=t.firstChild,t}}update(e){this.#e===null&&this.renderRoot?.customElementRegistry&&(this.#e=this.renderRoot.customElementRegistry,this.renderOptions.creationScope=h(this.ownerDocument,this.#e)),super.update(e)}connectedCallback(){d(this),super.connectedCallback()}disconnectedCallback(){super.disconnectedCallback(),f(this)}adoptedCallback(){let e=this.renderRoot;if(e&&this.ownerDocument.defaultView){let t=`customElementRegistry`in e?e.customElementRegistry:c(this);t!==void 0&&(this.#e=t,this.renderOptions.creationScope=h(this.ownerDocument,t))}}staticStyles=new pe(this);static properties={size:{reflect:!0,useDefault:!0,noAccessor:!0,converter:{fromAttribute:_,toAttribute:_}}};#n=`medium`;get size(){return this.#n}set size(e){let t=this.#n,n=_(e);this.#n=n;let r=this.getAttribute(`size`)===n?void 0:Object.assign(Object.create(this.constructor.getPropertyOptions(`size`)),{hasChanged:()=>!0});this.requestUpdate(`size`,t,r)}},he=Object.freeze({"--en-border-invalid-width":`2px`,"--en-border-width":`1px`,"--en-calendar-hover-opacity":`0.1`,"--en-calendar-pressed-opacity":`0.16`,"--en-palette-accent":`rgb(36 87 214 / 1)`,"--en-palette-action":`rgb(36 87 214 / 1)`,"--en-color-action":`rgb(36 87 214 / 1)`,"--en-palette-surface":`rgb(255 255 255 / 1)`,"--en-color-surface":`rgb(255 255 255 / 1)`,"--en-color-accent-border":`rgb(181.65277272 203.4391786 246.40882708 / 1)`,"--en-color-accent-subtle":`rgb(227.10943415 235.68356672 252.33563096 / 1)`,"--en-palette-emphasis":`rgb(0 0 0 / 1)`,"--en-color-action-hover":`rgb(31.04856826 77.00062118 191.430243 / 1)`,"--en-color-action-pressed":`rgb(26.20372458 67.21650774 169.34637937 / 1)`,"--en-color-action-text":`rgb(36 87 214 / 1)`,"--en-palette-boundary":`rgb(123 135 152 / 1)`,"--en-color-boundary":`rgb(123 135 152 / 1)`,"--en-color-brand":`rgb(36 87 214 / 1)`,"--en-palette-canvas":`rgb(247 248 250 / 1)`,"--en-color-canvas":`rgb(247 248 250 / 1)`,"--en-palette-danger-text":`rgb(180 35 24 / 1)`,"--en-color-danger-text":`rgb(180 35 24 / 1)`,"--en-palette-focus":`rgb(36 87 214 / 1)`,"--en-color-focus":`rgb(36 87 214 / 1)`,"--en-color-focus-halo":`rgb(36 87 214 / 1)`,"--en-palette-line":`rgb(214 220 228 / 1)`,"--en-color-line":`rgb(214 220 228 / 1)`,"--en-color-link":`rgb(36 87 214 / 1)`,"--en-palette-foreground-dark":`rgb(16 27 57 / 1)`,"--en-palette-foreground-light":`rgb(255 255 255 / 1)`,"--en-color-on-action":`rgb(255 255 255 / 1)`,"--en-color-on-brand":`rgb(255 255 255 / 1)`,"--en-color-scrim":`rgb(0 0 0 / 0.45)`,"--en-palette-selected":`rgb(231 238 255 / 1)`,"--en-color-selected":`rgb(231 238 255 / 1)`,"--en-palette-success-text":`rgb(20 108 67 / 1)`,"--en-color-success-text":`rgb(20 108 67 / 1)`,"--en-palette-surface-raised":`rgb(255 255 255 / 1)`,"--en-color-surface-raised":`rgb(255 255 255 / 1)`,"--en-palette-surface-subtle":`rgb(238 241 245 / 1)`,"--en-color-surface-subtle":`rgb(238 241 245 / 1)`,"--en-palette-text":`rgb(27 31 36 / 1)`,"--en-color-text":`rgb(27 31 36 / 1)`,"--en-palette-text-muted":`rgb(86 97 113 / 1)`,"--en-color-text-muted":`rgb(86 97 113 / 1)`,"--en-palette-warning-text":`rgb(138 75 5 / 1)`,"--en-color-warning-text":`rgb(138 75 5 / 1)`,"--en-duration-press":`80ms`,"--en-motion-press-offset":`0px`,"--en-motion-press-scale":`1`,"--en-shadow-none":`0px 0px 0px 0px rgb(0 0 0 / 0)`,"--en-duration-release":`80ms`,"--en-rhythm-base":`0.25rem`,"--en-space-3":`0.75rem`,"--en-space-4":`1rem`,"--en-radius-container":`1rem`,"--en-focus-halo-width":`0px`,"--en-focus-offset":`2px`,"--en-focus-width":`2px`,"--en-space-control-inline":`0.75rem`,"--en-radius-control":`0.5rem`,"--en-size-icon":`1.125rem`,"--en-space-12":`3rem`,"--en-space-2":`0.5rem`,"--en-space-6":`1.5rem`,"--en-size-control-min":`2.5rem`,"--en-duration-immediate":`0ms`,"--en-duration-enter":`0ms`,"--en-ease-standard":`cubic-bezier(0.2, 0, 0, 1)`,"--en-ease-enter":`cubic-bezier(0.2, 0, 0, 1)`,"--en-duration-exit":`0ms`,"--en-ease-exit":`cubic-bezier(0.2, 0, 0, 1)`,"--en-space-0-5":`0.125rem`,"--en-space-1":`0.25rem`,"--en-space-1-5":`0.375rem`,"--en-space-8":`2rem`,"--en-focus-accent-width":`0px`,"--en-size-navigation-indicator":`0px`,"--en-space-0":`0rem`,"--en-layout-panel-preferred":`20rem`,"--en-shadow-overlay":`0px 4px 16px 0px rgb(0 0 0 / 0.18)`,"--en-space-control-block":`0.375rem`,"--en-focus-inset-offset":`-2px`,"--en-font-ui-weight":`400`,"--en-font-label-strong-weight":`600`,"--en-space-actions":`0.375rem`,"--en-space-panel":`1.5rem`,"--en-size-switch-block":`1.5rem`,"--en-size-switch-inline":`2.5rem`,"--en-size-switch-thumb":`1rem`,"--en-duration-fast":`120ms`,"--en-duration-focus-enter":`0ms`,"--en-duration-focus-exit":`0ms`,"--en-duration-regular":`180ms`,"--en-duration-slow":`240ms`,"--en-duration-spin":`800ms`,"--en-ease-focus-enter":`cubic-bezier(0.2, 0, 0, 1)`,"--en-ease-focus-exit":`cubic-bezier(0.2, 0, 0, 1)`,"--en-focus-scroll-margin-block":`1rem`,"--en-focus-scroll-margin-inline":`1rem`,"--en-font-body-family":`system-ui, sans-serif`,"--en-font-body-line-height":`1.5`,"--en-font-body-size":`1rem`,"--en-size-type-scale-large":`1.125`,"--en-font-body-size-large":`1.125rem`,"--en-size-type-scale-medium":`1`,"--en-font-body-size-medium":`1rem`,"--en-size-type-scale-small":`0.9375`,"--en-font-body-size-small":`0.9375rem`,"--en-font-body-style":`normal`,"--en-font-body-tracking":`0px`,"--en-font-body-weight":`400`,"--en-font-code-family":`ui-monospace, monospace`,"--en-font-data-family":`system-ui, sans-serif`,"--en-font-data-line-height":`1.5`,"--en-font-data-size":`0.875rem`,"--en-font-data-size-large":`0.984375rem`,"--en-font-data-size-medium":`0.875rem`,"--en-font-data-size-small":`0.8203125rem`,"--en-font-data-style":`normal`,"--en-font-data-tracking":`0px`,"--en-font-data-weight":`400`,"--en-font-heading-large-family":`system-ui, sans-serif`,"--en-font-heading-large-line-height":`1.2`,"--en-font-heading-large-size":`2rem`,"--en-font-heading-large-size-large":`2.25rem`,"--en-font-heading-large-size-medium":`2rem`,"--en-font-heading-large-size-small":`1.875rem`,"--en-font-heading-large-style":`normal`,"--en-font-heading-large-tracking":`0px`,"--en-font-heading-large-weight":`600`,"--en-font-heading-medium-family":`system-ui, sans-serif`,"--en-font-heading-medium-line-height":`1.3`,"--en-font-heading-medium-size":`1.5rem`,"--en-font-heading-medium-size-large":`1.6875rem`,"--en-font-heading-medium-size-medium":`1.5rem`,"--en-font-heading-medium-size-small":`1.40625rem`,"--en-font-heading-medium-style":`normal`,"--en-font-heading-medium-tracking":`0px`,"--en-font-heading-medium-weight":`600`,"--en-font-heading-small-family":`system-ui, sans-serif`,"--en-font-heading-small-line-height":`1.4`,"--en-font-heading-small-size":`1.125rem`,"--en-font-heading-small-size-large":`1.265625rem`,"--en-font-heading-small-size-medium":`1.125rem`,"--en-font-heading-small-size-small":`1.0546875rem`,"--en-font-heading-small-style":`normal`,"--en-font-heading-small-tracking":`0px`,"--en-font-heading-small-weight":`600`,"--en-font-ui-family":`system-ui, sans-serif`,"--en-font-input-family":`system-ui, sans-serif`,"--en-font-ui-line-height":`1.5`,"--en-font-input-line-height":`1.5`,"--en-font-ui-size":`1rem`,"--en-font-input-size":`1rem`,"--en-font-input-size-large":`1.125rem`,"--en-font-input-size-medium":`1rem`,"--en-font-input-size-small":`1rem`,"--en-font-ui-style":`normal`,"--en-font-input-style":`normal`,"--en-font-ui-tracking":`0px`,"--en-font-input-tracking":`0px`,"--en-font-input-weight":`400`,"--en-font-label-strong-family":`system-ui, sans-serif`,"--en-font-label-strong-line-height":`1.5`,"--en-font-label-strong-size":`1rem`,"--en-font-label-strong-style":`normal`,"--en-font-label-strong-tracking":`0px`,"--en-font-metadata-family":`system-ui, sans-serif`,"--en-font-metadata-line-height":`1.5`,"--en-font-metadata-size":`0.8125rem`,"--en-font-metadata-size-large":`0.9140625rem`,"--en-font-metadata-size-medium":`0.8125rem`,"--en-font-metadata-size-small":`0.8125rem`,"--en-font-metadata-style":`normal`,"--en-font-metadata-tracking":`0px`,"--en-font-metadata-weight":`400`,"--en-font-ui-size-large":`1.125rem`,"--en-font-ui-size-medium":`1rem`,"--en-font-ui-size-small":`1rem`,"--en-layout-article-max":`48rem`,"--en-layout-dialog-collapse":`48rem`,"--en-layout-form-max":`28rem`,"--en-size-scale-large":`1.25`,"--en-layout-form-max-large":`35rem`,"--en-size-scale-medium":`1`,"--en-layout-form-max-medium":`28rem`,"--en-size-scale-small":`0.875`,"--en-layout-form-max-small":`24.5rem`,"--en-layout-panel-preferred-large":`25rem`,"--en-layout-panel-preferred-medium":`20rem`,"--en-layout-panel-preferred-small":`17.5rem`,"--en-layout-prose-max":`66ch`,"--en-motion-surface-offset":`0px`,"--en-motion-surface-scale":`1`,"--en-palette-on-action":`rgb(255 255 255 / 1)`,"--en-radius-choice":`2px`,"--en-radius-choice-large":`2.5px`,"--en-radius-choice-medium":`2px`,"--en-radius-choice-small":`1.75px`,"--en-radius-container-large":`1.25rem`,"--en-radius-container-medium":`1rem`,"--en-radius-container-small":`0.875rem`,"--en-radius-control-large":`0.625rem`,"--en-radius-control-medium":`0.5rem`,"--en-radius-control-small":`0.4375rem`,"--en-radius-dialog":`1.25rem`,"--en-radius-dialog-large":`1.5625rem`,"--en-radius-dialog-medium":`1.25rem`,"--en-radius-dialog-small":`1.09375rem`,"--en-radius-pill":`9999px`,"--en-shadow-dialog":`0px 12px 40px 0px rgb(0 0 0 / 0.18)`,"--en-size-avatar":`2.5rem`,"--en-size-avatar-large":`3.125rem`,"--en-size-avatar-medium":`2.5rem`,"--en-size-avatar-small":`2.1875rem`,"--en-size-choice-dot":`8px`,"--en-size-choice-dot-large":`10px`,"--en-size-choice-dot-medium":`8px`,"--en-size-choice-dot-small":`7px`,"--en-size-choice-mark-block":`10px`,"--en-size-choice-mark-block-large":`12.5px`,"--en-size-choice-mark-block-medium":`10px`,"--en-size-choice-mark-block-small":`8.75px`,"--en-size-choice-mark-inline":`6px`,"--en-size-choice-mark-inline-large":`7.5px`,"--en-size-choice-mark-inline-medium":`6px`,"--en-size-choice-mark-inline-small":`5.25px`,"--en-size-choice-mark-stroke":`2px`,"--en-size-control-large":`3.125rem`,"--en-size-control-medium":`2.5rem`,"--en-size-control-small":`2.1875rem`,"--en-size-icon-large":`1.40625rem`,"--en-size-icon-medium":`1.125rem`,"--en-size-icon-small":`0.984375rem`,"--en-size-icon-stroke":`1.5px`,"--en-size-progress":`0.5rem`,"--en-size-progress-large":`0.625rem`,"--en-size-progress-medium":`0.5rem`,"--en-size-progress-small":`0.4375rem`,"--en-size-quote-border":`2px`,"--en-size-range-length":`12rem`,"--en-size-range-track":`4px`,"--en-size-range-track-large":`5px`,"--en-size-range-track-medium":`4px`,"--en-size-range-track-small":`3.5px`,"--en-size-skeleton-line":`1rem`,"--en-size-skeleton-line-large":`1.25rem`,"--en-size-skeleton-line-medium":`1rem`,"--en-size-skeleton-line-small":`0.875rem`,"--en-size-spinner":`1.25rem`,"--en-size-spinner-large":`1.5625rem`,"--en-size-spinner-medium":`1.25rem`,"--en-size-spinner-small":`1.09375rem`,"--en-size-spinner-stroke":`2px`,"--en-size-target-min":`24px`,"--en-size-splitter":`24px`,"--en-size-splitter-large":`30px`,"--en-size-splitter-medium":`24px`,"--en-size-splitter-small":`21px`,"--en-size-swatch":`4rem`,"--en-size-swatch-large":`5rem`,"--en-size-swatch-medium":`4rem`,"--en-size-swatch-small":`3.5rem`,"--en-size-switch-block-large":`1.875rem`,"--en-size-switch-block-medium":`1.5rem`,"--en-size-switch-block-small":`1.3125rem`,"--en-size-switch-inline-large":`3.125rem`,"--en-size-switch-inline-medium":`2.5rem`,"--en-size-switch-inline-small":`2.1875rem`,"--en-size-switch-thumb-large":`1.25rem`,"--en-size-switch-thumb-medium":`1rem`,"--en-size-switch-thumb-small":`0.875rem`,"--en-size-tab-indicator":`2px`,"--en-size-target-touch":`2.75rem`,"--en-space-16":`4rem`,"--en-space-2-5":`0.625rem`,"--en-space-5":`1.25rem`,"--en-space-actions-large":`0.46875rem`,"--en-space-actions-medium":`0.375rem`,"--en-space-actions-small":`0.328125rem`,"--en-space-badge-block":`0.125rem`,"--en-space-badge-block-large":`0.15625rem`,"--en-space-badge-block-medium":`0.125rem`,"--en-space-badge-block-small":`0.109375rem`,"--en-space-badge-inline":`0.5rem`,"--en-space-badge-inline-large":`0.625rem`,"--en-space-badge-inline-medium":`0.5rem`,"--en-space-badge-inline-small":`0.4375rem`,"--en-space-control-block-large":`0.46875rem`,"--en-space-control-block-medium":`0.375rem`,"--en-space-control-block-small":`0.328125rem`,"--en-space-control-description":`0.375rem`,"--en-space-control-description-large":`0.46875rem`,"--en-space-control-description-medium":`0.375rem`,"--en-space-control-description-small":`0.328125rem`,"--en-space-control-inline-large":`0.9375rem`,"--en-space-control-inline-medium":`0.75rem`,"--en-space-control-inline-small":`0.65625rem`,"--en-space-fields":`1.5rem`,"--en-space-fields-large":`1.875rem`,"--en-space-fields-medium":`1.5rem`,"--en-space-fields-small":`1.3125rem`,"--en-space-icon-label":`0.5rem`,"--en-space-icon-label-large":`0.625rem`,"--en-space-icon-label-medium":`0.5rem`,"--en-space-icon-label-small":`0.4375rem`,"--en-space-label-control":`0.5rem`,"--en-space-label-control-large":`0.625rem`,"--en-space-label-control-medium":`0.5rem`,"--en-space-label-control-small":`0.4375rem`,"--en-space-panel-large":`1.875rem`,"--en-space-panel-medium":`1.5rem`,"--en-space-panel-small":`1.3125rem`,"--en-space-rows":`0.75rem`,"--en-space-rows-large":`0.9375rem`,"--en-space-rows-medium":`0.75rem`,"--en-space-rows-small":`0.65625rem`,"--en-space-sections":`2rem`,"--en-space-sections-large":`2.5rem`,"--en-space-sections-medium":`2rem`,"--en-space-sections-small":`1.75rem`,"--en-space-switch-inset":`0.1875rem`,"--en-space-switch-inset-large":`0.234375rem`,"--en-space-switch-inset-medium":`0.1875rem`,"--en-space-switch-inset-small":`0.1640625rem`});function ge(e){if(!Object.hasOwn(he,e))throw RangeError(`Unknown token `+e);return he[e]}var _e=Object.freeze([`small`,`medium`,`large`]);Object.freeze({small:.875,medium:1,large:1.25}),Object.freeze({small:.9375,medium:1,large:1.125});var ve=Object.freeze({"size.control":`size.control-min`,"size.icon":`size.icon`,"size.avatar":`size.avatar`,"size.swatch":`size.swatch`,"size.spinner":`size.spinner`,"size.progress":`size.progress`,"size.skeleton-line":`size.skeleton-line`,"size.splitter":`size.splitter`,"size.switch-inline":`size.switch-inline`,"size.switch-block":`size.switch-block`,"size.switch-thumb":`size.switch-thumb`,"size.choice-mark-inline":`size.choice-mark-inline`,"size.choice-mark-block":`size.choice-mark-block`,"size.choice-dot":`size.choice-dot`,"size.range-track":`size.range-track`,"space.switch-inset":`space.switch-inset`,"space.control-inline":`space.control-inline`,"space.control-block":`space.control-block`,"space.panel":`space.panel`,"space.rows":`space.rows`,"space.actions":`space.actions`,"space.fields":`space.fields`,"space.sections":`space.sections`,"space.icon-label":`space.icon-label`,"space.label-control":`space.label-control`,"space.control-description":`space.control-description`,"space.badge-inline":`space.badge-inline`,"space.badge-block":`space.badge-block`,"radius.control":`radius.control`,"radius.container":`radius.container`,"radius.dialog":`radius.dialog`,"radius.choice":`radius.choice`,"layout.form-max":`layout.form-max`,"layout.panel-preferred":`layout.panel-preferred`,"font.ui.size":`font.ui.size`,"font.input.size":`font.input.size`,"font.data.size":`font.data.size`,"font.metadata.size":`font.metadata.size`,"font.body.size":`font.body.size`,"font.heading-small.size":`font.heading-small.size`,"font.heading-medium.size":`font.heading-medium.size`,"font.heading-large.size":`font.heading-large.size`}),ye=Object.freeze(Object.entries(ve).map(([e,t])=>Object.freeze({role:`--en-${e.replaceAll(`.`,`-`)}`,base:`--en-${t.replaceAll(`.`,`-`)}`,variants:Object.freeze(Object.fromEntries(_e.map(t=>[t,`--en-${e.replaceAll(`.`,`-`)}-${t}`])))})));function be(e){let t=ge(e);if(!t)throw Error(`Missing stylesheet token default: ${e}`);return`var(${e}, ${t})`}var xe=new Map(ye.map(({base:e,role:t})=>[e,`--_en-sized-${t.slice(5)}`]));function Se(e){let t=be(e),n=xe.get(e);return n?`var(${n}, ${t})`:t}function v(t){return e(be(t))}function y(t){return e(Se(t))}function b(t,n){return a`var(${e(t)}, ${n})`}var x=a`scale var(--_en-press-duration, 0ms) ${y(`--en-ease-standard`)}, translate var(--_en-press-duration, 0ms) ${y(`--en-ease-standard`)}`;function Ce(e,t,n){return a`
    ${e} { --_en-press-duration: clamp(0ms, ${n.release}, 200ms); }
    ${t} { scale: clamp(.9, ${n.scale}, 1); translate: 0 clamp(-2px, ${n.offset}, 2px); --_en-press-duration: clamp(0ms, ${n.press}, 200ms); }
    :host([data-press='none']) ${e} { scale: none !important; translate: none !important; }
    @media (prefers-reduced-motion: reduce) { ${e} { scale: none !important; translate: none !important; transition: none !important; } }
  `}function S(e,t,n){return a`
    ${e} { --_en-press-shadow: 0 0 0 0 transparent; box-shadow: var(--_en-press-shadow); transition: ${x}; }
    ${t} { ${n.paint} --_en-press-shadow: ${n.shadow}; }
    ${Ce(e,t,n)}
    @media (forced-colors: active) { ${t} { background-color: Highlight; color: HighlightText; box-shadow: none; } }
  `}function C(e,t,n){return e?b(`--en-${e}-focus-${t}`,n):n}function w(e){let t=C(e.family,`width`,y(`--en-focus-width`));return{width:t,offset:C(e.family,`offset`,e.inset?a`calc(0px - ${t})`:y(`--en-focus-offset`)),color:C(e.family,`color`,y(`--en-color-focus`)),haloWidth:e.halo===!1?a`0px`:C(e.family,`halo-width`,y(`--en-focus-halo-width`)),haloColor:C(e.family,`halo-color`,y(`--en-color-focus-halo`))}}function T(e={}){let t=w(e);return a`max(0px, calc(${t.width} + ${t.offset}), ${t.haloWidth})`}var we=a`max(${T()}, ${T({family:`button`})}, ${T({family:`input`})}, ${T({family:`option`,inset:!0})}, ${T({family:`overlay`})})`;function E(e,t={}){return a`${e} {
    scroll-margin-block: max(${y(`--en-focus-scroll-margin-block`)}, ${T(t)});
    scroll-margin-inline: max(${y(`--en-focus-scroll-margin-inline`)}, ${T(t)});
  }`}function D(e,t={}){return O(a`${e}:focus-visible`,{...t,restSelector:t.restSelector??e})}function O(e,t={}){let n=w(t),r=t.restSelector,i=r&&t.halo!==!1,o=t.baseShadow??a`var(--_en-press-shadow, 0 0 0 0 transparent)`,s=a`${t.baseTransitions??x},`;return a`
    ${r?E(r,t):a``}
    ${i?a`${r} {
      box-shadow: 0 0 0 0 ${n.haloColor}, ${o};
      transition: ${s} box-shadow ${y(`--en-duration-focus-exit`)} ${y(`--en-ease-focus-exit`)};
    }`:a``}
    ${e} {
      outline: ${n.width} solid ${n.color};
      outline-offset: ${n.offset};
      box-shadow: 0 0 0 ${n.haloWidth} ${n.haloColor}, ${o};
      ${i?a`transition: ${s} box-shadow ${y(`--en-duration-focus-enter`)} ${y(`--en-ease-focus-enter`)};`:a``}
    }
    ${i?a`@media (prefers-reduced-motion: reduce) {
      ${r}, ${e} { transition: none; }
    }`:a``}
    @media (forced-colors: active) {
      ${e} { outline-color: Highlight; box-shadow: none; }
      ${i?a`${r}, ${e} { box-shadow: none; transition: none; }`:a``}
    }
  `}function k(t){let n=ye.filter(({role:e})=>t.cssText.includes(`var(--_en-sized-${e.slice(5)},`)).map(({role:e,variants:t})=>`--_en-sized-${e.slice(5)}: calc(${v(t.small).cssText} * var(--_en-size-small, 0) + ${v(t.medium).cssText} * var(--_en-size-medium, 1) + ${v(t.large).cssText} * var(--_en-size-large, 0));`).join(`
`);return n?a`:host, .en-foundation { ${e(n)} } ${t}`:t}var Te=a`:host { display: block; min-inline-size: 0; }`,Ee=a`:host { display: inline-block; vertical-align: middle; max-inline-size: 100%; }`,De=a`:host { display: inline-flex; align-items: center; justify-content: center; color: inherit; line-height: 0; vertical-align: middle; }`,Oe=a`
  :host, .en-foundation { --_en-size-small: 0; --_en-size-medium: 1; --_en-size-large: 0; }
  :host([size='inherit']), .en-foundation[data-size='inherit'] { --_en-size-small: inherit; --_en-size-medium: inherit; --_en-size-large: inherit; }
  :host([size='small']), .en-foundation[data-size='small'] { --_en-size-small: 1; --_en-size-medium: 0; --_en-size-large: 0; }
  :host([size='medium']), .en-foundation[data-size='medium'] { --_en-size-small: 0; --_en-size-medium: 1; --_en-size-large: 0; }
  :host([size='large']), .en-foundation[data-size='large'] { --_en-size-small: 0; --_en-size-medium: 0; --_en-size-large: 1; }
`,ke=k(a`
  ${Oe}
  :host, .en-foundation {
    box-sizing: border-box;
    color: ${y(`--en-color-text`)};
    font-family: ${y(`--en-font-ui-family`)};
    font-style: ${y(`--en-font-ui-style`)};
    letter-spacing: ${y(`--en-font-ui-tracking`)};
    font-size: ${y(`--en-font-ui-size`)};
    font-weight: ${y(`--en-font-ui-weight`)};
    line-height: ${y(`--en-font-ui-line-height`)};
    text-align: start;
  }
  :host *, :host *::before, :host *::after,
  .en-foundation *, .en-foundation *::before, .en-foundation *::after { box-sizing: border-box; }
  :host([hidden]), :host [hidden], .en-foundation [hidden] { display: none !important; }
  :host :where(button, input, textarea, select), .en-foundation :where(button, input, textarea, select) {
    font: inherit;
    letter-spacing: inherit;
    word-spacing: inherit;
  }
  ${E(a`:where(:host([tabindex]), .en-foundation[tabindex]),
    :where(:host, .en-foundation) :where(button, input, textarea, select, a[href], [tabindex])`)}
  :host(:focus-visible), .en-foundation:focus-visible {
    outline: ${y(`--en-focus-width`)} solid ${y(`--en-color-focus`)};
    outline-offset: ${y(`--en-focus-offset`)};
  }
  .en-sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .en-break { overflow-wrap: anywhere; }
  .en-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (forced-colors: active) {
    :host, .en-foundation { color: CanvasText; }
    :host(:focus-visible), .en-foundation:focus-visible { outline-color: Highlight; }
  }
`);function A(e=!1){return e?a`max(${y(`--en-size-target-min`)}, ${y(`--en-size-target-touch`)})`:y(`--en-size-target-min`)}function j(e=!1,t=y(`--en-size-control-min`)){return a`max(${b(`--en-control-min-size`,t)}, ${A(e)})`}var Ae=a`max(0px, ${b(`--en-segmented-control-frame-inset`,y(`--en-space-1`))})`,je=a`calc(${Ae} + ${y(`--en-border-width`)})`;function M(e=!1,t=!1){let n=A(e),r=y(`--en-space-control-block`),i=y(`--en-border-width`),o=a`calc(${y(`--en-space-1`)} + ${i})`,s=t?a`max(${o}, ${je})`:o;return a`max(
    ${b(`--en-control-min-size`,y(`--en-size-control-min`))},
    calc(${n} + 2 * ${s}),
    calc(${y(`--en-font-input-size`)} * ${y(`--en-font-input-line-height`)} + 2 * ${r} + 2 * ${i}),
    calc(${y(`--en-font-ui-size`)} * ${y(`--en-font-ui-line-height`)} + 2 * max(${r}, ${s}) + 2 * ${i})
  )`}function Me(e,t,n,r){return a`
    ${e} {
      --_en-inset-gap: max(${y(`--en-space-1`)}, ${T({family:`button`})});
      --_en-inset-radius: max(0px, calc(${n} - ${r} - var(--_en-inset-gap)));
      --_en-inset-size: max(${A()}, calc(${M()} - 2 * var(--_en-inset-gap)));
      --_en-inset-padding: max(0px, calc(${y(`--en-space-control-block`)} - var(--_en-inset-gap)));
    }
    ${t} {
      --_en-inset-action-radius: var(--_en-inset-radius);
      --_en-inset-action-size: var(--_en-inset-size);
      --_en-inset-action-padding: var(--_en-inset-padding);
      margin: var(--_en-inset-gap);
      flex-shrink: 0;
    }
    @media (any-pointer: coarse) {
      ${e} { --_en-inset-size: max(${A(!0)}, calc(${M(!0)} - 2 * var(--_en-inset-gap))); }
    }
  `}var Ne=a`
  .en-button {
    padding-block: var(--_en-inset-action-padding, ${y(`--en-space-control-block`)});
    border-radius: var(--_en-inset-action-radius, ${b(`--en-button-radius`,b(`--en-control-radius`,y(`--en-radius-control`)))});
  }
  .en-button:not(.en-icon-button) { min-block-size: var(--_en-inset-action-size, var(--_en-text-control-block-size)); }
  .en-button.en-icon-button:not([data-icon-only]) {
    min-block-size: var(--_en-inset-action-size, ${j()});
    min-inline-size: var(--_en-inset-action-size, ${j()});
  }
  .en-button[data-icon-only] {
    min-block-size: var(--_en-inset-action-size, var(--_en-icon-button-side));
    min-inline-size: var(--_en-inset-action-size, var(--_en-icon-button-side));
  }
  @media (any-pointer: coarse) {
    .en-button.en-icon-button:not([data-icon-only]) {
      min-block-size: var(--_en-inset-action-size, ${j(!0)});
      min-inline-size: var(--_en-inset-action-size, ${j(!0)});
    }
  }
`,Pe=x,Fe=b(`--en-button-inline-padding`,b(`--en-control-inline-padding`,y(`--en-space-control-inline`))),Ie=a`
  .en-button {
    --_en-button-shadow: var(--en-button-shadow, 0 0 0 0 transparent);
    --_en-button-state-background: var(--en-button-rest-background);
    --_en-button-state-color: var(--en-button-rest-color);
    padding-inline: ${Fe};
    display: inline-flex;
    min-inline-size: ${y(`--en-size-target-min`)};
    align-items: center;
    justify-content: center;
    gap: ${y(`--en-space-icon-label`)};
    border-color: ${b(`--en-button-border-color`,y(`--en-color-action`))};
    border-radius: ${b(`--en-button-radius`,b(`--en-control-radius`,y(`--en-radius-control`)))};
    background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-action`))});
    color: var(--_en-button-state-color, ${b(`--en-button-color`,y(`--en-color-on-action`))});
    font-weight: ${y(`--en-font-label-strong-weight`)};
    text-align: center;
    text-decoration: none;
    white-space: normal;
    overflow-wrap: break-word;
    cursor: pointer;
    transition: background-color ${y(`--en-duration-fast`)} ${y(`--en-ease-standard`)},
      border-color ${y(`--en-duration-fast`)} ${y(`--en-ease-standard`)}, ${Pe};
  }
  @media (hover: hover) { .en-button:where(:not(:disabled):not([aria-disabled='true']):hover) { background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-action-hover`))}); } }
  .en-button:where(:not(:disabled):not([aria-disabled='true']):active) { background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-action-pressed`))}); }
  .en-button--secondary, .en-button[data-variant='secondary'] {
    background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-surface-subtle`))});
    color: var(--_en-button-state-color, ${b(`--en-button-color`,y(`--en-color-text`))});
    border-color: ${b(`--en-button-border-color`,y(`--en-color-boundary`))};
  }
  .en-button--quiet, .en-button[data-variant='ghost'] {
    background: var(--_en-button-state-background, none);
    color: var(--_en-button-state-color, ${b(`--en-button-color`,y(`--en-color-action-text`))});
    border-color: ${b(`--en-button-border-color`,y(`--en-color-line`))};
  }
  @media (hover: hover) { :is(.en-button--secondary, .en-button--quiet, .en-button[data-variant='secondary'], .en-button[data-variant='ghost']):not(:disabled):not([aria-disabled='true']):hover {
    background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-selected`))});
  } }
  .en-button--danger, .en-button[data-variant='danger'] {
    background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-surface`))});
    color: var(--_en-button-state-color, ${b(`--en-button-color`,y(`--en-color-danger-text`))});
    border-color: ${b(`--en-button-border-color`,y(`--en-color-danger-text`))};
  }
  @media (hover: hover) { :is(.en-button--danger, .en-button[data-variant='danger']):not(:disabled):not([aria-disabled='true']):hover {
    background: var(--_en-button-state-background, ${b(`--en-button-background`,y(`--en-color-surface-subtle`))});
  } }
  /* Explicit state refinements have a shared order across variants. Clearing an
     absent state slot preserves each variant's existing broad/semantic fallback. */
  @media (hover: hover) {
    .en-button:where(:not(:disabled):not([aria-disabled='true']):hover) {
      --_en-button-state-background: var(--en-button-hover-background);
      --_en-button-state-color: var(--en-button-hover-color);
    }
  }
  .en-button:where(:not(:disabled):not([aria-disabled='true']):active) {
    --_en-button-state-background: var(--en-button-pressed-background);
    --_en-button-state-color: var(--en-button-pressed-color);
  }
  /* Held feedback is distinct on neutral variants, including no-hover pointers. */
  :is(.en-button--secondary, .en-button--quiet, .en-button--danger, .en-button[data-variant='secondary'], .en-button[data-variant='ghost'], .en-button[data-variant='danger']):not(:disabled):not([aria-disabled='true']):active {
    background: var(--en-button-pressed-background, var(--en-button-background, color-mix(in srgb, ${y(`--en-color-surface`)} 82%, currentColor)));
  }
  :is(.en-button--danger, .en-button[data-variant='danger']):not(:disabled):not([aria-disabled='true']):active {
    background: var(--en-button-pressed-background, var(--en-button-background, ${y(`--en-color-danger-text`)}));
    color: var(--en-button-pressed-color, var(--en-button-color, ${y(`--en-color-surface`)}));
  }
  .en-button:not(:disabled):not([aria-disabled='true']):active {
    --_en-button-shadow: var(--en-button-pressed-shadow, var(--en-button-shadow, 0 0 0 0 transparent));
  }
  /* Transform the complete control, including its surface, border and glyphs.
     Popup semantics do not imply a universal motion policy: a theme may refine
     their held geometry independently. Layout allocation remains unchanged. */
  ${Ce(a`.en-button`,a`.en-button:not(:disabled):not([aria-disabled='true']):not([data-press='none']):active`,{scale:a`var(--en-button-pressed-scale, ${y(`--en-motion-press-scale`)})`,offset:a`var(--en-button-pressed-offset, ${y(`--en-motion-press-offset`)})`,press:a`var(--en-button-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-button-release-duration, ${y(`--en-duration-release`)})`})}
  .en-button[aria-haspopup]:not([aria-haspopup='false']):not(:disabled):not([aria-disabled='true']):not([data-press='none']):active {
    scale: clamp(.9, var(--en-button-popup-pressed-scale, var(--en-button-pressed-scale, ${y(`--en-motion-press-scale`)})), 1);
    translate: 0 clamp(-2px, var(--en-button-popup-pressed-offset, var(--en-button-pressed-offset, ${y(`--en-motion-press-offset`)})), 2px);
  }
  :host([data-press='none']) .en-button { scale: none !important; translate: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .en-button { scale: none !important; translate: none !important; transition: none !important; }
  }
  @media (forced-colors: active) {
    .en-button:not(:disabled):not([aria-disabled='true']):active { background: Highlight !important; color: HighlightText !important; }
  }
  .en-button__prefix, .en-button__suffix { display: contents; }
  .en-button__label { min-inline-size: 0; }
  .en-icon-button { padding-inline: ${y(`--en-space-2`)}; min-inline-size: max(${b(`--en-control-min-size`,y(`--en-size-control-min`))}, ${y(`--en-size-target-min`)}); }
  /* Explicit button mode; existing stepper/overlay icon recipes retain their layout. */
  .en-button[data-icon-only] {
    --_en-icon-button-side: max(var(--_en-text-control-block-size), calc(max(${b(`--en-icon-size`,y(`--en-size-icon`))}, ${y(`--en-size-spinner`)}) + 2 * ${y(`--en-space-control-block`)} + 2 * ${y(`--en-border-width`)}));
    min-inline-size: var(--_en-icon-button-side);
    min-block-size: var(--_en-icon-button-side);
    inline-size: max-content;
    aspect-ratio: 1;
    padding: ${y(`--en-space-control-block`)};
    gap: 0;
    flex-shrink: 0;
  }
  .en-button[data-icon-only] > .en-button__label {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Keep one visual glyph while busy. The label and slotted nodes remain intact. */
  .en-button[data-icon-only][aria-busy='true'] > :is(.en-button__prefix, .en-button__suffix) { display: none; }

`,Le=a`background-color ${y(`--en-duration-fast`)} ${y(`--en-ease-standard`)}, border-color ${y(`--en-duration-fast`)} ${y(`--en-ease-standard`)}, ${Pe}`,Re=D(a`.en-button`,{family:`button`,baseTransitions:Le,baseShadow:a`var(--_en-button-shadow, 0 0 0 0 transparent)`}),ze=a`@media (hover: hover) { .en-button:not(:disabled):not([aria-disabled='true']):hover { background: Highlight !important; color: HighlightText !important; } }`;function N(e,t=!1){return a`${e} { --_en-text-control-block-size: ${M(t)}; }`}function Be(e){return a`${e} {
    box-sizing: border-box;
    min-inline-size: 0;
    min-block-size: ${j()};
    max-inline-size: 100%;
    padding-block: ${y(`--en-space-control-block`)};
    padding-inline: ${b(`--en-control-inline-padding`,y(`--en-space-control-inline`))};
    border: ${y(`--en-border-width`)} solid ${b(`--en-control-border-color`,y(`--en-color-boundary`))};
    border-radius: ${b(`--en-control-radius`,y(`--en-radius-control`))};
    background: ${b(`--en-control-background`,y(`--en-color-surface`))};
    color: ${b(`--en-control-color`,y(`--en-color-text`))};
    font: inherit;
    text-align: start;
  }`}function P(e){return a`${e} { min-block-size: var(--_en-text-control-block-size); }`}function Ve(e){return a`${e} {
    color: ${y(`--en-color-text-muted`)};
    background: ${y(`--en-color-surface-subtle`)};
    border-color: ${y(`--en-color-boundary`)};
    cursor: default;
  }`}function He(e){return a`${e} { min-block-size: ${j(!0)}; }`}function Ue(e){return a`${e} { min-inline-size: ${j(!0)}; }`}function We(e){return a`${e} { transition: none; }`}function Ge(e){return a`${e} { color: CanvasText !important; background: Canvas !important; border-color: ButtonText !important; }`}function F(e){return a`${e} { color: GrayText !important; border-color: GrayText !important; }`}var Ke=k(a`
  ${N(a`.en-button:not(.en-icon-button), .en-button[data-icon-only]`)}
  ${Be(a`.en-button`)}
  ${P(a`.en-button:not(.en-icon-button)`)}
  ${Ie}
  ${Ve(a`:is(.en-button):is(:disabled, [aria-disabled='true'])`)}
  ${Re}
  @media (any-pointer: coarse) {
    ${N(a`.en-button:not(.en-icon-button), .en-button[data-icon-only]`,!0)}
    ${He(a`.en-button`)}
    ${P(a`.en-button:not(.en-icon-button)`)}
    ${Ue(a`.en-icon-button`)}
  }
  @media (prefers-reduced-motion: reduce) { ${We(a`.en-button`)} }
  @media (forced-colors: active) {
    ${Ge(a`.en-button`)}
    ${F(a`:is(.en-button):is(:disabled, [aria-disabled='true'])`)}
    ${ze}
  }
  ${Ne}
`),qe=k(a`
  .en-spinner {
    display: inline-block;
    flex: none;
    inline-size: ${y(`--en-size-spinner`)};
    block-size: ${y(`--en-size-spinner`)};
    border: ${y(`--en-size-spinner-stroke`)} solid currentColor;
    border-inline-end-color: ${y(`--en-color-line`)};
    border-radius: ${y(`--en-radius-pill`)};
    animation: en-style-spin ${y(`--en-duration-spin`)} linear infinite;
  }
  @keyframes en-style-spin { to { transform: rotate(1turn); } }
  .en-skeleton { display: block; inline-size: 100%; block-size: ${b(`--en-skeleton-size`,y(`--en-size-skeleton-line`))}; background: ${b(`--en-skeleton-color`,y(`--en-color-surface-subtle`))}; border-radius: ${y(`--en-radius-control`)}; }
  .en-skeleton[data-shape='circle'] { inline-size: ${b(`--en-skeleton-size`,y(`--en-size-avatar`))}; block-size: ${b(`--en-skeleton-size`,y(`--en-size-avatar`))}; border-radius: ${y(`--en-radius-pill`)}; }
  .en-skeleton[data-shape='rectangle'] { block-size: ${b(`--en-skeleton-size`,y(`--en-space-16`))}; }
  @media (prefers-reduced-motion: reduce) { .en-spinner { animation: none; } }
  @media (forced-colors: active) { .en-spinner { border-color: CanvasText; border-inline-end-color: GrayText; } .en-skeleton { background: Canvas; border: ${y(`--en-border-width`)} solid GrayText; } }
`),I=e=>e??n,Je=e=>r`
  <button
    class=${e.iconOnly?`en-button en-icon-button`:`en-button`}
    ?data-icon-only=${e.iconOnly}
    part="control"
    type="button"
    tabindex=${e.tabIndex??0}
    data-variant=${e.variant}
    data-size=${e.size}
    ?disabled=${e.disabled||e.loading}
    aria-pressed=${I(e.pressed??void 0)}
    aria-busy=${e.loading?`true`:`false`}
    aria-haspopup=${I(e.popupRole??void 0)}
    aria-expanded=${I(e.popupExpanded??void 0)}
    aria-disabled=${I(e.ariaDisabled??void 0)}
  >
    ${e.loading?r`<span class="en-spinner" part="indicator" aria-hidden="true"></span>`:null}
    <slot class="en-button__prefix" name="prefix"></slot>
    <span class="en-button__label" part="label"><slot name="label"><slot></slot></slot></span>
    <slot class="en-button__suffix" name="suffix"></slot>
  </button>
`,Ye=new WeakMap,L=new WeakMap;function Xe(e,t){Ye.set(e,{write:t})}function Ze(e){let t=Ye.get(e);if(t){let e={};return t.owner=e,{set(n){t.owner===e&&t.write(n)},release(){t.owner===e&&(t.owner=void 0,t.write(0))}}}let n=L.get(e),r=e.getAttribute(`tabindex`),i={owner:{},original:n?.last===r?n.original:r};L.set(e,i);let a=!0;return{set(t){if(a&&L.get(e)===i){if(i.last!==void 0&&e.getAttribute(`tabindex`)!==i.last){a=!1,L.delete(e);return}i.last=String(t),e.getAttribute(`tabindex`)!==i.last&&e.setAttribute(`tabindex`,i.last)}},release(){a&&L.get(e)===i&&(a=!1,L.delete(e),i.last!==void 0&&e.getAttribute(`tabindex`)===i.last&&(i.original===null?e.removeAttribute(`tabindex`):e.setAttribute(`tabindex`,i.original)))}}}var Qe={tagName:`en-button`,elementClass:class extends me{static properties={variant:{reflect:!0},disabled:{type:Boolean,reflect:!0},loading:{type:Boolean,reflect:!0},iconOnly:{type:Boolean,attribute:`icon-only`,reflect:!0},popupRole:{attribute:`aria-haspopup`},pressedSemantics:{attribute:`aria-pressed`},popupExpanded:{attribute:`aria-expanded`},disabledSemantics:{attribute:`aria-disabled`},descriptionIds:{attribute:`aria-describedby`,hasChanged:()=>!0}};static styles=[ke,Ee,Ke,qe];tabStop=0;constructor(){super(),this.variant=`primary`,this.disabled=!1,this.loading=!1,this.iconOnly=!1,this.popupRole=null,this.pressedSemantics=null,this.popupExpanded=null,this.disabledSemantics=null,this.addEventListener(`click`,e=>{this.getAttribute(`aria-disabled`)===`true`&&(e.preventDefault(),e.stopImmediatePropagation())},{capture:!0}),this.descriptionIds=null,Xe(this,e=>{if(this.tabStop===e)return;this.tabStop=e;let t=this.renderRoot?.querySelector(`button`);t&&(t.tabIndex=e),this.requestUpdate()})}connectedCallback(){super.connectedCallback(),this.requestUpdate()}focus(e){this.renderRoot.querySelector(`button`)?.focus(e)}get buttonPressed(){return[`true`,`false`,`mixed`].includes(this.pressedSemantics??``)?this.pressedSemantics:null}render(){return Je({variant:this.variant,size:this.size,disabled:this.disabled,loading:this.loading,iconOnly:this.iconOnly,popupRole:this.popupRole,popupExpanded:this.popupExpanded,ariaDisabled:this.disabledSemantics,tabIndex:this.tabStop,pressed:this.buttonPressed})}updated(){let e=this.renderRoot.querySelector(`button`);if(!e)return;for(let[t,n]of[[`aria-pressed`,this.buttonPressed],[`aria-haspopup`,this.popupRole],[`aria-expanded`,this.popupExpanded],[`aria-disabled`,this.disabledSemantics]])n===null?e.hasAttribute(t)&&e.removeAttribute(t):e.getAttribute(t)!==n&&e.setAttribute(t,n);if(!(`ariaDescribedByElements`in e))return;let t=this.ariaDescribedByElements,n=e.ariaDescribedByElements;(n?.length!==t?.length||n?.some((e,n)=>e!==t?.[n]))&&(e.ariaDescribedByElements=t)}}},R=new WeakMap;function z(e,t,n,r){return new((e.ownerDocument?.defaultView?.CustomEvent)??globalThis.CustomEvent)(t,{detail:n,bubbles:!0,composed:!0,cancelable:r})}function $e(e,t,n={}){if(Object.is(t.previous,t.proposed))return`unchanged`;let r=Object.freeze({...n.extraDetail,previous:t.previous,proposed:t.proposed,reason:t.reason}),i=z(e,n.eventName??`en-change`,r,!0),a={authorRevision:t.getRevision(),acceptedEpoch:R.get(e)?.acceptedEpoch??0},o=R.get(e);o||(o={acceptedEpoch:0,frames:[]},R.set(e,o));let s=o;s.frames.push(a);let c=!1,l=()=>s.frames[s.frames.length-1]===a&&t.getRevision()===a.authorRevision&&s.acceptedEpoch===a.acceptedEpoch,u=()=>{c=!0,t.rollback(t.previous)};try{if(t.stage(t.proposed),!l())return c=!0,`superseded`;let n=e.dispatchEvent(i);if(!l())return c=!0,`superseded`;if(!n)return u(),`canceled`;let r=t.canCommit?.(t.proposed)??!0;if(r||i.preventDefault(),!l())return c=!0,`superseded`;if(!r)return u(),`canceled`;s.acceptedEpoch+=1;let o=s.acceptedEpoch;return c=!0,t.commit?.(t.proposed),t.getRevision()!==a.authorRevision||s.acceptedEpoch!==o?`superseded`:`committed`}catch(e){if(!c&&l())try{u()}catch(t){throw AggregateError([e,t],`Change transaction and its rollback both failed.`)}throw e}finally{s.frames.pop(),s.frames.length===0&&R.delete(e)}}function et(e,t,{cancelable:n=!1}={}){return e.dispatchEvent(z(e,`en-action`,Object.freeze({...t}),n))}function tt(e,t){e.dispatchEvent(z(e,`en-input`,Object.freeze({...t}),!1))}function nt(e,t,n){e.dispatchEvent(z(e,t,Object.freeze({...n}),!1))}var B={segmented:{scale:a`var(--en-segmented-pressed-scale, 1)`,offset:a`var(--en-segmented-pressed-offset, 0px)`,press:a`var(--en-segmented-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-segmented-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-segmented-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-segmented-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-segmented-pressed-color, ${y(`--en-color-text`)}); border-color: var(--en-segmented-pressed-border-color, ${y(`--en-color-boundary`)});`},accordion:{scale:a`var(--en-accordion-pressed-scale, 1)`,offset:a`var(--en-accordion-pressed-offset, 0px)`,press:a`var(--en-accordion-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-accordion-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-accordion-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-accordion-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-accordion-pressed-color, ${y(`--en-color-text`)});`},tab:{scale:a`var(--en-tab-pressed-scale, 1)`,offset:a`var(--en-tab-pressed-offset, 0px)`,press:a`var(--en-tab-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-tab-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-tab-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-tab-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-tab-pressed-color, var(--en-tab-color, ${y(`--en-color-action-text`)}));`},rating:{scale:a`var(--en-rating-pressed-scale, 1)`,offset:a`var(--en-rating-pressed-offset, 0px)`,press:a`var(--en-rating-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-rating-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-rating-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-rating-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-rating-pressed-color, ${y(`--en-color-text`)});`},"combobox-trigger":{scale:a`var(--en-combobox-trigger-pressed-scale, 1)`,offset:a`var(--en-combobox-trigger-pressed-offset, 0px)`,press:a`var(--en-combobox-trigger-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-combobox-trigger-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-combobox-trigger-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-combobox-trigger-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-combobox-trigger-pressed-color, ${y(`--en-color-text`)});`},navigation:{scale:a`var(--en-navigation-pressed-scale, 1)`,offset:a`var(--en-navigation-pressed-offset, 0px)`,press:a`var(--en-navigation-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-navigation-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-navigation-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-navigation-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-navigation-pressed-color, ${y(`--en-color-action-text`)});`},"editor-token":{scale:a`var(--en-editor-token-pressed-scale, 1)`,offset:a`var(--en-editor-token-pressed-offset, 0px)`,press:a`var(--en-editor-token-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-editor-token-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-editor-token-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-editor-token-pressed-background, ${y(`--en-color-accent-subtle`)}); color: var(--en-editor-token-pressed-color, var(--en-editor-token-color, ${y(`--en-color-text`)})); border-color: var(--en-editor-token-pressed-border-color, var(--en-editor-token-border-color, ${y(`--en-color-line`)}));`},option:{scale:a`var(--en-option-pressed-scale, 1)`,offset:a`var(--en-option-pressed-offset, 0px)`,press:a`var(--en-option-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-option-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-option-pressed-shadow, 0 0 0 0 transparent)`,paint:a``},calendar:{scale:a`var(--en-calendar-pressed-scale, 1)`,offset:a`var(--en-calendar-pressed-offset, 0px)`,press:a`var(--en-calendar-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-calendar-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-calendar-pressed-shadow, 0 0 0 0 transparent)`,paint:a``},checkbox:{scale:a`var(--en-checkbox-pressed-scale, 1)`,offset:a`var(--en-checkbox-pressed-offset, 0px)`,press:a`var(--en-checkbox-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-checkbox-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-checkbox-pressed-shadow, inset 0 0 0 1px currentColor)`,paint:a`border-color: var(--en-checkbox-pressed-border-color, ${y(`--en-color-action-pressed`)});`},radio:{scale:a`var(--en-radio-pressed-scale, 1)`,offset:a`var(--en-radio-pressed-offset, 0px)`,press:a`var(--en-radio-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-radio-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-radio-pressed-shadow, inset 0 0 0 1px currentColor)`,paint:a`border-color: var(--en-radio-pressed-border-color, ${y(`--en-color-action-pressed`)});`},switch:{scale:a`var(--en-switch-pressed-scale, 1)`,offset:a`var(--en-switch-pressed-offset, 0px)`,press:a`var(--en-switch-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-switch-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-switch-pressed-shadow, inset 0 0 0 1px currentColor)`,paint:a`border-color: var(--en-switch-pressed-border-color, ${y(`--en-color-action-pressed`)});`},select:{scale:a`var(--en-select-pressed-scale, 1)`,offset:a`var(--en-select-pressed-offset, 0px)`,press:a`var(--en-select-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-select-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-select-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-select-pressed-background, var(--en-input-background, ${y(`--en-color-accent-subtle`)})); color: var(--en-select-pressed-color, var(--en-input-color, ${y(`--en-color-text`)}));`},"number-step":{scale:a`var(--en-number-step-pressed-scale, var(--en-button-pressed-scale, 1))`,offset:a`var(--en-number-step-pressed-offset, var(--en-button-pressed-offset, 0px))`,press:a`var(--en-number-step-press-duration, ${y(`--en-duration-press`)})`,release:a`var(--en-number-step-release-duration, ${y(`--en-duration-release`)})`,shadow:a`var(--en-number-step-pressed-shadow, 0 0 0 0 transparent)`,paint:a`background: var(--en-number-step-pressed-background, var(--en-button-pressed-background, ${y(`--en-color-accent-subtle`)}));`}},V=b(`--en-input-border-width`,y(`--en-border-width`)),H=b(`--en-input-invalid-border-width`,y(`--en-border-invalid-width`)),U=b(`--en-input-radius`,b(`--en-control-radius`,y(`--en-radius-control`)));function rt(e,t){return a`
    ${e} { border-radius: ${U}; border-width: ${V}; border-color: ${b(`--en-input-border-color`,b(`--en-control-border-color`,y(`--en-color-boundary`)))}; }
    @media (hover: hover) {
      ${e}:hover:where(:not(:disabled):not([aria-disabled='true']):not(:has(:disabled))) { border-color: var(--en-input-hover-border-color, var(--en-input-border-color, var(--en-control-border-color, ${y(`--en-color-boundary`)}))); }
    }
    ${t} { border-color: ${b(`--en-input-invalid-border-color`,y(`--en-color-danger-text`))}; }
  `}var W=a`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,it=a`
  .en-description { margin: 0; font-size: ${y(`--en-font-ui-size`)}; line-height: ${y(`--en-font-body-line-height`)}; overflow-wrap: break-word; display: flow-root; color: ${y(`--en-color-text-muted`)}; }
  .en-description-fallback,
  .en-description > slot::slotted(:not([hidden])) { display: block; margin-block-start: var(--_en-field-gap, ${b(`--en-field-gap`,y(`--en-space-label-control`))}); }
  .en-description-fallback:empty { display: none; }
  @media (forced-colors: active) { .en-description { color: CanvasText; } }
`,G=a`clamp(0ms, var(--en-dialog-enter-duration, ${y(`--en-duration-enter`)}), 500ms)`,K=a`clamp(0ms, var(--en-dialog-exit-duration, ${y(`--en-duration-exit`)}), 500ms)`,q=a`clamp(0px, ${y(`--en-motion-surface-offset`)}, 8px)`,at=a`clamp(.95, ${y(`--en-motion-surface-scale`)}, 1)`,J=a`var(--_en-surface-duration, 0ms) var(--_en-surface-ease, linear)`,ot=a`opacity var(--_en-surface-opacity-duration, 0ms) var(--_en-surface-ease, linear), translate ${J}, scale ${J}, display ${J} allow-discrete, overlay ${J} allow-discrete`;function Y(e,t,n,r,i=a``,o=`popup`){let s=o===`dialog`?a`clamp(0ms, var(--en-dialog-enter-duration, ${y(`--en-duration-enter`)}), 500ms)`:a`clamp(0ms, var(--en-popup-enter-duration, ${y(`--en-duration-enter`)}), 500ms)`,c=o===`dialog`?a`clamp(0ms, var(--en-dialog-exit-duration, ${y(`--en-duration-exit`)}), 500ms)`:a`clamp(0ms, var(--en-popup-exit-duration, ${y(`--en-duration-exit`)}), 500ms)`,l=o===`dialog`?a`var(--en-dialog-enter-ease, ${y(`--en-ease-enter`)})`:a`var(--en-popup-enter-ease, ${y(`--en-ease-enter`)})`,u=o===`dialog`?a`var(--en-dialog-exit-ease, ${y(`--en-ease-exit`)})`:a`var(--en-popup-exit-ease, ${y(`--en-ease-exit`)})`,d=a`:where(${e})${i}`,f=a`${t}${i}`,p=a`${n}${i}`;return a`
    @supports (transition-behavior: allow-discrete) and (overlay: auto) {
      ${d} {
        --_en-surface-duration: ${c};
        --_en-surface-opacity-duration: ${c};
        --_en-surface-ease: ${u};
        opacity: 0;
        transition: ${ot};
      }
      ${f} {
        --_en-surface-duration: ${s};
        /* Modal and menu entry keep content opaque. Fade surfaces reverse
           from their current opacity when reopened during exit. */
        --_en-surface-opacity-duration: ${r===`fade`?s:a`0ms`};
        --_en-surface-ease: ${l};
        opacity: 1;
      }
      ${p} { pointer-events: none; }
      ${r===`elevation`?a`
        /* Opaque command content and its primary focus contour are immediate.
           Elevation adds entry paint without corrupting measured iPhone geometry. */
        @keyframes en-surface-elevation { from { box-shadow: none; } }
        ${f} { animation: en-surface-elevation ${s} ${l}; }
      `:a``}
      @starting-style { ${f} { opacity: ${r===`fade`?0:1}; } }
    }
    @media (prefers-reduced-motion: reduce) {
      ${d} { transition: none !important; animation: none !important; }
    }
    @media (forced-colors: active) {
      ${d} { animation: none; }
    }
  `}var st=a`
  ${Y(a`dialog:is(.en-dialog, .en-drawer)`,a`dialog:is(.en-dialog, .en-drawer)[open]`,a`dialog:is(.en-dialog, .en-drawer):not([open])`,`move`,a``,`dialog`)}
  @supports (transition-behavior: allow-discrete) and (overlay: auto) {
    dialog:is(.en-dialog, .en-drawer) {
      --_en-surface-x: 0px;
      --_en-surface-y: ${q};
      translate: var(--_en-surface-x) var(--_en-surface-y);
      scale: ${at};
    }
    /* Share modal travel distance; attachment selects its axis and sign.
       Keep the drawer unscaled so its attached edge stays flush. */
    dialog.en-drawer { --_en-surface-x: ${q}; --_en-surface-y: 0px; scale: 1; }
    dialog.en-drawer:is([data-placement='start'], [data-placement='left']) { --_en-surface-x: calc(-1 * ${q}); }
    dialog.en-drawer[data-placement='end']:dir(rtl) { --_en-surface-x: calc(-1 * ${q}); }
    dialog.en-drawer[data-placement='start']:dir(rtl) { --_en-surface-x: ${q}; }
    dialog.en-drawer:is([data-placement='top'], [data-placement='bottom']) { --_en-surface-x: 0px; --_en-surface-y: ${q}; }
    dialog.en-drawer[data-placement='top'] { --_en-surface-y: calc(-1 * ${q}); }
    dialog:is(.en-dialog, .en-drawer)[open] { translate: 0px 0px; scale: 1; }
    @starting-style {
      dialog:is(.en-dialog, .en-drawer)[open] {
        translate: var(--_en-surface-x) var(--_en-surface-y);
        scale: ${at};
      }
      dialog.en-drawer[open] { scale: 1; }
    }
    dialog:is(.en-dialog, .en-drawer)::backdrop {
      opacity: 0;
      transition: opacity ${K} var(--en-dialog-exit-ease, ${y(`--en-ease-exit`)}), display ${K} allow-discrete, overlay ${K} allow-discrete;
    }
    dialog:is(.en-dialog, .en-drawer)[open]::backdrop {
      opacity: 1;
      transition: opacity ${G} var(--en-dialog-enter-ease, ${y(`--en-ease-enter`)}), display ${G} allow-discrete, overlay ${G} allow-discrete;
    }
    dialog:is(.en-dialog, .en-drawer):not([open])::backdrop { pointer-events: none; }
    @starting-style { dialog:is(.en-dialog, .en-drawer)[open]::backdrop { opacity: 0; } }
  }
  @media (prefers-reduced-motion: reduce) {
    dialog:is(.en-dialog, .en-drawer) { translate: none !important; scale: none !important; }
    dialog:is(.en-dialog, .en-drawer)::backdrop { transition: none !important; }
  }
`,ct=a`
  .en-radio {
    flex: none;
    inline-size: ${b(`--en-choice-size`,y(`--en-size-icon`))};
    block-size: ${b(`--en-choice-size`,y(`--en-size-icon`))};
    margin: 0;
    accent-color: ${y(`--en-color-action`)};
    appearance: none;
    display: inline-grid;
    /* Keep the inline baseline independent of the checked-state grid dot. */
    vertical-align: middle;
    place-items: center;
    box-sizing: border-box;
    border: ${y(`--en-border-width`)} solid ${y(`--en-color-boundary`)};
    border-radius: ${y(`--en-radius-pill`)};
    background: ${y(`--en-color-surface`)};
    cursor: pointer;
  }
  .en-radio:checked { border-color: ${b(`--en-radio-selected-color`,y(`--en-color-action`))}; }
  .en-radio:checked::before { content: ''; inline-size: ${y(`--en-size-choice-dot`)}; block-size: ${y(`--en-size-choice-dot`)}; border-radius: ${y(`--en-radius-pill`)}; background: ${b(`--en-radio-selected-color`,y(`--en-color-action`))}; }
  .en-radio:not(:disabled):active { border-color: ${y(`--en-color-action-pressed`)}; }
  .en-radio:disabled { cursor: default; background: ${y(`--en-color-surface-subtle`)}; border-color: ${y(`--en-color-boundary`)}; }
  .en-radio:disabled::before { background: ${y(`--en-color-text-muted`)}; }
  ${S(a`.en-radio`,a`.en-radio:not(:disabled):not([data-press='none']):is(:active, .en-choice:active > .en-radio)`,B.radio)}
  @media (forced-colors: active) {
    .en-radio { accent-color: auto; background: Canvas; border-color: CanvasText; }
    .en-radio:checked { background: Canvas; border-color: CanvasText; }
    .en-radio:checked::before { background: CanvasText; }
    .en-radio:not(:disabled):active { border-color: Highlight; box-shadow: none; }
    .en-radio:disabled { background: Canvas; border-color: GrayText; }
    .en-radio:disabled::before { background: GrayText; }
    .en-radio:focus-visible { outline-color: CanvasText; }
  }
`;function lt(e){return a`
    ${e.motion===!1?a``:S(e.base,a`${e.pressed}:not([aria-disabled='true']):not(:disabled):not([data-press='none']):not([data-reorderable])`,B.option)}
    ${e.base} {
      /* Reset each row's state slots: a nested option must not inherit its parent's state. */
      --_en-option-selected-background: initial;
      --_en-option-selected-color: initial;
      --_en-option-active-background: initial;
      --_en-option-active-color: initial;
      --_en-option-hover-background: initial;
      --_en-option-hover-color: initial;
      --_en-option-pressed-background: initial;
      --_en-option-pressed-color: initial;
      --_en-option-disabled-background: initial;
      --_en-option-disabled-color: initial;
      --_en-option-rest-background: var(--en-option-rest-background, var(--en-option-background));
      --_en-option-rest-color: var(--en-option-rest-color, var(--en-option-color));
      background: var(--_en-option-disabled-background, var(--_en-option-pressed-background, var(--_en-option-hover-background, var(--_en-option-active-background, var(--_en-option-selected-background, var(--_en-option-rest-background, ${e.restBackground}))))));
      color: var(--_en-option-disabled-color, var(--_en-option-pressed-color, var(--_en-option-hover-color, var(--_en-option-active-color, var(--_en-option-selected-color, var(--_en-option-rest-color, ${e.restColor}))))));
      font-weight: ${b(`--en-option-font-weight`,a`inherit`)};
    }
    ${e.selected?a`${e.selected} {
      --_en-option-selected-background: ${b(`--en-option-selected-background`,b(`--en-option-background`,y(`--en-color-selected`)))};
      --_en-option-selected-color: ${b(`--en-option-selected-color`,b(`--en-option-color`,e.selectedColor??e.restColor))};
      font-weight: ${b(`--en-option-selected-font-weight`,b(`--en-option-font-weight`,y(`--en-font-label-strong-weight`)))};
    }`:a``}
    @media (hover: hover) { ${e.hover} {
      --_en-option-hover-background: ${b(`--en-option-hover-background`,b(`--en-option-background`,e.hoverBackground))};
      /* With neither override set, the state slot is invalid and falls through
         to active/selected/rest paint, rather than resetting it. */
      --_en-option-hover-color: var(--en-option-hover-color, var(--en-option-color));
    } }
    ${e.focus?a`${e.focus} {
      --_en-option-hover-background: ${b(`--en-option-hover-background`,b(`--en-option-background`,e.hoverBackground))};
      --_en-option-hover-color: var(--en-option-hover-color, var(--en-option-color));
    }`:a``}
    ${e.active?a`${e.active} {
      --_en-option-active-background: var(--en-option-active-background, var(--en-option-background));
      --_en-option-active-color: var(--en-option-active-color, var(--en-option-color));
    }`:a``}
    ${e.pressed} {
      --_en-option-pressed-background: var(--en-option-pressed-background, var(--en-option-background, color-mix(in srgb, ${e.hoverBackground} 82%, currentColor)));
      --_en-option-pressed-color: var(--en-option-pressed-color, var(--en-option-color));
    }
    ${e.disabled} {
      --_en-option-disabled-background: var(--en-option-disabled-background, var(--en-option-background));
      --_en-option-disabled-color: ${b(`--en-option-disabled-color`,b(`--en-option-color`,y(`--en-color-text-muted`)))};
    }
  `}var ut=a`
  ${Re}
  ${D(a`.en-accordion-trigger`,{family:`button`})}
  ${D(a`:where(.en-input, .en-textarea, .en-select, .en-color-control)`,{family:`input`})}
  ${D(a`.en-option`,{family:`option`})}
  ${D(a`:where(.en-link, .en-control:not(.en-color-control), .en-checkbox, .en-radio, .en-switch,
    .en-range, .en-tab, .en-split-separator, .en-rating-item)`)}
`,X=w({family:`input`}),dt=a`
  .en-field-focus-frame {
    position: relative;
    min-inline-size: 0;
    --_en-field-focus-accent-width: ${b(`--en-input-focus-accent-width`,y(`--en-focus-accent-width`))};
  }
  .en-field-focus-frame:not(.en-number-group) { display: grid; }
  .en-field-focus-frame > :is(input, textarea) { display: block; }
  .en-field-focus-frame::after {
    content: '';
    position: absolute;
    pointer-events: none;
    inset-inline: 0;
    inset-block-end: 0;
    box-sizing: border-box;
    block-size: max(var(--_en-field-focus-accent-width), ${b(`--en-control-radius`,y(`--en-radius-control`))});
    border-end-start-radius: ${b(`--en-control-radius`,y(`--en-radius-control`))};
    border-end-end-radius: ${b(`--en-control-radius`,y(`--en-radius-control`))};
    border-block-end: var(--_en-field-focus-accent-width) solid ${b(`--en-input-focus-accent-color`,y(`--en-color-focus`))};
    clip-path: inset(calc(100% - var(--_en-field-focus-accent-width)) 0 0 0);
    transform: scaleX(0);
    transform-origin: center;
    transition: transform ${y(`--en-duration-focus-exit`)} ${y(`--en-ease-focus-exit`)};
  }
  .en-number-group.en-field-focus-frame {
    box-shadow: 0 0 0 0 ${X.haloColor};
    transition: box-shadow ${y(`--en-duration-focus-exit`)} ${y(`--en-ease-focus-exit`)};
  }
  .en-number-group.en-field-focus-frame:focus-within {
    box-shadow: 0 0 0 ${X.haloWidth} ${X.haloColor};
    transition-duration: ${y(`--en-duration-focus-enter`)};
    transition-timing-function: ${y(`--en-ease-focus-enter`)};
  }
  .en-field-focus-frame:focus-within::after {
    transform: scaleX(1);
    transition-duration: ${y(`--en-duration-focus-enter`)};
    transition-timing-function: ${y(`--en-ease-focus-enter`)};
  }
  @media (prefers-reduced-motion: reduce) {
    .en-field-focus-frame::after, .en-field-focus-frame:focus-within::after,
    .en-number-group.en-field-focus-frame, .en-number-group.en-field-focus-frame:focus-within { transition: none; }
  }
  @media (forced-colors: active) {
    .en-field-focus-frame::after, .en-field-focus-frame:focus-within::after { border-block-end-color: Highlight; transition: none; }
    .en-number-group.en-field-focus-frame, .en-number-group.en-field-focus-frame:focus-within { box-shadow: none; transition: none; }
  }
`,ft=a`
  block-size: ${y(`--en-size-range-track`)};
  border: 0;
  border-radius: ${y(`--en-radius-pill`)};
  background: ${y(`--en-color-boundary`)};
`,pt=a`
  box-sizing: border-box;
  inline-size: ${y(`--en-size-icon`)};
  block-size: ${y(`--en-size-icon`)};
  border: ${y(`--en-border-width`)} solid ${y(`--en-color-action`)};
  border-radius: ${y(`--en-radius-pill`)};
  background: ${y(`--en-color-action`)};
`,mt=a`outline: ${y(`--en-focus-width`)} solid ${y(`--en-color-focus`)}; outline-offset: ${y(`--en-focus-offset`)};`,ht=a`
  @supports selector(input::-webkit-slider-thumb) {
    .en-range { appearance: none; background: none; cursor: pointer; }
    .en-range::-webkit-slider-runnable-track { ${ft} }
    .en-range::-webkit-slider-thumb { appearance: none; ${pt} margin-block-start: calc((${y(`--en-size-range-track`)} - ${y(`--en-size-icon`)}) / 2); }
    /* Exposed native thumbs own focus. A global halo must not reintroduce a
       rectangular range-host ring; native unsupported fallbacks keep that route. */
    .en-range, .en-range:focus-visible { box-shadow: none; }
    .en-range:focus-visible { outline: none; }
    .en-range:focus-visible::-webkit-slider-thumb { ${mt} }
    .en-range:disabled::-webkit-slider-thumb { background: ${y(`--en-color-text-muted`)}; border-color: ${y(`--en-color-text-muted`)}; }
    @media (forced-colors: active) {
      .en-range::-webkit-slider-runnable-track { background: ButtonText; }
      .en-range::-webkit-slider-thumb { background: Highlight; border-color: Highlight; }
      .en-range:disabled::-webkit-slider-thumb { background: GrayText; border-color: GrayText; }
      .en-range:focus-visible::-webkit-slider-thumb { outline-color: CanvasText; }
    }
  }
  @supports selector(input::-moz-range-thumb) {
    .en-range { appearance: none; background: none; cursor: pointer; }
    .en-range::-moz-range-track { ${ft} }
    .en-range::-moz-range-thumb { ${pt} }
    /* Exposed native thumbs own focus. A global halo must not reintroduce a
       rectangular range-host ring; native unsupported fallbacks keep that route. */
    .en-range, .en-range:focus-visible { box-shadow: none; }
    .en-range:focus-visible { outline: none; }
    .en-range:focus-visible::-moz-range-thumb { ${mt} }
    .en-range:disabled::-moz-range-thumb { background: ${y(`--en-color-text-muted`)}; border-color: ${y(`--en-color-text-muted`)}; }
    @media (forced-colors: active) {
      .en-range::-moz-range-track { background: ButtonText; }
      .en-range::-moz-range-thumb { background: Highlight; border-color: Highlight; }
      .en-range:disabled::-moz-range-thumb { background: GrayText; border-color: GrayText; }
      .en-range:focus-visible::-moz-range-thumb { outline-color: CanvasText; }
    }
  }
  .en-range:disabled { cursor: default; }
   .en-range::-webkit-slider-thumb { transition: scale clamp(0ms, var(--en-slider-thumb-release-duration, 80ms), 200ms) ${y(`--en-ease-standard`)}; }
   .en-range:not(:disabled):active::-webkit-slider-thumb { scale: clamp(.9, var(--en-slider-thumb-pressed-scale, 1), 1.25); transition-duration: clamp(0ms, var(--en-slider-thumb-press-duration, 80ms), 200ms); }
  @media (prefers-reduced-motion: reduce) {  .en-range::-webkit-slider-thumb { scale: none !important; transition: none !important; } }
  :host([data-press=none])  .en-range::-webkit-slider-thumb { scale: none !important; }

   .en-range::-moz-range-thumb { transition: scale clamp(0ms, var(--en-slider-thumb-release-duration, 80ms), 200ms) ${y(`--en-ease-standard`)}; }
   .en-range:not(:disabled):active::-moz-range-thumb { scale: clamp(.9, var(--en-slider-thumb-pressed-scale, 1), 1.25); transition-duration: clamp(0ms, var(--en-slider-thumb-press-duration, 80ms), 200ms); }
  @media (prefers-reduced-motion: reduce) {  .en-range::-moz-range-thumb { scale: none !important; transition: none !important; } }
  :host([data-press=none])  .en-range::-moz-range-thumb { scale: none !important; }

`,gt=a`
  .en-link {
    color: ${y(`--en-color-link`)};
    text-decoration: underline;
    text-underline-offset: ${y(`--en-space-0-5`)};
    overflow-wrap: break-word;
  }
  .en-link:not([aria-disabled='true']):active { text-decoration-thickness: .2em; }
  .en-link:visited { color: ${y(`--en-color-link`)}; }
`,_t=a`.en-link[aria-disabled='true'] { color: ${y(`--en-color-text-muted`)}; cursor: default; }`,vt=a`.en-link, .en-link:visited { color: LinkText; }`,Z=b(`--en-input-inline-padding`,b(`--en-control-inline-padding`,y(`--en-space-control-inline`))),yt=U,Q=a`max(0px, ${yt} - ${V})`,$=a`max(
  ${y(`--en-space-control-block`)},
  calc((var(--_en-text-control-block-size) - ${y(`--en-font-input-size`)} * ${y(`--en-font-input-line-height`)}) / 2 - ${V})
)`,bt=k(a`
  /* Compute on each consumer so local token/part overrides retain their scope. */
  ${N(a`.en-button:not(.en-icon-button), .en-button[data-icon-only], .en-input, .en-textarea, .en-select, .en-number-input, .en-number-step, .en-color-control`)}
  ${Be(a`.en-control, .en-button, .en-input, .en-textarea, .en-select`)}
  ${P(a`.en-button:not(.en-icon-button), .en-input, .en-textarea, .en-select`)}
  /* Field tokens customize inputs without changing action and choice surfaces.
     Family refinements take precedence over shared control defaults. */
  .en-input, .en-textarea, .en-select {
    padding-inline: ${Z};
    background: ${b(`--en-input-background`,b(`--en-control-background`,y(`--en-color-surface`)))};
    color: ${b(`--en-input-color`,b(`--en-control-color`,y(`--en-color-text`)))};
  }
  ${Ie}
  ${gt}
  ${Ve(a`:is(.en-button, .en-input, .en-textarea, .en-select, .en-control):is(:disabled, [aria-disabled='true'])`)}
  ${_t}
  .en-input, .en-textarea, .en-select {
    inline-size: 100%;
    font: ${y(`--en-font-input-weight`)} ${y(`--en-font-input-size`)} / ${y(`--en-font-input-line-height`)} ${y(`--en-font-input-family`)}; font-style: ${y(`--en-font-input-style`)}; letter-spacing: ${y(`--en-font-input-tracking`)};
  }
  /* Apply after the font shorthand so editable numeric content retains equal
     digit widths. Input modes also cover text-based numeric editors. */
  .en-input:is(.en-time-input, [type='number'], [type='date'], [type='time'], [type='datetime-local'], [type='month'], [type='week'], [type='tel']),
  :is(.en-input, .en-textarea):is([inputmode='numeric'], [inputmode='decimal'], [inputmode='tel']) {
    font-variant-numeric: tabular-nums;
  }
  /* Use the shared text-field surface and target envelope around the native
     date editor. Keep its fields, separators and calendar-picker activation. */
  .en-input[type='date'] {
    -webkit-appearance: none;
    appearance: none;
    padding-block: ${$};
  }
  .en-input[type='date']::-webkit-datetime-edit { padding: 0; }
  .en-input[type='date']::-webkit-datetime-edit-fields-wrapper { padding-block: 0; }
  .en-input[type='date']::-webkit-datetime-edit-year-field,
  .en-input[type='date']::-webkit-datetime-edit-month-field,
  .en-input[type='date']::-webkit-datetime-edit-day-field { padding-block: 0; }
  .en-input[type='date']::-webkit-date-and-time-value {
    margin-block: 0;
    text-align: inherit;
  }
  .en-input::placeholder, .en-textarea::placeholder { color: ${y(`--en-color-text-muted`)}; opacity: 1; }
  .en-text-input, .en-textarea { padding-block: ${$}; }
  .en-textarea { resize: block; }
  .en-input[aria-invalid='true'], .en-textarea[aria-invalid='true'], .en-select[aria-invalid='true'], .en-control[data-invalid] {
    border-color: ${y(`--en-color-danger-text`)};
  }
  .en-input:user-invalid, .en-textarea:user-invalid, .en-select:user-invalid { border-color: ${y(`--en-color-danger-text`)}; }
  /* The text-field marker keeps stronger invalid geometry out of other native controls.
     Preserve border + padding on each edge, including scoped padding/base-border tokens. */
  .en-text-input:is([aria-invalid='true'], :user-invalid) {
    border-width: ${H};
    padding-block: max(0px, calc(${$} + ${V} - ${H}));
    padding-inline: max(0px, calc(${Z} + ${V} - ${H}));
  }
  ${rt(a`:is(.en-input, .en-textarea, .en-select, .en-number-group)`,a`:is(.en-input, .en-textarea, .en-select)[aria-invalid='true'], :is(.en-input, .en-textarea, .en-select):user-invalid, .en-number-group[data-invalid]`)}
  .en-input-group { display: flex; align-items: stretch; gap: ${y(`--en-space-1`)}; min-inline-size: 0; }
  .en-input-group > .en-input { flex: 1 1 auto; inline-size: 0; min-inline-size: 0; }
  .en-number-group {
    gap: 0;
    padding: 0;
    border: ${V} solid ${b(`--en-input-border-color`,b(`--en-control-border-color`,y(`--en-color-boundary`)))};
    border-radius: ${yt};
    background: ${b(`--en-input-background`,b(`--en-control-background`,y(`--en-color-surface`)))};
  }
  .en-number-group[data-invalid] { border-color: ${b(`--en-input-invalid-border-color`,y(`--en-color-danger-text`))}; }
  .en-number-group > :is(.en-number-input, .en-number-step, button.en-button.en-number-step) { min-block-size: max(calc(var(--_en-text-control-block-size) - 2 * ${V}), ${y(`--en-size-target-min`)}); }
  .en-number-group > .en-number-input { border: 0; border-radius: 0; background: none; appearance: textfield; }
  .en-number-input::-webkit-inner-spin-button, .en-number-input::-webkit-outer-spin-button { appearance: none; margin: 0; }
  .en-number-step {
    flex: none;
    min-inline-size: ${j()};
    padding-inline: ${y(`--en-space-control-block`)};
    border: 0;
    border-inline-start: ${y(`--en-border-width`)} solid ${y(`--en-color-line`)};
    border-radius: 0;
    background: ${y(`--en-color-surface-subtle`)};
    color: ${y(`--en-color-text`)};
  }
  /* Match the frame's override as well as its token. Keep overflow visible so
     consumer-defined outward focus contours remain intact. */
  .en-number-step:not(:disabled):not([aria-disabled='true']):active { background: var(--en-button-pressed-background, ${y(`--en-color-accent-subtle`)}); }
  .en-number-step:last-child { border-start-end-radius: ${Q}; border-end-end-radius: ${Q}; }
  .en-number-step:first-child { border-inline-start: 0; border-inline-end: ${y(`--en-border-width`)} solid ${y(`--en-color-line`)}; border-start-start-radius: ${Q}; border-end-start-radius: ${Q}; }

  .en-color-control { cursor: pointer; padding: ${y(`--en-space-control-block`)}; block-size: var(--_en-text-control-block-size); }
  .en-color-control::-webkit-color-swatch-wrapper { padding: 0; }
  .en-color-control::-webkit-color-swatch { border: ${y(`--en-border-width`)} solid ${y(`--en-color-boundary`)}; border-radius: max(0px, ${y(`--en-radius-control`)} - ${y(`--en-space-control-block`)}); }
  .en-color-control::-moz-color-swatch { border: ${y(`--en-border-width`)} solid ${y(`--en-color-boundary`)}; border-radius: max(0px, ${y(`--en-radius-control`)} - ${y(`--en-space-control-block`)}); }
  ${ct}
  .en-checkbox, .en-switch {
    flex: none;
    inline-size: ${b(`--en-choice-size`,y(`--en-size-icon`))};
    block-size: ${b(`--en-choice-size`,y(`--en-size-icon`))};
    margin: 0;
    accent-color: ${y(`--en-color-action`)};
  }
  .en-checkbox {
    appearance: none;
    display: inline-grid;
    place-items: center;
    box-sizing: border-box;
    border: ${y(`--en-border-width`)} solid ${y(`--en-color-boundary`)};
    background: ${y(`--en-color-surface`)};
    cursor: pointer;
  }
  .en-checkbox { border-radius: ${y(`--en-radius-choice`)}; }
  .en-checkbox:checked, .en-checkbox:indeterminate { background: ${y(`--en-color-action`)}; border-color: ${y(`--en-color-action`)}; }
  .en-checkbox:checked::before {
    content: '';
    box-sizing: border-box;
    inline-size: ${y(`--en-size-choice-mark-inline`)};
    block-size: ${y(`--en-size-choice-mark-block`)};
    /* The check is directional artwork, not an inline-layout edge; never mirror it in RTL. */
    border-right: ${y(`--en-size-choice-mark-stroke`)} solid ${y(`--en-color-on-action`)};
    border-bottom: ${y(`--en-size-choice-mark-stroke`)} solid ${y(`--en-color-on-action`)};
    transform: rotate(45deg);
  }
  .en-checkbox:indeterminate::before { content: ''; inline-size: ${y(`--en-size-choice-mark-block`)}; block-size: 0; border: 0; border-block-end: ${y(`--en-size-choice-mark-stroke`)} solid ${y(`--en-color-on-action`)}; transform: none; }
  .en-checkbox:disabled { cursor: default; background: ${y(`--en-color-surface-subtle`)}; border-color: ${y(`--en-color-boundary`)}; }
  .en-checkbox:disabled::before { border-color: ${y(`--en-color-text-muted`)}; }
  .en-switch {
    position: relative;
    appearance: none;
    box-sizing: border-box;
    inline-size: ${b(`--en-switch-inline-size`,y(`--en-size-switch-inline`))};
    block-size: ${b(`--en-switch-block-size`,y(`--en-size-switch-block`))};
    border: ${y(`--en-border-width`)} solid ${y(`--en-color-boundary`)};
    border-radius: ${y(`--en-radius-pill`)};
    background: ${y(`--en-color-surface-subtle`)};
    cursor: pointer;
  }
  .en-switch::before {
    content: '';
    pointer-events: none;
    position: absolute;
    inset-block-start: ${y(`--en-space-switch-inset`)};
    inset-inline-start: ${y(`--en-space-switch-inset`)};
    --_en-switch-thumb-inline: ${b(`--en-switch-thumb-size`,y(`--en-size-switch-thumb`))};
    inline-size: var(--_en-switch-thumb-inline);
    block-size: ${b(`--en-switch-thumb-size`,y(`--en-size-switch-thumb`))};
    border-radius: ${y(`--en-radius-pill`)};
    background: ${y(`--en-color-text-muted`)};
    transition: inset-inline-start var(--_en-press-duration, ${y(`--en-duration-fast`)}) ${y(`--en-ease-standard`)}, inline-size var(--_en-press-duration, ${y(`--en-duration-fast`)}) ${y(`--en-ease-standard`)};
  }
  .en-switch:checked { background: ${y(`--en-color-action`)}; border-color: ${y(`--en-color-action`)}; }
  .en-switch:checked::before { inset-inline-start: calc(100% - var(--_en-switch-thumb-inline) - ${y(`--en-space-switch-inset`)}); background: ${y(`--en-color-on-action`)}; }
  .en-switch:not(:disabled):is(:active, .en-choice:active > .en-switch)::before { --_en-switch-thumb-inline: clamp(0px, var(--en-switch-thumb-pressed-size, var(--en-switch-thumb-size, ${y(`--en-size-switch-thumb`)})), calc(100% - 2 * ${y(`--en-space-switch-inset`)})); }
  @media (prefers-reduced-motion: reduce) { .en-switch:is(:active, .en-choice:active > .en-switch)::before { --_en-switch-thumb-inline: var(--en-switch-thumb-size, ${y(`--en-size-switch-thumb`)}); transition: none; } }
  :host([data-press=none]) .en-switch:is(:active, .en-choice:active > .en-switch)::before { --_en-switch-thumb-inline: var(--en-switch-thumb-size, ${y(`--en-size-switch-thumb`)}); }
  .en-switch:disabled { cursor: default; border-color: ${y(`--en-color-boundary`)}; background: ${y(`--en-color-surface-subtle`)}; }
  :is(.en-checkbox, .en-switch):not(:disabled):active { border-color: ${y(`--en-color-action-pressed`)}; }
  .en-switch:disabled::before { background: ${y(`--en-color-text-muted`)}; }
  .en-range { inline-size: 100%; min-inline-size: ${y(`--en-size-target-min`)}; min-block-size: ${j()}; margin: 0; accent-color: ${y(`--en-color-action`)}; }
  .en-range-row { display: flex; align-items: center; gap: ${y(`--en-space-3`)}; min-inline-size: 0; }
  .en-range-row > .en-range { flex: 1 1 auto; inline-size: 0; }
  .en-range-row[data-editable] { flex-wrap: wrap; }
  .en-range-row > .en-range-editor {
    flex: 0 1 calc(3 * ${y(`--en-size-control-min`)});
    inline-size: calc(3 * ${y(`--en-size-control-min`)});
    min-inline-size: min(100%, ${y(`--en-size-target-min`)});
    font-variant-numeric: tabular-nums;
  }
  /* The value axis alone becomes vertical. Labels, output and number editing
     retain the surrounding writing direction and normal text layout. */
  .en-range-row[data-orientation='vertical'] { flex-direction: column; flex-wrap: nowrap; }
  .en-range-row[data-orientation='vertical'] > .en-range {
    writing-mode: vertical-lr;
    direction: rtl;
    flex: none;
    inline-size: ${b(`--en-slider-length`,y(`--en-size-range-length`))};
    min-inline-size: ${j()};
    block-size: ${j()};
  }
  .en-range-row[data-orientation='vertical'] > .en-range-editor {
    flex: none;
    inline-size: min(100%, calc(3 * ${y(`--en-size-control-min`)}));
  }
  .en-range-error[data-pending] { visibility: hidden; }
  .en-range-row > output { flex: none; font-variant-numeric: tabular-nums; color: ${y(`--en-color-text`)}; }
  ${S(a`.en-checkbox`,a`.en-checkbox:not(:disabled):not([data-press='none']):is(:active, .en-choice:active > .en-checkbox)`,B.checkbox)}
  ${S(a`.en-switch`,a`.en-switch:not(:disabled):not([data-press='none']):is(:active, .en-choice:active > .en-switch)`,B.switch)}
  ${S(a`.en-select`,a`.en-select:not(:disabled):not([data-press='none']):active`,B.select)}
  ${S(a`.en-number-step`,a`.en-number-step:not(:disabled):not([aria-disabled='true']):not([data-press='none']):active`,B[`number-step`])}
  ${ut}
  ${dt}
  ${D(a`.en-number-group > .en-number-input`,{family:`input`,inset:!0,halo:!1})}
  ${D(a`.en-number-group > .en-number-step`,{family:`button`,inset:!0,halo:!1})}
  ${ht}
  @media (any-pointer: coarse) {
    ${N(a`.en-button:not(.en-icon-button), .en-button[data-icon-only], .en-input, .en-textarea, .en-select, .en-number-input, .en-number-step, .en-color-control`,!0)}
    ${He(a`.en-button, .en-control, .en-input, .en-textarea, .en-select, .en-range`)}
    .en-range-row[data-orientation='vertical'] > .en-range { min-inline-size: ${j(!0)}; }
    ${P(a`.en-button:not(.en-icon-button), .en-input, .en-textarea, .en-select`)}
    .en-color-control { block-size: var(--_en-text-control-block-size); }
    ${Ue(a`.en-icon-button, .en-number-step`)}
    .en-number-group > :is(.en-number-input, .en-number-step, button.en-button.en-number-step) { min-block-size: max(calc(var(--_en-text-control-block-size) - 2 * ${V}), ${A(!0)}); }
  }
  @media (prefers-reduced-motion: reduce) { ${We(a`.en-button, .en-switch::before`)} }
  @media (forced-colors: active) {
    ${Ge(a`.en-button, .en-control, .en-input, .en-textarea, .en-select, .en-number-group`)}
    ${vt}
    ${F(a`:is(.en-button, .en-control, .en-input, .en-textarea, .en-select):is(:disabled, [aria-disabled='true']), .en-link[aria-disabled='true']`)}
    ${ze}
    .en-checkbox, .en-switch, .en-range { accent-color: auto; }
    .en-checkbox { background: Canvas; border-color: CanvasText; }
    .en-checkbox:checked, .en-checkbox:indeterminate { background: Canvas; border-color: CanvasText; }
    .en-checkbox::before { border-color: CanvasText; }
    .en-checkbox:disabled { background: Canvas; border-color: GrayText; }
    .en-checkbox:disabled::before { border-color: GrayText; }
    .en-checkbox:focus-visible, .en-switch:focus-visible { outline-color: CanvasText; }
    .en-switch { background: Canvas; border-color: ButtonText; }
    .en-switch::before { background: ButtonText; }
    .en-switch:checked { background: Highlight; border-color: Highlight; }
    .en-switch:checked::before { background: HighlightText; }
  .en-switch:disabled { background: Canvas; border-color: GrayText; }
    :is(.en-checkbox, .en-switch):not(:disabled):active { border-color: Highlight; box-shadow: none; }
  .en-switch:disabled::before { background: GrayText; }
  }
  ${Ne}
`),xt=b(`--en-option-list-radius`,b(`--en-overlay-radius`,y(`--en-radius-container`))),St=a`max(${b(`--en-option-list-padding`,b(`--en-overlay-padding`,y(`--en-space-1`)))}, ${T({family:`option`,inset:!0})})`,Ct=k(a`
  .en-select { min-inline-size: 0; max-inline-size: 100%; white-space: nowrap; text-overflow: ellipsis; }
  .en-select > button { display: none; }
  /* Styling the closed control does not replace its OS picker. Keep this
     fallback outside base-select; ordinary select pseudos are not portable. */
  @supports selector(:has(> .en-select)) {
    @supports not ((appearance: base-select) and selector(::picker(select))) {
      .en-select {
        -webkit-appearance: none;
        appearance: none;
        padding-inline-end: calc(${Z} + ${y(`--en-size-icon`)} + ${y(`--en-space-icon-label`)});
        min-block-size: max(var(--_en-text-control-block-size), calc(${y(`--en-size-icon`)} + 2 * ${y(`--en-space-control-block`)} + 2 * ${y(`--en-border-width`)}));
      }
      .en-field-focus-frame:has(> .en-select)::before {
        content: '';
        position: absolute;
        z-index: 1;
        inset-inline-end: calc(${Z} + ${y(`--en-border-width`)});
        inset-block-start: 50%;
        translate: 0 -50%;
        inline-size: ${y(`--en-size-icon`)};
        block-size: ${y(`--en-size-icon`)};
        color: ${y(`--en-color-text-muted`)};
        background-color: currentColor;
        mask: ${W} center / contain no-repeat;
        pointer-events: none;
      }
      @media (forced-colors: active) {
        .en-field-focus-frame:has(> .en-select)::before { forced-color-adjust: none; color: ButtonText; }
        .en-field-focus-frame:has(> .en-select:disabled)::before { color: GrayText; }
      }
    }
  }
  @supports (appearance: base-select) and selector(::picker(select)) {
    .en-select, .en-select::picker(select) { appearance: ${b(`--en-select-appearance`,a`base-select`)}; }
    .en-select { align-items: center; gap: ${y(`--en-space-icon-label`)}; }
    /* Give the browser-owned label a shrinkable box separate from the caret.
       The implicit select button's anonymous text cannot be truncated reliably. */
    .en-select > button { all: unset; display: block; flex: 1; min-inline-size: 0; }
    .en-select selectedcontent { display: block; min-inline-size: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .en-select::picker(select) {
      padding: ${St};
      border: ${y(`--en-border-width`)} solid ${b(`--en-option-list-border-color`,b(`--en-overlay-border-color`,y(`--en-color-boundary`)))};
      border-radius: ${xt};
      background: ${b(`--en-option-list-background`,b(`--en-overlay-background`,y(`--en-color-surface-raised`)))};
      color: ${b(`--en-option-list-color`,b(`--en-overlay-color`,y(`--en-color-text`)))};
      box-shadow: ${b(`--en-option-list-shadow`,y(`--en-shadow-overlay`))};
      max-block-size: min(${b(`--en-option-list-max-block-size`,b(`--en-overlay-max-block-size`,y(`--en-layout-panel-preferred`)))}, calc(100dvh - ${y(`--en-space-8`)}));
      overflow: auto;
    }
    ${Y(a`.en-select`,a`.en-select:open`,a`.en-select:not(:open)`,`fade`,a`::picker(select)`)}
    .en-select option {
      white-space: normal; overflow-wrap: anywhere;
      position: relative;
      min-block-size: ${j()};
      padding: ${b(`--en-option-block-padding`,y(`--en-space-control-block`))} ${b(`--en-option-inline-padding`,y(`--en-space-control-inline`))};
      border-radius: ${b(`--en-option-radius`,a`max(0px, ${xt} - ${St} - ${y(`--en-border-width`)})`)};
    }
    .en-select option + option { margin-block-start: ${b(`--en-option-list-gap`,a`0px`)}; }
    ${lt({base:a`.en-select option`,selected:a`.en-select option:checked`,hover:a`.en-select option:not(:disabled):hover`,focus:a`.en-select option:not(:disabled):focus-visible`,pressed:a`.en-select option:not(:disabled):active`,disabled:a`.en-select option:disabled`,restBackground:a`transparent`,restColor:b(`--en-option-list-color`,b(`--en-overlay-color`,a`inherit`)),selectedColor:b(`--en-option-list-color`,b(`--en-overlay-color`,y(`--en-color-action-text`))),hoverBackground:y(`--en-color-selected`)})}
    .en-select option:not(:disabled):focus-visible { z-index: 1; }
    @media (hover: hover) { .en-select option:not(:disabled):hover { z-index: 1; } }
    /* Native :active is pressed activation, not the combobox's keyboard candidate. */
    ${O(a`.en-select option:not(:disabled):focus-visible`,{family:`option`,inset:!0,restSelector:a`.en-select option`})}
    @media (hover: hover) { ${O(a`.en-select option:not(:disabled):hover`,{family:`option`,inset:!0,restSelector:a`.en-select option`})} }
    .en-select::picker-icon {
      content: '';
      inline-size: ${y(`--en-size-icon`)};
      block-size: ${y(`--en-size-icon`)};
      flex: none;
      color: ${y(`--en-color-text-muted`)};
      background-color: currentColor;
      mask: ${W} center / contain no-repeat;
    }
    @media (any-pointer: coarse) { .en-select option { min-block-size: ${j(!0)}; } }
    @media (forced-colors: active) {
      .en-select::picker(select) { background: Canvas; color: CanvasText; border-color: ButtonText; box-shadow: none; }
      .en-select option { background: Canvas; color: CanvasText; }
      .en-select option:checked, .en-select option:not(:disabled):focus-visible { background: Highlight; color: HighlightText; outline-color: HighlightText; }
      @media (hover: hover) { .en-select option:not(:disabled):hover { background: Highlight; color: HighlightText; outline-color: HighlightText; } }
      .en-select option:disabled { color: GrayText; }
      /* Keep the decorative mask visible while using the user's system colors. */
      .en-select::picker-icon { forced-color-adjust: none; color: ButtonText; }
      .en-select:disabled::picker-icon { color: GrayText; }
    }
  }
`),wt=k(a`
  .en-field, .en-rating-field { --_en-field-gap: ${b(`--en-field-gap`,y(`--en-space-label-control`))}; }
  .en-field { display: flex; flex-direction: column; min-inline-size: 0; gap: 0; }
  .en-field > :not(:first-child):not(.en-description),
  .en-choice-content > :not(:first-child):not(.en-description) { margin-block-start: var(--_en-field-gap); }
  /* A fieldset legend already separates its first content through its margin. */
  .en-field > .en-legend + :not(.en-description) { margin-block-start: 0; }
  .en-label { display: block; color: ${y(`--en-color-text`)}; font-weight: ${y(`--en-font-label-strong-weight`)}; overflow-wrap: break-word; }
  ${it}
  .en-error { margin: 0; font-size: ${y(`--en-font-ui-size`)}; line-height: ${y(`--en-font-body-line-height`)}; overflow-wrap: break-word; }
  .en-error { color: ${y(`--en-color-danger-text`)}; }
  .en-choice { display: flex; align-items: center; gap: ${y(`--en-space-icon-label`)}; min-block-size: ${j()}; min-inline-size: ${y(`--en-size-target-min`)}; cursor: pointer; }
  .en-choice > :where(.en-label, .en-choice-content) { min-inline-size: 0; }
  .en-choice-content { --_en-field-gap: ${b(`--en-field-gap`,y(`--en-space-control-description`))}; display: flex; flex-direction: column; gap: 0; }
  .en-fieldset { margin: 0; padding: 0; min-inline-size: 0; border: 0; }
  .en-legend { padding: 0; margin-block-end: ${y(`--en-space-label-control`)}; font-weight: ${y(`--en-font-label-strong-weight`)}; }
  .en-form-stack { display: flex; flex-direction: column; gap: ${y(`--en-space-fields`)}; }
  .en-validation-summary { padding: ${y(`--en-space-panel`)}; border: ${y(`--en-border-width`)} solid ${y(`--en-color-danger-text`)}; border-radius: ${y(`--en-radius-container`)}; }
  .en-validation-summary :where(ul, ol) { padding-inline-start: ${y(`--en-space-6`)}; }
  @media (any-pointer: coarse) { .en-choice { min-block-size: ${j(!0)}; min-inline-size: ${A(!0)}; } }
  @media (forced-colors: active) { .en-label, .en-error { color: CanvasText; } .en-validation-summary { border-color: CanvasText; } }
`),Tt=k(a`
  .en-adorned { display:flex !important; align-items:center; border:${V} solid ${b(`--en-input-border-color`,y(`--en-color-boundary`))}; border-radius:${U}; background:${b(`--en-input-background`,y(`--en-color-surface`))}; }
  .en-adorned > input { flex:1; min-inline-size:0; border:0; background:transparent; }
  .en-adorned:has(:focus-visible) { outline:var(--en-input-focus-width, ${y(`--en-focus-width`)}) solid var(--en-input-focus-color, ${y(`--en-color-focus`)}); outline-offset:var(--en-input-focus-offset, ${y(`--en-focus-offset`)}); }
  .en-adorned > input:focus-visible { outline:none; box-shadow:none; }
  .en-adorned[data-invalid] { border-color:var(--en-input-invalid-border-color, ${y(`--en-color-danger-text`)}); }
  .en-adorned slot::slotted(*) { margin-inline:${y(`--en-space-2`)}; }
  ${Me(a`.en-adorned`,a`.en-adorned slot[name='help-action']::slotted(*)`,U,V)}
`);export{Te as A,S as B,Ke as C,M as D,Ae as E,we as F,pe as G,y as H,T as I,u as J,le as K,E as L,De as M,Ee as N,j as O,k as P,D as R,qe as S,je as T,ge as U,b as V,me as W,tt as _,gt as a,Ze as b,ut as c,Y as d,ot as f,$e as g,et as h,Ct as i,ke as j,A as k,lt as l,B as m,bt as n,_t as o,W as p,re as q,wt as r,vt as s,Tt as t,st as u,nt as v,F as w,I as x,Qe as y,O as z};