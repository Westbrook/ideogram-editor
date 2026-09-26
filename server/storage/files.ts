import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, statfsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, parse, relative } from 'node:path';
import { StoreError } from './errors.js';

export function assertPrivate(path: string, directory: boolean): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new StoreError('ROOT_UNSAFE');
  return stat;
}
export function assertComponents(path: string): void {
  let current = parse(path).root;
  for (const part of relative(current, path).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StoreError('ROOT_UNSAFE');
  }
}
export function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assertPrivate(path, true);
}
export function privateFile(path: string): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!sameFile(stat, assertPrivate(path, false))) throw new StoreError('ROOT_UNSAFE');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export function inspectTree(path: string): bigint {
  assertPrivate(path, true);
  let bytes = 0n;
  for (const name of readdirSync(path)) {
    const entry = join(path, name); const stat = lstatSync(entry);
    if (stat.isDirectory()) bytes += inspectTree(entry);
    else { assertPrivate(entry, false); bytes += BigInt(stat.size); }
  }
  return bytes;
}
export function localFilesystem(path: string): void {
  // Explicit local filesystem allowlist. Other filesystems fail closed, including
  // network mounts. Admission here is not a platform/power-loss qualification.
  if (process.platform === 'darwin') {
    // Darwin's f_type is a dynamically registered VFS number, not Linux's
    // filesystem magic. Resolve the actual device/type instead of guessing it.
    const options = { encoding: 'utf8' as const, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 5000 };
    const df = execFileSync('/bin/df', ['-P', path], options);
    const device = df.trim().split('\n').at(-1)!.split(/\s+/)[0];
    if (!/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(device)) throw new StoreError('UNSUPPORTED_STORAGE');
    const info = execFileSync('/usr/sbin/diskutil', ['info', '-plist', device], options);
    const type = /<key>FilesystemType<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
    if (type !== 'apfs' && type !== 'hfs') throw new StoreError('UNSUPPORTED_STORAGE');
    return;
  }
  const type = Number(statfsSync(path).type);
  const known = process.platform === 'linux' ? [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630] : [];
  if (!known.includes(type)) throw new StoreError('UNSUPPORTED_STORAGE');
}
