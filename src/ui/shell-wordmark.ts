import {html} from 'lit';

export const SHELL_WORDMARK = 'Editor';

// This view-only module is a development update boundary. The shell retains
// its document/session owners while Lit replaces this small rendered view.
export function renderShellWordmark() {
  return html`Ideogram <span class="wordmark-secondary">${SHELL_WORDMARK}</span>`;
}
