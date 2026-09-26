import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { assertComponents, assertPrivate, inspectTree, privateDirectory, sameFile, syncDirectory } from './files.js';
import { isSeq, validateBlob } from './canonical.js';
import { StoreError } from './errors.js';
export const IO_CHUNK = 1024 * 1024;
const MARGIN = 1024n ** 3n;
const EMERGENCY = 64n * 1024n ** 2n;
export class Objects {
    root;
    check;
    barrier;
    quota;
    stages = new Map();
    reserved = 0n;
    external = new Map();
    slots = new Set();
    available = () => { };
    onAvailable(callback) { this.available = callback; }
    proofs = new Map();
    staging;
    objects;
    constructor(root, check, barrier, quota) {
        this.root = root;
        this.check = check;
        this.barrier = barrier;
        this.quota = quota;
        this.objects = join(root, 'objects');
        privateDirectory(this.objects);
        this.objects = join(this.objects, 'sha256');
        privateDirectory(this.objects);
        this.staging = join(root, 'staging');
        privateDirectory(this.staging);
    }
    capacity(length) {
        const stats = statfsSync(this.root, { bigint: true });
        const free = stats.bavail * stats.bsize;
        const total = stats.blocks * stats.bsize;
        const required = length + (length + 3n) / 4n;
        const reserved = this.reserved + [...this.external.values()].reduce((a, b) => a + b, 0n);
        const used = this.quota ? inspectTree(this.root) : 0n;
        if (free < reserved + required + MARGIN + EMERGENCY || (total - free) * 10n >= total * 9n ||
            (this.quota && (used * 10n >= BigInt(this.quota) * 9n || used + reserved + required + MARGIN + EMERGENCY > BigInt(this.quota))))
            throw new StoreError('CAPACITY');
    }
    reserve(id, cost, enforce = true) {
        const previous = this.external.get(id);
        this.external.delete(id);
        try {
            if (enforce)
                this.capacity(cost);
            this.external.set(id, cost + (cost + 3n) / 4n);
        }
        catch (e) {
            if (previous !== undefined)
                this.external.set(id, previous);
            throw e;
        }
    }
    unreserve(id) { this.external.delete(id); }
    acquire(id) { if (this.slots.has(id))
        return; if (this.stages.size + this.slots.size >= 2)
        throw new StoreError('CAPACITY'); this.slots.add(id); }
    release(id) { if (this.slots.delete(id))
        this.available(); }
    reservationInventory() { return { reservedBytes: String(this.reserved + [...this.external.values()].reduce((a, b) => a + b, 0n)), activeTransfers: this.slots.size + this.stages.size }; }
    begin(byteLength, mediaType, expectedHash, metadata = false) {
        this.check();
        assertComponents(this.staging);
        assertPrivate(this.staging, true);
        if (!isSeq(byteLength))
            throw new StoreError('MALFORMED_REQUEST');
        validateBlob({ hash: expectedHash ?? `sha256:${'0'.repeat(64)}`, byteLength, mediaType });
        const length = BigInt(byteLength);
        if (metadata && length > 65536n)
            throw new StoreError('PAYLOAD_TOO_LARGE');
        if (this.stages.size + this.slots.size >= 2)
            throw new StoreError('CAPACITY');
        if (!metadata)
            this.capacity(length);
        const id = randomUUID();
        const path = join(this.staging, id);
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        const reserved = metadata ? 0n : length + (length + 3n) / 4n;
        this.reserved += reserved;
        this.stages.set(id, { fd, path, length, received: 0n, hash: createHash('sha256'), mediaType, expectedHash, reserved, checkedAt: Date.now() });
        return id;
    }
    chunk(id, bytes) {
        this.check();
        assertComponents(this.staging);
        const stage = this.stages.get(id);
        if (!stage || bytes.byteLength > IO_CHUNK || stage.received + BigInt(bytes.byteLength) > stage.length)
            throw new StoreError('MALFORMED_REQUEST');
        assertPrivate(this.staging, true);
        if (!sameFile(fstatSync(stage.fd), assertPrivate(stage.path, false)))
            throw new StoreError('ROOT_UNSAFE');
        if (stage.reserved && Date.now() - stage.checkedAt >= 30_000) {
            this.capacity(0n);
            stage.checkedAt = Date.now();
        }
        this.barrier('before-object-write');
        for (let offset = 0; offset < bytes.byteLength;) {
            const count = writeSync(stage.fd, bytes, offset, bytes.byteLength - offset);
            if (!count)
                throw new StoreError('STORAGE_FAILURE');
            offset += count;
        }
        stage.hash.update(bytes);
        stage.received += BigInt(bytes.byteLength);
    }
    finish(id) {
        this.check();
        const stage = this.stages.get(id);
        if (!stage || stage.received !== stage.length)
            throw new StoreError('MALFORMED_REQUEST');
        const hash = `sha256:${stage.hash.digest('hex')}`;
        if (stage.expectedHash && hash !== stage.expectedHash)
            throw new StoreError('CORRUPT_OBJECT');
        const ref = { hash, byteLength: String(stage.length), mediaType: stage.mediaType };
        this.barrier('before-object-flush');
        fsyncSync(stage.fd);
        this.barrier('after-object-flush');
        closeSync(stage.fd);
        stage.fd = -1;
        assertComponents(this.objects);
        assertPrivate(this.objects, true);
        const target = this.path(ref);
        privateDirectory(join(this.objects, hash.slice(7, 9)));
        this.barrier('before-object-rename');
        try {
            lstatSync(target);
            this.verify(ref);
            unlinkSync(stage.path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            renameSync(stage.path, target);
        }
        this.barrier('after-object-rename');
        syncDirectory(join(this.objects, hash.slice(7, 9)));
        syncDirectory(this.staging);
        this.barrier('after-object-directory-sync');
        this.verify(ref);
        this.reserved -= stage.reserved;
        this.stages.delete(id);
        this.available();
        return ref;
    }
    abort(id) {
        const stage = this.stages.get(id);
        if (!stage)
            return;
        if (stage.fd !== -1)
            closeSync(stage.fd);
        // Keep abandoned bytes for startup inventory; cleanup is a later explicit operation.
        this.reserved -= stage.reserved;
        this.stages.delete(id);
        this.available();
    }
    putMetadataInSlot(bytes, slot) {
        // A synchronous metadata write borrows its caller's existing IO permit.
        // No callback can admit another task until the permit is restored.
        if (!this.slots.delete(slot))
            throw new StoreError('CAPACITY');
        try {
            return this.putMetadata(bytes);
        }
        finally {
            this.slots.add(slot);
        }
    }
    putMetadata(bytes) {
        const id = this.begin(String(bytes.byteLength), 'application/json', undefined, true);
        try {
            this.chunk(id, bytes);
            return this.finish(id);
        }
        finally {
            this.abort(id);
        }
    }
    path(ref) { validateBlob(ref); return join(this.objects, ref.hash.slice(7, 9), ref.hash.slice(7)); }
    verify(ref, read = false) {
        this.check();
        validateBlob(ref);
        if (read && BigInt(ref.byteLength) > 65536n)
            throw new StoreError('PAYLOAD_TOO_LARGE');
        let fd;
        try {
            assertComponents(this.objects);
            assertPrivate(this.objects, true);
            assertPrivate(join(this.objects, ref.hash.slice(7, 9)), true);
            const identity = assertPrivate(this.path(ref), false);
            fd = openSync(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
            if (!sameFile(identity, fstatSync(fd))) {
                closeSync(fd);
                throw new StoreError('ROOT_UNSAFE');
            }
        }
        catch (error) {
            if (error.code === 'ENOENT')
                throw new StoreError('MISSING_OBJECT');
            throw error;
        }
        try {
            const hash = createHash('sha256');
            const chunk = Buffer.alloc(IO_CHUNK);
            let length = 0n;
            const parts = [];
            for (;;) {
                const n = readSync(fd, chunk);
                if (!n)
                    break;
                length += BigInt(n);
                hash.update(chunk.subarray(0, n));
                if (length > BigInt(ref.byteLength))
                    throw new StoreError('CORRUPT_OBJECT');
                if (read)
                    parts.push(Buffer.from(chunk.subarray(0, n)));
            }
            if (length !== BigInt(ref.byteLength) || `sha256:${hash.digest('hex')}` !== ref.hash)
                throw new StoreError('CORRUPT_OBJECT');
            return read ? Buffer.concat(parts) : undefined;
        }
        finally {
            closeSync(fd);
        }
    }
    readRange(ref, offset, length) {
        this.check();
        validateBlob(ref);
        if (!isSeq(offset) || !Number.isSafeInteger(length) || length < 0 || length > IO_CHUNK ||
            BigInt(offset) + BigInt(length) > BigInt(ref.byteLength))
            throw new StoreError('MALFORMED_REQUEST');
        assertComponents(this.objects);
        assertPrivate(this.objects, true);
        assertPrivate(join(this.objects, ref.hash.slice(7, 9)), true);
        const identity = assertPrivate(this.path(ref), false);
        const fd = openSync(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!sameFile(identity, fstatSync(fd)) || BigInt(identity.size) !== BigInt(ref.byteLength))
                throw new StoreError('CORRUPT_OBJECT');
            const bytes = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
                const n = readSync(fd, bytes, read, length - read, BigInt(offset) + BigInt(read));
                if (!n)
                    throw new StoreError('CORRUPT_OBJECT');
                read += n;
            }
            return bytes;
        }
        finally {
            closeSync(fd);
        }
    }
    stamp(ref) {
        const path = this.path(ref);
        assertComponents(this.objects);
        assertPrivate(this.objects, true);
        assertPrivate(join(this.objects, ref.hash.slice(7, 9)), true);
        const s = assertPrivate(path, false);
        return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    }
    async prove(ref, check) {
        this.check();
        if (this.proofs.size >= 512)
            throw new StoreError('CAPACITY');
        const stamp = this.stamp(ref);
        const path = this.path(ref);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!sameFile(fstatSync(fd), assertPrivate(path, false)))
                throw new StoreError('ROOT_UNSAFE');
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(IO_CHUNK);
            let length = 0n;
            for (;;) {
                this.check();
                check();
                const n = readSync(fd, buffer);
                if (!n)
                    break;
                length += BigInt(n);
                if (length > BigInt(ref.byteLength))
                    throw new StoreError('CORRUPT_OBJECT');
                hash.update(buffer.subarray(0, n));
                await new Promise(r => setImmediate(r));
            }
            if (length !== BigInt(ref.byteLength) || 'sha256:' + hash.digest('hex') !== ref.hash || this.stamp(ref) !== stamp)
                throw new StoreError('CORRUPT_OBJECT');
            const token = randomUUID();
            this.proofs.set(token, { ref, stamp });
            return token;
        }
        finally {
            closeSync(fd);
        }
    }
    proven(ref, token) { this.check(); const proof = this.proofs.get(token); if (!proof || proof.ref.hash !== ref.hash || proof.ref.byteLength !== ref.byteLength || proof.ref.mediaType !== ref.mediaType || this.stamp(ref) !== proof.stamp)
        throw new StoreError('CORRUPT_OBJECT'); }
    releaseProof(token) { this.proofs.delete(token); }
    // Internal raster output only. The sole writer checks private same-filesystem
    // bytes, flushes and renames, then cooperatively proves the immutable target.
    async adoptFile(path, ref, check) {
        this.check();
        validateBlob(ref);
        assertComponents(dirname(path));
        const identity = assertPrivate(path, false);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!sameFile(identity, fstatSync(fd)) || String(identity.size) !== ref.byteLength)
                throw new StoreError('CORRUPT_OBJECT');
            this.barrier('raster-before-flush');
            fsyncSync(fd);
            this.barrier('raster-after-flush');
        }
        finally {
            closeSync(fd);
        }
        const target = this.path(ref);
        privateDirectory(dirname(target));
        this.barrier('raster-before-rename');
        try {
            lstatSync(target);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            renameSync(path, target);
        }
        this.barrier('raster-after-rename');
        syncDirectory(dirname(target));
        syncDirectory(dirname(path));
        this.barrier('raster-after-directory-sync');
        return this.prove(ref, check);
    }
    inventory(registered) {
        const orphans = [];
        for (const shard of readdirSync(this.objects)) {
            assertPrivate(join(this.objects, shard), true);
            for (const name of readdirSync(join(this.objects, shard))) {
                assertPrivate(join(this.objects, shard, name), false);
                if (!registered.has(`sha256:${name}`))
                    orphans.push(name);
            }
        }
        return { orphanCount: String(orphans.length), stagingCount: String(readdirSync(this.staging).length) };
    }
    close() { for (const id of this.stages.keys())
        this.abort(id); }
}
