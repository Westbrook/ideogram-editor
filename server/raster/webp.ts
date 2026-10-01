import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CODECS } from './codec-platform.js';

// Resolve only the frozen native color library; no system library search.
export function directWebPLibraryPath(platform = process.platform, arch = process.arch): string | null {
  // Qualification remains tied to the frozen codec profile. A future profile
  // for another platform can name its corresponding shared library; unsupported
  // loaders/symbols fall back before resource admission, never after allocation.
  if (platform !== CODECS.platform || arch !== CODECS.arch) return null;
  const expression = platform === 'darwin' ? /\/libvips-cpp[^/]*\.dylib$/ : platform === 'linux' ? /\/libvips-cpp[^/]*\.so(?:\.[^/]*)?$/ : platform === 'win32' ? /\/libvips[^/]*\.dll$/i : null;
  const file = expression && CODECS.files.find(file => expression.test(file.path));
  if (!file) return null;
  const require = createRequire(import.meta.url), root = dirname(dirname(dirname(require.resolve('sharp'))));
  return join(root, file.path.replace(/^node_modules\//, ''));
}
