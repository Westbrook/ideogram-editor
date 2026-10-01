import { restoreAppearance } from './theme/appearance.js';
import { restoreDensity } from './theme/density.js';
declare global {
  interface Window { __IE_PAIRING__?: string }
  const __PROGRESS_REPORT_URL__: string;
}
// First app operation: take the launch secret out of the public window object.
let pairingToken = window.__IE_PAIRING__;
delete window.__IE_PAIRING__;
restoreAppearance();
restoreDensity();
try {
  const { mount } = await import('./ui/shell.js');
  const pending = mount(pairingToken);
  pairingToken = undefined;
  await pending;
  document.querySelector('#startup')?.remove();
} catch {
  pairingToken = undefined;
  document.querySelector('#app')?.replaceChildren();
  const message = document.querySelector('#startup-message');
  if (message) message.textContent = 'The editor could not load. Rebuild and restart the local launcher, then reload this page.';
  document.querySelector('#startup')?.setAttribute('role', 'alert');
}
export {};
