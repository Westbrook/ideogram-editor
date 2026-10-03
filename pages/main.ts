import { html, render } from 'lit';
import { restoreAppearance } from '../src/theme/appearance.js';
import { restoreDensity } from '../src/theme/density.js';

declare const __PAGES_SOURCE_COMMIT__: string;
declare const __PAGES_BUILD_DATE__: string;
declare global {
  interface Window { __IE_PAIRING__?: string }
  const __PROGRESS_REPORT_URL__: string;
}

const commit = __PAGES_SOURCE_COMMIT__, builtAt = __PAGES_BUILD_DATE__;
if (!/^[a-f0-9]{40}$/.test(commit) || !Number.isFinite(Date.parse(builtAt))) throw Error('The preview build metadata is unavailable.');
// The report is a local developer surface, never part of the public preview.
// Preserve all other query and fragment state; do not inspect launch credentials.
const route = new URL(location.href);
if (route.searchParams.has('progress-report')) {
  route.searchParams.delete('progress-report');
  history.replaceState(history.state, '', route);
}
// Reject the local launch event before the real shell installs its listener.
// This document-lifetime guard survives bfcache restoration and never examines
// the launch-token property. It owns no transport or document data.
window.addEventListener('ie-pairing', event => event.stopImmediatePropagation(), { capture: true });
restoreAppearance();
restoreDensity();
try {
  if (route.searchParams.get('view') === 'text-demo') {
    document.querySelector('#app')?.remove();
    document.body.classList.add('pages-text-demo');
    await import('./text-demo.js');
  } else {
    document.querySelector('#preview-app')?.remove();
    document.body.classList.add('pages-editor');
    const notice = document.createElement('aside');
    notice.className = 'editor-preview-notice';
    notice.dataset.testid = 'editor-preview-notice';
    notice.setAttribute('aria-label', 'Public preview');
    render(html`<div><strong>Offline editor preview</strong><p>Explore the editor interface. Documents, saving and providers require the local app.</p></div>
      <nav aria-label="Preview links"><a data-testid="preview-text-demo" href="?view=text-demo">Try native text</a>
      <a data-testid="preview-local-setup" href="https://github.com/Westbrook/ideogram-editor/blob/${commit}/docs/PAGES.md#run-the-local-editor">Run locally</a>
      <a data-testid="preview-source-commit" href="https://github.com/Westbrook/ideogram-editor/commit/${commit}" title=${commit}>Source ${commit.slice(0, 12)}</a></nav>`, notice);
    document.querySelector('#app')!.before(notice);
    // The exact Pages build alias supplies an offline session to this real shell.
    // No document, history, capability or connected state is fabricated.
    const { mount } = await import('../src/ui/shell.js');
    await mount();
  }
  document.querySelector('#startup')?.remove();
} catch {
  document.querySelector('#app')?.replaceChildren();
  document.querySelector('#preview-app')?.replaceChildren();
  const startup = document.querySelector('#startup');
  startup?.setAttribute('role', 'alert');
  const message = startup?.querySelector('p');
  if (message) message.textContent = 'The preview could not load. Reload the page or use the local setup instructions.';
}
