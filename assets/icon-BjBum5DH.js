import{c as e,n as t,o as n,u as r}from"./lit-tfDubpWu.js";import{F as i,H as a,M as o,O as s,P as c,R as l,S as u,U as d,V as f,W as p,c as m,d as h,f as g,j as _,u as v}from"./controls-DTIvEShr.js";var y=c(r`.en-body, .en-prose, .en-heading-small, .en-heading-medium, .en-heading-large, .en-metadata, .en-data {
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
`);function b(e,t){e.inert===t&&(e.inert=!t)}function x(e){let t=e.currentTarget;e.target===t&&(e.newState===`open`&&b(t,!0),queueMicrotask(()=>{if(!t.isConnected)return;let e=t.localName===`dialog`?t.open:t.matches(`:popover-open`);b(t,e)}))}var S=`(width < ${d(`--en-layout-dialog-collapse`)})`,C=c(r`
  .en-dialog, .en-drawer, .en-popover, .en-tooltip {
    box-sizing: border-box;
    min-inline-size: 0;
    max-inline-size: min(${f(`--en-overlay-max-inline-size`,a(`--en-layout-form-max`))}, calc(100% - ${a(`--en-space-8`)}));
    max-block-size: ${f(`--en-overlay-max-block-size`,r`calc(100dvh - ${a(`--en-space-8`)})`)};
    padding: ${f(`--en-overlay-padding`,a(`--en-space-panel`))};
    border: ${a(`--en-border-width`)} solid ${f(`--en-overlay-border-color`,a(`--en-color-boundary`))};
    border-radius: ${f(`--en-overlay-radius`,a(`--en-radius-dialog`))};
    background: ${f(`--en-overlay-background`,a(`--en-color-surface-raised`))};
    color: ${f(`--en-overlay-color`,a(`--en-color-text`))};
    font: inherit;
    text-align: start;
    overflow: auto;
    box-shadow: ${a(`--en-shadow-overlay`)};
  }
  ${h(r`.en-popover[popover]`,r`.en-popover:popover-open`,r`.en-popover[popover]:not(:popover-open)`,`fade`)}
  ${h(r`.en-tooltip[popover]`,r`.en-tooltip:popover-open`,r`.en-tooltip[popover]:not(:popover-open)`,`fade`)}
  ${v}
  .en-dialog { position: fixed; inset: 0; margin: auto; box-shadow: ${a(`--en-shadow-dialog`)}; }
  dialog.en-dialog, dialog.en-drawer { flex-direction: column; gap: ${a(`--en-space-4`)}; }
  dialog.en-dialog[open], dialog.en-drawer[open] { display: flex; }
  dialog.en-dialog:not([open]), dialog.en-drawer:not([open]) { display: none; }
  .en-dialog::backdrop, .en-drawer::backdrop { background: ${a(`--en-color-scrim`)}; }
  /* Optional guidance contributes flex items only when native slot content exists.
     The stable description target adds no flex gap of its own. */
  .en-overlay-description, .en-overlay-description > slot { display: contents; }
  .en-overlay-description-fallback,
  .en-overlay-description > slot::slotted(:not([hidden])) { display: block; margin: 0; overflow-wrap: break-word; }
  .en-overlay-description-fallback:empty { display: none; }
  .en-overlay-header, .en-overlay-footer { display: flex; align-items: center; flex-wrap: wrap; gap: ${a(`--en-space-3`)}; min-inline-size: 0; }
  .en-overlay-header { justify-content: space-between; }
  .en-overlay-footer { justify-content: flex-end; gap: ${a(`--en-space-actions`)}; }
  .en-overlay-header > slot, .en-overlay-footer > slot { display: contents; }
  .en-overlay-body {
    --_en-overlay-focus-clearance: ${i};
    min-inline-size: 0;
    min-block-size: 0;
    /* Expand the scrollport without moving content or changing the surrounding gaps. */
    margin: calc(0px - var(--_en-overlay-focus-clearance));
    padding: var(--_en-overlay-focus-clearance);
    scroll-padding: var(--_en-overlay-focus-clearance);
    overflow: auto;
  }
  .en-overlay-close { margin-inline-start: auto; }
  .en-popover { position: fixed; display: flex; flex-direction: column; margin: 0; row-gap: ${a(`--en-space-4`)}; border-radius: ${f(`--en-overlay-radius`,a(`--en-radius-container`))}; }
  [popover].en-popover:not(:popover-open), [popover].en-tooltip:not(:popover-open) { display: none; }
  .en-tooltip { position: fixed; inline-size: max-content; margin: 0; row-gap: ${a(`--en-space-2`)}; padding: ${f(`--en-overlay-padding`,a(`--en-space-2`))}; border-radius: ${f(`--en-overlay-radius`,a(`--en-radius-control`))}; overflow-wrap: break-word; }
  .en-overlay-content { display:contents; }
  [data-arrow].en-popover, [data-arrow].en-tooltip { overflow:visible; padding:0; }
  [data-arrow] > .en-overlay-content {
    display:flex; flex-direction:column; gap:inherit; min-block-size:0; min-inline-size:0;
    max-block-size:inherit; box-sizing:border-box; overflow:auto; border-radius:inherit;
    padding:${f(`--en-overlay-padding`,a(`--en-space-panel`))};
  }
  .en-tooltip[data-arrow] > .en-overlay-content { display:block; padding:${f(`--en-overlay-padding`,a(`--en-space-2`))}; }
  .en-overlay-arrow {
    position:absolute; width:calc(2 * ${f(`--en-overlay-arrow-size`,a(`--en-space-2`))});
    height:${f(`--en-overlay-arrow-size`,a(`--en-space-2`))};
    overflow:visible; pointer-events:none; visibility:hidden; transform-origin:50% 0;
    fill:${f(`--en-overlay-background`,a(`--en-color-surface-raised`))};
    stroke:${f(`--en-overlay-border-color`,a(`--en-color-boundary`))}; stroke-width:${a(`--en-border-width`)};
  }
  @media (forced-colors:active) { .en-overlay-arrow { fill:Canvas; stroke:CanvasText; } }
  /* An outside separator is clipped at viewport-flush edges, even for a drawer
     that fills the whole viewport. Keep it separate from the immediate focus cue. */
  :where(.en-drawer) { outline: ${a(`--en-border-width`)} solid ${f(`--en-overlay-border-color`,a(`--en-color-boundary`))}; outline-offset: 0; }
  ${l(r`:where(.en-dialog, .en-drawer)`,{family:`overlay`,baseShadow:a(`--en-shadow-dialog`),baseTransitions:g})}
  ${l(r`.en-popover`,{family:`overlay`,baseShadow:a(`--en-shadow-overlay`),baseTransitions:g})}
  .en-drawer {
    position: fixed;
    margin: 0;
    inset: auto;
    inset-block: 0;
    inset-inline-end: 0;
    inline-size: min(${f(`--en-overlay-max-inline-size`,a(`--en-layout-form-max`))}, 100%);
    max-inline-size: 100%;
    block-size: 100%;
    max-block-size: 100%;
    border-radius: 0;
    border-width: 0;
    box-shadow: ${a(`--en-shadow-dialog`)};
  }
  .en-drawer[data-placement='start'] { inset-inline-end: auto; inset-inline-start: 0; }
  .en-drawer[data-placement='left'] { inset-inline: auto; left: 0; right: auto; }
  .en-drawer[data-placement='right'] { inset-inline: auto; left: auto; right: 0; }
  .en-drawer[data-placement='top'], .en-drawer[data-placement='bottom'] { inset-inline: 0; inline-size: 100%; block-size: auto; max-block-size: ${f(`--en-overlay-max-block-size`,r`calc(100dvh - ${a(`--en-space-8`)})`)}; }
  .en-drawer[data-placement='top'] { inset-block-start: 0; inset-block-end: auto; }
  .en-drawer[data-placement='bottom'] { inset-block-start: auto; inset-block-end: 0; }
  @media (forced-colors: active) {
    .en-dialog, .en-drawer, .en-popover, .en-tooltip { color: CanvasText; background: Canvas; border-color: CanvasText; box-shadow: none; }
    :where(.en-drawer) { outline-color: CanvasText; }
    :where(.en-dialog, .en-drawer, .en-popover):focus-visible { outline-color: Highlight; }
  }
`);function w(e){let t=e.getRootNode();return(t.nodeType===9||t.nodeType===11&&`host`in t)&&`getElementById`in t?t:null}var T=new WeakMap,E=class{root;subscribers=new Map;resolved=new Map;observer;constructor(e){this.root=e;let t=(e.nodeType===9?e:e.ownerDocument)?.defaultView?.MutationObserver;this.observer=t?new t(e=>{let t=new Set;for(let n of e){if(n.type===`childList`){if(![...n.addedNodes,...n.removedNodes].some(e=>e.nodeType===1))continue;for(let e of this.subscribers.keys())t.add(e);break}n.oldValue&&t.add(n.oldValue);let e=n.target.id;e&&t.add(e)}for(let e of t)this.notify(e)}):void 0,this.observer?.observe(e,{childList:!0,subtree:!0,attributes:!0,attributeFilter:[`id`],attributeOldValue:!0})}notify(e){let t=this.subscribers.get(e);if(!t)return;let n=this.root.getElementById(e);if(!(this.resolved.has(e)&&this.resolved.get(e)===n)){this.resolved.set(e,n);for(let r of[...t])this.subscribers.get(e)===t&&t.has(r)&&r(n)}}subscribe(e,t){let n=this.subscribers.get(e);n||this.subscribers.set(e,n=new Set),n.add(t);let r=this.root.getElementById(e);if(!this.resolved.has(e)||this.resolved.get(e)!==r){this.resolved.set(e,r);for(let t of[...n])this.subscribers.get(e)===n&&n.has(t)&&t(r)}else t(r);let i=!1;return()=>{i||(i=!0,n.delete(t),!n.size&&this.subscribers.get(e)===n&&(this.subscribers.delete(e),this.resolved.delete(e)),this.subscribers.size||(this.observer?.disconnect(),T.get(this.root)===this&&T.delete(this.root)))}}};function D(e,t,n){if(!e||!t)return n(null),()=>{};if(!(e.nodeType===9?e:e.ownerDocument)?.defaultView?.MutationObserver)return n(e.getElementById(t)),()=>{};let r=T.get(e);return r||T.set(e,r=new E(e)),r.subscribe(t,n)}function O(e,t,n){return!(!e.isConnected||!n?.isConnected||w(e)?.getElementById(t)!==n||n.disabled||n.loading||n.matches(`:disabled,[aria-disabled="true"]`))}function k(e,t){return e?.defaultPrevented||!t?!1:(e?.preventDefault(),!0)}function A(e){let t=e.activeElement;for(;t?.shadowRoot?.activeElement;)t=t.shadowRoot.activeElement;return t}function j(e){if(!e?.isConnected||e.matches(`:disabled, [hidden], [aria-disabled="true"]`))return;let t=e;for(;t;){if(`inert`in t&&(t.inert||t.hidden))return;t=t.parentNode??(`host`in t?t.host:null)}e.getClientRects().length&&e.focus({preventScroll:!0})}function M(e,t){for(;t;){if(t===e)return!0;t=`assignedSlot`in t&&t.assignedSlot||t.parentNode||(`host`in t?t.host:null)}return!1}var N=c(r`
  .en-alert { display: flex; align-items: flex-start; gap: ${a(`--en-space-3`)}; min-inline-size: 0; padding: ${a(`--en-space-4`)}; border: ${a(`--en-border-width`)} solid ${f(`--en-alert-border-color`,a(`--en-color-accent-border`))}; border-radius: ${a(`--en-radius-container`)}; background: ${f(`--en-alert-background`,a(`--en-color-surface`))}; color: ${f(`--en-alert-color`,a(`--en-color-text`))}; }
  .en-alert__icon { flex: none; color: ${a(`--en-color-action`)}; }
  .en-alert__content { min-inline-size: 0; flex: 1 1 auto; overflow-wrap: break-word; }
  .en-alert__close { flex: none; margin-inline-start: auto; }
  .en-alert[data-variant='success'] { border-color: ${f(`--en-alert-border-color`,a(`--en-color-success-text`))}; }
  .en-alert[data-variant='warning'] { border-color: ${f(`--en-alert-border-color`,a(`--en-color-warning-text`))}; }
  .en-alert[data-variant='danger'] { border-color: ${f(`--en-alert-border-color`,a(`--en-color-danger-text`))}; }
  .en-alert[data-variant='success'] .en-alert__icon { color: ${a(`--en-color-success-text`)}; }
  .en-alert[data-variant='warning'] .en-alert__icon { color: ${a(`--en-color-warning-text`)}; }
  .en-alert[data-variant='danger'] .en-alert__icon { color: ${a(`--en-color-danger-text`)}; }
  .en-badge { display: inline-flex; align-items: center; gap: ${a(`--en-space-icon-label`)}; max-inline-size: 100%; padding-block: ${a(`--en-space-badge-block`)}; padding-inline: ${a(`--en-space-badge-inline`)}; border: ${a(`--en-border-width`)} solid ${a(`--en-color-line`)}; border-radius: ${f(`--en-badge-radius`,a(`--en-radius-control`))}; background: ${f(`--en-badge-background`,a(`--en-color-surface-subtle`))}; color: ${f(`--en-badge-color`,a(`--en-color-text`))}; font-size: ${a(`--en-font-metadata-size`)}; line-height: ${a(`--en-font-metadata-line-height`)}; overflow-wrap: break-word; }
  .en-badge__prefix { display: contents; }
  .en-badge__label { min-inline-size: 0; }
  .en-badge[data-variant='accent'] { background: ${f(`--en-badge-background`,a(`--en-color-accent-subtle`))}; color: ${f(`--en-badge-color`,a(`--en-color-action-text`))}; }
  .en-badge:is([data-variant='success'], [data-variant='warning'], [data-variant='danger']) { background: ${f(`--en-badge-background`,a(`--en-color-surface`))}; }
  .en-badge[data-variant='success'] { color: ${f(`--en-badge-color`,a(`--en-color-success-text`))}; }
  .en-badge[data-variant='warning'] { color: ${f(`--en-badge-color`,a(`--en-color-warning-text`))}; }
  .en-badge[data-variant='danger'] { color: ${f(`--en-badge-color`,a(`--en-color-danger-text`))}; }
  .en-progress, .en-progress-track { display: block; inline-size: 100%; block-size: ${f(`--en-progress-size`,a(`--en-size-progress`))}; overflow: hidden; border: 0; border-radius: ${a(`--en-radius-pill`)}; background: ${f(`--en-progress-track-color`,a(`--en-color-surface-subtle`))}; }
  .en-progress { appearance: none; accent-color: ${f(`--en-progress-color`,a(`--en-color-action`))}; }
  .en-progress-fill { display: block; inline-size: clamp(0%, var(--en-progress-value, 0%), 100%); block-size: 100%; border-radius: inherit; background: ${f(`--en-progress-color`,a(`--en-color-action`))}; }
  .en-progress::-webkit-progress-bar { background: ${f(`--en-progress-track-color`,a(`--en-color-surface-subtle`))}; border-radius: inherit; }
  .en-progress::-webkit-progress-value { background: ${f(`--en-progress-color`,a(`--en-color-action`))}; border-radius: inherit; }
  .en-progress::-moz-progress-bar { background: ${f(`--en-progress-color`,a(`--en-color-action`))}; border-radius: inherit; }
  ${u}
  @media (forced-colors: active) {
    .en-alert, .en-alert[data-variant], .en-badge, .en-badge[data-variant] { color: CanvasText; background: Canvas; border-color: CanvasText; }
    .en-alert__icon, .en-alert[data-variant] .en-alert__icon { color: CanvasText; }
    .en-progress, .en-progress-track { background: Canvas; border: ${a(`--en-border-width`)} solid CanvasText; }
    .en-progress-fill { background: Highlight; }
    .en-progress::-webkit-progress-bar { background: Canvas; }
    .en-progress::-webkit-progress-value { background: Highlight; }
    .en-progress::-moz-progress-bar { background: Highlight; }
  }
`),P=c(r`
  .en-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; inline-size: ${f(`--en-icon-size`,a(`--en-size-icon`))}; block-size: ${f(`--en-icon-size`,a(`--en-size-icon`))}; vertical-align: middle; color: inherit; }
  svg.en-icon[data-logical]:dir(rtl) { scale:-1 1; }
  .en-icon > :where(svg, img), .en-icon ::slotted(svg), .en-icon ::slotted(img) { display: block; inline-size: 100%; block-size: 100%; }
  svg.en-icon, .en-icon > svg, .en-icon ::slotted(svg) { display: block; stroke-width: ${a(`--en-size-icon-stroke`)}; }
  .en-avatar { display: inline-grid; place-items: center; vertical-align: middle; flex: none; inline-size: ${f(`--en-avatar-size`,a(`--en-size-avatar`))}; block-size: ${f(`--en-avatar-size`,a(`--en-size-avatar`))}; overflow: hidden; border-radius: ${f(`--en-avatar-radius`,a(`--en-radius-pill`))}; background: ${a(`--en-color-surface-subtle`)}; color: ${a(`--en-color-text`)}; }
  .en-avatar__image { display: block; inline-size: 100%; block-size: 100%; object-fit: cover; }
  .en-avatar__fallback { font-weight: ${a(`--en-font-label-strong-weight`)}; }
  .en-media { display: block; max-inline-size: 100%; block-size: auto; border-radius: ${f(`--en-media-radius`,a(`--en-radius-container`))}; aspect-ratio: ${f(`--en-media-aspect-ratio`,r`auto`)}; }
  @media (forced-colors: active) { .en-avatar { color: CanvasText; background: Canvas; border: ${a(`--en-border-width`)} solid CanvasText; } }
`);c(r`
  :host { inline-size: max(${f(`--en-swatch-size`,a(`--en-size-swatch`))}, ${s(!1,a(`--en-size-target-min`))}); min-inline-size: ${s(!1,a(`--en-size-target-min`))}; }
  .en-swatch__sample { position: relative; display: block; appearance: none; inline-size: 100%; block-size: max(${f(`--en-swatch-size`,a(`--en-size-swatch`))}, ${s(!1,a(`--en-size-target-min`))}); min-inline-size: ${s(!1,a(`--en-size-target-min`))}; padding: 0; margin: 0; overflow: hidden; border: ${a(`--en-border-width`)} solid ${a(`--en-color-boundary`)}; border-radius: ${a(`--en-radius-control`)}; background: transparent; color: inherit; cursor: pointer; }
  @media (any-pointer: coarse) {
    :host { inline-size:max(${f(`--en-swatch-size`,a(`--en-size-swatch`))},${s(!0,a(`--en-size-target-min`))}); min-inline-size:${s(!0,a(`--en-size-target-min`))}; }
    .en-swatch__sample { min-inline-size:${s(!0,a(`--en-size-target-min`))}; min-block-size:${s(!0,a(`--en-size-target-min`))}; }
  }
  @media (hover: hover) { .en-swatch__sample:not(:disabled):hover { border-color: ${a(`--en-color-action`)}; } }
  .en-swatch__sample:not(:disabled):active { border-width: max(2px, ${a(`--en-border-width`)}); }
  .en-swatch__sample:disabled { cursor: default; }
  .en-swatch__color { display: block; inline-size: 100%; block-size: 100%; }
  ${m}
  @media (forced-colors: active) {
    .en-swatch__sample { border-color: ButtonText; background: Canvas; }
  @media (hover: hover) { .en-swatch__sample:not(:disabled):hover { border-color: ButtonText; background: Canvas; } }
    .en-swatch__sample:disabled { border-color: GrayText; }
    .en-swatch__color { forced-color-adjust: none; }
  }
`);var F={bold:e`<path d="M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z" />`,italic:e`<path d="M10 4h9M5 20h9M15 4 9 20" />`,underline:e`<path d="M6 3v8a6 6 0 0 0 12 0V3M4 21h16" />`,"align-start":e`<path d="M4 5h16M4 10h10M4 15h16M4 20h10" />`,"align-center":e`<path d="M4 5h16M7 10h10M4 15h16M7 20h10" />`,"align-end":e`<path d="M4 5h16M10 10h10M4 15h16M10 20h10" />`,heading:e`<path d="M5 4v16M19 4v16M5 12h14" />`,paragraph:e`<path d="M13 4H9a5 5 0 0 0 0 10h4M13 4v16M18 4v16M9 4h12" />`,"bullet-list":e`<circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /><path d="M9 6h12M9 12h12M9 18h12" />`,"ordered-list":e`<path d="m3 4 1-1v6M3 9h3M3 15a1.5 1.5 0 0 1 3 0c0 1-3 3-3 4h3M10 6h11M10 12h11M10 18h11" />`,link:e`<path d="M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2" />`,unlink:e`<path d="m12 5 2-2a4 4 0 0 1 6 6l-2 2M6 13l-2 2a4 4 0 0 0 6 6l2-2M3 3l18 18" />`,undo:e`<path d="M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -2)" />`,redo:e`<path d="m15 4 6 6-6 6M21 10H10a6 6 0 0 0 0 12" transform="translate(0 -2)" />`,file:e`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" />`,calendar:e`<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4m10-4v4M3 11h18"></path>`,check:e`<path d="m5 12 4 4L19 6" />`,plus:e`<path d="M12 5v14M5 12h14" />`,close:e`<path d="m6 6 12 12M18 6 6 18" />`,"chevron-left":e`<path d="m15 6-6 6 6 6" />`,"chevron-right":e`<path d="m9 6 6 6-6 6" />`,"chevron-down":e`<path d="m6 9 6 6 6-6" />`,"arrow-right":e`<path d="M4 12h16m-6-6 6 6-6 6" />`,search:e`<circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />`,info:e`<circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" />`,warning:e`<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v1" />`,sparkles:e`<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4m-2-2h4" />`},I=(e,r)=>n`
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
    role=${r?`img`:t}
    aria-label=${r||t}
    aria-hidden=${r?t:`true`}
  >${F[e]??t}</svg>
`,L={tagName:`en-icon`,elementClass:class extends p{static properties={name:{type:String},label:{type:String}};static styles=[_,o,P];constructor(){super(),this.name=`info`,this.label=``}render(){return I(this.name,this.label)}}};export{A as a,O as c,S as d,C as f,y as h,M as i,D as l,b as m,N as n,j as o,x as p,P as r,k as s,L as t,w as u};