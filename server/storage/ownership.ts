import { closeSync, fsyncSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { preparePrivateRoot } from '../private-root.js';
import { assertComponents, assertPrivate, inspectTree, localFilesystem, privateFile, sameFile, syncDirectory } from './files.js';
import { StoreError } from './errors.js';

// fs-ext is loaded only in the parent thread. SQLite and all storage work run
// in the writer worker. The nonblocking kernel lock stays held until it exits.
const require = createRequire(import.meta.url);
export async function acquireRoot(input: string) {
  const root = await preparePrivateRoot(input);
  localFilesystem(root.path);
  const identity = assertPrivate(root.path, true);
  const lockPath = join(root.path, 'writer.lock');
  const fd = privateFile(lockPath);
  let closed = false;
  try {
    const { flockSync } = require('fs-ext') as { flockSync(fd: number, flag: 'exnb'): void };
    try { flockSync(fd, 'exnb'); }
    catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new StoreError('ROOT_BUSY');
      throw error;
    }
    const lockIdentity = assertPrivate(lockPath, false);
    fsyncSync(fd); syncDirectory(root.path);
    inspectTree(root.path);
    const check = () => {
      assertComponents(root.path);
      if (closed || !sameFile(identity, assertPrivate(root.path, true)) || !sameFile(lockIdentity, assertPrivate(lockPath, false))) throw new StoreError('ROOT_UNSAFE');
    };
    check();
    return { path: root.path, identity: { dev: identity.dev, ino: identity.ino }, check,
      close() { if (!closed) { closed = true; closeSync(fd); } } };
  } catch (error) { closeSync(fd); throw error; }
}
