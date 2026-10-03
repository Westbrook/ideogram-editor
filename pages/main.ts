import { html, render } from 'lit';
import { createElementScope } from '@en-reve/elements/element-scope.js';
import { buttonDefinition } from '@en-reve/elements/definitions/button.js';
import { selectDefinition } from '@en-reve/elements/definitions/select.js';
import { selectOptionDefinition } from '@en-reve/elements/definitions/select-option.js';
import { textareaDefinition } from '@en-reve/elements/definitions/textarea.js';
import { numberFieldDefinition } from '@en-reve/elements/definitions/number-field.js';
import { textFieldDefinition } from '@en-reve/elements/definitions/text-field.js';
import type { EnButton } from '@en-reve/elements/button.js';
import type { EnSelect } from '@en-reve/elements/select.js';
import type { EnTextarea } from '@en-reve/elements/textarea.js';
import type { EnNumberField } from '@en-reve/elements/number-field.js';
import type { EnTextField } from '@en-reve/elements/text-field.js';
import type { DraftInputEvent } from '@en-reve/elements/events.js';
import { ControlAdapter } from '../src/ui/adapters.js';
import { isAppearance, restoreAppearance, setAppearance } from '../src/theme/appearance.js';
import { currentDensity, isDensity, restoreDensity, setDensity } from '../src/theme/density.js';
import { DEFAULT_DRAFT, PREVIEW_FONTS, PREVIEW_TEXT_LIMIT, PreviewController, type PreviewDraft } from './controller.js';

declare const __PAGES_SOURCE_COMMIT__: string;
declare const __PAGES_BUILD_DATE__: string;

restoreAppearance();
restoreDensity();
const sourceCommit = __PAGES_SOURCE_COMMIT__;
const buildDate = __PAGES_BUILD_DATE__;
if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !Number.isFinite(Date.parse(buildDate)))
  throw Error('The preview build metadata is unavailable.');
const repository = 'https://github.com/Westbrook/ideogram-editor';
const scope = createElementScope({ document, registry: 'auto' });
scope.register([buttonDefinition, selectDefinition, selectOptionDefinition, textareaDefinition, numberFieldDefinition, textFieldDefinition]);
const container = document.querySelector('#preview-app');
if (!container) throw Error('The preview container is unavailable.');
const host = scope.createElement('div');
host.className = 'pages-preview';
container.append(host);
const adapter = new ControlAdapter();
const composing = new Set<EventTarget>();
let controller: PreviewController;

function editDraft(event: Event, key: 'text' | 'size' | 'color') {
  if (event.composedPath()[0] !== event.currentTarget) return;
  const input = event as DraftInputEvent;
  if (typeof input.detail?.value !== 'string') return;
  if (input.detail.isComposing) composing.add(event.currentTarget!);
  else composing.delete(event.currentTarget!);
  controller.setDraft({ ...controller.draft, [key]: input.detail.value });
  updateUI();
}
function acceptField(event: Event, key: keyof PreviewDraft) {
  const control = event.currentTarget as EnSelect | EnTextarea | EnNumberField | EnTextField;
  adapter.settled(event, () => control.value, value => controller.setDraft({ ...controller.draft, [key]: value }));
}
function action(event: Event, run: () => void) {
  adapter.action(event, run);
}
function reset() {
  if (composing.size) return;
  adapter.invalidate();
  controller.reset();
  for (const key of ['text', 'font', 'size', 'color', 'align', 'direction'] as const) {
    const field = host.querySelector<EnSelect | EnTextarea | EnNumberField | EnTextField>('[data-testid="preview-' + key + '"]');
    if (field) adapter.write(field, 'value', DEFAULT_DRAFT[key]);
  }
  updateUI();
}

