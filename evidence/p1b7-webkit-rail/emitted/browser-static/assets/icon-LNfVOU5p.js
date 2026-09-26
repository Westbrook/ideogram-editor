function e(e,t){e.inert===t&&(e.inert=!t)}function t(t){let n=t.currentTarget;t.target===n&&(t.newState===`open`&&e(n,!0),queueMicrotask(()=>{if(!n.isConnected)return;let t=n.localName===`dialog`?n.open:n.matches(`:popover-open`);e(n,t)}))}var n=globalThis,r=n.ShadowRoot&&(n.ShadyCSS===void 0||n.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,i=Symbol(),a=new WeakMap,o=class{constructor(e,t,n){if(this._$cssResult$=!0,n!==i)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(r&&e===void 0){let n=t!==void 0&&t.length===1;n&&(e=a.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),n&&a.set(t,e))}return e}toString(){return this.cssText}},s=e=>new o(typeof e==`string`?e:e+``,void 0,i),c=(e,...t)=>new o(e.length===1?e[0]:t.reduce((t,n,r)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if(typeof e==`number`)return e;throw Error(`Value passed to 'css' function must be a 'css' function result: `+e+`. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`)})(n)+e[r+1],e[0]),e,i),l=(e,t)=>{if(r)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let r of t){let t=document.createElement(`style`),i=n.litNonce;i!==void 0&&t.setAttribute(`nonce`,i),t.textContent=r.cssText,e.appendChild(t)}},u=r?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t=``;for(let n of e.cssRules)t+=n.cssText;return s(t)})(e):e,{is:d,defineProperty:f,getOwnPropertyDescriptor:ee,getOwnPropertyNames:te,getOwnPropertySymbols:ne,getPrototypeOf:re}=Object,p=globalThis,ie=p.trustedTypes,ae=ie?ie.emptyScript:``,oe=p.reactiveElementPolyfillSupport,m=(e,t)=>e,se={toAttribute(e,t){switch(t){case Boolean:e=e?ae:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},ce=(e,t)=>!d(e,t),le={attribute:!0,type:String,converter:se,reflect:!1,useDefault:!1,hasChanged:ce};Symbol.metadata??=Symbol(`metadata`),p.litPropertyMetadata??=new WeakMap;var h=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=le){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let n=Symbol(),r=this.getPropertyDescriptor(e,n,t);r!==void 0&&f(this.prototype,e,r)}}static getPropertyDescriptor(e,t,n){let{get:r,set:i}=ee(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:r,set(t){let a=r?.call(this);i?.call(this,t),this.requestUpdate(e,a,n)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??le}static _$Ei(){if(this.hasOwnProperty(m(`elementProperties`)))return;let e=re(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(m(`finalized`)))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(m(`properties`))){let e=this.properties,t=[...te(e),...ne(e)];for(let n of t)this.createProperty(n,e[n])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[e,n]of t)this.elementProperties.set(e,n)}this._$Eh=new Map;for(let[e,t]of this.elementProperties){let n=this._$Eu(e,t);n!==void 0&&this._$Eh.set(n,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let n=new Set(e.flat(1/0).reverse());for(let e of n)t.unshift(u(e))}else e!==void 0&&t.push(u(e));return t}static _$Eu(e,t){let n=t.attribute;return!1===n?void 0:typeof n==`string`?n:typeof e==`string`?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let n of t.keys())this.hasOwnProperty(n)&&(e.set(n,this[n]),delete this[n]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return l(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,n){this._$AK(e,n)}_$ET(e,t){let n=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,n);if(r!==void 0&&!0===n.reflect){let i=(n.converter?.toAttribute===void 0?se:n.converter).toAttribute(t,n.type);this._$Em=e,i==null?this.removeAttribute(r):this.setAttribute(r,i),this._$Em=null}}_$AK(e,t){let n=this.constructor,r=n._$Eh.get(e);if(r!==void 0&&this._$Em!==r){let e=n.getPropertyOptions(r),i=typeof e.converter==`function`?{fromAttribute:e.converter}:e.converter?.fromAttribute===void 0?se:e.converter;this._$Em=r;let a=i.fromAttribute(t,e.type);this[r]=a??this._$Ej?.get(r)??a,this._$Em=null}}requestUpdate(e,t,n,r=!1,i){if(e!==void 0){let a=this.constructor;if(!1===r&&(i=this[e]),n??=a.getPropertyOptions(e),!((n.hasChanged??ce)(i,t)||n.useDefault&&n.reflect&&i===this._$Ej?.get(e)&&!this.hasAttribute(a._$Eu(e,n))))return;this.C(e,t,n)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:n,reflect:r,wrapped:i},a){n&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,a??t??this[e]),!0!==i||a!==void 0)||(this._$AL.has(e)||(this.hasUpdated||n||(t=void 0),this._$AL.set(e,t)),!0===r&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}let e=this.constructor.elementProperties;if(e.size>0)for(let[t,n]of e){let{wrapped:e}=n,r=this[t];!0!==e||this._$AL.has(t)||r===void 0||this.C(t,void 0,n,r)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};h.elementStyles=[],h.shadowRootOptions={mode:`open`},h[m(`elementProperties`)]=new Map,h[m(`finalized`)]=new Map,oe?.({ReactiveElement:h}),(p.reactiveElementVersions??=[]).push(`2.1.2`);var ue=globalThis,de=e=>e,g=ue.trustedTypes,fe=g?g.createPolicy(`lit-html`,{createHTML:e=>e}):void 0,pe=`$lit$`,_=`lit$${Math.random().toFixed(9).slice(2)}$`,me=`?`+_,he=`<${me}>`,v=document,y=()=>v.createComment(``),b=e=>e===null||typeof e!=`object`&&typeof e!=`function`,ge=Array.isArray,_e=e=>ge(e)||typeof e?.[Symbol.iterator]==`function`,ve=`[ 	
\f\r]`,x=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,ye=/-->/g,be=/>/g,S=RegExp(`>|${ve}(?:([^\\s"'>=/]+)(${ve}*=${ve}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,`g`),xe=/'/g,Se=/"/g,Ce=/^(?:script|style|textarea|title)$/i,we=e=>(t,...n)=>({_$litType$:e,strings:t,values:n}),C=we(1),w=we(2),Te=we(3),T=Symbol.for(`lit-noChange`),E=Symbol.for(`lit-nothing`),Ee=new WeakMap,D=v.createTreeWalker(v,129);function De(e,t){if(!ge(e)||!e.hasOwnProperty(`raw`))throw Error(`invalid template strings array`);return fe===void 0?t:fe.createHTML(t)}var Oe=(e,t)=>{let n=e.length-1,r=[],i,a=t===2?`<svg>`:t===3?`<math>`:``,o=x;for(let t=0;t<n;t++){let n=e[t],s,c,l=-1,u=0;for(;u<n.length&&(o.lastIndex=u,c=o.exec(n),c!==null);)u=o.lastIndex,o===x?c[1]===`!--`?o=ye:c[1]===void 0?c[2]===void 0?c[3]!==void 0&&(o=S):(Ce.test(c[2])&&(i=RegExp(`</`+c[2],`g`)),o=S):o=be:o===S?c[0]===`>`?(o=i??x,l=-1):c[1]===void 0?l=-2:(l=o.lastIndex-c[2].length,s=c[1],o=c[3]===void 0?S:c[3]===`"`?Se:xe):o===Se||o===xe?o=S:o===ye||o===be?o=x:(o=S,i=void 0);let d=o===S&&e[t+1].startsWith(`/>`)?` `:``;a+=o===x?n+he:l>=0?(r.push(s),n.slice(0,l)+pe+n.slice(l)+_+d):n+_+(l===-2?t:d)}return[De(e,a+(e[n]||`<?>`)+(t===2?`</svg>`:t===3?`</math>`:``)),r]},ke=class e{constructor({strings:t,_$litType$:n},r){let i;this.parts=[];let a=0,o=0,s=t.length-1,c=this.parts,[l,u]=Oe(t,n);if(this.el=e.createElement(l,r),D.currentNode=this.el.content,n===2||n===3){let e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;(i=D.nextNode())!==null&&c.length<s;){if(i.nodeType===1){if(i.hasAttributes())for(let e of i.getAttributeNames())if(e.endsWith(pe)){let t=u[o++],n=i.getAttribute(e).split(_),r=/([.?@])?(.*)/.exec(t);c.push({type:1,index:a,name:r[2],strings:n,ctor:r[1]===`.`?je:r[1]===`?`?Me:r[1]===`@`?Ne:A}),i.removeAttribute(e)}else e.startsWith(_)&&(c.push({type:6,index:a}),i.removeAttribute(e));if(Ce.test(i.tagName)){let e=i.textContent.split(_),t=e.length-1;if(t>0){i.textContent=g?g.emptyScript:``;for(let n=0;n<t;n++)i.append(e[n],y()),D.nextNode(),c.push({type:2,index:++a});i.append(e[t],y())}}}else if(i.nodeType===8){if(i.data===me)c.push({type:2,index:a});else{let e=-1;for(;(e=i.data.indexOf(_,e+1))!==-1;)c.push({type:7,index:a}),e+=_.length-1}}a++}}static createElement(e,t){let n=v.createElement(`template`);return n.innerHTML=e,n}};function O(e,t,n=e,r){if(t===T)return t;let i=r===void 0?n._$Cl:n._$Co?.[r],a=b(t)?void 0:t._$litDirective$;return i?.constructor!==a&&(i?._$AO?.(!1),a===void 0?i=void 0:(i=new a(e),i._$AT(e,n,r)),r===void 0?n._$Cl=i:(n._$Co??=[])[r]=i),i!==void 0&&(t=O(e,i._$AS(e,t.values),i,r)),t}var Ae=class{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:n}=this._$AD,r=(e?.creationScope??v).importNode(t,!0);D.currentNode=r;let i=D.nextNode(),a=0,o=0,s=n[0];for(;s!==void 0;){if(a===s.index){let t;s.type===2?t=new k(i,i.nextSibling,this,e):s.type===1?t=new s.ctor(i,s.name,s.strings,this,e):s.type===6&&(t=new Pe(i,this,e)),this._$AV.push(t),s=n[++o]}a!==s?.index&&(i=D.nextNode(),a++)}return D.currentNode=v,r}p(e){let t=0;for(let n of this._$AV)n!==void 0&&(n.strings===void 0?n._$AI(e[t]):(n._$AI(e,n,t),t+=n.strings.length-2)),t++}},k=class e{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,n,r){this.type=2,this._$AH=E,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=n,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=O(this,e,t),b(e)?e===E||e==null||e===``?(this._$AH!==E&&this._$AR(),this._$AH=E):e!==this._$AH&&e!==T&&this._(e):e._$litType$===void 0?e.nodeType===void 0?_e(e)?this.k(e):this._(e):this.T(e):this.$(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==E&&b(this._$AH)?this._$AA.nextSibling.data=e:this.T(v.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:n}=e,r=typeof n==`number`?this._$AC(e):(n.el===void 0&&(n.el=ke.createElement(De(n.h,n.h[0]),this.options)),n);if(this._$AH?._$AD===r)this._$AH.p(t);else{let e=new Ae(r,this),n=e.u(this.options);e.p(t),this.T(n),this._$AH=e}}_$AC(e){let t=Ee.get(e.strings);return t===void 0&&Ee.set(e.strings,t=new ke(e)),t}k(t){ge(this._$AH)||(this._$AH=[],this._$AR());let n=this._$AH,r,i=0;for(let a of t)i===n.length?n.push(r=new e(this.O(y()),this.O(y()),this,this.options)):r=n[i],r._$AI(a),i++;i<n.length&&(this._$AR(r&&r._$AB.nextSibling,i),n.length=i)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let t=de(e).nextSibling;de(e).remove(),e=t}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}},A=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,n,r,i){this.type=1,this._$AH=E,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=i,n.length>2||n[0]!==``||n[1]!==``?(this._$AH=Array(n.length-1).fill(new String),this.strings=n):this._$AH=E}_$AI(e,t=this,n,r){let i=this.strings,a=!1;if(i===void 0)e=O(this,e,t,0),a=!b(e)||e!==this._$AH&&e!==T,a&&(this._$AH=e);else{let r=e,o,s;for(e=i[0],o=0;o<i.length-1;o++)s=O(this,r[n+o],t,o),s===T&&(s=this._$AH[o]),a||=!b(s)||s!==this._$AH[o],s===E?e=E:e!==E&&(e+=(s??``)+i[o+1]),this._$AH[o]=s}a&&!r&&this.j(e)}j(e){e===E?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??``)}},je=class extends A{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===E?void 0:e}},Me=class extends A{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==E)}},Ne=class extends A{constructor(e,t,n,r,i){super(e,t,n,r,i),this.type=5}_$AI(e,t=this){if((e=O(this,e,t,0)??E)===T)return;let n=this._$AH,r=e===E&&n!==E||e.capture!==n.capture||e.once!==n.once||e.passive!==n.passive,i=e!==E&&(n===E||r);r&&this.element.removeEventListener(this.name,this,n),i&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH==`function`?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}},Pe=class{constructor(e,t,n){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=n}get _$AU(){return this._$AM._$AU}_$AI(e){O(this,e)}},Fe={M:pe,P:_,A:me,C:1,L:Oe,R:Ae,D:_e,V:O,I:k,H:A,N:Me,U:Ne,B:je,F:Pe},Ie=ue.litHtmlPolyfillSupport;Ie?.(ke,k),(ue.litHtmlVersions??=[]).push(`3.3.3`);var Le=(e,t,n)=>{let r=n?.renderBefore??t,i=r._$litPart$;if(i===void 0){let e=n?.renderBefore??null;r._$litPart$=i=new k(t.insertBefore(y(),e),e,void 0,n??{})}return i._$AI(e),i},Re=globalThis,j=class extends h{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=Le(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return T}};j._$litElement$=!0,j.finalized=!0,Re.litElementHydrateSupport?.({LitElement:j});var ze=Re.litElementPolyfillSupport;ze?.({LitElement:j}),(Re.litElementVersions??=[]).push(`4.2.2`);function Be(e){let t=new Map,n=new Map,r=[],i=new Set,a=e=>{let r=t.get(e.tagName);if(r&&r.elementClass!==e.elementClass)throw Error(`Conflicting constructors for ${e.tagName}.`);if(t.set(e.tagName,e),i.has(e))return;i.add(e);let o=n.get(e.tagName)??new Set;n.set(e.tagName,o);for(let t of e.dependencies??[])o.add(t.tagName),a(t)};for(let t of e)a(t);let o=new Set,s=new Set,c=e=>{if(!(o.has(e)||s.has(e))){s.add(e);for(let t of n.get(e)??[])c(t);s.delete(e),o.add(e),r.push(t.get(e))}};for(let e of t.keys())c(e);return Object.freeze(r)}function Ve(e,t){let n=Be(t),r=new Map;for(let t of n){let n=r.get(t.elementClass);if(n&&n!==t.tagName)throw Error(`One constructor cannot define both ${n} and ${t.tagName}.`);r.set(t.elementClass,t.tagName);let i=e.get(t.tagName);if(i&&i!==t.elementClass)throw Error(`A different version of ${t.tagName} is already registered.`)}for(let t of n)e.get(t.tagName)||e.define(t.tagName,t.elementClass)}function He(e){let t=e,n=e.getRootNode();return`customElementRegistry`in t?t.customElementRegistry:`customElementRegistry`in n?n.customElementRegistry:e.ownerDocument.defaultView?.customElements}var Ue=new WeakMap,We=e=>Ue.get(e)??e.ownerDocument,Ge=e=>{Ue.set(e,e.ownerDocument)},Ke=e=>{Ue.delete(e)},M=`en-internal-registry-initialized`,qe=new WeakMap;function Je(e,t){let n=qe.get(e);n||qe.set(e,n=new Map);let r=n.get(t);return r||(r=new Set,n.set(t,r),Ye(e.whenDefined(t),n,t,r)),r}function Ye(e,t,n,r){e.then(()=>{t.delete(n);for(let e of r)e.target.deref()?.definitionReady(e.epoch);r.clear()})}var Xe=class{host;changed;subscriptions=new Map;epoch=0;documents=new Set;queued=!1;attempted=new WeakSet;constructor(e,t){this.host=e,this.changed=t,e.addController(this)}watch(e){let t=new Set,n=new Set;for(let r of e){if(!r.localName.includes(`-`)||r.matches(`:defined`))continue;let e=He(r);if(!e){e===null&&this.host.isConnected&&n.add(r.ownerDocument);continue}if(e.get(r.localName)){this.attempted.has(r)||(this.attempted.add(r),e.upgrade(r));continue}let i=Je(e,r.localName);if(t.add(i),!this.subscriptions.has(i)){let e={target:new WeakRef(this),epoch:this.epoch};i.add(e),this.subscriptions.set(i,e)}}for(let[e,n]of this.subscriptions)t.has(e)||(e.delete(n),this.subscriptions.delete(e));for(let e of this.documents)n.has(e)||e.removeEventListener(M,this.initialized,!0);for(let e of n)this.documents.has(e)||e.addEventListener(M,this.initialized,!0);this.documents=n}initialized=()=>{this.definitionReady(this.epoch)};definitionReady(e){e===this.epoch&&this.host.isConnected&&!this.queued&&(this.queued=!0,queueMicrotask(()=>{this.queued=!1,e===this.epoch&&this.host.isConnected&&this.changed()}))}hostConnected(){this.definitionReady(this.epoch)}hostDisconnected(){++this.epoch;for(let e of this.documents)e.removeEventListener(M,this.initialized,!0);this.documents.clear();for(let[e,t]of this.subscriptions)e.delete(t);this.subscriptions.clear(),this.queued=!1}},Ze=new WeakMap,Qe=new WeakMap,$e=new WeakMap;function et(e){let t=e.defaultView;if(!t?.customElements)throw Error(`Element scopes require a document with a browser window. Supply the owning browser document explicitly.`);return t}function tt(e,t){if(t.nodeType!==11)throw Error(`Dormant creation accepts only inert template fragments.`);let n=e.createElement(`template`);n.content.append(t.cloneNode(!0));let r=e.createElement(`div`,{customElementRegistry:null});r.innerHTML=n.innerHTML;let i=e.createDocumentFragment();return i.append(...r.childNodes),i}function nt(e){let t=et(e),n=Ze.get(t);if(n)return n;let r={native:!1,importMode:`global`,dormant:!1};try{let n=new t.CustomElementRegistry,i=e.createElement(`div`,{customElementRegistry:n}),a=i.attachShadow({mode:`open`,customElementRegistry:n}),o=`en-registry-capability`,s=t.HTMLElement;class c extends s{}if(i.customElementRegistry!==n||a.customElementRegistry!==n)throw Error(`Registry association unavailable`);if(i.innerHTML=`<${o}></${o}>`,n.define(o,c),n.upgrade(i),!(i.firstElementChild instanceof c))throw Error(`Scoped upgrade unavailable`);let l=e.createElement(`template`);l.innerHTML=`<${o}></${o}>`;let u=`options`;try{let t=e.importNode(l.content,{customElementRegistry:n,selfOnly:!1}),r=e.importNode(l.content,{customElementRegistry:n,selfOnly:!0});if(!(t.firstElementChild instanceof c)||r.childNodes.length)throw Error(`Import options ignored`)}catch{let t=e.implementation.createHTMLDocument();if(n.initialize(t),!(t.importNode(l.content,!0).firstElementChild instanceof c))throw Error(`Scoped import unavailable`);u=`document`}let d=!1;try{let t=tt(e,l.content),r=t.firstElementChild,i=e.createElement(`div`,{customElementRegistry:null});i.append(t),d=i.customElementRegistry===null&&r.customElementRegistry===null&&!(r instanceof c),n.initialize(i),n.upgrade(i),d&&=i.customElementRegistry===n&&r instanceof c}catch{}r={native:!0,importMode:u,dormant:d}}catch{}return r=Object.freeze(r),Ze.set(t,r),r}function N(e,t){if(t===et(e).customElements)return e;let n=nt(e);if(!n.native)throw Error(`Scoped element construction is unavailable in this document.`);if(t===null){if(!n.dormant)throw Error(`Dormant template construction is unavailable; initialize the root before rendering.`);let t=$e.get(e);return t||(t=e.implementation.createHTMLDocument(),t.importNode=((t,n=!1)=>{if(!n)throw Error(`Dormant template imports must be deep.`);return tt(e,t)}),$e.set(e,t)),t}let r=Qe.get(e);r||(r=new WeakMap,Qe.set(e,r));let i=r.get(t);return i||(i=e.implementation.createHTMLDocument(),n.importMode===`options`?i.importNode=((n,r=!1)=>e.importNode(n,{customElementRegistry:t,selfOnly:!r})):t.initialize(i),r.set(t,i)),i}function rt({document:e,registry:t=`auto`}){let n=et(e),r=t===`global`?void 0:nt(e),i=t===`global`?n.customElements:t===`auto`?r.native?new n.CustomElementRegistry:n.customElements:t,a=i!==n.customElements;if(a){if(!r?.native)throw Error(`The explicitly requested registry cannot be used in this document.`);if(e.createElement(`div`,{customElementRegistry:i}).customElementRegistry!==i)throw Error(`The requested registry association was not honored.`)}let o=N(e,i);return Object.freeze({document:e,registry:i,mode:a?`scoped`:`global`,creationScope:o,register:e=>Ve(i,e),createElement:t=>a?e.createElement(t,{customElementRegistry:i}):e.createElement(t),attachShadow(t,r={mode:`open`}){if(t.ownerDocument!==e)throw Error(`The shadow host belongs to another document.`);if(`customElementRegistry`in r&&r.customElementRegistry!==i)throw Error(`The requested shadow registry conflicts with this scope.`);if(t.shadowRoot){if((`customElementRegistry`in t.shadowRoot?t.shadowRoot.customElementRegistry:n.customElements)!==i)throw Error(`The existing shadow root belongs to another registry; initialize a null root explicitly.`);return t.shadowRoot}return t.attachShadow(a?{...r,customElementRegistry:i}:r)},initialize(t){if(t.ownerDocument!==e)throw Error(`The root belongs to another document.`);if(!(`customElementRegistry`in t)){if(!a)return;throw Error(`Registry initialization is unavailable.`)}if(t.customElementRegistry!==null&&t.customElementRegistry!==i)throw Error(`Cannot rebind a root that already belongs to another registry.`);if(typeof i.initialize!=`function`){if(t.customElementRegistry===i)return;throw Error(`Registry initialization is unavailable.`)}i.initialize(t),t.dispatchEvent(new n.Event(M,{bubbles:!0,composed:!0})),t.isConnected||e.dispatchEvent(new n.Event(M))},get:e=>i.get(e),whenDefined:e=>i.whenDefined(e),upgrade:e=>i.upgrade(e)})}var it=`data-en-static-styles`,at=new WeakMap,ot=new WeakMap;function st(e){let t=e.constructor;if(at.has(t))return at.get(t);let n=t.elementStyles,r=n.length>0&&n.every(e=>`cssText`in e&&typeof e.cssText==`string`&&!/@(?:import|namespace)\b/i.test(e.cssText))?n:null;return at.set(t,r),r}var ct=class{#e;#t=!1;#n;#r;#i;#a;#o=[];#s=``;constructor(e){this.#e=e,e.addController(this)}hostConnected(){if(this.#i&&this.#i!==this.#e.ownerDocument){this.#l();return}if(this.#t)return;let e=this.#e.shadowRoot,t=e?.firstElementChild;e&&t?.localName===`style`&&t.getAttribute(`data-en-static-styles`)===`v1`&&(this.#r=e,this.#n=t)}hostUpdated(){if(this.#t)return;this.#t=!0;let e=this.#e.renderRoot;if(!this.#n&&e&&`adoptedStyleSheets`in e&&e.adoptedStyleSheets.length){let t=st(this.#e);t&&(this.#r=e,this.#i=this.#e.ownerDocument,this.#a=t,this.#o=t.map(e=>e.styleSheet).filter(e=>!!e))}this.#e.updateComplete.then(()=>this.#c(),()=>{this.#n=void 0})}#c(){let e=this.#r,t=this.#n;if(this.#n=void 0,!r||!e||e!==this.#e.shadowRoot||!t||t.parentNode!==e||t.getAttribute(`data-en-static-styles`)!==`v1`||!(`adoptedStyleSheets`in e)||[...e.querySelectorAll(`style, link[rel~="stylesheet" i]`)].some(e=>e!==t)||t.getAttributeNames().some(e=>e!==`data-en-static-styles`&&e!==`nonce`)||!t.sheet||t.sheet.disabled)return;let n=st(this.#e);if(!n)return;let i=[...e.adoptedStyleSheets];try{let t=n.map(e=>e.styleSheet);if(t.some(e=>e===void 0))return;let r=t.filter(e=>!i.includes(e));e.adoptedStyleSheets=[...r,...i],this.#o=r}catch{try{e.adoptedStyleSheets=i}catch{}return}this.#i=this.#e.ownerDocument,this.#a=n,this.#s=t.nonce,t.remove()}#l(){let e=this.#r,t=this.#a;if(!e||e!==this.#e.renderRoot||!t)return;let n=ot.get(t);n===void 0&&(n=t.map(e=>e.cssText).join(``),ot.set(t,n));let r=this.#e.ownerDocument.createElement(`style`);r.setAttribute(it,`v1`),this.#s&&(r.nonce=this.#s),r.textContent=n,e.insertBefore(r,e.firstChild);try{e.adoptedStyleSheets=e.adoptedStyleSheets.filter(e=>!this.#o.includes(e))}catch{}this.#i=void 0,this.#a=void 0,this.#o=[]}};function lt(e){return e===`inherit`||e===`small`||e===`large`?e:`medium`}var ut=class extends j{#e;#t;getRenderRegistry(){return this.constructor.shadowRootOptions.customElementRegistry}attachShadow(e){if(this.#e!==void 0&&`customElementRegistry`in e&&e.customElementRegistry!==this.#e)throw Error(`Conflicting explicit shadow registry options.`);return this.#t=super.attachShadow(this.#e===void 0?e:{...e,customElementRegistry:this.#e})}createRenderRoot(){let e=this.getRenderRegistry(),t=this.shadowRoot,n=t&&`customElementRegistry`in t?t.customElementRegistry:void 0;if(t&&e!==void 0&&e!==(n===void 0?this.ownerDocument?.defaultView?.customElements:n))throw Error(`The explicitly requested render registry conflicts with the existing shadow root.`);let r=t&&n!==void 0?n:e===void 0?He(this):e;r!==void 0&&this.ownerDocument?.defaultView&&(this.renderOptions.creationScope=N(this.ownerDocument,r),this.#e=r);try{return super.createRenderRoot()}catch(e){let t=this.shadowRoot??this.#t,n=this.ownerDocument.defaultView,r=this.constructor.elementStyles;if(e.name!==`NotAllowedError`||!t||!n||n.HTMLElement.prototype.isPrototypeOf(this)||!r.every(e=>`cssText`in e))throw e;let i=this.ownerDocument.createElement(`style`);i.textContent=r.map(e=>`cssText`in e?e.cssText:``).join(``);let a=globalThis.litNonce;return a&&(i.nonce=a),t.append(i),this.renderOptions.renderBefore??=t.firstChild,t}}update(e){this.#e===null&&this.renderRoot?.customElementRegistry&&(this.#e=this.renderRoot.customElementRegistry,this.renderOptions.creationScope=N(this.ownerDocument,this.#e)),super.update(e)}connectedCallback(){Ge(this),super.connectedCallback()}disconnectedCallback(){super.disconnectedCallback(),Ke(this)}adoptedCallback(){let e=this.renderRoot;if(e&&this.ownerDocument.defaultView){let t=`customElementRegistry`in e?e.customElementRegistry:He(this);t!==void 0&&(this.#e=t,this.renderOptions.creationScope=N(this.ownerDocument,t))}}staticStyles=new ct(this);static properties={size:{reflect:!0,useDefault:!0,noAccessor:!0,converter:{fromAttribute:lt,toAttribute:lt}}};#n=`medium`;get size(){return this.#n}set size(e){let t=this.#n,n=lt(e);this.#n=n;let r=this.getAttribute(`size`)===n?void 0:Object.assign(Object.create(this.constructor.getPropertyOptions(`size`)),{hasChanged:()=>!0});this.requestUpdate(`size`,t,r)}},P=new WeakMap;function F(e,t,n,r){return new((e.ownerDocument?.defaultView?.CustomEvent)??globalThis.CustomEvent)(t,{detail:n,bubbles:!0,composed:!0,cancelable:r})}function dt(e,t,n={}){if(Object.is(t.previous,t.proposed))return`unchanged`;let r=Object.freeze({...n.extraDetail,previous:t.previous,proposed:t.proposed,reason:t.reason}),i=F(e,n.eventName??`en-change`,r,!0),a={authorRevision:t.getRevision(),acceptedEpoch:P.get(e)?.acceptedEpoch??0},o=P.get(e);o||(o={acceptedEpoch:0,frames:[]},P.set(e,o));let s=o;s.frames.push(a);let c=!1,l=()=>s.frames[s.frames.length-1]===a&&t.getRevision()===a.authorRevision&&s.acceptedEpoch===a.acceptedEpoch,u=()=>{c=!0,t.rollback(t.previous)};try{if(t.stage(t.proposed),!l())return c=!0,`superseded`;let n=e.dispatchEvent(i);if(!l())return c=!0,`superseded`;if(!n)return u(),`canceled`;let r=t.canCommit?.(t.proposed)??!0;if(r||i.preventDefault(),!l())return c=!0,`superseded`;if(!r)return u(),`canceled`;s.acceptedEpoch+=1;let o=s.acceptedEpoch;return c=!0,t.commit?.(t.proposed),t.getRevision()!==a.authorRevision||s.acceptedEpoch!==o?`superseded`:`committed`}catch(e){if(!c&&l())try{u()}catch(t){throw AggregateError([e,t],`Change transaction and its rollback both failed.`)}throw e}finally{s.frames.pop(),s.frames.length===0&&P.delete(e)}}function ft(e,t,{cancelable:n=!1}={}){return e.dispatchEvent(F(e,`en-action`,Object.freeze({...t}),n))}function pt(e,t){e.dispatchEvent(F(e,`en-input`,Object.freeze({...t}),!1))}function mt(e,t,n){e.dispatchEvent(F(e,t,Object.freeze({...n}),!1))}var ht=Object.freeze({"--en-border-invalid-width":`2px`,"--en-border-width":`1px`,"--en-calendar-hover-opacity":`0.1`,"--en-calendar-pressed-opacity":`0.16`,"--en-palette-accent":`rgb(36 87 214 / 1)`,"--en-palette-action":`rgb(36 87 214 / 1)`,"--en-color-action":`rgb(36 87 214 / 1)`,"--en-palette-surface":`rgb(255 255 255 / 1)`,"--en-color-surface":`rgb(255 255 255 / 1)`,"--en-color-accent-border":`rgb(181.65277272 203.4391786 246.40882708 / 1)`,"--en-color-accent-subtle":`rgb(227.10943415 235.68356672 252.33563096 / 1)`,"--en-palette-emphasis":`rgb(0 0 0 / 1)`,"--en-color-action-hover":`rgb(31.04856826 77.00062118 191.430243 / 1)`,"--en-color-action-pressed":`rgb(26.20372458 67.21650774 169.34637937 / 1)`,"--en-color-action-text":`rgb(36 87 214 / 1)`,"--en-palette-boundary":`rgb(123 135 152 / 1)`,"--en-color-boundary":`rgb(123 135 152 / 1)`,"--en-color-brand":`rgb(36 87 214 / 1)`,"--en-palette-canvas":`rgb(247 248 250 / 1)`,"--en-color-canvas":`rgb(247 248 250 / 1)`,"--en-palette-danger-text":`rgb(180 35 24 / 1)`,"--en-color-danger-text":`rgb(180 35 24 / 1)`,"--en-palette-focus":`rgb(36 87 214 / 1)`,"--en-color-focus":`rgb(36 87 214 / 1)`,"--en-color-focus-halo":`rgb(36 87 214 / 1)`,"--en-palette-line":`rgb(214 220 228 / 1)`,"--en-color-line":`rgb(214 220 228 / 1)`,"--en-color-link":`rgb(36 87 214 / 1)`,"--en-palette-foreground-dark":`rgb(16 27 57 / 1)`,"--en-palette-foreground-light":`rgb(255 255 255 / 1)`,"--en-color-on-action":`rgb(255 255 255 / 1)`,"--en-color-on-brand":`rgb(255 255 255 / 1)`,"--en-color-scrim":`rgb(0 0 0 / 0.45)`,"--en-palette-selected":`rgb(231 238 255 / 1)`,"--en-color-selected":`rgb(231 238 255 / 1)`,"--en-palette-success-text":`rgb(20 108 67 / 1)`,"--en-color-success-text":`rgb(20 108 67 / 1)`,"--en-palette-surface-raised":`rgb(255 255 255 / 1)`,"--en-color-surface-raised":`rgb(255 255 255 / 1)`,"--en-palette-surface-subtle":`rgb(238 241 245 / 1)`,"--en-color-surface-subtle":`rgb(238 241 245 / 1)`,"--en-palette-text":`rgb(27 31 36 / 1)`,"--en-color-text":`rgb(27 31 36 / 1)`,"--en-palette-text-muted":`rgb(86 97 113 / 1)`,"--en-color-text-muted":`rgb(86 97 113 / 1)`,"--en-palette-warning-text":`rgb(138 75 5 / 1)`,"--en-color-warning-text":`rgb(138 75 5 / 1)`,"--en-duration-press":`80ms`,"--en-motion-press-offset":`0px`,"--en-motion-press-scale":`1`,"--en-shadow-none":`0px 0px 0px 0px rgb(0 0 0 / 0)`,"--en-duration-release":`80ms`,"--en-rhythm-base":`0.25rem`,"--en-space-3":`0.75rem`,"--en-space-4":`1rem`,"--en-radius-container":`1rem`,"--en-focus-halo-width":`0px`,"--en-focus-offset":`2px`,"--en-focus-width":`2px`,"--en-space-control-inline":`0.75rem`,"--en-radius-control":`0.5rem`,"--en-size-icon":`1.125rem`,"--en-space-12":`3rem`,"--en-space-2":`0.5rem`,"--en-space-6":`1.5rem`,"--en-size-control-min":`2.5rem`,"--en-duration-immediate":`0ms`,"--en-duration-enter":`0ms`,"--en-ease-standard":`cubic-bezier(0.2, 0, 0, 1)`,"--en-ease-enter":`cubic-bezier(0.2, 0, 0, 1)`,"--en-duration-exit":`0ms`,"--en-ease-exit":`cubic-bezier(0.2, 0, 0, 1)`,"--en-space-0-5":`0.125rem`,"--en-space-1":`0.25rem`,"--en-space-1-5":`0.375rem`,"--en-space-8":`2rem`,"--en-focus-accent-width":`0px`,"--en-size-navigation-indicator":`0px`,"--en-space-0":`0rem`,"--en-layout-panel-preferred":`20rem`,"--en-shadow-overlay":`0px 4px 16px 0px rgb(0 0 0 / 0.18)`,"--en-space-control-block":`0.375rem`,"--en-focus-inset-offset":`-2px`,"--en-font-ui-weight":`400`,"--en-font-label-strong-weight":`600`,"--en-space-actions":`0.375rem`,"--en-space-panel":`1.5rem`,"--en-size-switch-block":`1.5rem`,"--en-size-switch-inline":`2.5rem`,"--en-size-switch-thumb":`1rem`,"--en-duration-fast":`120ms`,"--en-duration-focus-enter":`0ms`,"--en-duration-focus-exit":`0ms`,"--en-duration-regular":`180ms`,"--en-duration-slow":`240ms`,"--en-duration-spin":`800ms`,"--en-ease-focus-enter":`cubic-bezier(0.2, 0, 0, 1)`,"--en-ease-focus-exit":`cubic-bezier(0.2, 0, 0, 1)`,"--en-focus-scroll-margin-block":`1rem`,"--en-focus-scroll-margin-inline":`1rem`,"--en-font-body-family":`system-ui, sans-serif`,"--en-font-body-line-height":`1.5`,"--en-font-body-size":`1rem`,"--en-size-type-scale-large":`1.125`,"--en-font-body-size-large":`1.125rem`,"--en-size-type-scale-medium":`1`,"--en-font-body-size-medium":`1rem`,"--en-size-type-scale-small":`0.9375`,"--en-font-body-size-small":`0.9375rem`,"--en-font-body-style":`normal`,"--en-font-body-tracking":`0px`,"--en-font-body-weight":`400`,"--en-font-code-family":`ui-monospace, monospace`,"--en-font-data-family":`system-ui, sans-serif`,"--en-font-data-line-height":`1.5`,"--en-font-data-size":`0.875rem`,"--en-font-data-size-large":`0.984375rem`,"--en-font-data-size-medium":`0.875rem`,"--en-font-data-size-small":`0.8203125rem`,"--en-font-data-style":`normal`,"--en-font-data-tracking":`0px`,"--en-font-data-weight":`400`,"--en-font-heading-large-family":`system-ui, sans-serif`,"--en-font-heading-large-line-height":`1.2`,"--en-font-heading-large-size":`2rem`,"--en-font-heading-large-size-large":`2.25rem`,"--en-font-heading-large-size-medium":`2rem`,"--en-font-heading-large-size-small":`1.875rem`,"--en-font-heading-large-style":`normal`,"--en-font-heading-large-tracking":`0px`,"--en-font-heading-large-weight":`600`,"--en-font-heading-medium-family":`system-ui, sans-serif`,"--en-font-heading-medium-line-height":`1.3`,"--en-font-heading-medium-size":`1.5rem`,"--en-font-heading-medium-size-large":`1.6875rem`,"--en-font-heading-medium-size-medium":`1.5rem`,"--en-font-heading-medium-size-small":`1.40625rem`,"--en-font-heading-medium-style":`normal`,"--en-font-heading-medium-tracking":`0px`,"--en-font-heading-medium-weight":`600`,"--en-font-heading-small-family":`system-ui, sans-serif`,"--en-font-heading-small-line-height":`1.4`,"--en-font-heading-small-size":`1.125rem`,"--en-font-heading-small-size-large":`1.265625rem`,"--en-font-heading-small-size-medium":`1.125rem`,"--en-font-heading-small-size-small":`1.0546875rem`,"--en-font-heading-small-style":`normal`,"--en-font-heading-small-tracking":`0px`,"--en-font-heading-small-weight":`600`,"--en-font-ui-family":`system-ui, sans-serif`,"--en-font-input-family":`system-ui, sans-serif`,"--en-font-ui-line-height":`1.5`,"--en-font-input-line-height":`1.5`,"--en-font-ui-size":`1rem`,"--en-font-input-size":`1rem`,"--en-font-input-size-large":`1.125rem`,"--en-font-input-size-medium":`1rem`,"--en-font-input-size-small":`1rem`,"--en-font-ui-style":`normal`,"--en-font-input-style":`normal`,"--en-font-ui-tracking":`0px`,"--en-font-input-tracking":`0px`,"--en-font-input-weight":`400`,"--en-font-label-strong-family":`system-ui, sans-serif`,"--en-font-label-strong-line-height":`1.5`,"--en-font-label-strong-size":`1rem`,"--en-font-label-strong-style":`normal`,"--en-font-label-strong-tracking":`0px`,"--en-font-metadata-family":`system-ui, sans-serif`,"--en-font-metadata-line-height":`1.5`,"--en-font-metadata-size":`0.8125rem`,"--en-font-metadata-size-large":`0.9140625rem`,"--en-font-metadata-size-medium":`0.8125rem`,"--en-font-metadata-size-small":`0.8125rem`,"--en-font-metadata-style":`normal`,"--en-font-metadata-tracking":`0px`,"--en-font-metadata-weight":`400`,"--en-font-ui-size-large":`1.125rem`,"--en-font-ui-size-medium":`1rem`,"--en-font-ui-size-small":`1rem`,"--en-layout-article-max":`48rem`,"--en-layout-dialog-collapse":`48rem`,"--en-layout-form-max":`28rem`,"--en-size-scale-large":`1.25`,"--en-layout-form-max-large":`35rem`,"--en-size-scale-medium":`1`,"--en-layout-form-max-medium":`28rem`,"--en-size-scale-small":`0.875`,"--en-layout-form-max-small":`24.5rem`,"--en-layout-panel-preferred-large":`25rem`,"--en-layout-panel-preferred-medium":`20rem`,"--en-layout-panel-preferred-small":`17.5rem`,"--en-layout-prose-max":`66ch`,"--en-motion-surface-offset":`0px`,"--en-motion-surface-scale":`1`,"--en-palette-on-action":`rgb(255 255 255 / 1)`,"--en-radius-choice":`2px`,"--en-radius-choice-large":`2.5px`,"--en-radius-choice-medium":`2px`,"--en-radius-choice-small":`1.75px`,"--en-radius-container-large":`1.25rem`,"--en-radius-container-medium":`1rem`,"--en-radius-container-small":`0.875rem`,"--en-radius-control-large":`0.625rem`,"--en-radius-control-medium":`0.5rem`,"--en-radius-control-small":`0.4375rem`,"--en-radius-dialog":`1.25rem`,"--en-radius-dialog-large":`1.5625rem`,"--en-radius-dialog-medium":`1.25rem`,"--en-radius-dialog-small":`1.09375rem`,"--en-radius-pill":`9999px`,"--en-shadow-dialog":`0px 12px 40px 0px rgb(0 0 0 / 0.18)`,"--en-size-avatar":`2.5rem`,"--en-size-avatar-large":`3.125rem`,"--en-size-avatar-medium":`2.5rem`,"--en-size-avatar-small":`2.1875rem`,"--en-size-choice-dot":`8px`,"--en-size-choice-dot-large":`10px`,"--en-size-choice-dot-medium":`8px`,"--en-size-choice-dot-small":`7px`,"--en-size-choice-mark-block":`10px`,"--en-size-choice-mark-block-large":`12.5px`,"--en-size-choice-mark-block-medium":`10px`,"--en-size-choice-mark-block-small":`8.75px`,"--en-size-choice-mark-inline":`6px`,"--en-size-choice-mark-inline-large":`7.5px`,"--en-size-choice-mark-inline-medium":`6px`,"--en-size-choice-mark-inline-small":`5.25px`,"--en-size-choice-mark-stroke":`2px`,"--en-size-control-large":`3.125rem`,"--en-size-control-medium":`2.5rem`,"--en-size-control-small":`2.1875rem`,"--en-size-icon-large":`1.40625rem`,"--en-size-icon-medium":`1.125rem`,"--en-size-icon-small":`0.984375rem`,"--en-size-icon-stroke":`1.5px`,"--en-size-progress":`0.5rem`,"--en-size-progress-large":`0.625rem`,"--en-size-progress-medium":`0.5rem`,"--en-size-progress-small":`0.4375rem`,"--en-size-quote-border":`2px`,"--en-size-range-length":`12rem`,"--en-size-range-track":`4px`,"--en-size-range-track-large":`5px`,"--en-size-range-track-medium":`4px`,"--en-size-range-track-small":`3.5px`,"--en-size-skeleton-line":`1rem`,"--en-size-skeleton-line-large":`1.25rem`,"--en-size-skeleton-line-medium":`1rem`,"--en-size-skeleton-line-small":`0.875rem`,"--en-size-spinner":`1.25rem`,"--en-size-spinner-large":`1.5625rem`,"--en-size-spinner-medium":`1.25rem`,"--en-size-spinner-small":`1.09375rem`,"--en-size-spinner-stroke":`2px`,"--en-size-target-min":`24px`,"--en-size-splitter":`24px`,"--en-size-splitter-large":`30px`,"--en-size-splitter-medium":`24px`,"--en-size-splitter-small":`21px`,"--en-size-swatch":`4rem`,"--en-size-swatch-large":`5rem`,"--en-size-swatch-medium":`4rem`,"--en-size-swatch-small":`3.5rem`,"--en-size-switch-block-large":`1.875rem`,"--en-size-switch-block-medium":`1.5rem`,"--en-size-switch-block-small":`1.3125rem`,"--en-size-switch-inline-large":`3.125rem`,"--en-size-switch-inline-medium":`2.5rem`,"--en-size-switch-inline-small":`2.1875rem`,"--en-size-switch-thumb-large":`1.25rem`,"--en-size-switch-thumb-medium":`1rem`,"--en-size-switch-thumb-small":`0.875rem`,"--en-size-tab-indicator":`2px`,"--en-size-target-touch":`2.75rem`,"--en-space-16":`4rem`,"--en-space-2-5":`0.625rem`,"--en-space-5":`1.25rem`,"--en-space-actions-large":`0.46875rem`,"--en-space-actions-medium":`0.375rem`,"--en-space-actions-small":`0.328125rem`,"--en-space-badge-block":`0.125rem`,"--en-space-badge-block-large":`0.15625rem`,"--en-space-badge-block-medium":`0.125rem`,"--en-space-badge-block-small":`0.109375rem`,"--en-space-badge-inline":`0.5rem`,"--en-space-badge-inline-large":`0.625rem`,"--en-space-badge-inline-medium":`0.5rem`,"--en-space-badge-inline-small":`0.4375rem`,"--en-space-control-block-large":`0.46875rem`,"--en-space-control-block-medium":`0.375rem`,"--en-space-control-block-small":`0.328125rem`,"--en-space-control-description":`0.375rem`,"--en-space-control-description-large":`0.46875rem`,"--en-space-control-description-medium":`0.375rem`,"--en-space-control-description-small":`0.328125rem`,"--en-space-control-inline-large":`0.9375rem`,"--en-space-control-inline-medium":`0.75rem`,"--en-space-control-inline-small":`0.65625rem`,"--en-space-fields":`1.5rem`,"--en-space-fields-large":`1.875rem`,"--en-space-fields-medium":`1.5rem`,"--en-space-fields-small":`1.3125rem`,"--en-space-icon-label":`0.5rem`,"--en-space-icon-label-large":`0.625rem`,"--en-space-icon-label-medium":`0.5rem`,"--en-space-icon-label-small":`0.4375rem`,"--en-space-label-control":`0.5rem`,"--en-space-label-control-large":`0.625rem`,"--en-space-label-control-medium":`0.5rem`,"--en-space-label-control-small":`0.4375rem`,"--en-space-panel-large":`1.875rem`,"--en-space-panel-medium":`1.5rem`,"--en-space-panel-small":`1.3125rem`,"--en-space-rows":`0.75rem`,"--en-space-rows-large":`0.9375rem`,"--en-space-rows-medium":`0.75rem`,"--en-space-rows-small":`0.65625rem`,"--en-space-sections":`2rem`,"--en-space-sections-large":`2.5rem`,"--en-space-sections-medium":`2rem`,"--en-space-sections-small":`1.75rem`,"--en-space-switch-inset":`0.1875rem`,"--en-space-switch-inset-large":`0.234375rem`,"--en-space-switch-inset-medium":`0.1875rem`,"--en-space-switch-inset-small":`0.1640625rem`});function gt(e){if(!Object.hasOwn(ht,e))throw RangeError(`Unknown token `+e);return ht[e]}var _t=Object.freeze([`small`,`medium`,`large`]);Object.freeze({small:.875,medium:1,large:1.25}),Object.freeze({small:.9375,medium:1,large:1.125});var vt=Object.freeze({"size.control":`size.control-min`,"size.icon":`size.icon`,"size.avatar":`size.avatar`,"size.swatch":`size.swatch`,"size.spinner":`size.spinner`,"size.progress":`size.progress`,"size.skeleton-line":`size.skeleton-line`,"size.splitter":`size.splitter`,"size.switch-inline":`size.switch-inline`,"size.switch-block":`size.switch-block`,"size.switch-thumb":`size.switch-thumb`,"size.choice-mark-inline":`size.choice-mark-inline`,"size.choice-mark-block":`size.choice-mark-block`,"size.choice-dot":`size.choice-dot`,"size.range-track":`size.range-track`,"space.switch-inset":`space.switch-inset`,"space.control-inline":`space.control-inline`,"space.control-block":`space.control-block`,"space.panel":`space.panel`,"space.rows":`space.rows`,"space.actions":`space.actions`,"space.fields":`space.fields`,"space.sections":`space.sections`,"space.icon-label":`space.icon-label`,"space.label-control":`space.label-control`,"space.control-description":`space.control-description`,"space.badge-inline":`space.badge-inline`,"space.badge-block":`space.badge-block`,"radius.control":`radius.control`,"radius.container":`radius.container`,"radius.dialog":`radius.dialog`,"radius.choice":`radius.choice`,"layout.form-max":`layout.form-max`,"layout.panel-preferred":`layout.panel-preferred`,"font.ui.size":`font.ui.size`,"font.input.size":`font.input.size`,"font.data.size":`font.data.size`,"font.metadata.size":`font.metadata.size`,"font.body.size":`font.body.size`,"font.heading-small.size":`font.heading-small.size`,"font.heading-medium.size":`font.heading-medium.size`,"font.heading-large.size":`font.heading-large.size`}),yt=Object.freeze(Object.entries(vt).map(([e,t])=>Object.freeze({role:`--en-${e.replaceAll(`.`,`-`)}`,base:`--en-${t.replaceAll(`.`,`-`)}`,variants:Object.freeze(Object.fromEntries(_t.map(t=>[t,`--en-${e.replaceAll(`.`,`-`)}-${t}`])))})));function bt(e){let t=gt(e);if(!t)throw Error(`Missing stylesheet token default: ${e}`);return`var(${e}, ${t})`}var xt=new Map(yt.map(({base:e,role:t})=>[e,`--_en-sized-${t.slice(5)}`]));function St(e){let t=bt(e),n=xt.get(e);return n?`var(${n}, ${t})`:t}function Ct(e){return s(bt(e))}function I(e){return s(St(e))}function L(e,t){return c`var(${s(e)}, ${t})`}var wt=c`scale var(--_en-press-duration, 0ms) ${I(`--en-ease-standard`)}, translate var(--_en-press-duration, 0ms) ${I(`--en-ease-standard`)}`;function Tt(e,t,n){return c`
    ${e} { --_en-press-duration: clamp(0ms, ${n.release}, 200ms); }
    ${t} { scale: clamp(.9, ${n.scale}, 1); translate: 0 clamp(-2px, ${n.offset}, 2px); --_en-press-duration: clamp(0ms, ${n.press}, 200ms); }
    :host([data-press='none']) ${e} { scale: none !important; translate: none !important; }
    @media (prefers-reduced-motion: reduce) { ${e} { scale: none !important; translate: none !important; transition: none !important; } }
  `}function R(e,t,n){return c`
    ${e} { --_en-press-shadow: 0 0 0 0 transparent; box-shadow: var(--_en-press-shadow); transition: ${wt}; }
    ${t} { ${n.paint} --_en-press-shadow: ${n.shadow}; }
    ${Tt(e,t,n)}
    @media (forced-colors: active) { ${t} { background-color: Highlight; color: HighlightText; box-shadow: none; } }
  `}function z(e,t,n){return e?L(`--en-${e}-focus-${t}`,n):n}function Et(e){let t=z(e.family,`width`,I(`--en-focus-width`));return{width:t,offset:z(e.family,`offset`,e.inset?c`calc(0px - ${t})`:I(`--en-focus-offset`)),color:z(e.family,`color`,I(`--en-color-focus`)),haloWidth:e.halo===!1?c`0px`:z(e.family,`halo-width`,I(`--en-focus-halo-width`)),haloColor:z(e.family,`halo-color`,I(`--en-color-focus-halo`))}}function B(e={}){let t=Et(e);return c`max(0px, calc(${t.width} + ${t.offset}), ${t.haloWidth})`}var Dt=c`max(${B()}, ${B({family:`button`})}, ${B({family:`input`})}, ${B({family:`option`,inset:!0})}, ${B({family:`overlay`})})`;function Ot(e,t={}){return c`${e} {
    scroll-margin-block: max(${I(`--en-focus-scroll-margin-block`)}, ${B(t)});
    scroll-margin-inline: max(${I(`--en-focus-scroll-margin-inline`)}, ${B(t)});
  }`}function V(e,t={}){return H(c`${e}:focus-visible`,{...t,restSelector:t.restSelector??e})}function H(e,t={}){let n=Et(t),r=t.restSelector,i=r&&t.halo!==!1,a=t.baseShadow??c`var(--_en-press-shadow, 0 0 0 0 transparent)`,o=c`${t.baseTransitions??wt},`;return c`
    ${r?Ot(r,t):c``}
    ${i?c`${r} {
      box-shadow: 0 0 0 0 ${n.haloColor}, ${a};
      transition: ${o} box-shadow ${I(`--en-duration-focus-exit`)} ${I(`--en-ease-focus-exit`)};
    }`:c``}
    ${e} {
      outline: ${n.width} solid ${n.color};
      outline-offset: ${n.offset};
      box-shadow: 0 0 0 ${n.haloWidth} ${n.haloColor}, ${a};
      ${i?c`transition: ${o} box-shadow ${I(`--en-duration-focus-enter`)} ${I(`--en-ease-focus-enter`)};`:c``}
    }
    ${i?c`@media (prefers-reduced-motion: reduce) {
      ${r}, ${e} { transition: none; }
    }`:c``}
    @media (forced-colors: active) {
      ${e} { outline-color: Highlight; box-shadow: none; }
      ${i?c`${r}, ${e} { box-shadow: none; transition: none; }`:c``}
    }
  `}function U(e){let t=yt.filter(({role:t})=>e.cssText.includes(`var(--_en-sized-${t.slice(5)},`)).map(({role:e,variants:t})=>`--_en-sized-${e.slice(5)}: calc(${Ct(t.small).cssText} * var(--_en-size-small, 0) + ${Ct(t.medium).cssText} * var(--_en-size-medium, 1) + ${Ct(t.large).cssText} * var(--_en-size-large, 0));`).join(`
`);return t?c`:host, .en-foundation { ${s(t)} } ${e}`:e}var kt=U(c`.en-body, .en-prose, .en-heading-small, .en-heading-medium, .en-heading-large, .en-metadata, .en-data {
  margin: 0;
  overflow-wrap: break-word;
}
.en-body, .en-prose {
  color: var(--en-color-text, rgb(27 31 36 / 1));
    font: var(--en-font-body-weight, 400) var(--_en-sized-font-body-size, var(--en-font-body-size, 1rem)) / var(--en-font-body-line-height, 1.5) var(--en-font-body-family, system-ui, sans-serif);
  font-style: var(--en-font-body-style, normal);
  letter-spacing: var(--en-font-body-tracking, 0px);
}
.en-prose {
  max-inline-size: var(--en-prose-max-inline-size, var(--en-layout-prose-max, 66ch));
}
.en-prose :where(p, ul, ol, dl, blockquote) { margin-block: 0 var(--en-space-4, 1rem); }
.en-prose :where(ul, ol) { padding-inline-start: var(--en-space-6, 1.5rem); }
.en-heading-small {
    font: var(--en-font-heading-small-weight, 600) var(--_en-sized-font-heading-small-size, var(--en-font-heading-small-size, 1.125rem)) / var(--en-font-heading-small-line-height, 1.4) var(--en-font-heading-small-family, system-ui, sans-serif);
  font-style: var(--en-font-heading-small-style, normal);
  letter-spacing: var(--en-font-heading-small-tracking, 0px);
}
.en-heading-medium {
    font: var(--en-font-heading-medium-weight, 600) var(--_en-sized-font-heading-medium-size, var(--en-font-heading-medium-size, 1.5rem)) / var(--en-font-heading-medium-line-height, 1.3) var(--en-font-heading-medium-family, system-ui, sans-serif);
  font-style: var(--en-font-heading-medium-style, normal);
  letter-spacing: var(--en-font-heading-medium-tracking, 0px);
}
.en-heading-large {
    font: var(--en-font-heading-large-weight, 600) var(--_en-sized-font-heading-large-size, var(--en-font-heading-large-size, 2rem)) / var(--en-font-heading-large-line-height, 1.2) var(--en-font-heading-large-family, system-ui, sans-serif);
  font-style: var(--en-font-heading-large-style, normal);
  letter-spacing: var(--en-font-heading-large-tracking, 0px);
}
.en-metadata {
  color: var(--en-color-text-muted, rgb(86 97 113 / 1));
    font: var(--en-font-metadata-weight, 400) var(--_en-sized-font-metadata-size, var(--en-font-metadata-size, 0.8125rem)) / var(--en-font-metadata-line-height, 1.5) var(--en-font-metadata-family, system-ui, sans-serif);
  font-style: var(--en-font-metadata-style, normal);
  letter-spacing: var(--en-font-metadata-tracking, 0px);
}
.en-data {
    font: var(--en-font-data-weight, 400) var(--_en-sized-font-data-size, var(--en-font-data-size, 0.875rem)) / var(--en-font-data-line-height, 1.5) var(--en-font-data-family, system-ui, sans-serif);
  font-style: var(--en-font-data-style, normal);
  letter-spacing: var(--en-font-data-tracking, 0px);
  font-variant-numeric: tabular-nums;
}
`),At=c`:host { display: block; min-inline-size: 0; }`,jt=c`:host { display: inline-block; vertical-align: middle; max-inline-size: 100%; }`,Mt=c`:host { display: inline-flex; align-items: center; justify-content: center; color: inherit; line-height: 0; vertical-align: middle; }`,Nt=U(c`
  ${c`
  :host, .en-foundation { --_en-size-small: 0; --_en-size-medium: 1; --_en-size-large: 0; }
  :host([size='inherit']), .en-foundation[data-size='inherit'] { --_en-size-small: inherit; --_en-size-medium: inherit; --_en-size-large: inherit; }
  :host([size='small']), .en-foundation[data-size='small'] { --_en-size-small: 1; --_en-size-medium: 0; --_en-size-large: 0; }
  :host([size='medium']), .en-foundation[data-size='medium'] { --_en-size-small: 0; --_en-size-medium: 1; --_en-size-large: 0; }
  :host([size='large']), .en-foundation[data-size='large'] { --_en-size-small: 0; --_en-size-medium: 0; --_en-size-large: 1; }
`}
  :host, .en-foundation {
    box-sizing: border-box;
    color: ${I(`--en-color-text`)};
    font-family: ${I(`--en-font-ui-family`)};
    font-style: ${I(`--en-font-ui-style`)};
    letter-spacing: ${I(`--en-font-ui-tracking`)};
    font-size: ${I(`--en-font-ui-size`)};
    font-weight: ${I(`--en-font-ui-weight`)};
    line-height: ${I(`--en-font-ui-line-height`)};
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
  ${Ot(c`:where(:host([tabindex]), .en-foundation[tabindex]),
    :where(:host, .en-foundation) :where(button, input, textarea, select, a[href], [tabindex])`)}
  :host(:focus-visible), .en-foundation:focus-visible {
    outline: ${I(`--en-focus-width`)} solid ${I(`--en-color-focus`)};
    outline-offset: ${I(`--en-focus-offset`)};
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
`);function W(e=!1){return e?c`max(${I(`--en-size-target-min`)}, ${I(`--en-size-target-touch`)})`:I(`--en-size-target-min`)}function G(e=!1,t=I(`--en-size-control-min`)){return c`max(${L(`--en-control-min-size`,t)}, ${W(e)})`}var Pt=c`max(0px, ${L(`--en-segmented-control-frame-inset`,I(`--en-space-1`))})`,Ft=c`calc(${Pt} + ${I(`--en-border-width`)})`;function It(e=!1,t=!1){let n=W(e),r=I(`--en-space-control-block`),i=I(`--en-border-width`),a=c`calc(${I(`--en-space-1`)} + ${i})`,o=t?c`max(${a}, ${Ft})`:a;return c`max(
    ${L(`--en-control-min-size`,I(`--en-size-control-min`))},
    calc(${n} + 2 * ${o}),
    calc(${I(`--en-font-input-size`)} * ${I(`--en-font-input-line-height`)} + 2 * ${r} + 2 * ${i}),
    calc(${I(`--en-font-ui-size`)} * ${I(`--en-font-ui-line-height`)} + 2 * max(${r}, ${o}) + 2 * ${i})
  )`}function Lt(e,t,n,r){return c`
    ${e} {
      --_en-inset-gap: max(${I(`--en-space-1`)}, ${B({family:`button`})});
      --_en-inset-radius: max(0px, calc(${n} - ${r} - var(--_en-inset-gap)));
      --_en-inset-size: max(${W()}, calc(${It()} - 2 * var(--_en-inset-gap)));
      --_en-inset-padding: max(0px, calc(${I(`--en-space-control-block`)} - var(--_en-inset-gap)));
    }
    ${t} {
      --_en-inset-action-radius: var(--_en-inset-radius);
      --_en-inset-action-size: var(--_en-inset-size);
      --_en-inset-action-padding: var(--_en-inset-padding);
      margin: var(--_en-inset-gap);
      flex-shrink: 0;
    }
    @media (any-pointer: coarse) {
      ${e} { --_en-inset-size: max(${W(!0)}, calc(${It(!0)} - 2 * var(--_en-inset-gap))); }
    }
  `}var Rt=c`
  .en-button {
    padding-block: var(--_en-inset-action-padding, ${I(`--en-space-control-block`)});
    border-radius: var(--_en-inset-action-radius, ${L(`--en-button-radius`,L(`--en-control-radius`,I(`--en-radius-control`)))});
  }
  .en-button:not(.en-icon-button) { min-block-size: var(--_en-inset-action-size, var(--_en-text-control-block-size)); }
  .en-button.en-icon-button:not([data-icon-only]) {
    min-block-size: var(--_en-inset-action-size, ${G()});
    min-inline-size: var(--_en-inset-action-size, ${G()});
  }
  .en-button[data-icon-only] {
    min-block-size: var(--_en-inset-action-size, var(--_en-icon-button-side));
    min-inline-size: var(--_en-inset-action-size, var(--_en-icon-button-side));
  }
  @media (any-pointer: coarse) {
    .en-button.en-icon-button:not([data-icon-only]) {
      min-block-size: var(--_en-inset-action-size, ${G(!0)});
      min-inline-size: var(--_en-inset-action-size, ${G(!0)});
    }
  }
`,K={segmented:{scale:c`var(--en-segmented-pressed-scale, 1)`,offset:c`var(--en-segmented-pressed-offset, 0px)`,press:c`var(--en-segmented-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-segmented-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-segmented-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-segmented-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-segmented-pressed-color, ${I(`--en-color-text`)}); border-color: var(--en-segmented-pressed-border-color, ${I(`--en-color-boundary`)});`},accordion:{scale:c`var(--en-accordion-pressed-scale, 1)`,offset:c`var(--en-accordion-pressed-offset, 0px)`,press:c`var(--en-accordion-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-accordion-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-accordion-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-accordion-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-accordion-pressed-color, ${I(`--en-color-text`)});`},tab:{scale:c`var(--en-tab-pressed-scale, 1)`,offset:c`var(--en-tab-pressed-offset, 0px)`,press:c`var(--en-tab-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-tab-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-tab-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-tab-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-tab-pressed-color, var(--en-tab-color, ${I(`--en-color-action-text`)}));`},rating:{scale:c`var(--en-rating-pressed-scale, 1)`,offset:c`var(--en-rating-pressed-offset, 0px)`,press:c`var(--en-rating-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-rating-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-rating-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-rating-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-rating-pressed-color, ${I(`--en-color-text`)});`},"combobox-trigger":{scale:c`var(--en-combobox-trigger-pressed-scale, 1)`,offset:c`var(--en-combobox-trigger-pressed-offset, 0px)`,press:c`var(--en-combobox-trigger-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-combobox-trigger-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-combobox-trigger-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-combobox-trigger-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-combobox-trigger-pressed-color, ${I(`--en-color-text`)});`},navigation:{scale:c`var(--en-navigation-pressed-scale, 1)`,offset:c`var(--en-navigation-pressed-offset, 0px)`,press:c`var(--en-navigation-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-navigation-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-navigation-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-navigation-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-navigation-pressed-color, ${I(`--en-color-action-text`)});`},"editor-token":{scale:c`var(--en-editor-token-pressed-scale, 1)`,offset:c`var(--en-editor-token-pressed-offset, 0px)`,press:c`var(--en-editor-token-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-editor-token-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-editor-token-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-editor-token-pressed-background, ${I(`--en-color-accent-subtle`)}); color: var(--en-editor-token-pressed-color, var(--en-editor-token-color, ${I(`--en-color-text`)})); border-color: var(--en-editor-token-pressed-border-color, var(--en-editor-token-border-color, ${I(`--en-color-line`)}));`},option:{scale:c`var(--en-option-pressed-scale, 1)`,offset:c`var(--en-option-pressed-offset, 0px)`,press:c`var(--en-option-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-option-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-option-pressed-shadow, 0 0 0 0 transparent)`,paint:c``},calendar:{scale:c`var(--en-calendar-pressed-scale, 1)`,offset:c`var(--en-calendar-pressed-offset, 0px)`,press:c`var(--en-calendar-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-calendar-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-calendar-pressed-shadow, 0 0 0 0 transparent)`,paint:c``},checkbox:{scale:c`var(--en-checkbox-pressed-scale, 1)`,offset:c`var(--en-checkbox-pressed-offset, 0px)`,press:c`var(--en-checkbox-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-checkbox-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-checkbox-pressed-shadow, inset 0 0 0 1px currentColor)`,paint:c`border-color: var(--en-checkbox-pressed-border-color, ${I(`--en-color-action-pressed`)});`},radio:{scale:c`var(--en-radio-pressed-scale, 1)`,offset:c`var(--en-radio-pressed-offset, 0px)`,press:c`var(--en-radio-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-radio-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-radio-pressed-shadow, inset 0 0 0 1px currentColor)`,paint:c`border-color: var(--en-radio-pressed-border-color, ${I(`--en-color-action-pressed`)});`},switch:{scale:c`var(--en-switch-pressed-scale, 1)`,offset:c`var(--en-switch-pressed-offset, 0px)`,press:c`var(--en-switch-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-switch-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-switch-pressed-shadow, inset 0 0 0 1px currentColor)`,paint:c`border-color: var(--en-switch-pressed-border-color, ${I(`--en-color-action-pressed`)});`},select:{scale:c`var(--en-select-pressed-scale, 1)`,offset:c`var(--en-select-pressed-offset, 0px)`,press:c`var(--en-select-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-select-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-select-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-select-pressed-background, var(--en-input-background, ${I(`--en-color-accent-subtle`)})); color: var(--en-select-pressed-color, var(--en-input-color, ${I(`--en-color-text`)}));`},"number-step":{scale:c`var(--en-number-step-pressed-scale, var(--en-button-pressed-scale, 1))`,offset:c`var(--en-number-step-pressed-offset, var(--en-button-pressed-offset, 0px))`,press:c`var(--en-number-step-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-number-step-release-duration, ${I(`--en-duration-release`)})`,shadow:c`var(--en-number-step-pressed-shadow, 0 0 0 0 transparent)`,paint:c`background: var(--en-number-step-pressed-background, var(--en-button-pressed-background, ${I(`--en-color-accent-subtle`)}));`}},q=L(`--en-input-border-width`,I(`--en-border-width`)),zt=L(`--en-input-invalid-border-width`,I(`--en-border-invalid-width`)),Bt=L(`--en-input-radius`,L(`--en-control-radius`,I(`--en-radius-control`)));function Vt(e,t){return c`
    ${e} { border-radius: ${Bt}; border-width: ${q}; border-color: ${L(`--en-input-border-color`,L(`--en-control-border-color`,I(`--en-color-boundary`)))}; }
    @media (hover: hover) {
      ${e}:hover:where(:not(:disabled):not([aria-disabled='true']):not(:has(:disabled))) { border-color: var(--en-input-hover-border-color, var(--en-input-border-color, var(--en-control-border-color, ${I(`--en-color-boundary`)}))); }
    }
    ${t} { border-color: ${L(`--en-input-invalid-border-color`,I(`--en-color-danger-text`))}; }
  `}var Ht=c`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,Ut=c`
  .en-description { margin: 0; font-size: ${I(`--en-font-ui-size`)}; line-height: ${I(`--en-font-body-line-height`)}; overflow-wrap: break-word; display: flow-root; color: ${I(`--en-color-text-muted`)}; }
  .en-description-fallback,
  .en-description > slot::slotted(:not([hidden])) { display: block; margin-block-start: var(--_en-field-gap, ${L(`--en-field-gap`,I(`--en-space-label-control`))}); }
  .en-description-fallback:empty { display: none; }
  @media (forced-colors: active) { .en-description { color: CanvasText; } }
`,Wt=c`clamp(0ms, var(--en-dialog-enter-duration, ${I(`--en-duration-enter`)}), 500ms)`,Gt=c`clamp(0ms, var(--en-dialog-exit-duration, ${I(`--en-duration-exit`)}), 500ms)`,J=c`clamp(0px, ${I(`--en-motion-surface-offset`)}, 8px)`,Kt=c`clamp(.95, ${I(`--en-motion-surface-scale`)}, 1)`,qt=c`var(--_en-surface-duration, 0ms) var(--_en-surface-ease, linear)`,Jt=c`opacity var(--_en-surface-opacity-duration, 0ms) var(--_en-surface-ease, linear), translate ${qt}, scale ${qt}, display ${qt} allow-discrete, overlay ${qt} allow-discrete`;function Y(e,t,n,r,i=c``,a=`popup`){let o=a===`dialog`?c`clamp(0ms, var(--en-dialog-enter-duration, ${I(`--en-duration-enter`)}), 500ms)`:c`clamp(0ms, var(--en-popup-enter-duration, ${I(`--en-duration-enter`)}), 500ms)`,s=a===`dialog`?c`clamp(0ms, var(--en-dialog-exit-duration, ${I(`--en-duration-exit`)}), 500ms)`:c`clamp(0ms, var(--en-popup-exit-duration, ${I(`--en-duration-exit`)}), 500ms)`,l=a===`dialog`?c`var(--en-dialog-enter-ease, ${I(`--en-ease-enter`)})`:c`var(--en-popup-enter-ease, ${I(`--en-ease-enter`)})`,u=a===`dialog`?c`var(--en-dialog-exit-ease, ${I(`--en-ease-exit`)})`:c`var(--en-popup-exit-ease, ${I(`--en-ease-exit`)})`,d=c`:where(${e})${i}`,f=c`${t}${i}`,ee=c`${n}${i}`;return c`
    @supports (transition-behavior: allow-discrete) and (overlay: auto) {
      ${d} {
        --_en-surface-duration: ${s};
        --_en-surface-opacity-duration: ${s};
        --_en-surface-ease: ${u};
        opacity: 0;
        transition: ${Jt};
      }
      ${f} {
        --_en-surface-duration: ${o};
        /* Modal and menu entry keep content opaque. Fade surfaces reverse
           from their current opacity when reopened during exit. */
        --_en-surface-opacity-duration: ${r===`fade`?o:c`0ms`};
        --_en-surface-ease: ${l};
        opacity: 1;
      }
      ${ee} { pointer-events: none; }
      ${r===`elevation`?c`
        /* Opaque command content and its primary focus contour are immediate.
           Elevation adds entry paint without corrupting measured iPhone geometry. */
        @keyframes en-surface-elevation { from { box-shadow: none; } }
        ${f} { animation: en-surface-elevation ${o} ${l}; }
      `:c``}
      @starting-style { ${f} { opacity: ${r===`fade`?0:1}; } }
    }
    @media (prefers-reduced-motion: reduce) {
      ${d} { transition: none !important; animation: none !important; }
    }
    @media (forced-colors: active) {
      ${d} { animation: none; }
    }
  `}var Yt=c`
  ${Y(c`dialog:is(.en-dialog, .en-drawer)`,c`dialog:is(.en-dialog, .en-drawer)[open]`,c`dialog:is(.en-dialog, .en-drawer):not([open])`,`move`,c``,`dialog`)}
  @supports (transition-behavior: allow-discrete) and (overlay: auto) {
    dialog:is(.en-dialog, .en-drawer) {
      --_en-surface-x: 0px;
      --_en-surface-y: ${J};
      translate: var(--_en-surface-x) var(--_en-surface-y);
      scale: ${Kt};
    }
    /* Share modal travel distance; attachment selects its axis and sign.
       Keep the drawer unscaled so its attached edge stays flush. */
    dialog.en-drawer { --_en-surface-x: ${J}; --_en-surface-y: 0px; scale: 1; }
    dialog.en-drawer:is([data-placement='start'], [data-placement='left']) { --_en-surface-x: calc(-1 * ${J}); }
    dialog.en-drawer[data-placement='end']:dir(rtl) { --_en-surface-x: calc(-1 * ${J}); }
    dialog.en-drawer[data-placement='start']:dir(rtl) { --_en-surface-x: ${J}; }
    dialog.en-drawer:is([data-placement='top'], [data-placement='bottom']) { --_en-surface-x: 0px; --_en-surface-y: ${J}; }
    dialog.en-drawer[data-placement='top'] { --_en-surface-y: calc(-1 * ${J}); }
    dialog:is(.en-dialog, .en-drawer)[open] { translate: 0px 0px; scale: 1; }
    @starting-style {
      dialog:is(.en-dialog, .en-drawer)[open] {
        translate: var(--_en-surface-x) var(--_en-surface-y);
        scale: ${Kt};
      }
      dialog.en-drawer[open] { scale: 1; }
    }
    dialog:is(.en-dialog, .en-drawer)::backdrop {
      opacity: 0;
      transition: opacity ${Gt} var(--en-dialog-exit-ease, ${I(`--en-ease-exit`)}), display ${Gt} allow-discrete, overlay ${Gt} allow-discrete;
    }
    dialog:is(.en-dialog, .en-drawer)[open]::backdrop {
      opacity: 1;
      transition: opacity ${Wt} var(--en-dialog-enter-ease, ${I(`--en-ease-enter`)}), display ${Wt} allow-discrete, overlay ${Wt} allow-discrete;
    }
    dialog:is(.en-dialog, .en-drawer):not([open])::backdrop { pointer-events: none; }
    @starting-style { dialog:is(.en-dialog, .en-drawer)[open]::backdrop { opacity: 0; } }
  }
  @media (prefers-reduced-motion: reduce) {
    dialog:is(.en-dialog, .en-drawer) { translate: none !important; scale: none !important; }
    dialog:is(.en-dialog, .en-drawer)::backdrop { transition: none !important; }
  }
`,Xt=c`
  .en-radio {
    flex: none;
    inline-size: ${L(`--en-choice-size`,I(`--en-size-icon`))};
    block-size: ${L(`--en-choice-size`,I(`--en-size-icon`))};
    margin: 0;
    accent-color: ${I(`--en-color-action`)};
    appearance: none;
    display: inline-grid;
    /* Keep the inline baseline independent of the checked-state grid dot. */
    vertical-align: middle;
    place-items: center;
    box-sizing: border-box;
    border: ${I(`--en-border-width`)} solid ${I(`--en-color-boundary`)};
    border-radius: ${I(`--en-radius-pill`)};
    background: ${I(`--en-color-surface`)};
    cursor: pointer;
  }
  .en-radio:checked { border-color: ${L(`--en-radio-selected-color`,I(`--en-color-action`))}; }
  .en-radio:checked::before { content: ''; inline-size: ${I(`--en-size-choice-dot`)}; block-size: ${I(`--en-size-choice-dot`)}; border-radius: ${I(`--en-radius-pill`)}; background: ${L(`--en-radio-selected-color`,I(`--en-color-action`))}; }
  .en-radio:not(:disabled):active { border-color: ${I(`--en-color-action-pressed`)}; }
  .en-radio:disabled { cursor: default; background: ${I(`--en-color-surface-subtle`)}; border-color: ${I(`--en-color-boundary`)}; }
  .en-radio:disabled::before { background: ${I(`--en-color-text-muted`)}; }
  ${R(c`.en-radio`,c`.en-radio:not(:disabled):not([data-press='none']):is(:active, .en-choice:active > .en-radio)`,K.radio)}
  @media (forced-colors: active) {
    .en-radio { accent-color: auto; background: Canvas; border-color: CanvasText; }
    .en-radio:checked { background: Canvas; border-color: CanvasText; }
    .en-radio:checked::before { background: CanvasText; }
    .en-radio:not(:disabled):active { border-color: Highlight; box-shadow: none; }
    .en-radio:disabled { background: Canvas; border-color: GrayText; }
    .en-radio:disabled::before { background: GrayText; }
    .en-radio:focus-visible { outline-color: CanvasText; }
  }
`;function Zt(e){return c`
    ${e.motion===!1?c``:R(e.base,c`${e.pressed}:not([aria-disabled='true']):not(:disabled):not([data-press='none']):not([data-reorderable])`,K.option)}
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
      font-weight: ${L(`--en-option-font-weight`,c`inherit`)};
    }
    ${e.selected?c`${e.selected} {
      --_en-option-selected-background: ${L(`--en-option-selected-background`,L(`--en-option-background`,I(`--en-color-selected`)))};
      --_en-option-selected-color: ${L(`--en-option-selected-color`,L(`--en-option-color`,e.selectedColor??e.restColor))};
      font-weight: ${L(`--en-option-selected-font-weight`,L(`--en-option-font-weight`,I(`--en-font-label-strong-weight`)))};
    }`:c``}
    @media (hover: hover) { ${e.hover} {
      --_en-option-hover-background: ${L(`--en-option-hover-background`,L(`--en-option-background`,e.hoverBackground))};
      /* With neither override set, the state slot is invalid and falls through
         to active/selected/rest paint, rather than resetting it. */
      --_en-option-hover-color: var(--en-option-hover-color, var(--en-option-color));
    } }
    ${e.focus?c`${e.focus} {
      --_en-option-hover-background: ${L(`--en-option-hover-background`,L(`--en-option-background`,e.hoverBackground))};
      --_en-option-hover-color: var(--en-option-hover-color, var(--en-option-color));
    }`:c``}
    ${e.active?c`${e.active} {
      --_en-option-active-background: var(--en-option-active-background, var(--en-option-background));
      --_en-option-active-color: var(--en-option-active-color, var(--en-option-color));
    }`:c``}
    ${e.pressed} {
      --_en-option-pressed-background: var(--en-option-pressed-background, var(--en-option-background, color-mix(in srgb, ${e.hoverBackground} 82%, currentColor)));
      --_en-option-pressed-color: var(--en-option-pressed-color, var(--en-option-color));
    }
    ${e.disabled} {
      --_en-option-disabled-background: var(--en-option-disabled-background, var(--en-option-background));
      --_en-option-disabled-color: ${L(`--en-option-disabled-color`,L(`--en-option-color`,I(`--en-color-text-muted`)))};
    }
  `}var Qt=wt,$t=c`
  .en-button {
    --_en-button-shadow: var(--en-button-shadow, 0 0 0 0 transparent);
    --_en-button-state-background: var(--en-button-rest-background);
    --_en-button-state-color: var(--en-button-rest-color);
    padding-inline: ${L(`--en-button-inline-padding`,L(`--en-control-inline-padding`,I(`--en-space-control-inline`)))};
    display: inline-flex;
    min-inline-size: ${I(`--en-size-target-min`)};
    align-items: center;
    justify-content: center;
    gap: ${I(`--en-space-icon-label`)};
    border-color: ${L(`--en-button-border-color`,I(`--en-color-action`))};
    border-radius: ${L(`--en-button-radius`,L(`--en-control-radius`,I(`--en-radius-control`)))};
    background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-action`))});
    color: var(--_en-button-state-color, ${L(`--en-button-color`,I(`--en-color-on-action`))});
    font-weight: ${I(`--en-font-label-strong-weight`)};
    text-align: center;
    text-decoration: none;
    white-space: normal;
    overflow-wrap: break-word;
    cursor: pointer;
    transition: background-color ${I(`--en-duration-fast`)} ${I(`--en-ease-standard`)},
      border-color ${I(`--en-duration-fast`)} ${I(`--en-ease-standard`)}, ${Qt};
  }
  @media (hover: hover) { .en-button:where(:not(:disabled):not([aria-disabled='true']):hover) { background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-action-hover`))}); } }
  .en-button:where(:not(:disabled):not([aria-disabled='true']):active) { background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-action-pressed`))}); }
  .en-button--secondary, .en-button[data-variant='secondary'] {
    background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-surface-subtle`))});
    color: var(--_en-button-state-color, ${L(`--en-button-color`,I(`--en-color-text`))});
    border-color: ${L(`--en-button-border-color`,I(`--en-color-boundary`))};
  }
  .en-button--quiet, .en-button[data-variant='ghost'] {
    background: var(--_en-button-state-background, none);
    color: var(--_en-button-state-color, ${L(`--en-button-color`,I(`--en-color-action-text`))});
    border-color: ${L(`--en-button-border-color`,I(`--en-color-line`))};
  }
  @media (hover: hover) { :is(.en-button--secondary, .en-button--quiet, .en-button[data-variant='secondary'], .en-button[data-variant='ghost']):not(:disabled):not([aria-disabled='true']):hover {
    background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-selected`))});
  } }
  .en-button--danger, .en-button[data-variant='danger'] {
    background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-surface`))});
    color: var(--_en-button-state-color, ${L(`--en-button-color`,I(`--en-color-danger-text`))});
    border-color: ${L(`--en-button-border-color`,I(`--en-color-danger-text`))};
  }
  @media (hover: hover) { :is(.en-button--danger, .en-button[data-variant='danger']):not(:disabled):not([aria-disabled='true']):hover {
    background: var(--_en-button-state-background, ${L(`--en-button-background`,I(`--en-color-surface-subtle`))});
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
    background: var(--en-button-pressed-background, var(--en-button-background, color-mix(in srgb, ${I(`--en-color-surface`)} 82%, currentColor)));
  }
  :is(.en-button--danger, .en-button[data-variant='danger']):not(:disabled):not([aria-disabled='true']):active {
    background: var(--en-button-pressed-background, var(--en-button-background, ${I(`--en-color-danger-text`)}));
    color: var(--en-button-pressed-color, var(--en-button-color, ${I(`--en-color-surface`)}));
  }
  .en-button:not(:disabled):not([aria-disabled='true']):active {
    --_en-button-shadow: var(--en-button-pressed-shadow, var(--en-button-shadow, 0 0 0 0 transparent));
  }
  /* Transform the complete control, including its surface, border and glyphs.
     Popup semantics do not imply a universal motion policy: a theme may refine
     their held geometry independently. Layout allocation remains unchanged. */
  ${Tt(c`.en-button`,c`.en-button:not(:disabled):not([aria-disabled='true']):not([data-press='none']):active`,{scale:c`var(--en-button-pressed-scale, ${I(`--en-motion-press-scale`)})`,offset:c`var(--en-button-pressed-offset, ${I(`--en-motion-press-offset`)})`,press:c`var(--en-button-press-duration, ${I(`--en-duration-press`)})`,release:c`var(--en-button-release-duration, ${I(`--en-duration-release`)})`})}
  .en-button[aria-haspopup]:not([aria-haspopup='false']):not(:disabled):not([aria-disabled='true']):not([data-press='none']):active {
    scale: clamp(.9, var(--en-button-popup-pressed-scale, var(--en-button-pressed-scale, ${I(`--en-motion-press-scale`)})), 1);
    translate: 0 clamp(-2px, var(--en-button-popup-pressed-offset, var(--en-button-pressed-offset, ${I(`--en-motion-press-offset`)})), 2px);
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
  .en-icon-button { padding-inline: ${I(`--en-space-2`)}; min-inline-size: max(${L(`--en-control-min-size`,I(`--en-size-control-min`))}, ${I(`--en-size-target-min`)}); }
  /* Explicit button mode; existing stepper/overlay icon recipes retain their layout. */
  .en-button[data-icon-only] {
    --_en-icon-button-side: max(var(--_en-text-control-block-size), calc(max(${L(`--en-icon-size`,I(`--en-size-icon`))}, ${I(`--en-size-spinner`)}) + 2 * ${I(`--en-space-control-block`)} + 2 * ${I(`--en-border-width`)}));
    min-inline-size: var(--_en-icon-button-side);
    min-block-size: var(--_en-icon-button-side);
    inline-size: max-content;
    aspect-ratio: 1;
    padding: ${I(`--en-space-control-block`)};
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

`,en=c`background-color ${I(`--en-duration-fast`)} ${I(`--en-ease-standard`)}, border-color ${I(`--en-duration-fast`)} ${I(`--en-ease-standard`)}, ${Qt}`,tn=V(c`.en-button`,{family:`button`,baseTransitions:en,baseShadow:c`var(--_en-button-shadow, 0 0 0 0 transparent)`}),nn=c`@media (hover: hover) { .en-button:not(:disabled):not([aria-disabled='true']):hover { background: Highlight !important; color: HighlightText !important; } }`,rn=c`
  ${tn}
  ${V(c`.en-accordion-trigger`,{family:`button`})}
  ${V(c`:where(.en-input, .en-textarea, .en-select, .en-color-control)`,{family:`input`})}
  ${V(c`.en-option`,{family:`option`})}
  ${V(c`:where(.en-link, .en-control:not(.en-color-control), .en-checkbox, .en-radio, .en-switch,
    .en-range, .en-tab, .en-split-separator, .en-rating-item)`)}
`,an=Et({family:`input`}),on=c`
  .en-field-focus-frame {
    position: relative;
    min-inline-size: 0;
    --_en-field-focus-accent-width: ${L(`--en-input-focus-accent-width`,I(`--en-focus-accent-width`))};
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
    block-size: max(var(--_en-field-focus-accent-width), ${L(`--en-control-radius`,I(`--en-radius-control`))});
    border-end-start-radius: ${L(`--en-control-radius`,I(`--en-radius-control`))};
    border-end-end-radius: ${L(`--en-control-radius`,I(`--en-radius-control`))};
    border-block-end: var(--_en-field-focus-accent-width) solid ${L(`--en-input-focus-accent-color`,I(`--en-color-focus`))};
    clip-path: inset(calc(100% - var(--_en-field-focus-accent-width)) 0 0 0);
    transform: scaleX(0);
    transform-origin: center;
    transition: transform ${I(`--en-duration-focus-exit`)} ${I(`--en-ease-focus-exit`)};
  }
  .en-number-group.en-field-focus-frame {
    box-shadow: 0 0 0 0 ${an.haloColor};
    transition: box-shadow ${I(`--en-duration-focus-exit`)} ${I(`--en-ease-focus-exit`)};
  }
  .en-number-group.en-field-focus-frame:focus-within {
    box-shadow: 0 0 0 ${an.haloWidth} ${an.haloColor};
    transition-duration: ${I(`--en-duration-focus-enter`)};
    transition-timing-function: ${I(`--en-ease-focus-enter`)};
  }
  .en-field-focus-frame:focus-within::after {
    transform: scaleX(1);
    transition-duration: ${I(`--en-duration-focus-enter`)};
    transition-timing-function: ${I(`--en-ease-focus-enter`)};
  }
  @media (prefers-reduced-motion: reduce) {
    .en-field-focus-frame::after, .en-field-focus-frame:focus-within::after,
    .en-number-group.en-field-focus-frame, .en-number-group.en-field-focus-frame:focus-within { transition: none; }
  }
  @media (forced-colors: active) {
    .en-field-focus-frame::after, .en-field-focus-frame:focus-within::after { border-block-end-color: Highlight; transition: none; }
    .en-number-group.en-field-focus-frame, .en-number-group.en-field-focus-frame:focus-within { box-shadow: none; transition: none; }
  }
`,sn=c`
  block-size: ${I(`--en-size-range-track`)};
  border: 0;
  border-radius: ${I(`--en-radius-pill`)};
  background: ${I(`--en-color-boundary`)};
`,cn=c`
  box-sizing: border-box;
  inline-size: ${I(`--en-size-icon`)};
  block-size: ${I(`--en-size-icon`)};
  border: ${I(`--en-border-width`)} solid ${I(`--en-color-action`)};
  border-radius: ${I(`--en-radius-pill`)};
  background: ${I(`--en-color-action`)};
`,ln=c`outline: ${I(`--en-focus-width`)} solid ${I(`--en-color-focus`)}; outline-offset: ${I(`--en-focus-offset`)};`,un=c`
  @supports selector(input::-webkit-slider-thumb) {
    .en-range { appearance: none; background: none; cursor: pointer; }
    .en-range::-webkit-slider-runnable-track { ${sn} }
    .en-range::-webkit-slider-thumb { appearance: none; ${cn} margin-block-start: calc((${I(`--en-size-range-track`)} - ${I(`--en-size-icon`)}) / 2); }
    /* Exposed native thumbs own focus. A global halo must not reintroduce a
       rectangular range-host ring; native unsupported fallbacks keep that route. */
    .en-range, .en-range:focus-visible { box-shadow: none; }
    .en-range:focus-visible { outline: none; }
    .en-range:focus-visible::-webkit-slider-thumb { ${ln} }
    .en-range:disabled::-webkit-slider-thumb { background: ${I(`--en-color-text-muted`)}; border-color: ${I(`--en-color-text-muted`)}; }
    @media (forced-colors: active) {
      .en-range::-webkit-slider-runnable-track { background: ButtonText; }
      .en-range::-webkit-slider-thumb { background: Highlight; border-color: Highlight; }
      .en-range:disabled::-webkit-slider-thumb { background: GrayText; border-color: GrayText; }
      .en-range:focus-visible::-webkit-slider-thumb { outline-color: CanvasText; }
    }
  }
  @supports selector(input::-moz-range-thumb) {
    .en-range { appearance: none; background: none; cursor: pointer; }
    .en-range::-moz-range-track { ${sn} }
    .en-range::-moz-range-thumb { ${cn} }
    /* Exposed native thumbs own focus. A global halo must not reintroduce a
       rectangular range-host ring; native unsupported fallbacks keep that route. */
    .en-range, .en-range:focus-visible { box-shadow: none; }
    .en-range:focus-visible { outline: none; }
    .en-range:focus-visible::-moz-range-thumb { ${ln} }
    .en-range:disabled::-moz-range-thumb { background: ${I(`--en-color-text-muted`)}; border-color: ${I(`--en-color-text-muted`)}; }
    @media (forced-colors: active) {
      .en-range::-moz-range-track { background: ButtonText; }
      .en-range::-moz-range-thumb { background: Highlight; border-color: Highlight; }
      .en-range:disabled::-moz-range-thumb { background: GrayText; border-color: GrayText; }
      .en-range:focus-visible::-moz-range-thumb { outline-color: CanvasText; }
    }
  }
  .en-range:disabled { cursor: default; }
   .en-range::-webkit-slider-thumb { transition: scale clamp(0ms, var(--en-slider-thumb-release-duration, 80ms), 200ms) ${I(`--en-ease-standard`)}; }
   .en-range:not(:disabled):active::-webkit-slider-thumb { scale: clamp(.9, var(--en-slider-thumb-pressed-scale, 1), 1.25); transition-duration: clamp(0ms, var(--en-slider-thumb-press-duration, 80ms), 200ms); }
  @media (prefers-reduced-motion: reduce) {  .en-range::-webkit-slider-thumb { scale: none !important; transition: none !important; } }
  :host([data-press=none])  .en-range::-webkit-slider-thumb { scale: none !important; }

   .en-range::-moz-range-thumb { transition: scale clamp(0ms, var(--en-slider-thumb-release-duration, 80ms), 200ms) ${I(`--en-ease-standard`)}; }
   .en-range:not(:disabled):active::-moz-range-thumb { scale: clamp(.9, var(--en-slider-thumb-pressed-scale, 1), 1.25); transition-duration: clamp(0ms, var(--en-slider-thumb-press-duration, 80ms), 200ms); }
  @media (prefers-reduced-motion: reduce) {  .en-range::-moz-range-thumb { scale: none !important; transition: none !important; } }
  :host([data-press=none])  .en-range::-moz-range-thumb { scale: none !important; }

`,dn=c`
  .en-link {
    color: ${I(`--en-color-link`)};
    text-decoration: underline;
    text-underline-offset: ${I(`--en-space-0-5`)};
    overflow-wrap: break-word;
  }
  .en-link:not([aria-disabled='true']):active { text-decoration-thickness: .2em; }
  .en-link:visited { color: ${I(`--en-color-link`)}; }
`,fn=c`.en-link[aria-disabled='true'] { color: ${I(`--en-color-text-muted`)}; cursor: default; }`,pn=c`.en-link, .en-link:visited { color: LinkText; }`;function mn(e,t=!1){return c`${e} { --_en-text-control-block-size: ${It(t)}; }`}function hn(e){return c`${e} {
    box-sizing: border-box;
    min-inline-size: 0;
    min-block-size: ${G()};
    max-inline-size: 100%;
    padding-block: ${I(`--en-space-control-block`)};
    padding-inline: ${L(`--en-control-inline-padding`,I(`--en-space-control-inline`))};
    border: ${I(`--en-border-width`)} solid ${L(`--en-control-border-color`,I(`--en-color-boundary`))};
    border-radius: ${L(`--en-control-radius`,I(`--en-radius-control`))};
    background: ${L(`--en-control-background`,I(`--en-color-surface`))};
    color: ${L(`--en-control-color`,I(`--en-color-text`))};
    font: inherit;
    text-align: start;
  }`}function gn(e){return c`${e} { min-block-size: var(--_en-text-control-block-size); }`}function _n(e){return c`${e} {
    color: ${I(`--en-color-text-muted`)};
    background: ${I(`--en-color-surface-subtle`)};
    border-color: ${I(`--en-color-boundary`)};
    cursor: default;
  }`}function vn(e){return c`${e} { min-block-size: ${G(!0)}; }`}function yn(e){return c`${e} { min-inline-size: ${G(!0)}; }`}function bn(e){return c`${e} { transition: none; }`}function xn(e){return c`${e} { color: CanvasText !important; background: Canvas !important; border-color: ButtonText !important; }`}function Sn(e){return c`${e} { color: GrayText !important; border-color: GrayText !important; }`}var X=L(`--en-input-inline-padding`,L(`--en-control-inline-padding`,I(`--en-space-control-inline`))),Cn=Bt,Z=c`max(0px, ${Cn} - ${q})`,wn=c`max(
  ${I(`--en-space-control-block`)},
  calc((var(--_en-text-control-block-size) - ${I(`--en-font-input-size`)} * ${I(`--en-font-input-line-height`)}) / 2 - ${q})
)`,Tn=U(c`
  /* Compute on each consumer so local token/part overrides retain their scope. */
  ${mn(c`.en-button:not(.en-icon-button), .en-button[data-icon-only], .en-input, .en-textarea, .en-select, .en-number-input, .en-number-step, .en-color-control`)}
  ${hn(c`.en-control, .en-button, .en-input, .en-textarea, .en-select`)}
  ${gn(c`.en-button:not(.en-icon-button), .en-input, .en-textarea, .en-select`)}
  /* Field tokens customize inputs without changing action and choice surfaces.
     Family refinements take precedence over shared control defaults. */
  .en-input, .en-textarea, .en-select {
    padding-inline: ${X};
    background: ${L(`--en-input-background`,L(`--en-control-background`,I(`--en-color-surface`)))};
    color: ${L(`--en-input-color`,L(`--en-control-color`,I(`--en-color-text`)))};
  }
  ${$t}
  ${dn}
  ${_n(c`:is(.en-button, .en-input, .en-textarea, .en-select, .en-control):is(:disabled, [aria-disabled='true'])`)}
  ${fn}
  .en-input, .en-textarea, .en-select {
    inline-size: 100%;
    font: ${I(`--en-font-input-weight`)} ${I(`--en-font-input-size`)} / ${I(`--en-font-input-line-height`)} ${I(`--en-font-input-family`)}; font-style: ${I(`--en-font-input-style`)}; letter-spacing: ${I(`--en-font-input-tracking`)};
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
    padding-block: ${wn};
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
  .en-input::placeholder, .en-textarea::placeholder { color: ${I(`--en-color-text-muted`)}; opacity: 1; }
  .en-text-input, .en-textarea { padding-block: ${wn}; }
  .en-textarea { resize: block; }
  .en-input[aria-invalid='true'], .en-textarea[aria-invalid='true'], .en-select[aria-invalid='true'], .en-control[data-invalid] {
    border-color: ${I(`--en-color-danger-text`)};
  }
  .en-input:user-invalid, .en-textarea:user-invalid, .en-select:user-invalid { border-color: ${I(`--en-color-danger-text`)}; }
  /* The text-field marker keeps stronger invalid geometry out of other native controls.
     Preserve border + padding on each edge, including scoped padding/base-border tokens. */
  .en-text-input:is([aria-invalid='true'], :user-invalid) {
    border-width: ${zt};
    padding-block: max(0px, calc(${wn} + ${q} - ${zt}));
    padding-inline: max(0px, calc(${X} + ${q} - ${zt}));
  }
  ${Vt(c`:is(.en-input, .en-textarea, .en-select, .en-number-group)`,c`:is(.en-input, .en-textarea, .en-select)[aria-invalid='true'], :is(.en-input, .en-textarea, .en-select):user-invalid, .en-number-group[data-invalid]`)}
  .en-input-group { display: flex; align-items: stretch; gap: ${I(`--en-space-1`)}; min-inline-size: 0; }
  .en-input-group > .en-input { flex: 1 1 auto; inline-size: 0; min-inline-size: 0; }
  .en-number-group {
    gap: 0;
    padding: 0;
    border: ${q} solid ${L(`--en-input-border-color`,L(`--en-control-border-color`,I(`--en-color-boundary`)))};
    border-radius: ${Cn};
    background: ${L(`--en-input-background`,L(`--en-control-background`,I(`--en-color-surface`)))};
  }
  .en-number-group[data-invalid] { border-color: ${L(`--en-input-invalid-border-color`,I(`--en-color-danger-text`))}; }
  .en-number-group > :is(.en-number-input, .en-number-step, button.en-button.en-number-step) { min-block-size: max(calc(var(--_en-text-control-block-size) - 2 * ${q}), ${I(`--en-size-target-min`)}); }
  .en-number-group > .en-number-input { border: 0; border-radius: 0; background: none; appearance: textfield; }
  .en-number-input::-webkit-inner-spin-button, .en-number-input::-webkit-outer-spin-button { appearance: none; margin: 0; }
  .en-number-step {
    flex: none;
    min-inline-size: ${G()};
    padding-inline: ${I(`--en-space-control-block`)};
    border: 0;
    border-inline-start: ${I(`--en-border-width`)} solid ${I(`--en-color-line`)};
    border-radius: 0;
    background: ${I(`--en-color-surface-subtle`)};
    color: ${I(`--en-color-text`)};
  }
  /* Match the frame's override as well as its token. Keep overflow visible so
     consumer-defined outward focus contours remain intact. */
  .en-number-step:not(:disabled):not([aria-disabled='true']):active { background: var(--en-button-pressed-background, ${I(`--en-color-accent-subtle`)}); }
  .en-number-step:last-child { border-start-end-radius: ${Z}; border-end-end-radius: ${Z}; }
  .en-number-step:first-child { border-inline-start: 0; border-inline-end: ${I(`--en-border-width`)} solid ${I(`--en-color-line`)}; border-start-start-radius: ${Z}; border-end-start-radius: ${Z}; }

  .en-color-control { cursor: pointer; padding: ${I(`--en-space-control-block`)}; block-size: var(--_en-text-control-block-size); }
  .en-color-control::-webkit-color-swatch-wrapper { padding: 0; }
  .en-color-control::-webkit-color-swatch { border: ${I(`--en-border-width`)} solid ${I(`--en-color-boundary`)}; border-radius: max(0px, ${I(`--en-radius-control`)} - ${I(`--en-space-control-block`)}); }
  .en-color-control::-moz-color-swatch { border: ${I(`--en-border-width`)} solid ${I(`--en-color-boundary`)}; border-radius: max(0px, ${I(`--en-radius-control`)} - ${I(`--en-space-control-block`)}); }
  ${Xt}
  .en-checkbox, .en-switch {
    flex: none;
    inline-size: ${L(`--en-choice-size`,I(`--en-size-icon`))};
    block-size: ${L(`--en-choice-size`,I(`--en-size-icon`))};
    margin: 0;
    accent-color: ${I(`--en-color-action`)};
  }
  .en-checkbox {
    appearance: none;
    display: inline-grid;
    place-items: center;
    box-sizing: border-box;
    border: ${I(`--en-border-width`)} solid ${I(`--en-color-boundary`)};
    background: ${I(`--en-color-surface`)};
    cursor: pointer;
  }
  .en-checkbox { border-radius: ${I(`--en-radius-choice`)}; }
  .en-checkbox:checked, .en-checkbox:indeterminate { background: ${I(`--en-color-action`)}; border-color: ${I(`--en-color-action`)}; }
  .en-checkbox:checked::before {
    content: '';
    box-sizing: border-box;
    inline-size: ${I(`--en-size-choice-mark-inline`)};
    block-size: ${I(`--en-size-choice-mark-block`)};
    /* The check is directional artwork, not an inline-layout edge; never mirror it in RTL. */
    border-right: ${I(`--en-size-choice-mark-stroke`)} solid ${I(`--en-color-on-action`)};
    border-bottom: ${I(`--en-size-choice-mark-stroke`)} solid ${I(`--en-color-on-action`)};
    transform: rotate(45deg);
  }
  .en-checkbox:indeterminate::before { content: ''; inline-size: ${I(`--en-size-choice-mark-block`)}; block-size: 0; border: 0; border-block-end: ${I(`--en-size-choice-mark-stroke`)} solid ${I(`--en-color-on-action`)}; transform: none; }
  .en-checkbox:disabled { cursor: default; background: ${I(`--en-color-surface-subtle`)}; border-color: ${I(`--en-color-boundary`)}; }
  .en-checkbox:disabled::before { border-color: ${I(`--en-color-text-muted`)}; }
  .en-switch {
    position: relative;
    appearance: none;
    box-sizing: border-box;
    inline-size: ${L(`--en-switch-inline-size`,I(`--en-size-switch-inline`))};
    block-size: ${L(`--en-switch-block-size`,I(`--en-size-switch-block`))};
    border: ${I(`--en-border-width`)} solid ${I(`--en-color-boundary`)};
    border-radius: ${I(`--en-radius-pill`)};
    background: ${I(`--en-color-surface-subtle`)};
    cursor: pointer;
  }
  .en-switch::before {
    content: '';
    pointer-events: none;
    position: absolute;
    inset-block-start: ${I(`--en-space-switch-inset`)};
    inset-inline-start: ${I(`--en-space-switch-inset`)};
    --_en-switch-thumb-inline: ${L(`--en-switch-thumb-size`,I(`--en-size-switch-thumb`))};
    inline-size: var(--_en-switch-thumb-inline);
    block-size: ${L(`--en-switch-thumb-size`,I(`--en-size-switch-thumb`))};
    border-radius: ${I(`--en-radius-pill`)};
    background: ${I(`--en-color-text-muted`)};
    transition: inset-inline-start var(--_en-press-duration, ${I(`--en-duration-fast`)}) ${I(`--en-ease-standard`)}, inline-size var(--_en-press-duration, ${I(`--en-duration-fast`)}) ${I(`--en-ease-standard`)};
  }
  .en-switch:checked { background: ${I(`--en-color-action`)}; border-color: ${I(`--en-color-action`)}; }
  .en-switch:checked::before { inset-inline-start: calc(100% - var(--_en-switch-thumb-inline) - ${I(`--en-space-switch-inset`)}); background: ${I(`--en-color-on-action`)}; }
  .en-switch:not(:disabled):is(:active, .en-choice:active > .en-switch)::before { --_en-switch-thumb-inline: clamp(0px, var(--en-switch-thumb-pressed-size, var(--en-switch-thumb-size, ${I(`--en-size-switch-thumb`)})), calc(100% - 2 * ${I(`--en-space-switch-inset`)})); }
  @media (prefers-reduced-motion: reduce) { .en-switch:is(:active, .en-choice:active > .en-switch)::before { --_en-switch-thumb-inline: var(--en-switch-thumb-size, ${I(`--en-size-switch-thumb`)}); transition: none; } }
  :host([data-press=none]) .en-switch:is(:active, .en-choice:active > .en-switch)::before { --_en-switch-thumb-inline: var(--en-switch-thumb-size, ${I(`--en-size-switch-thumb`)}); }
  .en-switch:disabled { cursor: default; border-color: ${I(`--en-color-boundary`)}; background: ${I(`--en-color-surface-subtle`)}; }
  :is(.en-checkbox, .en-switch):not(:disabled):active { border-color: ${I(`--en-color-action-pressed`)}; }
  .en-switch:disabled::before { background: ${I(`--en-color-text-muted`)}; }
  .en-range { inline-size: 100%; min-inline-size: ${I(`--en-size-target-min`)}; min-block-size: ${G()}; margin: 0; accent-color: ${I(`--en-color-action`)}; }
  .en-range-row { display: flex; align-items: center; gap: ${I(`--en-space-3`)}; min-inline-size: 0; }
  .en-range-row > .en-range { flex: 1 1 auto; inline-size: 0; }
  .en-range-row[data-editable] { flex-wrap: wrap; }
  .en-range-row > .en-range-editor {
    flex: 0 1 calc(3 * ${I(`--en-size-control-min`)});
    inline-size: calc(3 * ${I(`--en-size-control-min`)});
    min-inline-size: min(100%, ${I(`--en-size-target-min`)});
    font-variant-numeric: tabular-nums;
  }
  /* The value axis alone becomes vertical. Labels, output and number editing
     retain the surrounding writing direction and normal text layout. */
  .en-range-row[data-orientation='vertical'] { flex-direction: column; flex-wrap: nowrap; }
  .en-range-row[data-orientation='vertical'] > .en-range {
    writing-mode: vertical-lr;
    direction: rtl;
    flex: none;
    inline-size: ${L(`--en-slider-length`,I(`--en-size-range-length`))};
    min-inline-size: ${G()};
    block-size: ${G()};
  }
  .en-range-row[data-orientation='vertical'] > .en-range-editor {
    flex: none;
    inline-size: min(100%, calc(3 * ${I(`--en-size-control-min`)}));
  }
  .en-range-error[data-pending] { visibility: hidden; }
  .en-range-row > output { flex: none; font-variant-numeric: tabular-nums; color: ${I(`--en-color-text`)}; }
  ${R(c`.en-checkbox`,c`.en-checkbox:not(:disabled):not([data-press='none']):is(:active, .en-choice:active > .en-checkbox)`,K.checkbox)}
  ${R(c`.en-switch`,c`.en-switch:not(:disabled):not([data-press='none']):is(:active, .en-choice:active > .en-switch)`,K.switch)}
  ${R(c`.en-select`,c`.en-select:not(:disabled):not([data-press='none']):active`,K.select)}
  ${R(c`.en-number-step`,c`.en-number-step:not(:disabled):not([aria-disabled='true']):not([data-press='none']):active`,K[`number-step`])}
  ${rn}
  ${on}
  ${V(c`.en-number-group > .en-number-input`,{family:`input`,inset:!0,halo:!1})}
  ${V(c`.en-number-group > .en-number-step`,{family:`button`,inset:!0,halo:!1})}
  ${un}
  @media (any-pointer: coarse) {
    ${mn(c`.en-button:not(.en-icon-button), .en-button[data-icon-only], .en-input, .en-textarea, .en-select, .en-number-input, .en-number-step, .en-color-control`,!0)}
    ${vn(c`.en-button, .en-control, .en-input, .en-textarea, .en-select, .en-range`)}
    .en-range-row[data-orientation='vertical'] > .en-range { min-inline-size: ${G(!0)}; }
    ${gn(c`.en-button:not(.en-icon-button), .en-input, .en-textarea, .en-select`)}
    .en-color-control { block-size: var(--_en-text-control-block-size); }
    ${yn(c`.en-icon-button, .en-number-step`)}
    .en-number-group > :is(.en-number-input, .en-number-step, button.en-button.en-number-step) { min-block-size: max(calc(var(--_en-text-control-block-size) - 2 * ${q}), ${W(!0)}); }
  }
  @media (prefers-reduced-motion: reduce) { ${bn(c`.en-button, .en-switch::before`)} }
  @media (forced-colors: active) {
    ${xn(c`.en-button, .en-control, .en-input, .en-textarea, .en-select, .en-number-group`)}
    ${pn}
    ${Sn(c`:is(.en-button, .en-control, .en-input, .en-textarea, .en-select):is(:disabled, [aria-disabled='true']), .en-link[aria-disabled='true']`)}
    ${nn}
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
  ${Rt}
`),En=L(`--en-option-list-radius`,L(`--en-overlay-radius`,I(`--en-radius-container`))),Dn=c`max(${L(`--en-option-list-padding`,L(`--en-overlay-padding`,I(`--en-space-1`)))}, ${B({family:`option`,inset:!0})})`,On=U(c`
  .en-select { min-inline-size: 0; max-inline-size: 100%; white-space: nowrap; text-overflow: ellipsis; }
  .en-select > button { display: none; }
  /* Styling the closed control does not replace its OS picker. Keep this
     fallback outside base-select; ordinary select pseudos are not portable. */
  @supports selector(:has(> .en-select)) {
    @supports not ((appearance: base-select) and selector(::picker(select))) {
      .en-select {
        -webkit-appearance: none;
        appearance: none;
        padding-inline-end: calc(${X} + ${I(`--en-size-icon`)} + ${I(`--en-space-icon-label`)});
        min-block-size: max(var(--_en-text-control-block-size), calc(${I(`--en-size-icon`)} + 2 * ${I(`--en-space-control-block`)} + 2 * ${I(`--en-border-width`)}));
      }
      .en-field-focus-frame:has(> .en-select)::before {
        content: '';
        position: absolute;
        z-index: 1;
        inset-inline-end: calc(${X} + ${I(`--en-border-width`)});
        inset-block-start: 50%;
        translate: 0 -50%;
        inline-size: ${I(`--en-size-icon`)};
        block-size: ${I(`--en-size-icon`)};
        color: ${I(`--en-color-text-muted`)};
        background-color: currentColor;
        mask: ${Ht} center / contain no-repeat;
        pointer-events: none;
      }
      @media (forced-colors: active) {
        .en-field-focus-frame:has(> .en-select)::before { forced-color-adjust: none; color: ButtonText; }
        .en-field-focus-frame:has(> .en-select:disabled)::before { color: GrayText; }
      }
    }
  }
  @supports (appearance: base-select) and selector(::picker(select)) {
    .en-select, .en-select::picker(select) { appearance: ${L(`--en-select-appearance`,c`base-select`)}; }
    .en-select { align-items: center; gap: ${I(`--en-space-icon-label`)}; }
    /* Give the browser-owned label a shrinkable box separate from the caret.
       The implicit select button's anonymous text cannot be truncated reliably. */
    .en-select > button { all: unset; display: block; flex: 1; min-inline-size: 0; }
    .en-select selectedcontent { display: block; min-inline-size: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .en-select::picker(select) {
      padding: ${Dn};
      border: ${I(`--en-border-width`)} solid ${L(`--en-option-list-border-color`,L(`--en-overlay-border-color`,I(`--en-color-boundary`)))};
      border-radius: ${En};
      background: ${L(`--en-option-list-background`,L(`--en-overlay-background`,I(`--en-color-surface-raised`)))};
      color: ${L(`--en-option-list-color`,L(`--en-overlay-color`,I(`--en-color-text`)))};
      box-shadow: ${L(`--en-option-list-shadow`,I(`--en-shadow-overlay`))};
      max-block-size: min(${L(`--en-option-list-max-block-size`,L(`--en-overlay-max-block-size`,I(`--en-layout-panel-preferred`)))}, calc(100dvh - ${I(`--en-space-8`)}));
      overflow: auto;
    }
    ${Y(c`.en-select`,c`.en-select:open`,c`.en-select:not(:open)`,`fade`,c`::picker(select)`)}
    .en-select option {
      white-space: normal; overflow-wrap: anywhere;
      position: relative;
      min-block-size: ${G()};
      padding: ${L(`--en-option-block-padding`,I(`--en-space-control-block`))} ${L(`--en-option-inline-padding`,I(`--en-space-control-inline`))};
      border-radius: ${L(`--en-option-radius`,c`max(0px, ${En} - ${Dn} - ${I(`--en-border-width`)})`)};
    }
    .en-select option + option { margin-block-start: ${L(`--en-option-list-gap`,c`0px`)}; }
    ${Zt({base:c`.en-select option`,selected:c`.en-select option:checked`,hover:c`.en-select option:not(:disabled):hover`,focus:c`.en-select option:not(:disabled):focus-visible`,pressed:c`.en-select option:not(:disabled):active`,disabled:c`.en-select option:disabled`,restBackground:c`transparent`,restColor:L(`--en-option-list-color`,L(`--en-overlay-color`,c`inherit`)),selectedColor:L(`--en-option-list-color`,L(`--en-overlay-color`,I(`--en-color-action-text`))),hoverBackground:I(`--en-color-selected`)})}
    .en-select option:not(:disabled):focus-visible { z-index: 1; }
    @media (hover: hover) { .en-select option:not(:disabled):hover { z-index: 1; } }
    /* Native :active is pressed activation, not the combobox's keyboard candidate. */
    ${H(c`.en-select option:not(:disabled):focus-visible`,{family:`option`,inset:!0,restSelector:c`.en-select option`})}
    @media (hover: hover) { ${H(c`.en-select option:not(:disabled):hover`,{family:`option`,inset:!0,restSelector:c`.en-select option`})} }
    .en-select::picker-icon {
      content: '';
      inline-size: ${I(`--en-size-icon`)};
      block-size: ${I(`--en-size-icon`)};
      flex: none;
      color: ${I(`--en-color-text-muted`)};
      background-color: currentColor;
      mask: ${Ht} center / contain no-repeat;
    }
    @media (any-pointer: coarse) { .en-select option { min-block-size: ${G(!0)}; } }
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
`),kn=U(c`
  .en-field, .en-rating-field { --_en-field-gap: ${L(`--en-field-gap`,I(`--en-space-label-control`))}; }
  .en-field { display: flex; flex-direction: column; min-inline-size: 0; gap: 0; }
  .en-field > :not(:first-child):not(.en-description),
  .en-choice-content > :not(:first-child):not(.en-description) { margin-block-start: var(--_en-field-gap); }
  /* A fieldset legend already separates its first content through its margin. */
  .en-field > .en-legend + :not(.en-description) { margin-block-start: 0; }
  .en-label { display: block; color: ${I(`--en-color-text`)}; font-weight: ${I(`--en-font-label-strong-weight`)}; overflow-wrap: break-word; }
  ${Ut}
  .en-error { margin: 0; font-size: ${I(`--en-font-ui-size`)}; line-height: ${I(`--en-font-body-line-height`)}; overflow-wrap: break-word; }
  .en-error { color: ${I(`--en-color-danger-text`)}; }
  .en-choice { display: flex; align-items: center; gap: ${I(`--en-space-icon-label`)}; min-block-size: ${G()}; min-inline-size: ${I(`--en-size-target-min`)}; cursor: pointer; }
  .en-choice > :where(.en-label, .en-choice-content) { min-inline-size: 0; }
  .en-choice-content { --_en-field-gap: ${L(`--en-field-gap`,I(`--en-space-control-description`))}; display: flex; flex-direction: column; gap: 0; }
  .en-fieldset { margin: 0; padding: 0; min-inline-size: 0; border: 0; }
  .en-legend { padding: 0; margin-block-end: ${I(`--en-space-label-control`)}; font-weight: ${I(`--en-font-label-strong-weight`)}; }
  .en-form-stack { display: flex; flex-direction: column; gap: ${I(`--en-space-fields`)}; }
  .en-validation-summary { padding: ${I(`--en-space-panel`)}; border: ${I(`--en-border-width`)} solid ${I(`--en-color-danger-text`)}; border-radius: ${I(`--en-radius-container`)}; }
  .en-validation-summary :where(ul, ol) { padding-inline-start: ${I(`--en-space-6`)}; }
  @media (any-pointer: coarse) { .en-choice { min-block-size: ${G(!0)}; min-inline-size: ${W(!0)}; } }
  @media (forced-colors: active) { .en-label, .en-error { color: CanvasText; } .en-validation-summary { border-color: CanvasText; } }
`),An=U(c`
  .en-adorned { display:flex !important; align-items:center; border:${q} solid ${L(`--en-input-border-color`,I(`--en-color-boundary`))}; border-radius:${Bt}; background:${L(`--en-input-background`,I(`--en-color-surface`))}; }
  .en-adorned > input { flex:1; min-inline-size:0; border:0; background:transparent; }
  .en-adorned:has(:focus-visible) { outline:var(--en-input-focus-width, ${I(`--en-focus-width`)}) solid var(--en-input-focus-color, ${I(`--en-color-focus`)}); outline-offset:var(--en-input-focus-offset, ${I(`--en-focus-offset`)}); }
  .en-adorned > input:focus-visible { outline:none; box-shadow:none; }
  .en-adorned[data-invalid] { border-color:var(--en-input-invalid-border-color, ${I(`--en-color-danger-text`)}); }
  .en-adorned slot::slotted(*) { margin-inline:${I(`--en-space-2`)}; }
  ${Lt(c`.en-adorned`,c`.en-adorned slot[name='help-action']::slotted(*)`,Bt,q)}
`),jn=`(width < ${gt(`--en-layout-dialog-collapse`)})`,Mn=U(c`
  .en-dialog, .en-drawer, .en-popover, .en-tooltip {
    box-sizing: border-box;
    min-inline-size: 0;
    max-inline-size: min(${L(`--en-overlay-max-inline-size`,I(`--en-layout-form-max`))}, calc(100% - ${I(`--en-space-8`)}));
    max-block-size: ${L(`--en-overlay-max-block-size`,c`calc(100dvh - ${I(`--en-space-8`)})`)};
    padding: ${L(`--en-overlay-padding`,I(`--en-space-panel`))};
    border: ${I(`--en-border-width`)} solid ${L(`--en-overlay-border-color`,I(`--en-color-boundary`))};
    border-radius: ${L(`--en-overlay-radius`,I(`--en-radius-dialog`))};
    background: ${L(`--en-overlay-background`,I(`--en-color-surface-raised`))};
    color: ${L(`--en-overlay-color`,I(`--en-color-text`))};
    font: inherit;
    text-align: start;
    overflow: auto;
    box-shadow: ${I(`--en-shadow-overlay`)};
  }
  ${Y(c`.en-popover[popover]`,c`.en-popover:popover-open`,c`.en-popover[popover]:not(:popover-open)`,`fade`)}
  ${Y(c`.en-tooltip[popover]`,c`.en-tooltip:popover-open`,c`.en-tooltip[popover]:not(:popover-open)`,`fade`)}
  ${Yt}
  .en-dialog { position: fixed; inset: 0; margin: auto; box-shadow: ${I(`--en-shadow-dialog`)}; }
  dialog.en-dialog, dialog.en-drawer { flex-direction: column; gap: ${I(`--en-space-4`)}; }
  dialog.en-dialog[open], dialog.en-drawer[open] { display: flex; }
  dialog.en-dialog:not([open]), dialog.en-drawer:not([open]) { display: none; }
  .en-dialog::backdrop, .en-drawer::backdrop { background: ${I(`--en-color-scrim`)}; }
  /* Optional guidance contributes flex items only when native slot content exists.
     The stable description target adds no flex gap of its own. */
  .en-overlay-description, .en-overlay-description > slot { display: contents; }
  .en-overlay-description-fallback,
  .en-overlay-description > slot::slotted(:not([hidden])) { display: block; margin: 0; overflow-wrap: break-word; }
  .en-overlay-description-fallback:empty { display: none; }
  .en-overlay-header, .en-overlay-footer { display: flex; align-items: center; flex-wrap: wrap; gap: ${I(`--en-space-3`)}; min-inline-size: 0; }
  .en-overlay-header { justify-content: space-between; }
  .en-overlay-footer { justify-content: flex-end; gap: ${I(`--en-space-actions`)}; }
  .en-overlay-header > slot, .en-overlay-footer > slot { display: contents; }
  .en-overlay-body {
    --_en-overlay-focus-clearance: ${Dt};
    min-inline-size: 0;
    min-block-size: 0;
    /* Expand the scrollport without moving content or changing the surrounding gaps. */
    margin: calc(0px - var(--_en-overlay-focus-clearance));
    padding: var(--_en-overlay-focus-clearance);
    scroll-padding: var(--_en-overlay-focus-clearance);
    overflow: auto;
  }
  .en-overlay-close { margin-inline-start: auto; }
  .en-popover { position: fixed; display: flex; flex-direction: column; margin: 0; row-gap: ${I(`--en-space-4`)}; border-radius: ${L(`--en-overlay-radius`,I(`--en-radius-container`))}; }
  [popover].en-popover:not(:popover-open), [popover].en-tooltip:not(:popover-open) { display: none; }
  .en-tooltip { position: fixed; inline-size: max-content; margin: 0; row-gap: ${I(`--en-space-2`)}; padding: ${L(`--en-overlay-padding`,I(`--en-space-2`))}; border-radius: ${L(`--en-overlay-radius`,I(`--en-radius-control`))}; overflow-wrap: break-word; }
  .en-overlay-content { display:contents; }
  [data-arrow].en-popover, [data-arrow].en-tooltip { overflow:visible; padding:0; }
  [data-arrow] > .en-overlay-content {
    display:flex; flex-direction:column; gap:inherit; min-block-size:0; min-inline-size:0;
    max-block-size:inherit; box-sizing:border-box; overflow:auto; border-radius:inherit;
    padding:${L(`--en-overlay-padding`,I(`--en-space-panel`))};
  }
  .en-tooltip[data-arrow] > .en-overlay-content { display:block; padding:${L(`--en-overlay-padding`,I(`--en-space-2`))}; }
  .en-overlay-arrow {
    position:absolute; width:calc(2 * ${L(`--en-overlay-arrow-size`,I(`--en-space-2`))});
    height:${L(`--en-overlay-arrow-size`,I(`--en-space-2`))};
    overflow:visible; pointer-events:none; visibility:hidden; transform-origin:50% 0;
    fill:${L(`--en-overlay-background`,I(`--en-color-surface-raised`))};
    stroke:${L(`--en-overlay-border-color`,I(`--en-color-boundary`))}; stroke-width:${I(`--en-border-width`)};
  }
  @media (forced-colors:active) { .en-overlay-arrow { fill:Canvas; stroke:CanvasText; } }
  /* An outside separator is clipped at viewport-flush edges, even for a drawer
     that fills the whole viewport. Keep it separate from the immediate focus cue. */
  :where(.en-drawer) { outline: ${I(`--en-border-width`)} solid ${L(`--en-overlay-border-color`,I(`--en-color-boundary`))}; outline-offset: 0; }
  ${V(c`:where(.en-dialog, .en-drawer)`,{family:`overlay`,baseShadow:I(`--en-shadow-dialog`),baseTransitions:Jt})}
  ${V(c`.en-popover`,{family:`overlay`,baseShadow:I(`--en-shadow-overlay`),baseTransitions:Jt})}
  .en-drawer {
    position: fixed;
    margin: 0;
    inset: auto;
    inset-block: 0;
    inset-inline-end: 0;
    inline-size: min(${L(`--en-overlay-max-inline-size`,I(`--en-layout-form-max`))}, 100%);
    max-inline-size: 100%;
    block-size: 100%;
    max-block-size: 100%;
    border-radius: 0;
    border-width: 0;
    box-shadow: ${I(`--en-shadow-dialog`)};
  }
  .en-drawer[data-placement='start'] { inset-inline-end: auto; inset-inline-start: 0; }
  .en-drawer[data-placement='left'] { inset-inline: auto; left: 0; right: auto; }
  .en-drawer[data-placement='right'] { inset-inline: auto; left: auto; right: 0; }
  .en-drawer[data-placement='top'], .en-drawer[data-placement='bottom'] { inset-inline: 0; inline-size: 100%; block-size: auto; max-block-size: ${L(`--en-overlay-max-block-size`,c`calc(100dvh - ${I(`--en-space-8`)})`)}; }
  .en-drawer[data-placement='top'] { inset-block-start: 0; inset-block-end: auto; }
  .en-drawer[data-placement='bottom'] { inset-block-start: auto; inset-block-end: 0; }
  @media (forced-colors: active) {
    .en-dialog, .en-drawer, .en-popover, .en-tooltip { color: CanvasText; background: Canvas; border-color: CanvasText; box-shadow: none; }
    :where(.en-drawer) { outline-color: CanvasText; }
    :where(.en-dialog, .en-drawer, .en-popover):focus-visible { outline-color: Highlight; }
  }
`);function Nn(e){let t=e.getRootNode();return(t.nodeType===9||t.nodeType===11&&`host`in t)&&`getElementById`in t?t:null}var Pn=new WeakMap,Fn=class{root;subscribers=new Map;resolved=new Map;observer;constructor(e){this.root=e;let t=(e.nodeType===9?e:e.ownerDocument)?.defaultView?.MutationObserver;this.observer=t?new t(e=>{let t=new Set;for(let n of e){if(n.type===`childList`){if(![...n.addedNodes,...n.removedNodes].some(e=>e.nodeType===1))continue;for(let e of this.subscribers.keys())t.add(e);break}n.oldValue&&t.add(n.oldValue);let e=n.target.id;e&&t.add(e)}for(let e of t)this.notify(e)}):void 0,this.observer?.observe(e,{childList:!0,subtree:!0,attributes:!0,attributeFilter:[`id`],attributeOldValue:!0})}notify(e){let t=this.subscribers.get(e);if(!t)return;let n=this.root.getElementById(e);if(!(this.resolved.has(e)&&this.resolved.get(e)===n)){this.resolved.set(e,n);for(let r of[...t])this.subscribers.get(e)===t&&t.has(r)&&r(n)}}subscribe(e,t){let n=this.subscribers.get(e);n||this.subscribers.set(e,n=new Set),n.add(t);let r=this.root.getElementById(e);if(!this.resolved.has(e)||this.resolved.get(e)!==r){this.resolved.set(e,r);for(let t of[...n])this.subscribers.get(e)===n&&n.has(t)&&t(r)}else t(r);let i=!1;return()=>{i||(i=!0,n.delete(t),!n.size&&this.subscribers.get(e)===n&&(this.subscribers.delete(e),this.resolved.delete(e)),this.subscribers.size||(this.observer?.disconnect(),Pn.get(this.root)===this&&Pn.delete(this.root)))}}};function In(e,t,n){if(!e||!t)return n(null),()=>{};if(!(e.nodeType===9?e:e.ownerDocument)?.defaultView?.MutationObserver)return n(e.getElementById(t)),()=>{};let r=Pn.get(e);return r||Pn.set(e,r=new Fn(e)),r.subscribe(t,n)}function Ln(e,t,n){return!(!e.isConnected||!n?.isConnected||Nn(e)?.getElementById(t)!==n||n.disabled||n.loading||n.matches(`:disabled,[aria-disabled="true"]`))}function Rn(e,t){return e?.defaultPrevented||!t?!1:(e?.preventDefault(),!0)}function zn(e){let t=e.activeElement;for(;t?.shadowRoot?.activeElement;)t=t.shadowRoot.activeElement;return t}function Bn(e){if(!e?.isConnected||e.matches(`:disabled, [hidden], [aria-disabled="true"]`))return;let t=e;for(;t;){if(`inert`in t&&(t.inert||t.hidden))return;t=t.parentNode??(`host`in t?t.host:null)}e.getClientRects().length&&e.focus({preventScroll:!0})}function Vn(e,t){for(;t;){if(t===e)return!0;t=`assignedSlot`in t&&t.assignedSlot||t.parentNode||(`host`in t?t.host:null)}return!1}var Hn=U(c`
  ${mn(c`.en-button:not(.en-icon-button), .en-button[data-icon-only]`)}
  ${hn(c`.en-button`)}
  ${gn(c`.en-button:not(.en-icon-button)`)}
  ${$t}
  ${_n(c`:is(.en-button):is(:disabled, [aria-disabled='true'])`)}
  ${tn}
  @media (any-pointer: coarse) {
    ${mn(c`.en-button:not(.en-icon-button), .en-button[data-icon-only]`,!0)}
    ${vn(c`.en-button`)}
    ${gn(c`.en-button:not(.en-icon-button)`)}
    ${yn(c`.en-icon-button`)}
  }
  @media (prefers-reduced-motion: reduce) { ${bn(c`.en-button`)} }
  @media (forced-colors: active) {
    ${xn(c`.en-button`)}
    ${Sn(c`:is(.en-button):is(:disabled, [aria-disabled='true'])`)}
    ${nn}
  }
  ${Rt}
`),Un=U(c`
  .en-spinner {
    display: inline-block;
    flex: none;
    inline-size: ${I(`--en-size-spinner`)};
    block-size: ${I(`--en-size-spinner`)};
    border: ${I(`--en-size-spinner-stroke`)} solid currentColor;
    border-inline-end-color: ${I(`--en-color-line`)};
    border-radius: ${I(`--en-radius-pill`)};
    animation: en-style-spin ${I(`--en-duration-spin`)} linear infinite;
  }
  @keyframes en-style-spin { to { transform: rotate(1turn); } }
  .en-skeleton { display: block; inline-size: 100%; block-size: ${L(`--en-skeleton-size`,I(`--en-size-skeleton-line`))}; background: ${L(`--en-skeleton-color`,I(`--en-color-surface-subtle`))}; border-radius: ${I(`--en-radius-control`)}; }
  .en-skeleton[data-shape='circle'] { inline-size: ${L(`--en-skeleton-size`,I(`--en-size-avatar`))}; block-size: ${L(`--en-skeleton-size`,I(`--en-size-avatar`))}; border-radius: ${I(`--en-radius-pill`)}; }
  .en-skeleton[data-shape='rectangle'] { block-size: ${L(`--en-skeleton-size`,I(`--en-space-16`))}; }
  @media (prefers-reduced-motion: reduce) { .en-spinner { animation: none; } }
  @media (forced-colors: active) { .en-spinner { border-color: CanvasText; border-inline-end-color: GrayText; } .en-skeleton { background: Canvas; border: ${I(`--en-border-width`)} solid GrayText; } }
`),Q=e=>e??E,Wn=e=>C`
  <button
    class=${e.iconOnly?`en-button en-icon-button`:`en-button`}
    ?data-icon-only=${e.iconOnly}
    part="control"
    type="button"
    tabindex=${e.tabIndex??0}
    data-variant=${e.variant}
    data-size=${e.size}
    ?disabled=${e.disabled||e.loading}
    aria-pressed=${Q(e.pressed??void 0)}
    aria-busy=${e.loading?`true`:`false`}
    aria-haspopup=${Q(e.popupRole??void 0)}
    aria-expanded=${Q(e.popupExpanded??void 0)}
    aria-disabled=${Q(e.ariaDisabled??void 0)}
  >
    ${e.loading?C`<span class="en-spinner" part="indicator" aria-hidden="true"></span>`:null}
    <slot class="en-button__prefix" name="prefix"></slot>
    <span class="en-button__label" part="label"><slot name="label"><slot></slot></slot></span>
    <slot class="en-button__suffix" name="suffix"></slot>
  </button>
`,Gn=new WeakMap,$=new WeakMap;function Kn(e,t){Gn.set(e,{write:t})}function qn(e){let t=Gn.get(e);if(t){let e={};return t.owner=e,{set(n){t.owner===e&&t.write(n)},release(){t.owner===e&&(t.owner=void 0,t.write(0))}}}let n=$.get(e),r=e.getAttribute(`tabindex`),i={owner:{},original:n?.last===r?n.original:r};$.set(e,i);let a=!0;return{set(t){if(a&&$.get(e)===i){if(i.last!==void 0&&e.getAttribute(`tabindex`)!==i.last){a=!1,$.delete(e);return}i.last=String(t),e.getAttribute(`tabindex`)!==i.last&&e.setAttribute(`tabindex`,i.last)}},release(){a&&$.get(e)===i&&(a=!1,$.delete(e),i.last!==void 0&&e.getAttribute(`tabindex`)===i.last&&(i.original===null?e.removeAttribute(`tabindex`):e.setAttribute(`tabindex`,i.original)))}}}var Jn={tagName:`en-button`,elementClass:class extends ut{static properties={variant:{reflect:!0},disabled:{type:Boolean,reflect:!0},loading:{type:Boolean,reflect:!0},iconOnly:{type:Boolean,attribute:`icon-only`,reflect:!0},popupRole:{attribute:`aria-haspopup`},pressedSemantics:{attribute:`aria-pressed`},popupExpanded:{attribute:`aria-expanded`},disabledSemantics:{attribute:`aria-disabled`},descriptionIds:{attribute:`aria-describedby`,hasChanged:()=>!0}};static styles=[Nt,jt,Hn,Un];tabStop=0;constructor(){super(),this.variant=`primary`,this.disabled=!1,this.loading=!1,this.iconOnly=!1,this.popupRole=null,this.pressedSemantics=null,this.popupExpanded=null,this.disabledSemantics=null,this.addEventListener(`click`,e=>{this.getAttribute(`aria-disabled`)===`true`&&(e.preventDefault(),e.stopImmediatePropagation())},{capture:!0}),this.descriptionIds=null,Kn(this,e=>{if(this.tabStop===e)return;this.tabStop=e;let t=this.renderRoot?.querySelector(`button`);t&&(t.tabIndex=e),this.requestUpdate()})}connectedCallback(){super.connectedCallback(),this.requestUpdate()}focus(e){this.renderRoot.querySelector(`button`)?.focus(e)}get buttonPressed(){return[`true`,`false`,`mixed`].includes(this.pressedSemantics??``)?this.pressedSemantics:null}render(){return Wn({variant:this.variant,size:this.size,disabled:this.disabled,loading:this.loading,iconOnly:this.iconOnly,popupRole:this.popupRole,popupExpanded:this.popupExpanded,ariaDisabled:this.disabledSemantics,tabIndex:this.tabStop,pressed:this.buttonPressed})}updated(){let e=this.renderRoot.querySelector(`button`);if(!e)return;for(let[t,n]of[[`aria-pressed`,this.buttonPressed],[`aria-haspopup`,this.popupRole],[`aria-expanded`,this.popupExpanded],[`aria-disabled`,this.disabledSemantics]])n===null?e.hasAttribute(t)&&e.removeAttribute(t):e.getAttribute(t)!==n&&e.setAttribute(t,n);if(!(`ariaDescribedByElements`in e))return;let t=this.ariaDescribedByElements,n=e.ariaDescribedByElements;(n?.length!==t?.length||n?.some((e,n)=>e!==t?.[n]))&&(e.ariaDescribedByElements=t)}}};U(c`
  .en-alert { display: flex; align-items: flex-start; gap: ${I(`--en-space-3`)}; min-inline-size: 0; padding: ${I(`--en-space-4`)}; border: ${I(`--en-border-width`)} solid ${L(`--en-alert-border-color`,I(`--en-color-accent-border`))}; border-radius: ${I(`--en-radius-container`)}; background: ${L(`--en-alert-background`,I(`--en-color-surface`))}; color: ${L(`--en-alert-color`,I(`--en-color-text`))}; }
  .en-alert__icon { flex: none; color: ${I(`--en-color-action`)}; }
  .en-alert__content { min-inline-size: 0; flex: 1 1 auto; overflow-wrap: break-word; }
  .en-alert__close { flex: none; margin-inline-start: auto; }
  .en-alert[data-variant='success'] { border-color: ${L(`--en-alert-border-color`,I(`--en-color-success-text`))}; }
  .en-alert[data-variant='warning'] { border-color: ${L(`--en-alert-border-color`,I(`--en-color-warning-text`))}; }
  .en-alert[data-variant='danger'] { border-color: ${L(`--en-alert-border-color`,I(`--en-color-danger-text`))}; }
  .en-alert[data-variant='success'] .en-alert__icon { color: ${I(`--en-color-success-text`)}; }
  .en-alert[data-variant='warning'] .en-alert__icon { color: ${I(`--en-color-warning-text`)}; }
  .en-alert[data-variant='danger'] .en-alert__icon { color: ${I(`--en-color-danger-text`)}; }
  .en-badge { display: inline-flex; align-items: center; gap: ${I(`--en-space-icon-label`)}; max-inline-size: 100%; padding-block: ${I(`--en-space-badge-block`)}; padding-inline: ${I(`--en-space-badge-inline`)}; border: ${I(`--en-border-width`)} solid ${I(`--en-color-line`)}; border-radius: ${L(`--en-badge-radius`,I(`--en-radius-control`))}; background: ${L(`--en-badge-background`,I(`--en-color-surface-subtle`))}; color: ${L(`--en-badge-color`,I(`--en-color-text`))}; font-size: ${I(`--en-font-metadata-size`)}; line-height: ${I(`--en-font-metadata-line-height`)}; overflow-wrap: break-word; }
  .en-badge__prefix { display: contents; }
  .en-badge__label { min-inline-size: 0; }
  .en-badge[data-variant='accent'] { background: ${L(`--en-badge-background`,I(`--en-color-accent-subtle`))}; color: ${L(`--en-badge-color`,I(`--en-color-action-text`))}; }
  .en-badge:is([data-variant='success'], [data-variant='warning'], [data-variant='danger']) { background: ${L(`--en-badge-background`,I(`--en-color-surface`))}; }
  .en-badge[data-variant='success'] { color: ${L(`--en-badge-color`,I(`--en-color-success-text`))}; }
  .en-badge[data-variant='warning'] { color: ${L(`--en-badge-color`,I(`--en-color-warning-text`))}; }
  .en-badge[data-variant='danger'] { color: ${L(`--en-badge-color`,I(`--en-color-danger-text`))}; }
  .en-progress, .en-progress-track { display: block; inline-size: 100%; block-size: ${L(`--en-progress-size`,I(`--en-size-progress`))}; overflow: hidden; border: 0; border-radius: ${I(`--en-radius-pill`)}; background: ${L(`--en-progress-track-color`,I(`--en-color-surface-subtle`))}; }
  .en-progress { appearance: none; accent-color: ${L(`--en-progress-color`,I(`--en-color-action`))}; }
  .en-progress-fill { display: block; inline-size: clamp(0%, var(--en-progress-value, 0%), 100%); block-size: 100%; border-radius: inherit; background: ${L(`--en-progress-color`,I(`--en-color-action`))}; }
  .en-progress::-webkit-progress-bar { background: ${L(`--en-progress-track-color`,I(`--en-color-surface-subtle`))}; border-radius: inherit; }
  .en-progress::-webkit-progress-value { background: ${L(`--en-progress-color`,I(`--en-color-action`))}; border-radius: inherit; }
  .en-progress::-moz-progress-bar { background: ${L(`--en-progress-color`,I(`--en-color-action`))}; border-radius: inherit; }
  ${Un}
  @media (forced-colors: active) {
    .en-alert, .en-alert[data-variant], .en-badge, .en-badge[data-variant] { color: CanvasText; background: Canvas; border-color: CanvasText; }
    .en-alert__icon, .en-alert[data-variant] .en-alert__icon { color: CanvasText; }
    .en-progress, .en-progress-track { background: Canvas; border: ${I(`--en-border-width`)} solid CanvasText; }
    .en-progress-fill { background: Highlight; }
    .en-progress::-webkit-progress-bar { background: Canvas; }
    .en-progress::-webkit-progress-value { background: Highlight; }
    .en-progress::-moz-progress-bar { background: Highlight; }
  }
`);var Yn=U(c`
  .en-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; inline-size: ${L(`--en-icon-size`,I(`--en-size-icon`))}; block-size: ${L(`--en-icon-size`,I(`--en-size-icon`))}; vertical-align: middle; color: inherit; }
  svg.en-icon[data-logical]:dir(rtl) { scale:-1 1; }
  .en-icon > :where(svg, img), .en-icon ::slotted(svg), .en-icon ::slotted(img) { display: block; inline-size: 100%; block-size: 100%; }
  svg.en-icon, .en-icon > svg, .en-icon ::slotted(svg) { display: block; stroke-width: ${I(`--en-size-icon-stroke`)}; }
  .en-avatar { display: inline-grid; place-items: center; vertical-align: middle; flex: none; inline-size: ${L(`--en-avatar-size`,I(`--en-size-avatar`))}; block-size: ${L(`--en-avatar-size`,I(`--en-size-avatar`))}; overflow: hidden; border-radius: ${L(`--en-avatar-radius`,I(`--en-radius-pill`))}; background: ${I(`--en-color-surface-subtle`)}; color: ${I(`--en-color-text`)}; }
  .en-avatar__image { display: block; inline-size: 100%; block-size: 100%; object-fit: cover; }
  .en-avatar__fallback { font-weight: ${I(`--en-font-label-strong-weight`)}; }
  .en-media { display: block; max-inline-size: 100%; block-size: auto; border-radius: ${L(`--en-media-radius`,I(`--en-radius-container`))}; aspect-ratio: ${L(`--en-media-aspect-ratio`,c`auto`)}; }
  @media (forced-colors: active) { .en-avatar { color: CanvasText; background: Canvas; border: ${I(`--en-border-width`)} solid CanvasText; } }
`);U(c`
  :host { inline-size: max(${L(`--en-swatch-size`,I(`--en-size-swatch`))}, ${G(!1,I(`--en-size-target-min`))}); min-inline-size: ${G(!1,I(`--en-size-target-min`))}; }
  .en-swatch__sample { position: relative; display: block; appearance: none; inline-size: 100%; block-size: max(${L(`--en-swatch-size`,I(`--en-size-swatch`))}, ${G(!1,I(`--en-size-target-min`))}); min-inline-size: ${G(!1,I(`--en-size-target-min`))}; padding: 0; margin: 0; overflow: hidden; border: ${I(`--en-border-width`)} solid ${I(`--en-color-boundary`)}; border-radius: ${I(`--en-radius-control`)}; background: transparent; color: inherit; cursor: pointer; }
  @media (any-pointer: coarse) {
    :host { inline-size:max(${L(`--en-swatch-size`,I(`--en-size-swatch`))},${G(!0,I(`--en-size-target-min`))}); min-inline-size:${G(!0,I(`--en-size-target-min`))}; }
    .en-swatch__sample { min-inline-size:${G(!0,I(`--en-size-target-min`))}; min-block-size:${G(!0,I(`--en-size-target-min`))}; }
  }
  @media (hover: hover) { .en-swatch__sample:not(:disabled):hover { border-color: ${I(`--en-color-action`)}; } }
  .en-swatch__sample:not(:disabled):active { border-width: max(2px, ${I(`--en-border-width`)}); }
  .en-swatch__sample:disabled { cursor: default; }
  .en-swatch__color { display: block; inline-size: 100%; block-size: 100%; }
  ${rn}
  @media (forced-colors: active) {
    .en-swatch__sample { border-color: ButtonText; background: Canvas; }
  @media (hover: hover) { .en-swatch__sample:not(:disabled):hover { border-color: ButtonText; background: Canvas; } }
    .en-swatch__sample:disabled { border-color: GrayText; }
    .en-swatch__color { forced-color-adjust: none; }
  }
`);var Xn={bold:w`<path d="M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z" />`,italic:w`<path d="M10 4h9M5 20h9M15 4 9 20" />`,underline:w`<path d="M6 3v8a6 6 0 0 0 12 0V3M4 21h16" />`,"align-start":w`<path d="M4 5h16M4 10h10M4 15h16M4 20h10" />`,"align-center":w`<path d="M4 5h16M7 10h10M4 15h16M7 20h10" />`,"align-end":w`<path d="M4 5h16M10 10h10M4 15h16M10 20h10" />`,heading:w`<path d="M5 4v16M19 4v16M5 12h14" />`,paragraph:w`<path d="M13 4H9a5 5 0 0 0 0 10h4M13 4v16M18 4v16M9 4h12" />`,"bullet-list":w`<circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /><path d="M9 6h12M9 12h12M9 18h12" />`,"ordered-list":w`<path d="m3 4 1-1v6M3 9h3M3 15a1.5 1.5 0 0 1 3 0c0 1-3 3-3 4h3M10 6h11M10 12h11M10 18h11" />`,link:w`<path d="M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2" />`,unlink:w`<path d="m12 5 2-2a4 4 0 0 1 6 6l-2 2M6 13l-2 2a4 4 0 0 0 6 6l2-2M3 3l18 18" />`,undo:w`<path d="M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -2)" />`,redo:w`<path d="m15 4 6 6-6 6M21 10H10a6 6 0 0 0 0 12" transform="translate(0 -2)" />`,file:w`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" />`,calendar:w`<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4m10-4v4M3 11h18"></path>`,check:w`<path d="m5 12 4 4L19 6" />`,plus:w`<path d="M12 5v14M5 12h14" />`,close:w`<path d="m6 6 12 12M18 6 6 18" />`,"chevron-left":w`<path d="m15 6-6 6 6 6" />`,"chevron-right":w`<path d="m9 6 6 6-6 6" />`,"chevron-down":w`<path d="m6 9 6 6 6-6" />`,"arrow-right":w`<path d="M4 12h16m-6-6 6 6-6 6" />`,search:w`<circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />`,info:w`<circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" />`,warning:w`<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v1" />`,sparkles:w`<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4m-2-2h4" />`},Zn=(e,t)=>C`
  <svg
    class="en-icon"
    ?data-logical=${e===`align-start`||e===`align-end`}
    part="base"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    focusable="false"
    role=${t?`img`:E}
    aria-label=${t||E}
    aria-hidden=${t?E:`true`}
  >${Xn[e]??E}</svg>
`,Qn={tagName:`en-icon`,elementClass:class extends ut{static properties={name:{type:String},label:{type:String}};static styles=[Nt,Mt,Yn];constructor(){super(),this.name=`info`,this.label=``}render(){return Zn(this.name,this.label)}}};export{T as $,At as A,I as B,Ht as C,It as D,Pt as E,Ot as F,ut as G,dt as H,V as I,Xe as J,ct as K,H as L,kt as M,U as N,G as O,B as P,Le as Q,R,Jt as S,Ft as T,pt as U,ft as V,mt as W,j as X,We as Y,E as Z,kn as _,Hn as a,t as at,Zt as b,Bn as c,In as d,Te as et,Nn as f,Tn as g,An as h,Q as i,c as it,Nt as j,W as k,Rn as l,Mn as m,Jn as n,Fe as nt,Vn as o,e as ot,jn as p,rt as q,qn as r,w as rt,zn as s,Qn as t,C as tt,Ln as u,On as v,K as w,Y as x,rn as y,L as z};