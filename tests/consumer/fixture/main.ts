import '@en-reve/tokens/default.css';
import { html, render } from 'lit';
import { buttonStyles } from '@en-reve/styles/buttons.js';
import { createValueModel } from '@en-reve/primitives/state/value.js';
import { createElementScope } from '@en-reve/elements/element-scope.js';
import { buttonDefinition } from '@en-reve/elements/definitions/button.js';
import { treeDefinition } from '@en-reve/elements/definitions/tree.js';
import { EnButton } from '@en-reve/elements/button.js';
import type { LitElement } from 'lit';

const status = document.querySelector<HTMLElement>('#status')!;
const container = document.querySelector<HTMLElement>('#fixture')!;
const mode = new URL(location.href).searchParams.get('registry') === 'global' ? 'global' : 'auto';
if (customElements.get('en-button')) throw new Error('Class/descriptor imports registered globally');
const scope = createElementScope({ document, registry: mode });
scope.register([buttonDefinition, treeDefinition]);
scope.register([buttonDefinition]);
if (scope.get('en-button') !== EnButton || !scope.get('en-tree-item')) throw new Error('Registration dependency closure failed');
if (!buttonStyles.cssText) throw new Error('Public styles export missing');
let conflictRejected = false;
try { scope.register([{ tagName: 'en-button', elementClass: class extends HTMLElement {} }]); }
catch { conflictRejected = true; }
if (!conflictRejected || scope.get('en-button') !== EnButton) throw new Error('Constructor conflict was not rejected');
const host = scope.createElement('div');
container.append(host);
const count = createValueModel(0);
const draw = () => render(html`
  <en-button @click=${() => { count.set(count.value.get() + 1); draw(); }}>Increment</en-button>
  <output aria-label="Count">${count.value.get()}</output>
  <button @click=${loadLazy}>Load text field</button>
  <div id="lazy"></div>
`, host, { creationScope: scope.creationScope });
async function loadLazy() {
  const { createElementLoader } = await import('@en-reve/elements/lazy.js');
  const loader = createElementLoader(scope.registry);
  await loader.load(['en-text-field']);
  if (scope.get('en-text-field')) throw new Error('Lazy load registered before ensure');
  await loader.ensure(['en-text-field']);
  const field = scope.createElement('en-text-field') as LitElement & { label: string; value: string };
  field.label = 'Consumer input';
  field.value = 'Packed source';
  host.querySelector('#lazy')!.append(field);
  await field.updateComplete;
  status.textContent = `Ready: ${scope.mode}; lazy field rendered`;
}
draw();
await (host.querySelector('en-button') as LitElement).updateComplete;
status.textContent = `Ready: ${scope.mode}`;
