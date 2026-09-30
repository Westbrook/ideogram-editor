export type Appearance = 'auto' | 'light' | 'dark';
const key = 'ideogram.appearance';
export function isAppearance(value: unknown): value is Appearance {
  return value === 'auto' || value === 'light' || value === 'dark';
}
export function restoreAppearance(): void {
  let value: unknown;
  try { value = localStorage.getItem(key); } catch { /* Storage can be unavailable. */ }
  document.documentElement.dataset.enAppearance = isAppearance(value) ? value : 'auto';
}
export function setAppearance(value: Appearance): void {
  document.documentElement.dataset.enAppearance = value;
  try { localStorage.setItem(key, value); } catch { /* The current view still works. */ }
}
