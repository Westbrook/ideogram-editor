import profile from './profile.json';
import { fail, frozen, hashBytes, readSealedAsset } from './contracts';
import type { FontInput } from './contracts';
import { textMemory, registerFontBacking } from './memory';
// URL references emit assets without fetching or evaluating fonts at startup.
const urls = import.meta.glob('../../vendor/text/fonts/*', { eager: true, query: '?url', import: 'default' }) as Record<string,string>;
export const bundledFonts = frozen(profile.fonts.map(f => ({ id: f.id, hash: 'sha256:' + f.sha256, bytes: f.bytes })));
const loaded = new Map<string, FontInput>();
const loading = new Map<string, Promise<FontInput>>();
export async function loadBundledFont(id: string, signal?: AbortSignal): Promise<FontInput> {
  const cached = loaded.get(id); if (cached) return cached;
  const pending = loading.get(id); if (pending) return pending;
  const entry = profile.fonts.find(f => f.id === id); if (!entry) fail('FONT_NOT_BUNDLED');
  // Full peak is booked before fetch, including chunks, Blob and digest input.
  const lease = textMemory.reserve(5 * entry.bytes);
  const operation = (async () => {
  try {
  const url = new URL(urls['../../vendor/text/' + entry!.file], location.href);
  if (url.origin !== location.origin) fail('FONT_ORIGIN');
  const bytes = await readSealedAsset(url, entry!.bytes, signal);
  if (bytes.size !== entry!.bytes || await hashBytes(bytes) !== 'sha256:' + entry!.sha256) fail('FONT_HASH');
  const font: FontInput = frozen({ hash: 'sha256:' + entry!.sha256, bytes, faceIndex: 0, origin: 'bundled',
    license: { hash: entry!.licenseHash, embedding: 'permitted' } });
  lease.release(); textMemory.reserve(bytes.size); registerFontBacking(bytes);
  loaded.set(id, font); return font;
  } finally { lease.release(); loading.delete(id); }
  })();
  loading.set(id, operation); return operation;
}