// Render controls once. Native text drafts and IME composition remain owned by
// their public En Reve elements; status updates do not author-write their values.
render(html`
  <a class="preview-skip" href="#text-controls">Skip to text controls</a>
  <header class="preview-header">
    <a class="preview-brand" href=${repository} aria-label="Ideogram Editor source repository">
      <span class="preview-monogram" aria-hidden="true">ie</span>
      <span>Ideogram <span class="preview-brand-secondary">Editor</span><small>PUBLIC PREVIEW</small></span>
    </a>
    <div class="preview-preferences" role="group" aria-label="Interface preferences">
      <en-select data-testid="appearance" label="Appearance" .value=${document.documentElement.dataset.enAppearance ?? 'auto'}
        @en-change=${(event: Event) => {
          const field = event.currentTarget as EnSelect;
          adapter.settled(event, () => field.value, value => { if (isAppearance(value)) setAppearance(value); });
        }}>
        <en-select-option value="auto">System</en-select-option>
        <en-select-option value="light">Light</en-select-option>
        <en-select-option value="dark">Dark</en-select-option>
      </en-select>
      <en-select data-testid="density" label="Density" .value=${currentDensity()}
        @en-change=${(event: Event) => {
          const field = event.currentTarget as EnSelect;
          adapter.settled(event, () => field.value, value => { if (isDensity(value)) setDensity(value); });
        }}>
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
      <a data-testid="local-setup" href=${repository + '/blob/' + sourceCommit + '/docs/PAGES.md#run-the-local-editor'}>Run the local editor <span aria-hidden="true">↗</span></a>
    </aside>
  </section>
  <main class="preview-workspace" aria-label="Text preview workspace">
    <section id="text-controls" class="preview-controls" aria-labelledby="controls-title" tabindex="-1">
      <div class="preview-panel-heading"><h2 id="controls-title">Text & style</h2><span class="preview-chip">IN THIS TAB</span></div>
      <en-textarea data-testid="preview-text" label="Text" .value=${DEFAULT_DRAFT.text} .rows=${5} .maxLength=${PREVIEW_TEXT_LIMIT}
        description="Up to 2,048 characters and 16 lines. Enter adds a line break."
        @en-input=${(event: Event) => editDraft(event, 'text')} @en-change=${(event: Event) => acceptField(event, 'text')}></en-textarea>
      <en-select data-testid="preview-font" label="Font" .value=${DEFAULT_DRAFT.font}
        description="Bundled regular faces. Noto Sans fills supported Latin characters when another face is selected."
        @en-change=${(event: Event) => acceptField(event, 'font')}>
        ${PREVIEW_FONTS.map(font => html`<en-select-option value=${font.id}>${font.label}</en-select-option>`)}
      </en-select>
      <div class="preview-field-pair">
        <en-number-field data-testid="preview-size" label="Font size" .value=${DEFAULT_DRAFT.size} .min=${12} .max=${160} .step=${1}
          description="12–160 pixels"
          @en-input=${(event: Event) => editDraft(event, 'size')} @en-change=${(event: Event) => acceptField(event, 'size')}></en-number-field>
        <en-text-field data-testid="preview-color" label="Text color" .value=${DEFAULT_DRAFT.color} .maxLength=${7}
          description="Six-digit hex, e.g. #194ECA" autocomplete="off" spellcheck="false"
          @en-input=${(event: Event) => editDraft(event, 'color')} @en-change=${(event: Event) => acceptField(event, 'color')}></en-text-field>
      </div>
      <div class="preview-field-pair">
        <en-select data-testid="preview-align" label="Alignment" .value=${DEFAULT_DRAFT.align}
          @en-change=${(event: Event) => acceptField(event, 'align')}>
          <en-select-option value="start">Start</en-select-option>
          <en-select-option value="center">Center</en-select-option>
          <en-select-option value="end">End</en-select-option>
          <en-select-option value="left">Left</en-select-option>
          <en-select-option value="right">Right</en-select-option>
        </en-select>
        <en-select data-testid="preview-direction" label="Direction" .value=${DEFAULT_DRAFT.direction}
          @en-change=${(event: Event) => acceptField(event, 'direction')}>
          <en-select-option value="auto">Automatic</en-select-option>
          <en-select-option value="ltr">Left to right</en-select-option>
          <en-select-option value="rtl">Right to left</en-select-option>
        </en-select>
      </div>
      <div class="preview-render-actions">
        <en-button data-testid="render-text" @click=${(event: Event) => action(event, () => {
          if (!composing.size) void controller.render();
        })}>Render text</en-button>
        <en-button data-testid="cancel-render" variant="secondary" disabled
          @click=${(event: Event) => action(event, () => controller.cancel())}>Cancel render</en-button>
        <en-button data-testid="reset-preview" variant="ghost" @click=${(event: Event) => action(event, reset)}>Reset preview</en-button>
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
          @click=${(event: Event) => action(event, () => { void controller.download(); })}>Download PNG</en-button>
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
    <div><a data-testid="source-commit" href=${repository + '/commit/' + sourceCommit}>Source ${sourceCommit.slice(0, 8)}</a>
      <span>Built <time datetime=${buildDate}>${buildDate.slice(0, 10)}</time></span>
      <a href=${import.meta.env.BASE_URL + 'notices/index.txt'}>Third-party notices</a></div>
  </footer>
`, host, { creationScope: scope.creationScope });

function required<T extends HTMLElement>(selector: string): T {
  const element = host.querySelector<T>(selector);
  if (!element) throw Error('A preview control is unavailable.');
  return element;
}
const canvas = required<HTMLCanvasElement>('[data-testid="preview-canvas"]');
const status = required('[data-testid="preview-status"]');
const error = required('[data-testid="preview-error"]');
const stage = required('[data-testid="preview-stage"]');
const empty = required('[data-testid="preview-empty"]');
const rendered = required('#rendered-text');
const description = required('[data-testid="rendered-description"]');
const renderButton = required<EnButton>('[data-testid="render-text"]');
const cancelButton = required<EnButton>('[data-testid="cancel-render"]');
const resetButton = required<EnButton>('[data-testid="reset-preview"]');
const downloadButton = required<EnButton>('[data-testid="download-png"]');

function updateUI() {
  if (!controller) return;
  const state = controller.state;
  status.textContent = state.message;
  error.textContent = state.error;
  error.hidden = !state.error;
  stage.setAttribute('aria-busy', String(state.busy));
  canvas.hidden = !state.hasImage;
  empty.hidden = state.hasImage;
  rendered.textContent = state.renderedText;
  description.hidden = !state.hasImage;
  renderButton.disabled = state.busy || state.unavailable || !!composing.size;
  cancelButton.disabled = !state.busy;
  resetButton.disabled = !!composing.size;
  downloadButton.disabled = state.busy || state.unavailable || !state.current || !!composing.size;
}
controller = new PreviewController(canvas, updateUI);
updateUI();
// Composition can begin before the first en-input notification. Observe only
// standard events; do not reach into a control's private native subtree.
host.addEventListener('compositionstart', event => { if (event.target) composing.add(event.target); updateUI(); });
host.addEventListener('compositionend', event => { if (event.target) composing.delete(event.target); updateUI(); });
window.addEventListener('pagehide', () => { adapter.invalidate(); composing.clear(); controller.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) { composing.clear(); controller.resume(); } });
document.querySelector('#startup')?.remove();
