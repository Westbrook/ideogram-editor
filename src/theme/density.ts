export type Density = 'comfortable' | 'compact' | 'spacious';
const key = 'ideogram.density';
const themes: Readonly<Record<Density, string>> = {
  comfortable: 'spectrum-inspired-comfortable',
  compact: 'spectrum-inspired',
  spacious: 'spectrum-inspired-spacious',
};

export function isDensity(value: unknown): value is Density {
  return value === 'comfortable' || value === 'compact' || value === 'spacious';
}

export function currentDensity(): Density {
  const theme = document.documentElement.dataset.enTheme;
  return theme === themes.compact ? 'compact' : theme === themes.spacious ? 'spacious' : 'comfortable';
}

export function restoreDensity(): void {
  let value: unknown;
  try { value = localStorage.getItem(key); } catch { /* Storage can be unavailable. */ }
  document.documentElement.dataset.enTheme = themes[isDensity(value) ? value : 'comfortable'];
}

// Full compiled themes update the entire resolved sizing graph. This preference
// does not touch document state, selection, focus or any unapplied draft.
export function setDensity(value: Density): void {
  document.documentElement.dataset.enTheme = themes[value];
  try { localStorage.setItem(key, value); } catch { /* The current view still works. */ }
}
