import { LitElement, html, nothing } from 'lit';
import { createElementScope } from '@en-reve/elements/element-scope.js';
import { buttonDefinition } from '@en-reve/elements/definitions/button.js';
import { textareaDefinition } from '@en-reve/elements/definitions/textarea.js';
import { splitViewDefinition } from '@en-reve/elements/definitions/split-view.js';
import { toolbarDefinition } from '@en-reve/elements/definitions/toolbar.js';
import { createValueModel } from '@en-reve/primitives/state/value.js';
import { SignalController } from '@en-reve/primitives/interactions/signal-controller.js';
import type { EnTextarea } from '@en-reve/elements/textarea.js';
import type { DraftInputEvent } from '@en-reve/elements/events.js';
import { createSessionClient } from '../state/session-client.js';
import { icon } from './icons.js';

const scope = createElementScope({ document, registry: 'auto' });
scope.register([buttonDefinition, textareaDefinition, splitViewDefinition, toolbarDefinition]);
const operations = ['Generate image', 'Generate with Instant', 'Generate with Fast', 'Transform image', 'Edit masked region', 'Generate with adapters', 'Transform with adapters', 'Edit with adapters'];
const trayNames = ['Results', 'Jobs', 'History'] as const;
type Tray = typeof trayNames[number];
const panes = ['Layers', 'Composition'] as const;
const drafts = createValueModel<Record<string, string>>({});
const ui = createValueModel({ operation: operations[0], tool: 'Pan', tray: 'Results' as Tray, trayOpen: true, inspector: 'Layers', requestOpen: false, inspectorOpen: false, sessionOpen: false, helpOpen: false, narrow: matchMedia('(max-width: 1100px)').matches, zoom: '100' });
const patch = (value: Partial<ReturnType<typeof ui.value.get>>) => ui.set({ ...ui.value.get(), ...value });
const connection = createSessionClient();
const statusName = { checking: 'Connecting', paired: 'Connected locally', unpaired: 'Pairing needed', offline: 'Server offline', error: 'Connection error' };

