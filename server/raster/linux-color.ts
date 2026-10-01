import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CODEC_ID } from './codec-platform.js';
import { LINUX_COLOR } from './linux-color-platform.js';

export function linuxColorLibraryPath(): string | null {
  if (!LINUX_COLOR || process.platform !== LINUX_COLOR.platform || process.arch !== LINUX_COLOR.arch) return null;
  const require = createRequire(import.meta.url);
  const modules = dirname(dirname(dirname(require.resolve('sharp'))));
  return join(dirname(modules), LINUX_COLOR.path);
}

export function verifyLinuxColor(): void {
  const path = linuxColorLibraryPath();
  if (!path || !LINUX_COLOR) return;
  if (LINUX_COLOR.codecIdentity !== CODEC_ID) throw Error('RASTER_CODEC_UNQUALIFIED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const block = Buffer.alloc(64 * 1024), hash = createHash('sha256');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== LINUX_COLOR.bytes) throw Error('RASTER_CODEC_UNQUALIFIED');
    let length: number, total = 0;
    while ((length = readSync(fd, block))) { total += length; hash.update(block.subarray(0, length)); }
    if (total !== LINUX_COLOR.bytes || 'sha256:' + hash.digest('hex') !== LINUX_COLOR.hash) throw Error('RASTER_CODEC_UNQUALIFIED');
  } finally { closeSync(fd); }
}
