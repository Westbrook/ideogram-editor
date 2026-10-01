const storageKey = 'ideogram.single-key-shortcuts';

export function singleKeyShortcutsEnabled(): boolean {
  try { return localStorage.getItem(storageKey) !== 'disabled'; }
  catch { return true; }
}

export function setSingleKeyShortcutsEnabled(enabled: boolean): void {
  try { localStorage.setItem(storageKey, enabled ? 'enabled' : 'disabled'); }
  catch { /* The setting still applies to the current view. */ }
}

export function isKeyboardPreferenceStorageKey(key: string | null): boolean {
  return key === null || key === storageKey;
}
