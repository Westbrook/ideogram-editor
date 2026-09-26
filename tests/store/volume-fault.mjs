// Opt-in host qualification, never mounts or fills the user's actual storage.
// The image and mount are created afresh; cleanup detaches only this exact image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, ftruncateSync, openSync, statfsSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childFor, command, encode, expectedBytes, refFor } from './helpers.mjs';

test('isolated mounted ENOSPC and read-only volume: no false receipt; exact state recovers after writable capacity returns', async t => {
  assert.equal(process.platform, 'darwin', 'This named-host qualification requires macOS hdiutil.');
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-full-volume-'));
  const mount = join(directory, 'mount'); const image = join(directory, 'fault.dmg');
  await mkdir(mount);
  let attached = false; let writer; let fd;
  try {
    execFileSync('/usr/bin/hdiutil', ['create', '-size', '64m', '-fs', 'HFS+', '-volname', 'IdeogramIsolatedFault', image], { stdio: 'pipe' });
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-owners', 'on', '-mountpoint', mount, image], { stdio: 'pipe' }); attached = true;
    const root = join(mount, 'private');
    writer = await childFor(t, root, { phase: 'before-object-write' });
    assert.equal(writer.startup.type, 'ready', JSON.stringify(writer.startup));
    const c = command(refFor(expectedBytes));
    const pending = writer.call('submit', encode(c)).catch(error => error);
    await writer.wait('barrier');
    const before = statfsSync(mount);
    fd = openSync(join(mount, 'filler'), 'wx', 0o600);
    let filled = 0; let actualCode;
    // Exhaust large blocks, then remaining allocation units on this new image.
    for (const size of [1024 * 1024, 4096, 512]) {
      const bytes = Buffer.alloc(size, 123);
      try { for (;;) { const n = writeSync(fd, bytes); if (!n) throw new Error('No progress'); filled += n; } }
      catch (error) { assert.equal(error.code, 'ENOSPC'); actualCode = error.code; }
    }
    fsyncSync(fd);
    const full = statfsSync(mount);
    await writer.call('release'); const failure = await pending;
    assert.equal(failure.code, 'STORAGE_FULL');
    assert.equal((await writer.wait('failure')).failure.code, 'ENOSPC');
    assert.equal(await writer.call('lookup', c.command.commandId), null);
    assert.equal((await writer.call('events')).highWater, '0'); assert.equal(await writer.call('document', 'document_1'), null);
    ftruncateSync(fd, 0); fsyncSync(fd); closeSync(fd); fd = undefined;
    const retried = await writer.call('submit', encode(c));
    assert.equal(retried.status, 'rejected'); assert.equal(retried.code, 'MISSING_ASSET');
    const detail = await writer.call('readMetadata', retried.details); assert.ok(detail.byteLength > 0);
    await writer.assertNoEffects(); await writer.close(); writer = undefined;
    const reopened = await childFor(t, root);
    assert.deepEqual(await reopened.call('submit', encode(c)), retried); await reopened.assertNoEffects(); await reopened.close();
    const databaseBytes = await readFile(join(root, 'metadata.sqlite'));
    execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' }); attached = false;
    execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-owners', 'on', '-mountpoint', mount, image], { stdio: 'pipe' }); attached = true;
    assert.throws(() => openSync(join(root, 'writer.lock'), 'r+'), { code: 'EROFS' });
    const readOnly = await childFor(t, root); assert.equal(readOnly.startup.code, 'STORAGE_FAILURE');
    assert.deepEqual(await readFile(join(root, 'metadata.sqlite')), databaseBytes);
    execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' }); attached = false;
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-owners', 'on', '-mountpoint', mount, image], { stdio: 'pipe' }); attached = true;
    const writable = await childFor(t, root);
    assert.deepEqual(await writable.call('submit', encode(c)), retried); await writable.assertNoEffects(); await writable.close();
    t.diagnostic(JSON.stringify({ filesystem: 'HFS+ inside isolated 64MiB image; not the APFS production root',
      beforeAvailableBytes: before.bavail * before.bsize, fullAvailableBytes: full.bavail * full.bsize,
      fillerBytes: filled, actualFilesystemError: actualCode, writerOutcome: failure.code,
      readOnlyFilesystemError: 'EROFS', readOnlyPhase: 'ownership startup refuses without mutating existing metadata', powerLossQualified: false }));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (writer) await writer.kill();
    if (attached) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
    await rm(directory, { recursive: true, force: true });
  }
});