class EditorShell extends LitElement {
  private readonly read = new SignalController(this, () => ({ ui: ui.value.get(), drafts: drafts.value.get(), session: connection.state.value.get() }));
  private lifecycle?: AbortController;
  private readonly media = matchMedia('(max-width: 1100px)');
  private composition = false;
  constructor() { super(); this.renderOptions.creationScope = scope.creationScope; }
  protected createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    this.lifecycle = new AbortController();
    window.addEventListener('ie-pairing', () => {
      let token = window.__IE_PAIRING__; delete window.__IE_PAIRING__;
      void connection.start(token); token = undefined;
    }, { signal: this.lifecycle.signal });
    this.addEventListener('keydown', this.shortcut, { signal: this.lifecycle.signal });
    this.addEventListener('compositionstart', () => { this.composition = true; }, { signal: this.lifecycle.signal });
    this.addEventListener('compositionend', () => { this.composition = false; }, { signal: this.lifecycle.signal });
    this.media.addEventListener('change', () => {
      // Keep the active native editor connected and visible during reflow.
      const active = document.activeElement;
      patch({ narrow: this.media.matches,
        ...(this.media.matches && this.querySelector('#request')?.contains(active) ? { requestOpen: true } : {}),
        ...(this.media.matches && this.querySelector('#inspector')?.contains(active) ? { inspectorOpen: true } : {}),
      });
    }, { signal: this.lifecycle.signal });
  }
  disconnectedCallback() { super.disconnectedCallback(); this.lifecycle?.abort(); connection.dispose(); }
  private shortcut = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || this.composition || event.keyCode === 229) return;
    if (event.composedPath().some(node => node instanceof HTMLElement && (node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || node.isContentEditable))) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); patch({ tool: 'Pan' }); }
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); patch({ tool: 'Zoom' }); }
    if (event.key === '?') { event.preventDefault(); patch({ helpOpen: true }); }
    if (event.key === 'Escape') {
      const state = ui.value.get();
      if (state.sessionOpen) { patch({ sessionOpen: false }); this.focusAfter('#session-trigger'); }
      else if (state.helpOpen) { patch({ helpOpen: false }); this.focusAfter('#help-trigger'); }
      else if (state.narrow && (state.requestOpen || state.inspectorOpen)) {
        const request = state.requestOpen;
        patch({ requestOpen: false, inspectorOpen: false }); this.focusAfter(request ? '#request-trigger' : '#inspector-trigger');
      }
    }
  };
  private async focusAfter(selector: string) { this.requestUpdate(); await this.updateComplete; this.querySelector<HTMLElement>(selector)?.focus(); }
  private go = (id: string) => {
    if (id === 'request') patch({ requestOpen: true });
    if (id === 'inspector') patch({ inspectorOpen: true });
    if (id === 'results') patch({ trayOpen: true });
    const url = new URL(location.href); url.hash = id; history.replaceState(history.state, '', url);
    void this.focusAfter(`#${id}`);
  };
  private draftInput = (event: DraftInputEvent) => {
    const host = event.currentTarget;
    if (event.composedPath()[0] !== host) return;
    // en-input is only an ephemeral native draft observation. No projection
    // write back into the field, command, history entry or network request.
    drafts.set({ ...drafts.value.get(), [ui.value.get().operation]: event.detail.value });
  };
  private switchOperation = (event: Event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (!operations.includes(value)) return;
    patch({ operation: value });
    // The explicit operation switch is the only author write to this field.
    const field = this.querySelector<EnTextarea>('#prompt');
    if (field) field.value = drafts.value.get()[value] ?? '';
  };
  private tabKeys(event: KeyboardEvent, names: readonly string[], current: string, change: (name: string) => void) {
    let index = names.indexOf(current);
    if (event.key === 'ArrowRight') index = (index + 1) % names.length;
    else if (event.key === 'ArrowLeft') index = (index + names.length - 1) % names.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = names.length - 1;
    else return;
    const target = event.currentTarget as HTMLElement;
    event.preventDefault(); change(names[index]); this.requestUpdate();
    void this.updateComplete.then(() => target.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  }
  protected render() {
    const { ui: view, drafts: values, session } = this.read.snapshot;
    const prompt = values[view.operation] ?? '';
    return html`
      <div class="skip-links"><a href="#request" @click=${(e: Event) => { e.preventDefault(); this.go('request'); }}>Go to request</a><a href="#canvas" @click=${(e: Event) => { e.preventDefault(); this.go('canvas'); }}>Go to canvas</a><a href="#inspector" @click=${(e: Event) => { e.preventDefault(); this.go('inspector'); }}>Go to layers</a><a href="#results" @click=${(e: Event) => { e.preventDefault(); this.go('results'); }}>Go to results</a></div>
      <header class="document-bar">
        <div class="identity"><span class="brand-mark">${icon('spark')}</span><div><strong>Ideogram <span class="wordmark-secondary">Editor</span></strong><span class="document-name">No document open</span></div></div>
        <nav aria-label="Document actions" class="document-actions"><button disabled title="Document creation is not available yet">New</button><button disabled>Open</button><button disabled>Import</button><span class="divider"></span><button disabled aria-label="Undo">${icon('undo')}</button><button disabled aria-label="Redo">${icon('redo')}</button></nav>
        <div class="bar-end"><button id="session-trigger" class="connection-button" aria-expanded=${view.sessionOpen} aria-controls="session-panel" @click=${() => patch({ sessionOpen: !view.sessionOpen })}><span class="status-dot" data-connected=${session.connection === 'paired'}></span>${statusName[session.connection]}</button><button disabled>Save copy</button><en-button disabled size="small">Export</en-button><button id="help-trigger" class="icon-button" aria-label="Help and keyboard shortcuts" aria-expanded=${view.helpOpen} @click=${() => patch({ helpOpen: !view.helpOpen })}>?</button></div>
      </header>
      <section id="session-panel" class="connection-panel" aria-label="Local connection" ?hidden=${!view.sessionOpen && session.connection === 'paired'}>
        <div><strong>${statusName[session.connection]}</strong><p role="status">${session.message}</p><p class="muted">Pair from the launcher on this computer. Never paste credentials into the editor.</p></div>
        <div class="connection-actions"><en-button variant="secondary" ?disabled=${session.busy} @click=${() => connection.resume()}>Check connection</en-button><en-button variant="secondary" ?disabled=${session.busy || session.connection !== 'paired'} @click=${() => connection.renew()}>Renew connection</en-button><en-button variant="ghost" ?disabled=${session.busy || session.connection !== 'paired'} @click=${() => connection.revoke()}>Disconnect</en-button></div>
      </section>
      <section class="help-panel" aria-label="Editor help" ?hidden=${!view.helpOpen}><strong>Find your way around</strong><p>H selects Pan · Z selects Zoom · Arrow keys move through tools and tabs · Escape closes a panel. Text fields keep their native editing shortcuts.</p><p>This preview supports request drafts and local connections. Document import, editing, saving, export, and generation are not available yet. Drafts live only in this tab and are lost on reload.</p><button @click=${() => { patch({ helpOpen: false }); this.focusAfter('#help-trigger'); }}>Close help</button></section>
      <div class="mobile-openers"><button id="request-trigger" aria-expanded=${view.requestOpen} aria-controls="request" @click=${() => patch({ requestOpen: !view.requestOpen })}>${icon('spark')} Request</button><button id="inspector-trigger" aria-expanded=${view.inspectorOpen} aria-controls="inspector" @click=${() => patch({ inspectorOpen: !view.inspectorOpen })}>${icon('layers')} Layers & composition</button></div>
      <main class="workspace" aria-label="Image editor">
        <aside class="tool-rail" aria-label="Editing tools"><en-toolbar label="Canvas tools" orientation=${view.narrow ? 'horizontal' : 'vertical'}>
          ${[['Move', 'move', 'V'], ['Text', 'text', 'T'], ['Select', 'select', 'M'], ['Mask', 'mask', 'B'], ['Crop', 'crop', 'C'], ['Pan', 'hand', 'H'], ['Zoom', 'zoom', 'Z']].map(([name, glyph, key]) => html`<button class="tool" ?disabled=${!['Pan', 'Zoom'].includes(name)} aria-label=${`${name} (${key})`} aria-pressed=${view.tool === name} title=${['Pan', 'Zoom'].includes(name) ? `${name} (${key})` : `${name} — editing is not available yet`} @click=${() => patch({ tool: name })}>${icon(glyph)}<span>${name}</span></button>`)}
        </en-toolbar><span class="rail-foot">LOCAL</span></aside>
        <en-split-view class="outer-split" label="Request panel width" primary-label="Request" secondary-label="Canvas and inspector" .value=${24} .min=${22} .max=${34} .disabled=${view.narrow}>
          <section id="request" slot="primary" class="request-panel panel" tabindex="-1" aria-label="Request" ?hidden=${view.narrow && !view.requestOpen}>
            <div class="panel-heading"><h1>Request</h1><span class="quiet-tag">Draft</span></div>
            <div class="request-fields"><label class="field-label" for="operation">Operation</label><select id="operation" @change=${this.switchOperation}>${operations.map(name => html`<option .selected=${view.operation === name}>${name}</option>`)}</select>
              <div class="prompt-heading"><span class="eyebrow">PLAIN PROMPT</span><span class="muted">${prompt.length} characters</span></div>
              <en-textarea id="prompt" label="Prompt" placeholder="Describe the image you have in mind…" .rows=${4} description="Draft only · kept in this tab until reload" @en-input=${this.draftInput}></en-textarea>
              <div class="section-title"><h2>Inputs</h2><span class="muted">None attached</span></div><div class="attachment-empty">${icon('image')}<div><strong>No images attached</strong><p>Sources and masks are always explicit.</p></div></div>
              <div class="input-actions"><button disabled>＋ Source</button><button disabled>＋ Mask</button><button disabled>＋ Adapter</button></div>
              <details class="settings"><summary>Request settings <span>Not available yet</span></summary><p>Size, quality, strength, seed, and adapter settings will be available with generation. No request can be sent from this preview.</p></details>
            </div>
            <div class="request-summary"><div class="section-title"><h2>Request summary</h2><span class="quiet-tag">Local draft</span></div><dl><div><dt>Operation</dt><dd>${view.operation}</dd></div><div><dt>Inputs</dt><dd>None</dd></div><div><dt>Cost</dt><dd>No request prepared</dd></div></dl><en-button disabled class="generate">${icon('spark')} Generate</en-button><p class="muted">Generation is not available yet.${session.capabilities?.credentialConfigured === false ? ' No provider key is configured.' : ''} Drafts work without a key.</p></div>
          </section>
          <en-split-view slot="secondary" class="inner-split" label="Canvas and inspector width" primary-label="Canvas" secondary-label="Inspector" .value=${73} .min=${55} .max=${78} .disabled=${view.narrow}>
            <section slot="primary" id="canvas" class="canvas-panel" aria-label="Canvas" tabindex="-1">
              <div class="canvas-toolbar"><span class="tool-context">${icon(view.tool === 'Pan' ? 'hand' : 'zoom')} ${view.tool}<span class="muted"> · No document</span></span><div class="zoom-controls" role="group" aria-label="Canvas controls"><label for="zoom">Zoom</label><input id="zoom" aria-label="Zoom percentage" type="number" min="10" max="400" step="10" .value=${view.zoom} @input=${(event: Event) => patch({ zoom: (event.target as HTMLInputElement).value })}><span>%</span><button @click=${() => patch({ zoom: '100' })}>Reset</button></div></div>
              <div class="canvas-viewport"><div class="canvas-empty"><span class="canvas-emblem">${icon('image')}</span><span class="eyebrow">YOUR NEXT IDEA STARTS HERE</span><h2>A little room to create.</h2><p>Draft an image request on the left.<br>Import and editing are coming next.</p><button class="primary-link" @click=${() => { this.go('request'); this.updateComplete.then(() => this.querySelector<EnTextarea>('#prompt')?.focus()); }}>Write a prompt <span aria-hidden="true">↗</span></button><span class="canvas-note">No document · no pixels · nothing sent</span></div></div>
              <div class="canvas-caption"><span>Canvas preview</span><span>Document size —</span></div>
            </section>
            <aside slot="secondary" id="inspector" class="inspector panel" aria-label="Layers and properties" tabindex="-1" ?hidden=${view.narrow && !view.inspectorOpen}>
              <div class="tabs inspector-tabs" role="tablist" aria-label="Document structure" @keydown=${(e: KeyboardEvent) => this.tabKeys(e, panes, view.inspector, name => patch({ inspector: name }))}>${panes.map(name => html`<button role="tab" id=${`tab-${name}`} aria-selected=${view.inspector === name} aria-controls="structure-panel" tabindex=${view.inspector === name ? 0 : -1} @click=${() => patch({ inspector: name })}>${name}</button>`)}</div>
              <section id="structure-panel" role="tabpanel" aria-labelledby=${`tab-${view.inspector}`} class="structure-empty"><span class="empty-icon">${icon(view.inspector === 'Layers' ? 'layers' : 'select')}</span><h2>${view.inspector === 'Layers' ? 'No layers yet' : 'No composition yet'}</h2><p>${view.inspector === 'Layers' ? 'Your document’s image and text layers will appear here.' : 'Composition describes a scene. It is separate from document layers.'}</p><button disabled>${view.inspector === 'Layers' ? '＋ Add layer' : '＋ Add scene object'}</button></section>
              <section class="properties" aria-labelledby="properties-title"><div class="section-title"><h2 id="properties-title">Properties</h2>${icon('settings')}</div><p class="muted">Open a document and select a layer to inspect its properties.</p><div class="property-grid">${['X', 'Y', 'Width', 'Height', 'Rotation', 'Opacity'].map(label => html`<label>${label}<input disabled aria-label=${label} placeholder="—"></label>`)}</div><p class="fine-print">Selecting a layer never attaches it to a request.</p></section>
            </aside>
          </en-split-view>
        </en-split-view>
      </main>
      <section id="results" class="results-tray" aria-label="Results, jobs and history" tabindex="-1"><div class="tray-header"><div class="tabs" role="tablist" aria-label="Activity" @keydown=${(e: KeyboardEvent) => this.tabKeys(e, trayNames, view.tray, name => patch({ tray: name as Tray, trayOpen: true }))}>${trayNames.map(name => html`<button id=${`tab-${name}`} role="tab" aria-selected=${view.tray === name} aria-controls="activity-panel" tabindex=${view.tray === name ? 0 : -1} @click=${() => patch({ tray: name, trayOpen: true })}>${name}<span class="count">0</span></button>`)}</div><button class="tray-toggle" aria-expanded=${view.trayOpen} aria-controls="activity-panel" @click=${() => patch({ trayOpen: !view.trayOpen })}>${view.trayOpen ? 'Collapse' : 'Expand'} <span aria-hidden="true">${view.trayOpen ? '⌄' : '⌃'}</span></button></div><div id="activity-panel" role="tabpanel" aria-labelledby=${`tab-${view.tray}`} ?hidden=${!view.trayOpen}><div class="tray-empty">${icon(view.tray === 'Results' ? 'image' : view.tray === 'History' ? 'undo' : 'spark')}<div><strong>${view.tray === 'Results' ? 'Your results will land here' : view.tray === 'Jobs' ? 'No jobs submitted' : 'No document history'}</strong><p>${view.tray === 'Results' ? 'Generated images stay candidates until you choose to add them.' : view.tray === 'Jobs' ? 'Generation is unavailable. No provider requests have been made.' : 'Document edits and saved checkpoints will appear here. Prompt drafts are separate.'}</p></div></div></div></section>
      <footer class="status-bar"><span>${view.tool} <span class="status-separator">/</span> No layer selected</span><span>Drafts are not saved <span class="status-separator">·</span> Document storage unavailable</span></footer>
      ${new URL(location.href).searchParams.has('progress-report') ? html`<a class="report-return" href=${__PROGRESS_REPORT_URL__}>Progress Report <span aria-hidden="true">↗</span></a>` : nothing}
    `;
  }
}
scope.register([{ tagName: 'ie-shell', elementClass: EditorShell }]);
export async function mount(token?: string) {
  const shell = scope.createElement('ie-shell') as EditorShell;
  document.querySelector('#app')!.append(shell);
  await shell.updateComplete;
  void connection.start(token);
  token = undefined;
}
