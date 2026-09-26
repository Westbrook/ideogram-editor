// PF-1 STORE profile. Directory and range indexes live on disk, not in a JS map.
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 as nativeCRC32 } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivate, sameFile, privateFile } from '../storage/files.js';
import { StoreError } from '../storage/errors.js';
import { IO_CHUNK } from '../storage/objects.js';
export const tick = () => new Promise(r => setImmediate(r));
export const invalid = () => { throw new StoreError('MALFORMED_REQUEST'); };
export const pathValid = (s) => s === 'manifest.json' || /^records\/(0|[1-9][0-9]*)\.jsonl$/.test(s) || /^objects\/[0-9a-f]{64}$/.test(s);
// zlib exposes the public incremental CRC-32 API; retain the raw-state interface.
export function crc32(bytes, state = 0xffffffff) { return (nativeCRC32(bytes, (state ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0; }
export function write(fd, b) { for (let n = 0; n < b.length;) {
    const k = writeSync(fd, b, n, b.length - n);
    if (!k)
        throw new StoreError('STORAGE_FAILURE');
    n += k;
} }
export function read(fd, position, length) { if (length > IO_CHUNK || length < 0)
    invalid(); const b = Buffer.alloc(length); for (let n = 0; n < length;) {
    const k = readSync(fd, b, n, length - n, position + BigInt(n));
    if (!k)
        invalid();
    n += k;
} return b; }
export function spool(path) { closeSync(privateFile(path)); const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;'); return db; }
export class ZipIndex {
    path;
    db;
    fd;
    size;
    identity;
    initialStamp;
    constructor(path, db) {
        this.path = path;
        this.db = db;
        this.identity = assertPrivate(path, false);
        this.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!sameFile(this.identity, fstatSync(this.fd))) {
            closeSync(this.fd);
            invalid();
        }
        this.initialStamp = this.stamp();
        this.size = fstatSync(this.fd, { bigint: true }).size;
        db.exec('CREATE TABLE zip_entries(name TEXT PRIMARY KEY COLLATE BINARY, offset TEXT NOT NULL, bytes TEXT NOT NULL, crc INTEGER NOT NULL, sha256 TEXT) STRICT; CREATE UNIQUE INDEX zip_names_folded ON zip_entries(lower(name)); CREATE TABLE zip_ranges(start TEXT PRIMARY KEY,end TEXT NOT NULL) STRICT;');
    }
    stamp() { const s = assertPrivate(this.path, false); return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]); }
    check() { if (this.stamp() !== this.initialStamp || !sameFile(this.identity, fstatSync(this.fd)))
        throw new StoreError('CORRUPT_OBJECT'); }
    async headers(check) {
        // PF-1 has no comments, prefixes, trailing executable payload or data descriptors.
        if (this.size < 22n)
            invalid();
        const end = read(this.fd, this.size - 22n, 22);
        if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(20) !== 0 || end.readUInt16LE(4) || end.readUInt16LE(6))
            invalid();
        let count = BigInt(end.readUInt16LE(10)), cdBytes = BigInt(end.readUInt32LE(12)), cdStart = BigInt(end.readUInt32LE(16)), tail = this.size - 22n;
        if (end.readUInt16LE(8) !== Number(count))
            invalid();
        if (count === 65535n || cdBytes === 0xffffffffn || cdStart === 0xffffffffn) {
            if (tail < 76n)
                invalid();
            const locator = read(this.fd, tail - 20n, 20);
            if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1)
                invalid();
            const at = locator.readBigUInt64LE(8);
            if (at + 56n !== tail - 20n)
                invalid();
            const z = read(this.fd, at, 56);
            if (z.readUInt32LE(0) !== 0x06064b50 || z.readBigUInt64LE(4) !== 44n || z.readUInt32LE(16) || z.readUInt32LE(20) || z.readBigUInt64LE(24) !== z.readBigUInt64LE(32) || z.readUInt16LE(14) > 45)
                invalid();
            const n = z.readBigUInt64LE(32), bytes = z.readBigUInt64LE(40), start = z.readBigUInt64LE(48);
            if (count !== 65535n && count !== n || cdBytes !== 0xffffffffn && cdBytes !== bytes || cdStart !== 0xffffffffn && cdStart !== start)
                invalid();
            count = n;
            cdBytes = bytes;
            cdStart = start;
            tail = at;
        }
        if (cdStart + cdBytes !== tail || count === 0n || count > cdBytes / 46n)
            invalid();
        let cursor = cdStart;
        const add = this.db.prepare('INSERT INTO zip_entries VALUES (?,?,?,?,NULL)'), range = this.db.prepare('INSERT INTO zip_ranges VALUES (?,?)');
        for (let i = 0n; i < count; i++) {
            check();
            this.check();
            if (cursor + 46n > tail)
                invalid();
            const h = read(this.fd, cursor, 46);
            if (h.readUInt32LE(0) !== 0x02014b50)
                invalid();
            const flags = h.readUInt16LE(8), method = h.readUInt16LE(10), nameLength = h.readUInt16LE(28), extraLength = h.readUInt16LE(30), comment = h.readUInt16LE(32), external = h.readUInt32LE(38);
            if (![0, 0x800].includes(flags) || method || comment || h.readUInt16LE(34) || h.readUInt16LE(6) > 45 || h.readUInt16LE(36) || external & 0x18)
                invalid();
            const mode = external >>> 16, type = mode & 0xf000;
            if (type !== 0 && type !== 0x8000 || mode & 0o111)
                invalid();
            if (cursor + 46n + BigInt(nameLength + extraLength) > tail || nameLength > 128)
                invalid();
            const nameBytes = read(this.fd, cursor + 46n, nameLength), name = nameBytes.toString('ascii');
            if ([...nameBytes].some(n => n > 127) || !pathValid(name))
                invalid();
            let bytes = BigInt(h.readUInt32LE(24)), compressed = BigInt(h.readUInt32LE(20)), offset = BigInt(h.readUInt32LE(42));
            const extra = read(this.fd, cursor + 46n + BigInt(nameLength), extraLength);
            let e = 0, zip64 = false;
            while (e < extra.length) {
                if (e + 4 > extra.length)
                    invalid();
                const tag = extra.readUInt16LE(e), size = extra.readUInt16LE(e + 2);
                e += 4;
                if (e + size > extra.length || tag !== 1 || zip64)
                    invalid();
                zip64 = true;
                let q = e;
                for (const field of ['bytes', 'compressed', 'offset']) {
                    const v = field === 'bytes' ? bytes : field === 'compressed' ? compressed : offset;
                    if (v === 0xffffffffn) {
                        if (q + 8 > e + size)
                            invalid();
                        const n = extra.readBigUInt64LE(q);
                        q += 8;
                        if (field === 'bytes')
                            bytes = n;
                        else if (field === 'compressed')
                            compressed = n;
                        else
                            offset = n;
                    }
                }
                if (q !== e + size)
                    invalid();
                e += size;
            }
            if (bytes !== compressed || offset + 30n > cdStart)
                invalid();
            const l = read(this.fd, offset, 30);
            if (l.readUInt32LE(0) !== 0x04034b50 || l.readUInt16LE(4) !== h.readUInt16LE(6) || l.readUInt16LE(6) !== flags || l.readUInt16LE(8) !== method || l.readUInt32LE(10) !== h.readUInt32LE(12) || l.readUInt32LE(14) !== h.readUInt32LE(16) || l.readUInt16LE(26) !== nameLength)
                invalid();
            const le = Number(l.readUInt16LE(28)), data = offset + 30n + BigInt(nameLength + le);
            if (data + bytes > cdStart || !read(this.fd, offset + 30n, nameLength).equals(nameBytes))
                invalid();
            let lb = BigInt(l.readUInt32LE(22)), lc = BigInt(l.readUInt32LE(18));
            const lx = read(this.fd, offset + 30n + BigInt(nameLength), le);
            if (lb === 0xffffffffn || lc === 0xffffffffn) {
                if (le !== 20 || lx.readUInt16LE(0) !== 1 || lx.readUInt16LE(2) !== 16 || lb !== 0xffffffffn || lc !== 0xffffffffn)
                    invalid();
                lb = lx.readBigUInt64LE(4);
                lc = lx.readBigUInt64LE(12);
            }
            else if (le)
                invalid();
            if (lb !== bytes || lc !== bytes)
                invalid();
            try {
                add.run(name, String(data), String(bytes), h.readUInt32LE(16));
                range.run(String(offset), String(data + bytes));
            }
            catch {
                invalid();
            }
            cursor += 46n + BigInt(nameLength + extraLength);
            await tick();
        }
        if (cursor !== tail || !this.db.prepare("SELECT 1 FROM zip_entries WHERE name='manifest.json'").get())
            invalid();
        let next = 0n;
        for (const r of this.db.prepare('SELECT * FROM zip_ranges ORDER BY length(start),start').iterate()) {
            if (BigInt(String(r.start)) !== next)
                invalid();
            next = BigInt(String(r.end));
        }
        if (next !== cdStart)
            invalid();
        this.check();
    }
    entry(name) { const r = this.db.prepare('SELECT * FROM zip_entries WHERE name=?').get(name); if (!r)
        return invalid(); return { name, offset: BigInt(String(r.offset)), bytes: BigInt(String(r.bytes)), crc: Number(r.crc), sha256: String(r.sha256 ?? '') }; }
    async *chunks(entry, check) { for (let at = 0n; at < entry.bytes;) {
        check();
        this.check();
        const n = Number(entry.bytes - at > BigInt(IO_CHUNK) ? BigInt(IO_CHUNK) : entry.bytes - at);
        const b = read(this.fd, entry.offset + at, n);
        at += BigInt(n);
        yield b;
        await tick();
    } this.check(); }
    async hashes(check) { for (const r of this.db.prepare('SELECT name FROM zip_entries ORDER BY name').iterate()) {
        const e = this.entry(String(r.name)), h = createHash('sha256');
        let crc = 0xffffffff;
        for await (const b of this.chunks(e, check)) {
            h.update(b);
            crc = crc32(b, crc);
        }
        if (((crc ^ 0xffffffff) >>> 0) !== e.crc)
            invalid();
        const hash = h.digest('hex');
        if (e.name.startsWith('objects/') && e.name.slice(8) !== hash)
            invalid();
        this.db.prepare('UPDATE zip_entries SET sha256=? WHERE name=?').run(hash, e.name);
    } }
    close() { closeSync(this.fd); }
}
export async function writeZip(path, index, sources, check, beforeWrite = () => { }) {
    const fd = privateFile(path);
    index.exec('CREATE TABLE output_zip(name TEXT PRIMARY KEY,offset TEXT NOT NULL,bytes TEXT NOT NULL,crc INTEGER NOT NULL) STRICT');
    let offset = 0n, count = 0n;
    const emit = (b) => { beforeWrite(); write(fd, b); offset += BigInt(b.length); };
    try {
        for await (const s of sources) {
            check();
            if (!pathValid(s.name))
                invalid();
            const n = Buffer.from(s.name, 'ascii'), h = Buffer.alloc(30), x = Buffer.alloc(20);
            h.writeUInt32LE(0x04034b50);
            h.writeUInt16LE(45, 4);
            h.writeUInt16LE(0x800, 6);
            h.writeUInt32LE(s.crc, 14);
            h.writeUInt32LE(0xffffffff, 18);
            h.writeUInt32LE(0xffffffff, 22);
            h.writeUInt16LE(n.length, 26);
            h.writeUInt16LE(20, 28);
            x.writeUInt16LE(1);
            x.writeUInt16LE(16, 2);
            x.writeBigUInt64LE(s.bytes, 4);
            x.writeBigUInt64LE(s.bytes, 12);
            index.prepare('INSERT INTO output_zip VALUES (?,?,?,?)').run(s.name, String(offset), String(s.bytes), s.crc);
            emit(h);
            emit(n);
            emit(x);
            let length = 0n, crc = 0xffffffff;
            const hash = createHash('sha256');
            for await (const b of s.chunks()) {
                check();
                if (b.length > IO_CHUNK)
                    invalid();
                length += BigInt(b.length);
                if (length > s.bytes)
                    invalid();
                hash.update(b);
                crc = crc32(b, crc);
                emit(b);
                await tick();
            }
            if (length !== s.bytes || ((crc ^ 0xffffffff) >>> 0) !== s.crc || hash.digest('hex') !== s.sha256)
                throw new StoreError('CORRUPT_OBJECT');
            count++;
        }
        const cdStart = offset;
        for (const r of index.prepare('SELECT * FROM output_zip ORDER BY length(offset),offset').iterate()) {
            const n = Buffer.from(String(r.name)), h = Buffer.alloc(46), x = Buffer.alloc(28);
            h.writeUInt32LE(0x02014b50);
            h.writeUInt16LE(0x32d, 4);
            h.writeUInt16LE(45, 6);
            h.writeUInt16LE(0x800, 8);
            h.writeUInt32LE(Number(r.crc), 16);
            h.writeUInt32LE(0xffffffff, 20);
            h.writeUInt32LE(0xffffffff, 24);
            h.writeUInt16LE(n.length, 28);
            h.writeUInt16LE(28, 30);
            h.writeUInt32LE((0o100600 * 65536) >>> 0, 38);
            h.writeUInt32LE(0xffffffff, 42);
            x.writeUInt16LE(1);
            x.writeUInt16LE(24, 2);
            x.writeBigUInt64LE(BigInt(String(r.bytes)), 4);
            x.writeBigUInt64LE(BigInt(String(r.bytes)), 12);
            x.writeBigUInt64LE(BigInt(String(r.offset)), 20);
            emit(h);
            emit(n);
            emit(x);
            check();
            await tick();
        }
        const cdBytes = offset - cdStart, zAt = offset, z = Buffer.alloc(56);
        z.writeUInt32LE(0x06064b50);
        z.writeBigUInt64LE(44n, 4);
        z.writeUInt16LE(45, 12);
        z.writeUInt16LE(45, 14);
        z.writeBigUInt64LE(count, 24);
        z.writeBigUInt64LE(count, 32);
        z.writeBigUInt64LE(cdBytes, 40);
        z.writeBigUInt64LE(cdStart, 48);
        emit(z);
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50);
        locator.writeBigUInt64LE(zAt, 8);
        locator.writeUInt32LE(1, 16);
        emit(locator);
        const e = Buffer.alloc(22);
        e.writeUInt32LE(0x06054b50);
        e.writeUInt16LE(65535, 8);
        e.writeUInt16LE(65535, 10);
        e.writeUInt32LE(0xffffffff, 12);
        e.writeUInt32LE(0xffffffff, 16);
        emit(e);
        fsyncSync(fd);
        return offset;
    }
    finally {
        closeSync(fd);
    }
}
